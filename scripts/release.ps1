<#
.SYNOPSIS
    Build, verify, and publish a Neato Rewind release.

.DESCRIPTION
    One command to take the working tree to a shipped release:

      1. Verify the security gate (no bundled API key in the artifacts)
      2. Build the Python sidecar, then the Tauri installers
      3. Upload to the public GCS bucket under BOTH a versioned name
         (archival) and the stable "latest" name the website serves
      4. Publish a GitHub release with the same artifacts

    The website never needs touching again. DOWNLOAD_WINDOWS_URL on
    Vercel points at the stable object, which this script overwrites on
    every release. Content-Disposition is set so the user still
    downloads a version-stamped filename even though the URL is fixed.

    Historically (builds 7-12) each release was uploaded under a fresh
    object name and the Vercel env var was edited by hand. That is what
    let the site serve a Jul 23 build for weeks after newer ones
    existed. The stable-name + no-cache approach removes that step, and
    with it that failure mode.

.PARAMETER Version
    Version to publish, e.g. "0.1.1". Must already be set in
    tauri.conf.json, frontend/package.json, and src-tauri/Cargo.toml -
    the script verifies all three agree and refuses to continue if not.

.PARAMETER Notes
    Release notes body for the GitHub release.

.PARAMETER SkipBuild
    Reuse artifacts already in target/release/bundle. Use only when you
    just built and are re-running the publish half.

.PARAMETER DryRun
    Do everything except the two irreversible steps (GCS upload and
    GitHub release). Prints exactly what would be uploaded where.

.EXAMPLE
    pwsh scripts/release.ps1 -Version 0.1.1 -Notes "Ask date-scoping, resizable sidebar"

.EXAMPLE
    pwsh scripts/release.ps1 -Version 0.1.1 -DryRun
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Notes = "",
    [switch]$SkipBuild,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$Frontend   = Join-Path $RepoRoot "frontend"
$Backend    = Join-Path $RepoRoot "backend"
$BundleDir  = Join-Path $Frontend "src-tauri\target\release\bundle"
$Bucket     = "gs://neato-rewind-downloads"
$StableName = "NeatoRewind-Setup-latest-x64.exe"

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Die($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red; exit 1 }

# Run a native exe and judge it by its EXIT CODE, not by whether it
# wrote to stderr.
#
# Windows PowerShell 5.1 wraps every stderr line from a native command
# in an ErrorRecord. Under $ErrorActionPreference = 'Stop' that makes
# ordinary progress output fatal -- gcloud prints "Copying file://..."
# to stderr and the script dies mid-upload despite exiting 0.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$What,
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$AllowFailure
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0 -and -not $AllowFailure) { Die "$What failed (exit $code)" }
    return $code
}

# --- 1. Version consistency -------------------------------------------
Step "Verifying version $Version across manifests"

$tauriConf = Get-Content (Join-Path $Frontend "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$pkgJson   = Get-Content (Join-Path $Frontend "package.json") -Raw | ConvertFrom-Json
$cargoVer  = (Select-String -Path (Join-Path $Frontend "src-tauri\Cargo.toml") `
                -Pattern '^version\s*=\s*"(.+)"').Matches[0].Groups[1].Value

$mismatch = @()
if ($tauriConf.version -ne $Version) { $mismatch += "tauri.conf.json = $($tauriConf.version)" }
if ($pkgJson.version   -ne $Version) { $mismatch += "package.json = $($pkgJson.version)" }
if ($cargoVer          -ne $Version) { $mismatch += "Cargo.toml = $cargoVer" }
if ($mismatch.Count -gt 0) {
    Die "version mismatch (expected $Version): $($mismatch -join '; ')"
}
Ok "all three manifests agree on $Version"

# --- 2. Cloud-mode preconditions --------------------------------------
Step "Checking cloud-mode build preconditions"

$envProd = Join-Path $Frontend ".env.production"
if (-not (Test-Path $envProd)) { Die ".env.production missing (needs NEXT_PUBLIC_AI_MODE=cloud)" }
if (-not (Select-String -Path $envProd -Pattern "NEXT_PUBLIC_AI_MODE=cloud" -Quiet)) {
    Die ".env.production does not set NEXT_PUBLIC_AI_MODE=cloud"
}
Ok "cloud mode configured"

# keys.py must have an EMPTY bundled key - a real key here would ship
# to every user inside the installer.
$keysPy = Join-Path $Backend "app\keys.py"
if (Test-Path $keysPy) {
    $keyLine = Select-String -Path $keysPy -Pattern '^BUNDLED_GEMINI_KEY\s*=\s*(.*)$'
    if ($keyLine) {
        $val = $keyLine.Matches[0].Groups[1].Value.Trim()
        if ($val -ne '""' -and $val -ne "''") {
            Die "BUNDLED_GEMINI_KEY is not empty in keys.py - blank it before building a distributable"
        }
    }
}
Ok "BUNDLED_GEMINI_KEY is empty"

# --- 3. Build ----------------------------------------------------------
if (-not $SkipBuild) {
    Step "Building Python sidecar"
    Push-Location $Backend
    try {
        python build_sidecar.py
        if ($LASTEXITCODE -ne 0) { Die "sidecar build failed" }
    } finally { Pop-Location }
    Ok "sidecar rebuilt and staged"

    Step "Building Tauri installers"
    Push-Location $Frontend
    try {
        npm run tauri build
        if ($LASTEXITCODE -ne 0) { Die "tauri build failed" }
    } finally { Pop-Location }
    Ok "installers built"
} else {
    Step "Skipping build (-SkipBuild)"
}

# --- 4. Security gate --------------------------------------------------
# Per docs/ops/cloud-mode-build.md: no Gemini key may appear in any
# shipped artifact. Runs AFTER the build so it inspects what actually
# ships, not what we intended to ship.
Step "Security gate: scanning artifacts for embedded API keys"
# findstr, not Select-String: these are multi-MB binaries and findstr
# handles binary content reliably, where Select-String's text decoding
# can miss a match. /M lists filenames only, /S recurses.
$leaks = & findstr /S /M /C:"AIza" (Join-Path $BundleDir "*") 2>$null
if ($LASTEXITCODE -eq 0 -and $leaks) {
    $leaks | ForEach-Object { Write-Host "    LEAK: $_" -ForegroundColor Red }
    Die "API key found in build artifacts - DO NOT DISTRIBUTE"
}
Ok "no API keys in artifacts"

# --- 5. Locate artifacts ----------------------------------------------
Step "Locating artifacts"
$setupExe = Get-ChildItem -Path (Join-Path $BundleDir "nsis") -Filter "*$Version*setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$msi      = Get-ChildItem -Path (Join-Path $BundleDir "msi")  -Filter "*$Version*.msi"      -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setupExe) { Die "no NSIS installer matching version $Version in $BundleDir\nsis" }
Ok "setup.exe: $($setupExe.Name) ($([math]::Round($setupExe.Length/1MB,1)) MB)"
if ($msi) { Ok "msi:       $($msi.Name) ($([math]::Round($msi.Length/1MB,1)) MB)" }

$versionedName = "NeatoRewind-Setup-$Version-x64.exe"

if ($DryRun) {
    Step "DRY RUN - no upload, no release"
    Write-Host "  would upload -> $Bucket/$versionedName  (archival)"
    Write-Host "  would upload -> $Bucket/$StableName      (served by website)"
    $assetList = $setupExe.Name
    if ($msi) { $assetList += " + " + $msi.Name }
    Write-Host "  would create -> GitHub release v$Version with $assetList"
    exit 0
}

# --- 6. Upload to GCS --------------------------------------------------
Step "Uploading to $Bucket"

# Versioned copy: immutable archive, safe to cache forever.
Invoke-Native -What "versioned upload" -Exe "gcloud" -Arguments @(
    "storage", "cp", $setupExe.FullName, "$Bucket/$versionedName",
    "--cache-control=public, max-age=31536000, immutable"
) | Out-Null
Ok "uploaded $versionedName (archival)"

# Stable copy: this is the object the website serves. no-cache so a new
# release is picked up immediately instead of sitting behind a CDN or
# browser cache. Content-Disposition makes the browser save it under a
# version-stamped filename even though the URL is fixed, so users can
# tell builds apart in their Downloads folder.
# Built as a variable rather than inline: escaping nested quotes inside
# an unquoted argument token is a parser trap in PowerShell.
$disposition = '--content-disposition=attachment; filename="' + $versionedName + '"'
Invoke-Native -What "stable upload" -Exe "gcloud" -Arguments @(
    "storage", "cp", $setupExe.FullName, "$Bucket/$StableName",
    "--cache-control=no-cache, max-age=0",
    $disposition
) | Out-Null
Ok "uploaded $StableName (live download)"

$stableUrl = "https://storage.googleapis.com/neato-rewind-downloads/$StableName"

# --- 7. Verify what users will actually get ---------------------------
Step "Verifying live download"
try {
    $head = Invoke-WebRequest -Uri $stableUrl -Method Head -UseBasicParsing -TimeoutSec 30
    $liveLen = [int64]$head.Headers['Content-Length']
    if ($liveLen -ne $setupExe.Length) {
        Die "live size $liveLen != local size $($setupExe.Length) - upload did not take"
    }
    Ok "live URL serves $([math]::Round($liveLen/1MB,1)) MB, matches local build"
    Ok $stableUrl
} catch {
    Write-Host "  [warn] could not verify live URL: $_" -ForegroundColor Yellow
}

# --- 8. GitHub release -------------------------------------------------
Step "Publishing GitHub release v$Version"
$assets = @($setupExe.FullName)
if ($msi) { $assets += $msi.FullName }

# gh writes progress to stderr too, so it goes through Invoke-Native
# for the same reason gcloud does.
$exists = Invoke-Native -What "release lookup" -Exe "gh" -AllowFailure -Arguments @(
    "release", "view", "v$Version", "--repo", "markhiltonapps/rewind"
)
if ($exists -eq 0) {
    Write-Host "  release v$Version exists - uploading assets with --clobber"
    Invoke-Native -What "asset upload" -Exe "gh" -Arguments (
        @("release", "upload", "v$Version") + $assets +
        @("--clobber", "--repo", "markhiltonapps/rewind")
    ) | Out-Null
} else {
    $body = if ($Notes) { $Notes } else { "Neato Rewind $Version" }
    # Notes go via a temp file: multi-line text through a native
    # command line gets mangled by the shell.
    $notesFile = Join-Path ([System.IO.Path]::GetTempPath()) "rewind-notes-$Version.md"
    [System.IO.File]::WriteAllText($notesFile, $body)
    Invoke-Native -What "release create" -Exe "gh" -Arguments (
        @("release", "create", "v$Version") + $assets +
        @("--repo", "markhiltonapps/rewind",
          "--title", "Neato Rewind $Version",
          "--notes-file", $notesFile)
    ) | Out-Null
    Remove-Item $notesFile -ErrorAction SilentlyContinue
}
Ok "GitHub release published"

Step "Done"
Write-Host "  Website download URL (unchanged, always latest):" -ForegroundColor Green
Write-Host "    $stableUrl"
Write-Host "  Archival copy:" -ForegroundColor Green
Write-Host "    https://storage.googleapis.com/neato-rewind-downloads/$versionedName"
