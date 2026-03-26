#!/usr/bin/env node
/**
 * scripts/downloadWasm.js
 *
 * Downloads aubio.js and essentia.js WASM bundles from jsDelivr/npm into lib/.
 * Called by: npm run download-wasm   (also used by postinstall via copyWasm.js)
 *
 * Usage:
 *   node scripts/downloadWasm.js
 *   node scripts/downloadWasm.js --force    # re-download even if files exist
 */

"use strict";

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const url    = require("url");

const FORCE  = process.argv.includes("--force");
const LIB    = path.join(__dirname, "..", "lib");
const ROOT   = path.join(__dirname, "..");

/** Minimum byte size that indicates a real bundle (not a stub/error page). */
const MIN_VALID_BYTES = 10 * 1024; // 10 KB

const BUNDLES = [
    {
        name: "CSInterface.js",
        dest: ROOT,   // goes in extension root, not lib/
        urls: [
            "https://raw.githubusercontent.com/Adobe-CEP/CSInterface/master/src/CSInterface.js"
        ]
    },
    {
        name: "aubio.js",
        // Use the package root URL — both CDNs redirect to the package's `main`
        // entry (the UMD/browser build that sets window.aubio globally).
        urls: [
            "https://cdn.jsdelivr.net/npm/aubiojs@0.2.1",
            "https://unpkg.com/aubiojs@0.2.1"
        ]
    },
    {
        name: "essentia.js",
        // essentia.js ships a UMD build that exposes window.Essentia
        urls: [
            "https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.umd.js",
            "https://unpkg.com/essentia.js@0.1.3/dist/essentia-wasm.umd.js"
        ]
    }
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const cyan   = s => `\x1b[36m${s}\x1b[0m`;
const green  = s => `\x1b[32m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;

function step(msg)  { console.log(`  ${cyan("→")} ${msg}`); }
function ok(msg)    { console.log(`  ${green("✓")} ${msg}`); }
function warn(msg)  { console.log(`  ${yellow("!")} ${msg}`); }
function fail(msg)  { console.log(`  ${red("✗")} ${msg}`); }

/**
 * Download `srcUrl` to `destPath`, following up to `maxRedirects` redirects.
 * Resolves with byte count, rejects on HTTP error or network failure.
 */
function download(srcUrl, destPath, maxRedirects) {
    maxRedirects = maxRedirects === undefined ? 5 : maxRedirects;

    return new Promise(function(resolve, reject) {
        var parsed = url.parse(srcUrl);
        var transport = parsed.protocol === "https:" ? https : http;

        var req = transport.get(srcUrl, function(res) {
            // Follow redirects (301 / 302 / 307 / 308)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (maxRedirects <= 0) {
                    return reject(new Error("Too many redirects: " + srcUrl));
                }
                var redirectUrl = res.headers.location;
                // Handle protocol-relative URLs
                if (redirectUrl.startsWith("//")) {
                    redirectUrl = parsed.protocol + redirectUrl;
                }
                // Handle root-relative URLs
                if (redirectUrl.startsWith("/")) {
                    redirectUrl = parsed.protocol + "//" + parsed.host + redirectUrl;
                }
                res.resume(); // discard body
                return resolve(download(redirectUrl, destPath, maxRedirects - 1));
            }

            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error("HTTP " + res.statusCode + " for " + srcUrl));
            }

            var tmp = destPath + ".tmp";
            var out = fs.createWriteStream(tmp);
            var bytes = 0;

            res.on("data", function(chunk) { bytes += chunk.length; });
            res.pipe(out);

            out.on("error", function(err) {
                fs.unlink(tmp, function() {});
                reject(err);
            });

            out.on("finish", function() {
                fs.rename(tmp, destPath, function(err) {
                    if (err) return reject(err);
                    resolve(bytes);
                });
            });
        });

        req.on("error", reject);
        req.setTimeout(30000, function() {
            req.destroy(new Error("Request timed out: " + srcUrl));
        });
    });
}

/**
 * Try each URL in `urls` in order, resolving on the first success.
 */
async function tryUrls(urls, destPath) {
    var lastErr;
    for (var i = 0; i < urls.length; i++) {
        try {
            step("  Trying " + urls[i]);
            var bytes = await download(urls[i], destPath);
            return bytes;
        } catch (err) {
            lastErr = err;
            warn("  " + err.message);
        }
    }
    throw lastErr;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log("");
    console.log("  Beat Analyser — WASM bundle downloader");
    console.log("  ───────────────────────────────────────");
    console.log("");

    if (!fs.existsSync(LIB)) {
        fs.mkdirSync(LIB, { recursive: true });
    }

    var allOk = true;

    for (var i = 0; i < BUNDLES.length; i++) {
        var bundle = BUNDLES[i];
        var dest   = path.join(bundle.dest || LIB, bundle.name);

        // Skip if already a valid-sized file (and not forced)
        if (!FORCE && fs.existsSync(dest)) {
            var existing = fs.statSync(dest).size;
            if (existing >= MIN_VALID_BYTES) {
                ok(bundle.name + " already present (" + Math.round(existing / 1024) + " KB) — skipping.");
                continue;
            }
            warn(bundle.name + " exists but is too small (" + existing + " bytes) — re-downloading.");
        }

        step("Downloading " + bundle.name + " …");

        try {
            var bytes = await tryUrls(bundle.urls, dest);
            ok(bundle.name + " → lib/ (" + Math.round(bytes / 1024) + " KB)");
        } catch (err) {
            fail("Could not download " + bundle.name + ": " + err.message);
            warn("Try: npm run download-wasm --force");
            warn("Or download manually into lib/:");
            bundle.urls.forEach(function(u) { warn("  " + u); });
            allOk = false;
        }
    }

    console.log("");
    if (allOk) {
        ok("All bundles ready.");
    } else {
        fail("Some downloads failed. The extension will use stub implementations.");
        fail("Beat tracking and key detection will not work until real bundles are in lib/.");
        process.exitCode = 1;
    }
    console.log("");
}

main().catch(function(err) {
    fail("Unexpected error: " + err.message);
    process.exitCode = 1;
});
