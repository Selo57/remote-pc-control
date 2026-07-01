param(
  [string]$Version = "local"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $Root "release"
$StageDir = Join-Path $ReleaseDir "remote-pc-control-$Version"
$ZipPath = Join-Path $ReleaseDir "remote-pc-control-$Version.zip"

Set-Location $Root

function Copy-Path($RelativePath) {
  $source = Join-Path $Root $RelativePath
  if (!(Test-Path $source)) {
    return
  }
  $destination = Join-Path $StageDir $RelativePath
  $parent = Split-Path -Parent $destination
  if ($parent) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

function Remove-IfExists($RelativePath) {
  $path = Join-Path $StageDir $RelativePath
  if (Test-Path $path) {
    Remove-Item -LiteralPath $path -Recurse -Force
  }
}

New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null
if (Test-Path $StageDir) {
  Remove-Item -LiteralPath $StageDir -Recurse -Force
}
if (Test-Path $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null

$paths = @(
  ".github",
  "docs",
  "native",
  "scripts",
  "src",
  "tests",
  ".editorconfig",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
  ".prettierrc.json",
  "CHANGELOG.md",
  "Configure-RemotePC.cmd",
  "CONTRIBUTING.md",
  "Create-ReleaseZip.cmd",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "Start-RemotePC.cmd",
  "Stop-RemotePC.cmd",
  "config.example.json",
  "docker-compose.yml",
  "eslint.config.js",
  "index.html",
  "package-lock.json",
  "package.json",
  "postcss.config.js",
  "tailwind.config.ts",
  "tsconfig.electron.json",
  "tsconfig.host.json",
  "tsconfig.json",
  "tsconfig.test.json",
  "vite.config.ts"
)

foreach ($path in $paths) {
  Copy-Path $path
}

if (Test-Path (Join-Path $Root "dist")) {
  Copy-Path "dist"
}

Remove-IfExists ".env"
Remove-IfExists "data"
Remove-IfExists "logs"
Remove-IfExists "node_modules"
Remove-IfExists "native\RemotePc.InputHost\obj"
Remove-IfExists "native\RemotePc.InputHost\bin"

$forbiddenFiles = Get-ChildItem $StageDir -Recurse -File | Where-Object {
  $_.Name -eq ".env" -or
  $_.Extension -in @(".exe", ".dll", ".pdb") -or
  $_.FullName -match "\\(data|logs|node_modules|bin|obj)\\"
}
if ($forbiddenFiles) {
  $names = ($forbiddenFiles | ForEach-Object { $_.FullName.Substring($StageDir.Length + 1) }) -join ", "
  throw "Release staging contains forbidden runtime or binary files: $names"
}

$secretPatterns = @(
  "https://(discord\.com|discordapp\.com)/api/webhooks/",
  "https://[a-zA-Z0-9-]+\.trycloudflare\.com"
)
$textFiles = Get-ChildItem $StageDir -Recurse -File | Where-Object {
  $_.Extension -in @(".cmd", ".cs", ".css", ".html", ".js", ".json", ".md", ".mmd", ".ps1", ".ts", ".tsx", ".yml")
}
foreach ($pattern in $secretPatterns) {
  $matches = $textFiles | Select-String -Pattern $pattern -ErrorAction SilentlyContinue
  if ($matches) {
    throw "Release staging contains a secret-like URL in $($matches[0].Path)."
  }
}

Compress-Archive -Path (Join-Path $StageDir "*") -DestinationPath $ZipPath -Force
Write-Host "Created $ZipPath" -ForegroundColor Green
