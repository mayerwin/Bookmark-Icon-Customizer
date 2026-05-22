# Package the extension for Chrome Web Store upload.
# Reads the version from manifest.json and writes:
#   dist\bookmark-icon-customizer-v<version>.zip
# Only runtime files are included (no node_modules, docs, scratch, dev
# scripts, .git, etc.). Re-run any time after editing sources or bumping
# the version in manifest.json — the matching-version zip is overwritten;
# older-version zips in dist\ are left in place as archive copies.

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$manifest = Get-Content 'manifest.json' -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { throw 'No version field in manifest.json' }

# Allowlist of runtime files/dirs. Anything not listed here (node_modules,
# docs, scratch, dist, .git, .gitignore, README, PRIVACY, PROMOTION_POSTS,
# generate_icons.js, resize_icons.js, package.json, package-lock.json,
# package.bat, package.ps1, .claude) is excluded from the zip.
$items = @(
  'manifest.json',
  'background.js',
  'content_script.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'launcher.html',
  'launcher.js',
  'sandbox.html',
  'icons',
  'lib'
)

foreach ($i in $items) {
  if (-not (Test-Path -LiteralPath $i)) { throw "Missing required file: $i" }
}

if (-not (Test-Path 'dist')) { New-Item -ItemType Directory -Path 'dist' | Out-Null }
$output = Join-Path 'dist' "bookmark-icon-customizer-v$version.zip"
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }

# Stage to a temp dir before zipping. Compress-Archive opens source files
# with exclusive read locks, which transiently conflicts with Dropbox sync,
# antivirus scans, and IDEs that hold manifest.json open — copying first
# breaks the contention so packaging always succeeds.
$staging = Join-Path $env:TEMP "bic-pkg-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $staging | Out-Null

try {
  Write-Host "Packaging v$version..."
  foreach ($i in $items) {
    Copy-Item -LiteralPath $i -Destination $staging -Recurse -Force
  }
  $stagedItems = Get-ChildItem -LiteralPath $staging | ForEach-Object { $_.FullName }
  Compress-Archive -Path $stagedItems -DestinationPath $output -Force
  $sizeKB = [math]::Round((Get-Item -LiteralPath $output).Length / 1KB, 1)
  Write-Host "Done: $output ($sizeKB KB)"
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
