#!/usr/bin/env bash
# Beat Analyser — CEP dev-install script (macOS / Linux)
#
# Usage:
#   ./scripts/install.sh            # symlink + debug mode + WASM download
#   ./scripts/install.sh --copy     # copy instead of symlink
#   ./scripts/install.sh --skip-wasm
#   ./scripts/install.sh --copy --skip-wasm
#
# On Linux this script targets the per-user CEP path used by Creative Cloud.
# Adjust $EXTENSIONS_DIR below if your install is non-standard.

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
RED='\033[0;31m'; RESET='\033[0m'; BOLD='\033[1m'

step() { echo -e "${CYAN}  → $*${RESET}"; }
ok()   { echo -e "${GREEN}  ✓ $*${RESET}"; }
warn() { echo -e "${YELLOW}  ! $*${RESET}"; }
fail() { echo -e "${RED}  ✗ $*${RESET}"; }

# ── Flags ─────────────────────────────────────────────────────────────────────

DO_COPY=false
SKIP_WASM=false

for arg in "$@"; do
    case "$arg" in
        --copy)       DO_COPY=true ;;
        --skip-wasm)  SKIP_WASM=true ;;
        -h|--help)
            sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) fail "Unknown argument: $arg"; exit 1 ;;
    esac
done

# ── Paths ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"   # …/BeatAnalyser
LIB_DIR="$REPO_ROOT/lib"

if [[ "$OSTYPE" == darwin* ]]; then
    EXTENSIONS_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
    PLATFORM="mac"
else
    # Linux (Creative Cloud on Linux is rare but supported by some versions)
    EXTENSIONS_DIR="$HOME/.config/Adobe/CEP/extensions"
    PLATFORM="linux"
    warn "Linux detected — Creative Cloud / Premiere Pro support is limited."
fi

LINK_TARGET="$EXTENSIONS_DIR/BeatAnalyser"

# ── Banner ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}  Beat Analyser — CEP Dev Install (${PLATFORM})${RESET}"
echo -e "  ─────────────────────────────────────────"
echo ""

# ── Step 1: PlayerDebugMode ───────────────────────────────────────────────────

step "Enabling unsigned extensions (PlayerDebugMode) …"

if [[ "$PLATFORM" == "mac" ]]; then
    for ver in 11 10 9; do
        domain="com.adobe.CSXS.$ver"
        # Check if the plist already has the key set correctly
        current="$(defaults read "$domain" PlayerDebugMode 2>/dev/null || true)"
        if [[ "$current" == "1" ]]; then
            ok "$domain PlayerDebugMode already = 1"
        else
            defaults write "$domain" PlayerDebugMode 1
            ok "defaults write $domain PlayerDebugMode 1"
        fi
    done

    # Flush preference cache (macOS 10.9+)
    if command -v killall &>/dev/null; then
        killall cfprefsd 2>/dev/null || true
    fi
else
    warn "PlayerDebugMode: no registry/plist mechanism on Linux."
    warn "If running via Wine/CrossOver, set the registry key manually. See SETUP.md."
fi

# ── Step 2: Symlink / copy to extensions directory ────────────────────────────

step "Linking extension into CEP extensions directory …"

mkdir -p "$EXTENSIONS_DIR"

if [[ -L "$LINK_TARGET" ]]; then
    warn "Symlink already exists — removing and recreating."
    rm "$LINK_TARGET"
elif [[ -d "$LINK_TARGET" ]]; then
    warn "A folder already exists at $LINK_TARGET"
    read -r -p "    Remove it and proceed? [y/N] " answer
    if [[ ! "$answer" =~ ^[Yy] ]]; then
        fail "Aborted. Remove $LINK_TARGET manually, then re-run."
        exit 1
    fi
    rm -rf "$LINK_TARGET"
fi

if [[ "$DO_COPY" == true ]]; then
    cp -R "$REPO_ROOT" "$LINK_TARGET"
    ok "Copied → $LINK_TARGET"
    warn "Edits in the repo are NOT reflected automatically. Re-run with --copy to refresh."
else
    ln -s "$REPO_ROOT" "$LINK_TARGET"
    ok "Symlink: $LINK_TARGET → $REPO_ROOT"
fi

# ── Step 3: Download WASM bundles ─────────────────────────────────────────────

if [[ "$SKIP_WASM" == false ]]; then
    step "Downloading WASM bundles into lib/ …"
    mkdir -p "$LIB_DIR"

    download_if_needed() {
        local name="$1"
        local url="$2"
        local dest="$LIB_DIR/$name"

        if [[ -f "$dest" ]]; then
            local size
            size=$(wc -c < "$dest" | tr -d ' ')
            if (( size > 10240 )); then
                ok "$name already present ($(( size / 1024 )) KB) — skipping."
                return
            fi
        fi

        step "  Downloading $name …"
        if command -v curl &>/dev/null; then
            curl -fsSL --retry 3 --retry-delay 2 -o "$dest" "$url" && \
                ok "$name → lib/ ($(( $(wc -c < "$dest" | tr -d ' ') / 1024 )) KB)" || \
                { fail "curl failed for $name"; warn "URL: $url"; }
        elif command -v wget &>/dev/null; then
            wget -q --tries=3 --waitretry=2 -O "$dest" "$url" && \
                ok "$name → lib/ ($(( $(wc -c < "$dest" | tr -d ' ') / 1024 )) KB)" || \
                { fail "wget failed for $name"; warn "URL: $url"; }
        else
            fail "Neither curl nor wget found. Install one, then re-run or download manually."
            warn "URL: $url"
        fi
    }

    download_if_needed "aubio.js" \
        "https://cdn.jsdelivr.net/npm/aubiojs@0.1.3/build/aubio.js"

    download_if_needed "essentia.js" \
        "https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.umd.js"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "  ─────────────────────────────────────────"
echo -e "${BOLD}  Setup complete. Next steps:${RESET}"
echo -e "    1. Restart Adobe Premiere Pro."
echo -e "    2. Window → Extensions → Beat Analyser."
echo -e "    3. Right-click the panel → Inspect Element to open DevTools."
echo -e "       (requires --remote-debugging-port in .debug file — see SETUP.md §4)"
echo ""
