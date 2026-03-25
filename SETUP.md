# Beat Analyser — Setup Guide

This guide covers everything needed to install Beat Analyser as a development
extension in Adobe Premiere Pro: enabling unsigned extensions, linking the
project folder into CEP's extensions directory, downloading the WASM audio
libraries, and packaging a signed ZXP for distribution.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Enable unsigned extensions (PlayerDebugMode)](#2-enable-unsigned-extensions)
3. [Quick start — automated install](#3-quick-start)
4. [Manual install](#4-manual-install)
5. [Download WASM bundles](#5-download-wasm-bundles)
6. [Open Chrome DevTools for the panel](#6-devtools)
7. [npm scripts reference](#7-npm-scripts)
8. [Building a distributable (dist/)](#8-build)
9. [Signing a ZXP for deployment](#9-zxp-signing)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites

| Requirement | Version |
|---|---|
| Adobe Premiere Pro | 2021 (v15.0) or later |
| Node.js | 16 or later (`node --version`) |
| npm | 7 or later (bundled with Node 16+) |
| OS | Windows 10/11 · macOS 11+ |

Clone (or download) this repository and `cd` into `BeatAnalyser/`:

```sh
git clone https://github.com/your-org/music-analyser-premiere-pro.git
cd music-analyser-premiere-pro/BeatAnalyser
npm install          # installs dev deps + copies WASM bundles into lib/
```

---

## 2. Enable unsigned extensions

Adobe CEP blocks extensions that are not signed with a commercial certificate
unless **PlayerDebugMode** is explicitly enabled for your user account.

> **This must be set once per machine.** It survives Premiere updates.

### Windows — Registry key

Open **Registry Editor** (`regedit`) or run from an elevated command prompt:

```cmd
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f
```

If you also have older Premiere versions installed, set the same key for their
corresponding CSXS versions:

```cmd
reg add "HKCU\Software\Adobe\CSXS.10" /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add "HKCU\Software\Adobe\CSXS.9"  /v PlayerDebugMode /t REG_SZ /d 1 /f
```

### macOS — defaults plist

```sh
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.10 PlayerDebugMode 1   # if needed
defaults write com.adobe.CSXS.9  PlayerDebugMode 1   # if needed
killall cfprefsd    # flush preference cache
```

> **Why CSXS.11?** This extension targets CEP 11 (`manifest.xml` declares
> `RequiredRuntime Version="11.0"`). CSXS version = CEP version. If Premiere
> reports that no extensions are installed, double-check the version number.

---

## 3. Quick start — automated install

The install scripts handle all three steps (PlayerDebugMode, symlink, WASM
download) in one command.

### macOS / Linux

```sh
# From the BeatAnalyser/ directory:
bash scripts/install.sh

# Or, if you prefer a full copy instead of a symlink:
bash scripts/install.sh --copy

# Skip WASM download (if already in lib/):
bash scripts/install.sh --skip-wasm
```

Make the script executable if needed:

```sh
chmod +x scripts/install.sh
```

### Windows (PowerShell)

Open **PowerShell** (not cmd) and run:

```powershell
# From the BeatAnalyser\ directory:
.\scripts\install.ps1

# Copy instead of symlink (avoids needing Developer Mode):
.\scripts\install.ps1 -Copy

# Skip WASM download:
.\scripts\install.ps1 -SkipWasm
```

If you see `"execution of scripts is disabled"`, run PowerShell as Administrator
and allow scripts for the current session:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\install.ps1
```

---

## 4. Manual install

If you prefer to do the steps yourself, or the scripts are blocked by IT policy:

### 4a. Create the extensions directory (if absent)

**Windows:**
```
%APPDATA%\Adobe\CEP\extensions\
```

**macOS:**
```
~/Library/Application Support/Adobe/CEP/extensions/
```

### 4b. Create a symlink or copy the folder

**Windows (PowerShell — requires Developer Mode or Admin):**
```powershell
$src  = "C:\path\to\music-analyser-premiere-pro\BeatAnalyser"
$dest = "$env:APPDATA\Adobe\CEP\extensions\BeatAnalyser"
New-Item -ItemType SymbolicLink -Path $dest -Target $src
```

**macOS / Linux:**
```sh
ln -s /path/to/music-analyser-premiere-pro/BeatAnalyser \
      ~/Library/Application\ Support/Adobe/CEP/extensions/BeatAnalyser
```

> Using a **symlink** means any edits inside the repo are immediately live —
> you only need to reload the panel, not re-copy. Use a plain copy only when
> symlinks are unavailable (e.g. on a FAT drive or restricted CI machine).

### 4c. Verify the directory structure

After linking, the extensions directory should look like:

```
CEP/
└── extensions/
    └── BeatAnalyser/          ← symlink or copy
        ├── CSXS/
        │   └── manifest.xml
        ├── css/
        ├── js/
        ├── jsx/
        ├── lib/
        │   ├── aubio.js
        │   └── essentia.js
        └── index.html
```

---

## 5. Download WASM bundles

`aubio.js` and `essentia.js` are large binary bundles that are not committed to
the repository. They are fetched automatically by `npm install` (via the
`postinstall` script). To re-download manually:

```sh
npm run download-wasm           # pulls from jsDelivr CDN
npm run download-wasm -- --force  # re-download even if files exist
```

The files are saved to `lib/`:

| File | Source | Size (approx.) |
|---|---|---|
| `lib/aubio.js` | `aubiojs@0.1.3/build/aubio.js` | ~450 KB |
| `lib/essentia.js` | `essentia.js@0.1.3/dist/essentia-wasm.umd.js` | ~6 MB |

If jsDelivr is blocked in your environment, download from unpkg as a fallback:

```sh
curl -fsSL https://unpkg.com/aubiojs@0.1.3/build/aubio.js         -o lib/aubio.js
curl -fsSL https://unpkg.com/essentia.js@0.1.3/dist/essentia-wasm.umd.js -o lib/essentia.js
```

---

## 6. DevTools

The `.debug` file in the extension root configures remote debugging on port
**8789**. To open Chrome DevTools for the Beat Analyser panel:

1. Ensure PlayerDebugMode is enabled (§2).
2. Launch Premiere Pro and open: **Window → Extensions → Beat Analyser**.
3. Open **Chrome** or **Edge** and navigate to:
   ```
   http://localhost:8789
   ```
4. Click **"Beat Analyser"** in the inspectable targets list.

> You can also right-click anywhere inside the panel and choose
> **"Inspect Element"** if that option appears in the context menu (depends on
> Premiere version and CEF build).

To change the debug port, edit `.debug` and update the `Port` attribute.

---

## 7. npm scripts reference

Run from the `BeatAnalyser/` directory.

| Script | Command | What it does |
|---|---|---|
| `postinstall` | *(auto)* | Copies WASM from `node_modules` → `lib/` after `npm install` |
| `download-wasm` | `npm run download-wasm` | Downloads/refreshes WASM bundles from CDN |
| `dev` | `npm run dev` | Downloads WASM, runs platform install script, then watches `js/`, `css/`, `jsx/` for changes |
| `build` | `npm run build` | Copies extension to `dist/BeatAnalyser/` |
| `build:clean` | `npm run build:clean` | Removes `dist/` first, then builds |
| `package` | `npm run package` | Builds dist then signs as a ZXP (requires ZXPSignCmd) |
| `lint` | `npm run lint` | ESLint on `js/**/*.js` |

### Typical development flow

```sh
npm install       # first time only
npm run dev       # installs extension + watches for changes
```

After saving a file, reload the panel in Premiere Pro:
- **Windows:** focus the panel, press `Ctrl+Shift+F5`
- **macOS:** focus the panel, press `Cmd+Shift+F5`
- Or close and reopen: **Window → Extensions → Beat Analyser**

---

## 8. Build

`npm run build` copies the extension source to `dist/BeatAnalyser/`, excluding
`node_modules/`, `scripts/`, `.git/`, source maps, and temp files.

```
dist/
└── BeatAnalyser/
    ├── CSXS/manifest.xml
    ├── css/
    ├── js/
    ├── jsx/
    ├── lib/            ← aubio.js + essentia.js included
    └── index.html
```

You can then:
- Zip `dist/BeatAnalyser/` and share it (unsigned, requires PlayerDebugMode on
  the target machine).
- Sign it as a ZXP for distribution without requiring PlayerDebugMode (§9).

---

## 9. ZXP signing

ZXP is the Adobe-signed ZIP format for CEP extensions. Signed extensions work
without PlayerDebugMode and can be distributed via Adobe Exchange.

### 9a. Install ZXPSignCmd

Download the **Adobe ZXP Sign Command** tool from the CEP resources repository:

```
https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD
```

Place the binary on your `PATH` or set `ZXPSIGNCMD_PATH`:

```sh
export ZXPSIGNCMD_PATH=/usr/local/bin/ZXPSignCmd
```

### 9b. Create a self-signed certificate (development)

```sh
ZXPSignCmd -selfSignedCert US CA "Beat Analyser Dev" beatanalyser \
           <password> beat-analyser.p12
```

> Self-signed certs will show a warning in Premiere. For public distribution,
> obtain a commercial code-signing certificate from DigiCert or GlobalSign.

### 9c. Sign and package

```sh
CERT_PATH=./beat-analyser.p12 CERT_PASSWORD=<password> npm run package
```

This runs `build:clean` first, then signs `dist/BeatAnalyser/` producing
`dist/BeatAnalyser.zxp`.

### 9d. Install the ZXP

In Premiere Pro:
```
Window → Extensions → Manage Extensions → Install from disk → BeatAnalyser.zxp
```

Or use the **Adobe Exchange** desktop app to install the `.zxp`.

---

## 10. Troubleshooting

### Panel doesn't appear in Window → Extensions

1. **PlayerDebugMode** — Verify it is set (§2). After setting it, you must
   **fully quit and restart Premiere Pro** (not just close the project).
2. **Symlink target** — Run `ls -la` (macOS) or `dir /AL` (Windows) in the
   extensions directory to confirm the symlink points to the right place.
3. **manifest.xml** — Any XML parse error silently suppresses the extension.
   Open `CSXS/manifest.xml` in a browser to check for errors.
4. **CSXS version mismatch** — `manifest.xml` declares `RequiredRuntime
   Version="11.0"`. Premiere Pro 2021 (v15) introduced CEP 11. If you are on an
   older version, change to `Version="10.0"` and update the registry/plist key
   accordingly.

### Panel loads but shows blank white

- Open DevTools (§6) and check the **Console** for JavaScript errors.
- Verify `lib/aubio.js` and `lib/essentia.js` exist and are > 10 KB.
- Check that `index.html` script tags reference the correct paths.

### "EvalScript error." in the browser console

ExtendScript threw an unhandled exception. Steps to diagnose:
1. Open the **ExtendScript Toolkit** or use `$.writeln()` in `hostScript.jsx`.
2. Look for `undefined` return values or missing Premiere Pro objects.
3. Verify a project is open and a sequence is active before clicking Analyse.

### WASM download fails behind a proxy

```sh
https_proxy=http://proxy.example.com:8080 npm run download-wasm
```

Or download the files manually (§5) and place them in `lib/`.

### Symlink creation fails on Windows

Windows requires either:
- **Developer Mode** enabled (`Settings → Update & Security → For developers`), or
- Running PowerShell as **Administrator**.

Alternatively use `-Copy` mode:
```powershell
.\scripts\install.ps1 -Copy
```

### `Set-ExecutionPolicy` blocked by Group Policy

Ask your IT department, or run the script content directly:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

---

*Beat Analyser — CEP 11 panel for Adobe Premiere Pro*
