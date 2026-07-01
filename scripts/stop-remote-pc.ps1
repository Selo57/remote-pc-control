$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PidPath = Join-Path $Root "data\remote-pc.pid"
$SupervisorPidPath = Join-Path $Root "data\remote-pc-watchdog.pid"
$StopFlagPath = Join-Path $Root "data\remote-pc-watchdog.stop"
$Port = 8787
$EnvPath = Join-Path $Root ".env"

if (Test-Path $EnvPath) {
  $portLine = Get-Content $EnvPath |
    Where-Object { $_ -match "^REMOTE_PC_PORT=" } |
    Select-Object -First 1
  if ($portLine) {
    $Port = [int](($portLine -split "=", 2)[1].Trim())
  }
}

New-Item -ItemType Directory -Path (Join-Path $Root "data") -Force | Out-Null

function Stop-ProcessFromPidFile($Path, $Name) {
  if (!(Test-Path $Path)) {
    return $false
  }
  $pidValue = Get-Content $Path | Select-Object -First 1
  if (!$pidValue) {
    Remove-Item $Path -Force -ErrorAction SilentlyContinue
    return $false
  }
  try {
    $process = Get-Process -Id ([int]$pidValue) -ErrorAction Stop
    if ($process.Id -ne $PID) {
      Stop-Process -Id $process.Id -Force
      Write-Host "Stopped $Name process $($process.Id)."
    }
    Remove-Item $Path -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    Remove-Item $Path -Force -ErrorAction SilentlyContinue
    Write-Host "$Name process was not running."
    return $false
  }
}

Set-Content -Path $StopFlagPath -Value "stop" -Encoding ASCII
Stop-ProcessFromPidFile $SupervisorPidPath "Remote PC watchdog" | Out-Null

if (!(Stop-ProcessFromPidFile $PidPath "Remote PC host")) {
  Write-Host "No Remote PC host PID file found. It may already be stopped."
}

try {
  $tunnels = Get-CimInstance Win32_Process -Filter "name = 'cloudflared.exe'" |
    Where-Object { $_.CommandLine -like "*tunnel*" -and $_.CommandLine -like "*127.0.0.1:$Port*" }
  foreach ($tunnel in $tunnels) {
    Stop-Process -Id $tunnel.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped Cloudflare tunnel process $($tunnel.ProcessId)."
  }
} catch {
  Write-Host "Could not inspect Cloudflare tunnel processes."
}

Remove-Item $StopFlagPath -Force -ErrorAction SilentlyContinue
