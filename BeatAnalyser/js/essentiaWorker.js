/**
 * essentiaWorker.js — Essentia.js key detection in a Web Worker.
 *
 * CEP panels restrict synchronous WebAssembly compilation on the main thread
 * for buffers > 4 KB. Web Workers do not have this restriction.
 * This worker loads essentia.js via importScripts (synchronous in workers)
 * and runs the full HPCP + Key detection pipeline off the main thread.
 *
 * Message protocol
 * ----------------
 * Incoming:  { type: "analyseKey", pcm: Float32Array, sampleRate: number }
 * Outgoing:  { type: "keyResult",  key, scale, keyStrength }
 *            { type: "error",      message: string }
 */

"use strict";

var CHROMA_FRAME_SIZE = 4096;
var CHROMA_HOP_SIZE   = 4096;
var CHROMA_BIN_COUNT  = 36;
var CHROMA_HARMONICS  = 8;

// ── Load essentia.js ──────────────────────────────────────────────────────────

var loadError = null;
try {
  importScripts("../lib/essentia.js");
} catch (e) {
  loadError = "Failed to load essentia.js: " + e.message;
}

// ── Essentia initialisation ───────────────────────────────────────────────────

var _essentiaPromise = null;

function getEssentia() {
  if (_essentiaPromise) return _essentiaPromise;

  if (loadError) {
    _essentiaPromise = Promise.reject(new Error(loadError));
    return _essentiaPromise;
  }

  // essentia-wasm.umd.js sets EssentiaWASM as a global async factory.
  if (typeof EssentiaWASM === "function") {
    _essentiaPromise = EssentiaWASM().then(function (module) {
      return new Essentia(module);
    });
  } else if (typeof Essentia !== "undefined" &&
             typeof Essentia.arrayToVector === "function") {
    // Already a live instance (older bundle format).
    _essentiaPromise = Promise.resolve(Essentia);
  } else {
    _essentiaPromise = Promise.reject(
      new Error("EssentiaWASM is not defined. Check lib/essentia.js.")
    );
  }

  return _essentiaPromise;
}

// ── HPCP pipeline ─────────────────────────────────────────────────────────────

function computeChromagram(essentia, pcm, sampleRate) {
  var frameSize   = CHROMA_FRAME_SIZE;
  var hopSize     = CHROMA_HOP_SIZE;
  var binCount    = CHROMA_BIN_COUNT;
  var hpcpAccum   = new Float32Array(binCount);
  var validFrames = 0;
  var numFrames   = Math.floor((pcm.length - frameSize) / hopSize) + 1;

  for (var i = 0; i < numFrames; i++) {
    var start = i * hopSize;
    var frameData;
    if (start + frameSize <= pcm.length) {
      frameData = pcm.slice(start, start + frameSize);
    } else {
      frameData = new Float32Array(frameSize);
      frameData.set(pcm.subarray(start));
    }

    var frameVec     = essentia.arrayToVector(frameData);
    var windowed     = essentia.Windowing(frameVec, true, 0, "hann", false);
    frameVec.delete();

    var specResult   = essentia.Spectrum(windowed.frame, frameSize);
    windowed.frame.delete();

    var peaksResult  = essentia.SpectralPeaks(
      specResult.spectrum, 0.0001, 3500, 60, 20, "byFrequency", sampleRate
    );
    specResult.spectrum.delete();

    var freqArray = essentia.vectorToArray(peaksResult.frequencies);
    if (freqArray.length === 0) {
      peaksResult.frequencies.delete();
      peaksResult.magnitudes.delete();
      continue;
    }

    var hpcpResult = essentia.HPCP(
      peaksResult.frequencies, peaksResult.magnitudes,
      true, 500, CHROMA_HARMONICS, 3500, false, 20, false,
      "unitMax", 440, sampleRate, binCount, 500, "squaredCosine", 1
    );
    peaksResult.frequencies.delete();
    peaksResult.magnitudes.delete();

    var hpcpData = essentia.vectorToArray(hpcpResult.hpcp);
    hpcpResult.hpcp.delete();

    for (var b = 0; b < binCount; b++) {
      hpcpAccum[b] += hpcpData[b];
    }
    validFrames++;
  }

  if (validFrames === 0) {
    throw new Error("No valid harmonic frames — audio may be noise or silence.");
  }

  for (var b = 0; b < binCount; b++) {
    hpcpAccum[b] /= validFrames;
  }

  return hpcpAccum;
}

function runKeyDetection(essentia, meanHpcp) {
  var hpcpVec = essentia.arrayToVector(meanHpcp);
  var result  = essentia.Key(
    hpcpVec, 4, CHROMA_BIN_COUNT, "temperley", 0.6, false, true
  );
  hpcpVec.delete();
  return {
    key:         result.key,
    scale:       result.scale,
    keyStrength: Math.round(result.strength * 10000) / 10000
  };
}

// ── Message handler ───────────────────────────────────────────────────────────

self.addEventListener("message", function (e) {
  var data = e.data;
  if (!data || data.type !== "analyseKey") return;

  getEssentia()
    .then(function (essentia) {
      var pcm = data.pcm instanceof Float32Array
        ? data.pcm
        : new Float32Array(data.pcm);
      var meanHpcp = computeChromagram(essentia, pcm, data.sampleRate);
      var keyResult = runKeyDetection(essentia, meanHpcp);
      self.postMessage({ type: "keyResult", result: keyResult });
    })
    .catch(function (err) {
      self.postMessage({ type: "error", message: err.message });
    });
});
