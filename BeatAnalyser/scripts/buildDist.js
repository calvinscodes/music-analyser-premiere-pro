#!/usr/bin/env node
/**
 * scripts/buildDist.js
 *
 * "build" script: copies the BeatAnalyser extension into a clean dist/ folder,
 * ready for packaging into a ZXP or manual deployment.
 *
 * Output: dist/BeatAnalyser/
 *
 * Usage:
 *   node scripts/buildDist.js
 *   node scripts/buildDist.js --clean    # remove dist/ first
 */

"use strict";

var fs   = require("fs");
var path = require("path");

var CLEAN = process.argv.includes("--clean");

var ROOT = path.join(__dirname, "..");
var DIST = path.join(ROOT, "..", "dist", "BeatAnalyser");

// Files/folders to include in the build (relative to BeatAnalyser/)
var INCLUDE = [
    "CSXS",
    "css",
    "js",
    "jsx",
    "lib",
    "index.html"
];

// Patterns to exclude (checked against the full destination path)
var EXCLUDE_PATTERNS = [
    /node_modules/,
    /\.git/,
    /scripts/,
    /dist/,
    /\.DS_Store/,
    /Thumbs\.db/,
    /\.map$/,
    /\.tmp$/
];

var green  = function(s) { return "\x1b[32m" + s + "\x1b[0m"; };
var yellow = function(s) { return "\x1b[33m" + s + "\x1b[0m"; };
var cyan   = function(s) { return "\x1b[36m" + s + "\x1b[0m"; };
var bold   = function(s) { return "\x1b[1m"  + s + "\x1b[0m"; };

function ok(msg)   { console.log("  " + green("✓") + " " + msg); }
function warn(msg) { console.log("  " + yellow("!") + " " + msg); }
function step(msg) { console.log("  " + cyan("→") + " " + msg); }

function shouldExclude(absPath) {
    return EXCLUDE_PATTERNS.some(function(p) { return p.test(absPath); });
}

/**
 * Recursively copy src into dest, honouring exclude patterns.
 * Returns [fileCount, byteCount].
 */
function copyRecursive(src, dest) {
    var fileCount = 0;
    var byteCount = 0;

    var stat = fs.statSync(src);

    if (stat.isDirectory()) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        var entries = fs.readdirSync(src);
        entries.forEach(function(entry) {
            var srcChild  = path.join(src, entry);
            var destChild = path.join(dest, entry);
            if (shouldExclude(srcChild)) return;
            var r = copyRecursive(srcChild, destChild);
            fileCount += r[0];
            byteCount += r[1];
        });
    } else if (stat.isFile()) {
        fs.copyFileSync(src, dest);
        fileCount++;
        byteCount += stat.size;
    }

    return [fileCount, byteCount];
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log("");
console.log(bold("  Beat Analyser — dist build"));
console.log("  ──────────────────────────────");
console.log("");

if (CLEAN && fs.existsSync(DIST)) {
    step("Removing existing dist/ …");
    fs.rmSync(DIST, { recursive: true, force: true });
    ok("Cleaned.");
}

if (!fs.existsSync(DIST)) {
    fs.mkdirSync(DIST, { recursive: true });
}

var totalFiles = 0;
var totalBytes = 0;

INCLUDE.forEach(function(entry) {
    var src  = path.join(ROOT, entry);
    var dest = path.join(DIST, entry);

    if (!fs.existsSync(src)) {
        warn(entry + " not found — skipping.");
        return;
    }

    step("Copying " + entry + " …");
    var r = copyRecursive(src, dest);
    totalFiles += r[0];
    totalBytes += r[1];
    ok(entry + " (" + r[0] + " file" + (r[0] === 1 ? "" : "s") + ")");
});

console.log("");
ok("Build complete → " + path.relative(process.cwd(), DIST));
ok(totalFiles + " files, " + Math.round(totalBytes / 1024) + " KB total");
console.log("");
console.log("  Next: run " + cyan("npm run package") + " to sign as a ZXP.");
console.log("");
