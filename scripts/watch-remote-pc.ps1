param(
  [int]$CheckSeconds = 10
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $Root ".env"
$PidPath = Join-Path $Root "data\remote-pc.pid"
$SupervisorPidPath = Join-Path $Root "data\remote-pc-watchdog.pid"
$StopFlagPath = Join-Path $Root "data\remote-pc-watchdog.stop"
$LogPath = Join-Path $Root "logs\supervisor.log"
$DefaultPort = 8787
$DefaultAdminPort = 8788

Set-Location $Root
New-Item -ItemType Directory -Path (Join-Path $Root "data") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Root "logs") -Force | Out-Null

function Write-Log($Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -Path $LogPath -Value $line -Encoding ASCII
  Write-Host $line
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
    return ""
  }
  return (Get-Content $tokenPath -Raw).Trim()
}

function Get-ProcessFromPidFile($Path) {
  if (!(Test-Path $Path)) {
    return $null
  }
  $pidValue = Get-Content $Path | Select-Object -First 1
  if (!$pidValue) {
    Remove-Item $Path -Force -ErrorAction SilentlyContinue
    return $null
  }
  try {
    return Get-Process -Id ([int]$pidValue) -ErrorAction Stop
  } catch {
    Remove-Item $Path -Force -ErrorAction SilentlyContinue
    return $null
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

function Get-HostStatus {
  $adminPort = Get-AdminPort
  $adminToken = Get-AdminToken
  if (!$adminToken) {
    return $null
  }
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$adminPort/api/host/status" -Headers @{ "x-remote-pc-admin-token" = $adminToken } -TimeoutSec 3
  } catch {
    return $null
  }
}

function Start-HostOnce {
  $script = Join-Path $PSScriptRoot "start-remote-pc.ps1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -NoOpen -NoDiscordStartReport
  if ($LASTEXITCODE -ne 0) {
    throw "start-remote-pc.ps1 exited with code $LASTEXITCODE"
  }
}

function Stop-StaleHost {
  $process = Get-ProcessFromPidFile $PidPath
  if ($process) {
    Write-Log "Stopping stale host process $($process.Id)."
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
}

function Stop-StaleTunnel($Port) {
  try {
    $tunnels = Get-CimInstance Win32_Process -Filter "name = 'cloudflared.exe'" |
      Where-Object { $_.CommandLine -like "*tunnel*" -and $_.CommandLine -like "*127.0.0.1:$Port*" }
    foreach ($tunnel in $tunnels) {
      Write-Log "Stopping stale Cloudflare tunnel process $($tunnel.ProcessId)."
      Stop-Process -Id $tunnel.ProcessId -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Log "Could not inspect stale Cloudflare tunnel processes."
  }
}

function Send-Discord($Content) {
  $envValues = Read-EnvFile
  $webhook = $envValues["DISCORD_WEBHOOK_URL"]
  if (!$webhook) {
    return
  }
  if ($Content -match "pairing|secret|token|password|pin|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.") {
    Write-Log "Blocked Discord watchdog message that looked sensitive."
    return
  }
  try {
    Invoke-RestMethod -Uri $webhook -Method Post -ContentType "application/json" -Body (@{ content = $Content } | ConvertTo-Json -Compress) -TimeoutSec 10 | Out-Null
    Write-Log "Discord watchdog notification sent."
  } catch {
    Write-Log "Discord watchdog notification failed."
  }
}

function Send-CurrentLinkReport($Reason) {
  $status = Get-HostStatus
  if ($status -and $status.cloudflareUrl) {
    $null = Send-Discord "Remote PC started a new link report: $($status.cloudflareUrl)"
    Write-Log "$Reason link report sent for $($status.cloudflareUrl)"
    return $true
  }
  Write-Log "$Reason link report skipped because no Cloudflare URL is available yet."
  return $false
}

function HostStartedRecently($Status) {
  if (!$Status -or !$Status.startedAt) {
    return $false
  }
  try {
    return ((Get-Date) - ([datetime]$Status.startedAt)).TotalSeconds -lt 90
  } catch {
    return $false
  }
}

$existingSupervisor = Get-ProcessFromPidFile $SupervisorPidPath
if ($existingSupervisor -and $existingSupervisor.Id -ne $PID) {
  $null = Send-CurrentLinkReport "Existing watchdog"
  Write-Host "Remote PC watchdog is already running as PID $($existingSupervisor.Id)."
  exit 0
}

Set-Content -Path $SupervisorPidPath -Value $PID -Encoding ASCII
Remove-Item $StopFlagPath -Force -ErrorAction SilentlyContinue

$restartFailures = 0
$needsAttentionSent = $false
$manualStartReportHandled = $false
$lastUrl = ""
$backoffSeconds = 5

Write-Log "Remote PC watchdog started."

try {
  while (!(Test-Path $StopFlagPath)) {
    $port = Get-Port
    if (Test-HostAlive $port) {
      $status = Get-HostStatus
      if ($status) {
        if ($status.cloudflareUrl -and $status.cloudflareUrl -ne $lastUrl) {
          $lastUrl = $status.cloudflareUrl
          Write-Log "Cloudflare URL is $lastUrl"
        }
        if (!$manualStartReportHandled -and $status.cloudflareUrl) {
          if (HostStartedRecently $status) {
            Write-Log "Manual start link report skipped because the host just started and will report its new link."
          } else {
            $null = Send-Discord "Remote PC started a new link report: $($status.cloudflareUrl)"
            Write-Log "Manual start link report sent for $($status.cloudflareUrl)"
          }
          $manualStartReportHandled = $true
        }
        if ($status.remoteAccess -eq "online") {
          $restartFailures = 0
          $needsAttentionSent = $false
          $backoffSeconds = 5
        }
      }
      Start-Sleep -Seconds $CheckSeconds
      continue
    }

    Write-Log "Host health check failed; restarting host."
    Stop-StaleHost
    Stop-StaleTunnel $port
    try {
      Start-HostOnce
      $restartFailures = 0
      $needsAttentionSent = $false
      $backoffSeconds = 5
    } catch {
      $restartFailures += 1
      Write-Log "Host restart failed: $($_.Exception.Message)"
      if ($restartFailures -ge 5 -and !$needsAttentionSent) {
        Send-Discord "Remote PC needs attention."
        $needsAttentionSent = $true
      }
      Write-Log "Retrying in $backoffSeconds seconds."
      Start-Sleep -Seconds $backoffSeconds
      $backoffSeconds = [Math]::Min($backoffSeconds * 2, 300)
    }
  }
} finally {
  Write-Log "Remote PC watchdog stopped."
  Remove-Item $SupervisorPidPath -Force -ErrorAction SilentlyContinue
  Remove-Item $StopFlagPath -Force -ErrorAction SilentlyContinue
}
