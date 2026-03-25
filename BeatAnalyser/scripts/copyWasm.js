#!/usr/bin/env node
/**
 * scripts/copyWasm.js
 *
 * postinstall helper: copies aubio.js and essentia.js from node_modules into
 * lib/ so index.html can load them with a simple <script src="lib/..."> tag.
 *
 * If the node_modules copy is missing or is a stub (<10 KB), falls back to
 * running downloadWasm.js to pull from CDN.
 *
 * Called automatically by:  npm install  (via "postinstall" in package.json)
 * Can also be run manually: node scripts/copyWasm.js
 */

"use strict";

var fs   = require("fs");
var path = require("path");
var cp   = require("child_process");

var ROOT = path.join(__dirname, "..");
var LIB  = path.join(ROOT, "lib");
var NM   = path.join(ROOT, "node_modules");

var MIN_VALID_BYTES = 10 * 1024;

var green  = function(s) { return "\x1b[32m" + s + "\x1b[0m"; };
var yellow = function(s) { return "\x1b[33m" + s + "\x1b[0m"; };
var cyan   = function(s) { return "\x1b[36m" + s + "\x1b[0m"; };

function ok(msg)   { console.log("  " + green("✓") + " " + msg); }
function warn(msg) { console.log("  " + yellow("!") + " " + msg); }
function step(msg) { console.log("  " + cyan("→") + " " + msg); }

/** Copy src → dest only if src is a real bundle. Returns true on success. */
function tryCopy(src, dest) {
    if (!fs.existsSync(src)) return false;
    var size = fs.statSync(src).size;
    if (size < MIN_VALID_BYTES) return false;

    // Skip if dest is already the same size (idempotent)
    if (fs.existsSync(dest) && fs.statSync(dest).size === size) {
        ok(path.basename(dest) + " already up-to-date (" + Math.round(size / 1024) + " KB).");
        return true;
    }

    fs.copyFileSync(src, dest);
    ok("Copied " + path.basename(dest) + " → lib/ (" + Math.round(size / 1024) + " KB)");
    return true;
}

if (!fs.existsSync(LIB)) {
    fs.mkdirSync(LIB, { recursive: true });
}

var needDownload = false;

// ── aubio.js ─────────────────────────────────────────────────────────────────
// Resolve the entry file from aubiojs's own package.json so this script stays
// correct across package versions (the file path changed between 0.1.x → 0.2.x).
var audioDest = path.join(LIB, "aubio.js");

step("aubio.js …");
(function () {
    var pkgPath = path.join(NM, "aubiojs", "package.json");
    if (!fs.existsSync(pkgPath)) {
        warn("aubiojs not found in node_modules — will try CDN fallback.");
        needDownload = true;
        return;
    }
    var pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    // Prefer a browser-specific entry if declared, then fall back to main.
    var rel = pkg.browser || pkg.main || "dist/aubio.esm.js";
    // Normalise Windows backslashes
    rel = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    var aubioSrc = path.join(NM, "aubiojs", rel);
    if (!tryCopy(aubioSrc, audioDest)) {
        warn("aubio.js not found at expected path: " + aubioSrc);
        needDownload = true;
    }
}());

// ── essentia.js ───────────────────────────────────────────────────────────────
// essentia.js ships the UMD WASM build at:
//   node_modules/essentia.js/dist/essentia-wasm.umd.js
var essentiaSrc  = path.join(NM, "essentia.js", "dist", "essentia-wasm.umd.js");
var essentiaDest = path.join(LIB, "essentia.js");

step("essentia.js …");
if (!tryCopy(essentiaSrc, essentiaDest)) {
    warn("essentia.js not found in node_modules (expected: " + essentiaSrc + ")");
    needDownload = true;
}

// ── Fallback: CDN download ────────────────────────────────────────────────────
if (needDownload) {
    warn("Falling back to CDN download …");
    try {
        cp.execFileSync(process.execPath, [path.join(__dirname, "downloadWasm.js")], {
            stdio: "inherit",
            cwd: ROOT
        });
    } catch (err) {
        warn("CDN download failed — the extension will run with stub implementations.");
        warn("Run: node scripts/downloadWasm.js --force   once you have internet access.");
    }
}
