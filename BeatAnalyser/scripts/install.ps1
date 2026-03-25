#Requires -Version 5.1
<#
.SYNOPSIS
    Beat Analyser CEP extension — Windows dev-install script.

.DESCRIPTION
    1. Enables unsigned CEP extensions via the PlayerDebugMode registry key.
    2. Creates a symlink from the Premiere Pro extensions directory to this repo's
       BeatAnalyser folder so edits are reflected without re-copying.
    3. Downloads aubio.js and essentia.js WASM bundles into lib/ if absent.

.PARAMETER Copy
    Copy the folder instead of creating a symlink (useful on FAT/exFAT drives or
    when symlinks are unavailable without elevated privileges).

.PARAMETER SkipWasm
    Skip the WASM download step.

.EXAMPLE
    .\scripts\install.ps1
    .\scripts\install.ps1 -Copy
    .\scripts\install.ps1 -SkipWasm
#>
[CmdletBinding()]
param(
    [switch]$Copy,
    [switch]$SkipWasm
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Step  { param($msg) Write-Host "  → $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "  ✗ $msg" -ForegroundColor Red }

function Confirm-Elevated {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = [System.Security.Principal.WindowsPrincipal] $id
    return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ── Paths ─────────────────────────────────────────────────────────────────────

$repoRoot      = Split-Path -Parent $PSScriptRoot          # …/BeatAnalyser
$extensionsDir = "$env:APPDATA\Adobe\CEP\extensions"
$linkTarget    = Join-Path $extensionsDir "BeatAnalyser"
$libDir        = Join-Path $repoRoot "lib"

# ── Banner ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Beat Analyser — CEP Dev Install (Windows)" -ForegroundColor White
Write-Host "  ─────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# ── Step 1: PlayerDebugMode registry key ─────────────────────────────────────

Write-Step "Setting PlayerDebugMode for CSXS 11 …"

$regPath = "HKCU:\Software\Adobe\CSXS.11"

try {
    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }
    Set-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value "1" -Type String
    Write-Ok "HKCU\Software\Adobe\CSXS.11 → PlayerDebugMode = 1"
} catch {
    Write-Fail "Could not write registry key: $_"
    Write-Warn "You may need to run this script as Administrator, or set the key manually."
    Write-Warn "See SETUP.md §2 for instructions."
}

# Also set for CSXS.10 and CSXS.9 as fallback for older Premiere installs
foreach ($ver in @("CSXS.10", "CSXS.9")) {
    $p = "HKCU:\Software\Adobe\$ver"
    if (Test-Path $p) {
        try {
            Set-ItemProperty -Path $p -Name "PlayerDebugMode" -Value "1" -Type String
            Write-Ok "  Also set for $ver (detected)"
        } catch { }
    }
}

# ── Step 2: Symlink / copy to extensions directory ────────────────────────────

Write-Step "Creating extension link in CEP extensions directory …"

if (-not (Test-Path $extensionsDir)) {
    New-Item -ItemType Directory -Path $extensionsDir -Force | Out-Null
    Write-Ok "Created $extensionsDir"
}

if (Test-Path $linkTarget) {
    $existing = Get-Item $linkTarget -Force
    if ($existing.LinkType -eq "SymbolicLink") {
        Write-Warn "Symlink already exists at $linkTarget — removing and recreating."
        Remove-Item $linkTarget -Force -Recurse
    } elseif ($existing.PSIsContainer) {
        Write-Warn "A folder already exists at $linkTarget."
        $answer = Read-Host "    Remove it and proceed? [y/N]"
        if ($answer -notmatch '^[Yy]') {
            Write-Fail "Aborted. Remove $linkTarget manually, then re-run."
            exit 1
        }
        Remove-Item $linkTarget -Force -Recurse
    }
}

if ($Copy) {
    Write-Step "Copying folder (–Copy flag set) …"
    Copy-Item -Path $repoRoot -Destination $linkTarget -Recurse -Force
    Write-Ok "Copied → $linkTarget"
    Write-Warn "Remember: edits in the repo are NOT reflected automatically. Re-run with -Copy to refresh."
} else {
    # Symlinks on Windows require either Developer Mode or elevated privileges.
    $isAdmin = Confirm-Elevated
    if (-not $isAdmin) {
        Write-Warn "Creating a symlink may require Developer Mode or Admin rights."
        Write-Warn "If the next step fails, re-run as Administrator or use: .\install.ps1 -Copy"
    }
    try {
        New-Item -ItemType SymbolicLink -Path $linkTarget -Target $repoRoot | Out-Null
        Write-Ok "Symlink created: $linkTarget → $repoRoot"
    } catch {
        Write-Fail "Symlink failed: $_"
        Write-Warn "Falling back to folder copy …"
        Copy-Item -Path $repoRoot -Destination $linkTarget -Recurse -Force
        Write-Ok "Copied (fallback) → $linkTarget"
    }
}

# ── Step 3: Download WASM bundles ─────────────────────────────────────────────

if (-not $SkipWasm) {
    Write-Step "Downloading WASM bundles into lib/ …"

    if (-not (Test-Path $libDir)) {
        New-Item -ItemType Directory -Path $libDir -Force | Out-Null
    }

    $bundles = @(
        @{
            Name   = "aubio.js"
            Url    = "https://cdn.jsdelivr.net/npm/aubiojs@0.1.3/build/aubio.js"
            Dest   = Join-Path $libDir "aubio.js"
        },
        @{
            Name   = "essentia.js"
            Url    = "https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.umd.js"
            Dest   = Join-Path $libDir "essentia.js"
        }
    )

    foreach ($bundle in $bundles) {
        $dest = $bundle.Dest
        if (Test-Path $dest) {
            $size = (Get-Item $dest).Length
            if ($size -gt 10240) {
                Write-Ok "$($bundle.Name) already present ($([math]::Round($size/1KB)) KB) — skipping."
                continue
            }
        }
        Write-Step "  Downloading $($bundle.Name) …"
        try {
            Invoke-WebRequest -Uri $bundle.Url -OutFile $dest -UseBasicParsing
            $size = (Get-Item $dest).Length
            Write-Ok "$($bundle.Name) → lib/ ($([math]::Round($size/1KB)) KB)"
        } catch {
            Write-Fail "Failed to download $($bundle.Name): $_"
            Write-Warn "Download manually from: $($bundle.Url)"
        }
    }
}

# ── Done ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ─────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  Setup complete. Next steps:" -ForegroundColor White
Write-Host "    1. Restart Adobe Premiere Pro." -ForegroundColor Gray
Write-Host "    2. Window → Extensions → Beat Analyser." -ForegroundColor Gray
Write-Host "    3. Open DevTools: right-click panel → Inspect (if CEF debug port is open)." -ForegroundColor Gray
Write-Host ""
