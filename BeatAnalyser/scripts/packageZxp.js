#!/usr/bin/env node
/**
 * scripts/packageZxp.js
 *
 * ZXP signing placeholder.
 *
 * Real ZXP signing requires:
 *   1. ZXPSignCmd (from Adobe Exchange / Creative Cloud SDK tools)
 *      https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD
 *   2. A self-signed or commercial certificate (.p12).
 *
 * This script checks for the prerequisites and prints the exact commands to run.
 * When ZXPSignCmd is on PATH (or at ZXPSIGNCMD_PATH env var) it will invoke it
 * automatically.
 *
 * Environment variables:
 *   ZXPSIGNCMD_PATH   Path to ZXPSignCmd binary  (default: looks on PATH)
 *   CERT_PATH         Path to .p12 certificate   (default: ./beat-analyser.p12)
 *   CERT_PASSWORD     Certificate password        (default: prompts interactively)
 *   ZXP_OUT           Output .zxp path            (default: ./dist/BeatAnalyser.zxp)
 *
 * Usage:
 *   node scripts/packageZxp.js
 *   CERT_PATH=~/certs/mykey.p12 CERT_PASSWORD=secret node scripts/packageZxp.js
 */

"use strict";

var fs   = require("fs");
var path = require("path");
var cp   = require("child_process");

var ROOT     = path.join(__dirname, "..");
var DIST_EXT = path.join(ROOT, "..", "dist", "BeatAnalyser");
var ZXP_OUT  = process.env.ZXP_OUT || path.join(ROOT, "..", "dist", "BeatAnalyser.zxp");

var green  = function(s) { return "\x1b[32m" + s + "\x1b[0m"; };
var yellow = function(s) { return "\x1b[33m" + s + "\x1b[0m"; };
var cyan   = function(s) { return "\x1b[36m" + s + "\x1b[0m"; };
var red    = function(s) { return "\x1b[31m" + s + "\x1b[0m"; };
var bold   = function(s) { return "\x1b[1m"  + s + "\x1b[0m"; };

function ok(msg)   { console.log("  " + green("✓") + " " + msg); }
function warn(msg) { console.log("  " + yellow("!") + " " + msg); }
function step(msg) { console.log("  " + cyan("→") + " " + msg); }
function fail(msg) { console.log("  " + red("✗") + " " + msg); }
function info(msg) { console.log("  " + msg); }

// ── Locate ZXPSignCmd ─────────────────────────────────────────────────────────

function findZxpSignCmd() {
    if (process.env.ZXPSIGNCMD_PATH) {
        return fs.existsSync(process.env.ZXPSIGNCMD_PATH)
            ? process.env.ZXPSIGNCMD_PATH : null;
    }

    // Common install locations
    var candidates = [];
    if (process.platform === "win32") {
        candidates = [
            "ZXPSignCmd.exe",
            "C:\\Program Files\\Adobe\\Adobe ZXP Sign Command\\ZXPSignCmd.exe"
        ];
    } else {
        candidates = [
            "ZXPSignCmd",
            "/usr/local/bin/ZXPSignCmd",
            path.join(process.env.HOME || "~", "bin", "ZXPSignCmd")
        ];
    }

    for (var i = 0; i < candidates.length; i++) {
        try {
            cp.execFileSync(candidates[i], ["-help"], { stdio: "pipe" });
            return candidates[i];
        } catch (_) { /* not found or not executable */ }
    }
    return null;
}

// ── Self-signed cert generation hint ─────────────────────────────────────────

function printCertHint(certPath) {
    console.log("");
    console.log(bold("  Generate a self-signed certificate (development only):"));
    console.log("");

    if (process.platform === "win32") {
        console.log("  " + cyan("PowerShell (run as Administrator):"));
        info('  ZXPSignCmd -selfSignedCert US CA "Beat Analyser Dev" beatanalyser \\');
        info('             <password> "' + certPath + '"');
    } else {
        console.log("  " + cyan("Terminal:"));
        info('  ZXPSignCmd -selfSignedCert US CA "Beat Analyser Dev" beatanalyser \\');
        info("             <password> '" + certPath + "'");
    }

    console.log("");
    warn("Self-signed certs are for development only.");
    warn("For distribution via Adobe Exchange, obtain a commercial code-signing cert");
    warn("from a CA such as DigiCert or GlobalSign.");
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log("");
console.log(bold("  Beat Analyser — ZXP Packager"));
console.log("  ──────────────────────────────");
console.log("");

// Check dist folder exists
if (!fs.existsSync(DIST_EXT)) {
    fail("dist/BeatAnalyser/ not found. Run " + cyan("npm run build") + " first.");
    process.exit(1);
}
ok("dist/BeatAnalyser/ found.");

// Locate ZXPSignCmd
step("Looking for ZXPSignCmd …");
var zxpCmd = findZxpSignCmd();

if (!zxpCmd) {
    fail("ZXPSignCmd not found on PATH or at ZXPSIGNCMD_PATH.");
    console.log("");
    console.log(bold("  Install ZXPSignCmd:"));
    console.log("  https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD");
    console.log("");
    console.log(bold("  Then sign manually:"));
    var certPath = process.env.CERT_PATH || path.join(ROOT, "beat-analyser.p12");
    info("  ZXPSignCmd -sign '" + DIST_EXT + "' \\");
    info("             '" + ZXP_OUT + "' \\");
    info("             '" + certPath + "' \\");
    info("             <password>");
    printCertHint(certPath);
    process.exit(1);
}

ok("ZXPSignCmd found: " + zxpCmd);

// Resolve cert path
var certPath = process.env.CERT_PATH || path.join(ROOT, "beat-analyser.p12");
if (!fs.existsSync(certPath)) {
    fail("Certificate not found: " + certPath);
    warn("Set CERT_PATH env var or place beat-analyser.p12 in the BeatAnalyser/ root.");
    printCertHint(certPath);
    process.exit(1);
}
ok("Certificate: " + certPath);

// Resolve password (prompt if not set)
var certPassword = process.env.CERT_PASSWORD;
if (!certPassword) {
    // Node has no built-in synchronous prompt; instruct user to pass via env var.
    fail("CERT_PASSWORD environment variable not set.");
    warn("Re-run with:  CERT_PASSWORD=<password> npm run package");
    process.exit(1);
}

// Ensure output directory exists
var distDir = path.dirname(ZXP_OUT);
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

// Run ZXPSignCmd
step("Signing → " + ZXP_OUT + " …");

var args = [
    "-sign",
    DIST_EXT,
    ZXP_OUT,
    certPath,
    certPassword
];

try {
    var out = cp.execFileSync(zxpCmd, args, { encoding: "utf8" });
    if (out) info(out.trim());
    ok("ZXP created: " + ZXP_OUT);
    ok("Size: " + Math.round(fs.statSync(ZXP_OUT).size / 1024) + " KB");
    console.log("");
    console.log("  Install in Premiere Pro:");
    info("  Window → Extensions → Manage Extensions → Install from disk → " + ZXP_OUT);
    console.log("");
} catch (err) {
    fail("ZXPSignCmd failed:");
    if (err.stdout) info(err.stdout.trim());
    if (err.stderr) info(err.stderr.trim());
    process.exit(1);
}
