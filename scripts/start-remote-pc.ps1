param(
  [switch]$NoOpen,
  [switch]$NoDiscordStartReport
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $Root ".env"
$ExampleEnvPath = Join-Path $Root ".env.example"
$PidPath = Join-Path $Root "data\remote-pc.pid"
$DefaultPort = 8787
$DefaultAdminPort = 8788

Set-Location $Root

function Write-Step($Message) {
  Write-Host ""
  Write-Host "== $Message" -ForegroundColor Cyan
}

function Get-RandomSecret {
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd("=")
}

function Get-RandomPin {
  $bytes = New-Object byte[] 8
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  $number = ([BitConverter]::ToUInt64($bytes, 0) % [uint64]9000000000) + [uint64]1000000000
  return $number.ToString()
}

function Read-EnvFile {
  $values = @{}
  if (!(Test-Path $EnvPath)) {
    return $values
  }
  foreach ($line in Get-Content $EnvPath) {
    if ($line -match "^\s*#" -or $line.Trim() -eq "") {
      continue
    }
    $parts = $line -split "=", 2
    if ($parts.Count -eq 2) {
      $values[$parts[0].Trim()] = $parts[1].Trim()
    }
  }
  return $values
}

function Set-EnvValue($Name, $Value) {
  $lines = @()
  if (Test-Path $EnvPath) {
    $lines = @(Get-Content $EnvPath)
  }

  $escaped = [regex]::Escape($Name)
  $updated = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^$escaped=") {
      $lines[$i] = "$Name=$Value"
      $updated = $true
    }
  }

  if (!$updated) {
    $lines += "$Name=$Value"
  }

  Set-Content -Path $EnvPath -Value $lines -Encoding ASCII
}

function Ensure-Env {
  if (!(Test-Path $EnvPath)) {
    Write-Step "First run setup"
    Copy-Item $ExampleEnvPath $EnvPath
    Set-EnvValue "REMOTE_PC_SECRET" (Get-RandomSecret)
    Write-Host "Created .env and generated a local signing secret."
  }

  $envValues = Read-EnvFile
  if (!$envValues["REMOTE_PC_SECRET"] -or $envValues["REMOTE_PC_SECRET"] -like "replace-with-*") {
    Set-EnvValue "REMOTE_PC_SECRET" (Get-RandomSecret)
  }

  if (!$envValues["REMOTE_PC_PIN"] -or $envValues["REMOTE_PC_PIN"] -notmatch "^\d{8,12}$") {
    Set-EnvValue "REMOTE_PC_PIN" (Get-RandomPin)
  }

  if (!$envValues["REMOTE_PC_HOST"]) {
    Set-EnvValue "REMOTE_PC_HOST" "127.0.0.1"
  }
  if (!$envValues["REMOTE_PC_ADMIN_PORT"]) {
    Set-EnvValue "REMOTE_PC_ADMIN_PORT" "$DefaultAdminPort"
  }
  if (!$envValues["REMOTE_PC_REQUIRE_LOCAL_APPROVAL"]) {
    Set-EnvValue "REMOTE_PC_REQUIRE_LOCAL_APPROVAL" "true"
  }
  if (!$envValues["CLOUDFLARE_ENABLED"]) {
    Set-EnvValue "CLOUDFLARE_ENABLED" "true"
  }
  if (!$envValues["CLOUDFLARE_MODE"]) {
    Set-EnvValue "CLOUDFLARE_MODE" "quick"
  }
  if (!$envValues["STREAM_PRESET"]) {
    Set-EnvValue "STREAM_PRESET" "low-latency"
  }
  if (!$envValues["STREAM_CAPTURE_BACKEND"]) {
    Set-EnvValue "STREAM_CAPTURE_BACKEND" "gdigrab"
  }
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Test-Executable($CommandOrPath) {
  if (!$CommandOrPath) {
    return $false
  }

  if ([IO.Path]::IsPathRooted($CommandOrPath)) {
    return Test-Path -LiteralPath $CommandOrPath -PathType Leaf
  }

  if ($CommandOrPath.Contains("\") -or $CommandOrPath.Contains("/")) {
    return Test-Path -LiteralPath (Join-Path $Root $CommandOrPath) -PathType Leaf
  }

  return [bool](Get-Command $CommandOrPath -ErrorAction SilentlyContinue)
}

function Test-Node24 {
  if (!(Get-Command "node" -ErrorAction SilentlyContinue)) {
    return $false
  }

  try {
    $rawVersion = (& node --version).Trim().TrimStart("v")
    $version = [version]($rawVersion -split "-", 2)[0]
    return $version.Major -ge 24
  } catch {
    return $false
  }
}

function Test-DotNet8Sdk {
  if (!(Get-Command "dotnet" -ErrorAction SilentlyContinue)) {
    return $false
  }

  try {
    foreach ($line in & dotnet --list-sdks) {
      $versionText = ($line -split "\s+", 2)[0]
      $version = [version]($versionText -split "-", 2)[0]
      if ($version.Major -ge 8) {
        return $true
      }
    }
  } catch {
    return $false
  }

  return $false
}

function Install-WinGetPackage($DisplayName, $PackageId) {
  $winget = Get-Command "winget" -ErrorAction SilentlyContinue
  if (!$winget) {
    throw "$DisplayName is missing, and WinGet is unavailable. Install or update App Installer from Microsoft Store, then run Start-RemotePC.cmd again."
  }

  Write-Step "Installing missing requirement: $DisplayName"
  & $winget.Source install `
    --id $PackageId `
    --exact `
    --source winget `
    --accept-package-agreements `
    --accept-source-agreements `
    --silent `
    --disable-interactivity
  if ($LASTEXITCODE -ne 0) {
    throw "WinGet could not install $DisplayName. Exit code: $LASTEXITCODE. Install package '$PackageId' manually, then run Start-RemotePC.cmd again."
  }

  Refresh-ProcessPath
}

function Ensure-SystemRequirements {
  Write-Step "Checking system requirements"

  if (!(Test-Node24)) {
    Install-WinGetPackage "Node.js 24 or newer" "OpenJS.NodeJS.LTS"
  }
  if (!(Get-Command "npm" -ErrorAction SilentlyContinue)) {
    Refresh-ProcessPath
  }
  if (!(Test-Node24) -or !(Get-Command "npm" -ErrorAction SilentlyContinue)) {
    throw "Node.js 24+ or npm is still unavailable after setup. Close this window, run Start-RemotePC.cmd again, or install Node.js LTS manually."
  }

  if (!(Test-DotNet8Sdk)) {
    Install-WinGetPackage ".NET SDK 8 or newer" "Microsoft.DotNet.SDK.8"
  }
  if (!(Test-DotNet8Sdk)) {
    throw ".NET SDK 8+ is still unavailable after setup. Close this window, run Start-RemotePC.cmd again, or install .NET SDK 8 manually."
  }

  $envValues = Read-EnvFile
  $ffmpegPath = if ($envValues["FFMPEG_PATH"]) { $envValues["FFMPEG_PATH"] } else { "ffmpeg" }
  if (!(Test-Executable $ffmpegPath)) {
    if ($ffmpegPath -ne "ffmpeg") {
      throw "The configured FFMPEG_PATH '$ffmpegPath' was not found. Fix it in Configure-RemotePC.cmd or set it to ffmpeg for automatic installation."
    }
    Install-WinGetPackage "FFmpeg" "Gyan.FFmpeg"
  }
  if (!(Test-Executable $ffmpegPath)) {
    throw "FFmpeg is still unavailable after setup. Close this window, run Start-RemotePC.cmd again, or install FFmpeg manually."
  }

  $cloudflareEnabled = !$envValues["CLOUDFLARE_ENABLED"] -or $envValues["CLOUDFLARE_ENABLED"] -ne "false"
  if ($cloudflareEnabled) {
    $cloudflaredPath = if ($envValues["CLOUDFLARED_PATH"]) { $envValues["CLOUDFLARED_PATH"] } else { "cloudflared" }
    if (!(Test-Executable $cloudflaredPath)) {
      if ($cloudflaredPath -ne "cloudflared") {
        throw "The configured CLOUDFLARED_PATH '$cloudflaredPath' was not found. Fix it in Configure-RemotePC.cmd or set it to cloudflared for automatic installation."
      }
      Install-WinGetPackage "cloudflared" "Cloudflare.cloudflared"
    }
    if (!(Test-Executable $cloudflaredPath)) {
      throw "cloudflared is still unavailable after setup. Close this window, run Start-RemotePC.cmd again, or install cloudflared manually."
    }
  }

  Write-Host "System requirements are ready."
}

function Ensure-Built {
  if (!(Test-Path (Join-Path $Root "node_modules"))) {
    Write-Step "Installing Node dependencies"
    npm install
  }

  $hostBuild = Join-Path $Root "dist\host\main.js"
  $clientBuild = Join-Path $Root "dist\client\index.html"
  $buildInputs = @(
    Get-ChildItem (Join-Path $Root "src") -Recurse -File
    Get-Item (Join-Path $Root "package-lock.json")
    Get-Item (Join-Path $Root "vite.config.ts")
  )
  $latestBuildInput = $buildInputs | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  $needsBuild = !(Test-Path $hostBuild) -or
    !(Test-Path $clientBuild) -or
    $latestBuildInput.LastWriteTimeUtc -gt (Get-Item $hostBuild).LastWriteTimeUtc -or
    $latestBuildInput.LastWriteTimeUtc -gt (Get-Item $clientBuild).LastWriteTimeUtc
  if ($needsBuild) {
    Write-Step "Building host and web client"
    npm run build
  }

  $inputBuild = Join-Path $Root "native\RemotePc.InputHost\bin\Release\net8.0-windows\RemotePc.InputHost.dll"
  $inputSource = Get-ChildItem (Join-Path $Root "native\RemotePc.InputHost") -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if (!(Test-Path $inputBuild) -or $inputSource.LastWriteTimeUtc -gt (Get-Item $inputBuild).LastWriteTimeUtc) {
    Write-Step "Building Windows input helper"
    npm run build:input
  }
}

function Get-Port {
  $envValues = Read-EnvFile
  if ($envValues["REMOTE_PC_PORT"]) {
    return [int]$envValues["REMOTE_PC_PORT"]
  }
  return $DefaultPort
}

function Get-AdminPort {
  $envValues = Read-EnvFile
  if ($envValues["REMOTE_PC_ADMIN_PORT"]) {
    return [int]$envValues["REMOTE_PC_ADMIN_PORT"]
  }
  return $DefaultAdminPort
}

function Get-AdminToken {
  $envValues = Read-EnvFile
  $dataDir = if ($envValues["REMOTE_PC_DATA_DIR"]) { $envValues["REMOTE_PC_DATA_DIR"] } else { ".\data" }
  if (![IO.Path]::IsPathRooted($dataDir)) {
    $dataDir = Join-Path $Root $dataDir
  }
  $tokenPath = Join-Path $dataDir "admin.key"
  if (!(Test-Path $tokenPath)) {
    throw "Local administrator token was not created at $tokenPath."
  }
  return (Get-Content $tokenPath -Raw).Trim()
}

function Send-Discord($Content) {
  if ($NoDiscordStartReport) {
    return
  }
  $envValues = Read-EnvFile
  $webhook = $envValues["DISCORD_WEBHOOK_URL"]
  if (!$webhook) {
    return
  }
  if ($Content -match "pairing|secret|token|password|pin|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.") {
    Write-Host "Blocked Discord notification that looked sensitive." -ForegroundColor Yellow
    return
  }
  try {
    Invoke-RestMethod -Uri $webhook -Method Post -ContentType "application/json" -Body (@{ content = $Content } | ConvertTo-Json -Compress) -TimeoutSec 10 | Out-Null
    Write-Host "Discord link report sent."
  } catch {
    Write-Host "Discord link report failed." -ForegroundColor Yellow
  }
}

function Test-HostAlive($Port) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    return [bool]$health.ok
  } catch {
    return $false
  }
}

function Get-ExistingProcess {
  if (!(Test-Path $PidPath)) {
    return $null
  }
  $pidValue = Get-Content $PidPath | Select-Object -First 1
  if (!$pidValue) {
    return $null
  }
  try {
    return Get-Process -Id ([int]$pidValue) -ErrorAction Stop
  } catch {
    Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
    return $null
  }
}

function Start-HostProcess {
  $existing = Get-ExistingProcess
  if ($existing) {
    Write-Host "Remote PC host is already running as PID $($existing.Id)."
    return $existing
  }

  Write-Step "Starting Remote PC host"
  $process = Start-Process -FilePath "node" -ArgumentList "dist/host/main.js" -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  New-Item -ItemType Directory -Path (Split-Path -Parent $PidPath) -Force | Out-Null
  Set-Content -Path $PidPath -Value $process.Id -Encoding ASCII
  return $process
}

function Show-Status($Port, $AdminPort) {
  $status = $null
  $envValues = Read-EnvFile
  $pin = $envValues["REMOTE_PC_PIN"]
  $adminToken = Get-AdminToken
  $adminHeaders = @{ "x-remote-pc-admin-token" = $adminToken }
  Write-Host "Waiting for Cloudflare Quick Tunnel URL" -NoNewline
  for ($i = 0; $i -lt 90; $i++) {
    try {
      $status = Invoke-RestMethod -Uri "http://127.0.0.1:$AdminPort/api/host/status" -Headers $adminHeaders -TimeoutSec 3
      if ($status.cloudflareUrl) {
        break
      }
    } catch {
    }
    Write-Host "." -NoNewline
    Start-Sleep -Seconds 1
  }
  Write-Host ""

  if (!$status) {
    throw "The host did not answer on http://127.0.0.1:$Port."
  }

  Write-Step "Use this anywhere in the world"
  if ($status.cloudflareUrl) {
    Write-Host "Remote link:  $($status.cloudflareUrl)" -ForegroundColor Green
    $null = Send-Discord "Remote PC started a new link report: $($status.cloudflareUrl)"
  } else {
    Write-Host "Remote link:  Cloudflare is still connecting. Check the PC status page in a moment." -ForegroundColor Yellow
  }
  Write-Host "PC status:    http://127.0.0.1:$AdminPort/host"
  if ($pin) {
    Write-Host "PIN:          $pin" -ForegroundColor Green
  } else {
    Write-Host "PIN:          not configured" -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "Phone login uses the local PIN only. There is no username/password and no pairing code."

  if (!$NoOpen) {
    $encodedToken = [uri]::EscapeDataString($adminToken)
    Start-Process "http://127.0.0.1:$AdminPort/host#token=$encodedToken"
  }
}

try {
  Ensure-Env
  Ensure-SystemRequirements
  Ensure-Built
  $port = Get-Port
  $adminPort = Get-AdminPort
  if (Test-HostAlive $port) {
    Write-Host "Remote PC host is already answering on port $port."
  } else {
    $process = Start-HostProcess
    Write-Host "Waiting for local host" -NoNewline
    for ($i = 0; $i -lt 20; $i++) {
      if (Test-HostAlive $port) {
        break
      }
      if ($process.HasExited) {
        throw "The host process exited early. Check logs\host.log."
      }
      Write-Host "." -NoNewline
      Start-Sleep -Seconds 1
    }
    Write-Host ""
    if (!(Test-HostAlive $port)) {
      throw "The host did not start within 20 seconds. Check logs\host.log."
    }
  }

  Show-Status $port $adminPort

  Write-Step "Running"
  Write-Host "You can close this window; the host keeps running in the background."
  Write-Host "Use Stop-RemotePC.cmd to stop it."
} catch {
  Write-Host ""
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
