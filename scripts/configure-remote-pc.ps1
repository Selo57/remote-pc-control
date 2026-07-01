param(
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $Root ".env"
$ExampleEnvPath = Join-Path $Root ".env.example"

Set-Location $Root

function Write-Step($Message) {
  if (!$Quiet) {
    Write-Host ""
    Write-Host "== $Message" -ForegroundColor Cyan
  }
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

function Read-Value($Prompt, $Default = "") {
  if ($Default) {
    $value = Read-Host "$Prompt [$Default]"
    if (!$value) {
      return $Default
    }
    return $value.Trim()
  }
  return (Read-Host $Prompt).Trim()
}

function Get-Default($Value, $Fallback) {
  if ($null -ne $Value -and "$Value" -ne "") {
    return "$Value"
  }
  return "$Fallback"
}

function Read-Choice($Prompt, $Default, $Allowed) {
  for (;;) {
    $value = Read-Value $Prompt $Default
    if ($Allowed -contains $value.ToLowerInvariant()) {
      return $value.ToLowerInvariant()
    }
    Write-Host "Choose one of: $($Allowed -join ', ')." -ForegroundColor Yellow
  }
}

function Read-YesNo($Prompt, $DefaultYes = $true) {
  $default = if ($DefaultYes) { "Y" } else { "N" }
  $value = Read-Value "$Prompt (y/n)" $default
  return $value -match "^(y|yes)$"
}

function Read-Number($Prompt, $Default, $Min, $Max) {
  for (;;) {
    $raw = Read-Value $Prompt $Default
    $number = 0
    if ([int]::TryParse($raw, [ref]$number) -and $number -ge $Min -and $number -le $Max) {
      return $number
    }
    Write-Host "Enter a number from $Min to $Max." -ForegroundColor Yellow
  }
}

function Ensure-EnvFile {
  if (!(Test-Path $EnvPath)) {
    Copy-Item $ExampleEnvPath $EnvPath
  }
}

try {
  Write-Step "Remote PC setup"
  Write-Host "This writes local settings to .env. Do not commit .env to GitHub."

  Ensure-EnvFile
  $envValues = Read-EnvFile

  if (!$envValues["REMOTE_PC_SECRET"] -or $envValues["REMOTE_PC_SECRET"] -like "replace-with-*") {
    Set-EnvValue "REMOTE_PC_SECRET" (Get-RandomSecret)
  }

  $currentPin = $envValues["REMOTE_PC_PIN"]
  if (!$currentPin -or $currentPin -notmatch "^\d{8,12}$") {
    $currentPin = Get-RandomPin
  }
  for (;;) {
    $pin = Read-Value "Control PIN, 8-12 digits" $currentPin
    if ($pin -match "^\d{8,12}$") {
      Set-EnvValue "REMOTE_PC_PIN" $pin
      break
    }
    Write-Host "Use 8 to 12 digits." -ForegroundColor Yellow
  }

  Set-EnvValue "REMOTE_PC_HOST" "127.0.0.1"
  $publicPort = Read-Number "Public application port" (Get-Default $envValues["REMOTE_PC_PORT"] "8787") 1024 65535
  Set-EnvValue "REMOTE_PC_PORT" $publicPort
  for (;;) {
    $adminPort = Read-Number "Local administration port" (Get-Default $envValues["REMOTE_PC_ADMIN_PORT"] "8788") 1024 65535
    if ($adminPort -ne $publicPort) {
      Set-EnvValue "REMOTE_PC_ADMIN_PORT" $adminPort
      break
    }
    Write-Host "The administration port must differ from the public port." -ForegroundColor Yellow
  }
  $requireApproval = Read-YesNo "Require local approval for new devices" ((Get-Default $envValues["REMOTE_PC_REQUIRE_LOCAL_APPROVAL"] "true") -ne "false")
  Set-EnvValue "REMOTE_PC_REQUIRE_LOCAL_APPROVAL" ($requireApproval.ToString().ToLowerInvariant())

  $useCloudflare = Read-YesNo "Enable Cloudflare remote access" ((Get-Default $envValues["CLOUDFLARE_ENABLED"] "true") -ne "false")
  Set-EnvValue "CLOUDFLARE_ENABLED" ($useCloudflare.ToString().ToLowerInvariant())
  if ($useCloudflare) {
    $mode = Read-Choice "Cloudflare mode: quick or named" ((Get-Default $envValues["CLOUDFLARE_MODE"] "quick").ToLowerInvariant()) @("quick", "named")
    Set-EnvValue "CLOUDFLARE_MODE" $mode
    Set-EnvValue "CLOUDFLARED_PATH" (Read-Value "cloudflared command/path" (Get-Default $envValues["CLOUDFLARED_PATH"] "cloudflared"))
    if ($mode -eq "named") {
      Set-EnvValue "CLOUDFLARE_NAMED_TUNNEL_NAME" (Read-Value "Named tunnel name" (Get-Default $envValues["CLOUDFLARE_NAMED_TUNNEL_NAME"] ""))
      Set-EnvValue "CLOUDFLARE_NAMED_TUNNEL_CONFIG" (Read-Value "Named tunnel config path" (Get-Default $envValues["CLOUDFLARE_NAMED_TUNNEL_CONFIG"] ""))
      Set-EnvValue "CLOUDFLARE_FIXED_DOMAIN" (Read-Value "Fixed public domain" (Get-Default $envValues["CLOUDFLARE_FIXED_DOMAIN"] ""))
    }
  }

  $webhook = Read-Value "Discord webhook URL, blank to keep, 'none' to clear" ""
  if ($webhook -eq "none") {
    Set-EnvValue "DISCORD_WEBHOOK_URL" ""
  } elseif ($webhook) {
    if ($webhook -notmatch "^https://discord\.com/api/webhooks/") {
      Write-Host "That does not look like a Discord webhook URL; leaving the current value unchanged." -ForegroundColor Yellow
    } else {
      Set-EnvValue "DISCORD_WEBHOOK_URL" $webhook
    }
  }

  Set-EnvValue "FFMPEG_PATH" (Read-Value "FFmpeg command/path" (Get-Default $envValues["FFMPEG_PATH"] "ffmpeg"))
  Set-EnvValue "STREAM_CAPTURE_BACKEND" (Read-Choice "Capture backend: gdigrab or ddagrab" ((Get-Default $envValues["STREAM_CAPTURE_BACKEND"] "gdigrab").ToLowerInvariant()) @("gdigrab", "ddagrab"))
  Set-EnvValue "STREAM_WIDTH" (Read-Number "Stream width" (Get-Default $envValues["STREAM_WIDTH"] "1280") 640 3840)
  Set-EnvValue "STREAM_HEIGHT" (Read-Number "Stream height" (Get-Default $envValues["STREAM_HEIGHT"] "720") 360 2160)
  Set-EnvValue "STREAM_FPS" (Read-Number "Stream FPS" (Get-Default $envValues["STREAM_FPS"] "60") 15 60)
  Set-EnvValue "STREAM_PRESET" (Read-Choice "Stream preset: low-latency, balanced, high-quality" ((Get-Default $envValues["STREAM_PRESET"] "low-latency").ToLowerInvariant()) @("low-latency", "balanced", "high-quality"))
  Set-EnvValue "STREAM_STUN_URLS" (Read-Value "STUN URLs" (Get-Default $envValues["STREAM_STUN_URLS"] "stun:stun.l.google.com:19302"))
  Set-EnvValue "EMERGENCY_HOTKEY" (Read-Value "Emergency disable hotkey" (Get-Default $envValues["EMERGENCY_HOTKEY"] "CommandOrControl+Alt+Shift+F12"))

  Write-Step "Saved"
  Write-Host ".env updated."
  Write-Host "Run Start-RemotePC.cmd to start the host."
} catch {
  Write-Host ""
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
