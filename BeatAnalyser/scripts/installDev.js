#!/usr/bin/env node
/**
 * scripts/installDev.js
 *
 * Cross-platform shim invoked by `npm run dev`.
 * Delegates to the native platform script:
 *   Windows → PowerShell scripts/install.ps1
 *   macOS/Linux → bash scripts/install.sh
 *
 * After setup it watches js/, css/, jsx/ for changes and prints a reminder
 * to reload the panel (CEP panels reload on Ctrl+Shift+F5 / Cmd+Shift+F5,
 * or by closing and reopening via Window → Extensions).
 */

"use strict";

var cp   = require("child_process");
var fs   = require("fs");
var path = require("path");

var ROOT    = path.join(__dirname, "..");
var IS_WIN  = process.platform === "win32";

var green  = function(s) { return "\x1b[32m" + s + "\x1b[0m"; };
var yellow = function(s) { return "\x1b[33m" + s + "\x1b[0m"; };
var cyan   = function(s) { return "\x1b[36m" + s + "\x1b[0m"; };
var bold   = function(s) { return "\x1b[1m"  + s + "\x1b[0m"; };

function ok(msg)   { console.log("  " + green("✓") + " " + msg); }
function warn(msg) { console.log("  " + yellow("!") + " " + msg); }
function step(msg) { console.log("  " + cyan("→") + " " + msg); }

// ── Run platform install script ───────────────────────────────────────────────

step("Running platform install script …");

try {
    if (IS_WIN) {
        var ps1 = path.join(__dirname, "install.ps1");
        cp.execFileSync("powershell.exe", [
            "-ExecutionPolicy", "Bypass",
            "-NonInteractive",
            "-File", ps1
        ], { stdio: "inherit", cwd: ROOT });
    } else {
        var sh = path.join(__dirname, "install.sh");
        // Ensure the script is executable
        try { fs.chmodSync(sh, 0o755); } catch (_) {}
        cp.execFileSync("bash", [sh], { stdio: "inherit", cwd: ROOT });
    }
} catch (err) {
    warn("Install script exited with code " + (err.status || "?") + ".");
    warn("Check the output above for details.");
    process.exit(err.status || 1);
}

// ── File watcher ──────────────────────────────────────────────────────────────

var WATCH_DIRS = ["js", "css", "jsx"].map(function(d) {
    return path.join(ROOT, d);
});

console.log("");
console.log(bold("  Watching for file changes …"));
WATCH_DIRS.forEach(function(d) {
    if (!fs.existsSync(d)) return;
    console.log("  " + cyan("○") + " " + path.relative(ROOT, d) + "/");
});
console.log("");
console.log("  Reload the panel after each save:");
if (IS_WIN) {
    console.log("    Ctrl+Shift+F5  (focus the panel first)");
} else {
    console.log("    Cmd+Shift+F5   (focus the panel first)");
}
console.log("  Or: Window → Extensions → close → reopen Beat Analyser");
console.log("");
console.log("  " + yellow("Ctrl+C") + " to stop watching.");
console.log("");

// Debounce rapid saves (e.g. format-on-save)
var debounceTimers = {};

function onChange(dir, filename) {
    var key = dir + "/" + (filename || "");
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(function() {
        var ts = new Date().toTimeString().slice(0, 8);
        console.log("  " + cyan("[" + ts + "]") + " Changed: " +
            path.relative(ROOT, dir) + "/" + (filename || ""));
        console.log("  " + yellow("→") + " Reload the panel to pick up changes.");
    }, 150);
}

WATCH_DIRS.forEach(function(d) {
    if (!fs.existsSync(d)) return;
    try {
        fs.watch(d, { recursive: true }, function(event, filename) {
            onChange(d, filename);
        });
    } catch (e) {
        // fs.watch recursive not supported on all Linux kernels
        warn("Could not watch " + d + ": " + e.message);
    }
});

// Keep the process alive
process.stdin.resume();
