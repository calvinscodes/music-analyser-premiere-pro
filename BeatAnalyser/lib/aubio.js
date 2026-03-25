/**
 * aubio.js — WASM bundle stub
 *
 * This file is a placeholder. Replace it with the real aubio.js WASM bundle.
 *
 * Obtain the real bundle via one of:
 *   npm install aubiojs            # then copy node_modules/aubiojs/dist/aubio.js
 *   https://github.com/qiuxiang/aubiojs/releases
 *
 * The real module exposes a factory function:
 *   Aubio() → Promise<AubioModule>
 *
 * AubioModule.Tempo(bufferSize, hopSize, sampleRate) → TempoTracker
 *   .do(Float32Array frame)
 *   .getBeat()    → boolean
 *   .getBpm()     → number
 *   .getConfidence() → number
 *   .free()
 *
 * Run `npm install` in the BeatAnalyser directory to auto-copy the real file
 * via the postinstall script (scripts/copyWasm.js).
 */

/* global window */
(function (global) {
  "use strict";

  if (typeof global.Aubio === "undefined") {
    console.warn(
      "[BeatAnalyser] aubio.js stub loaded — replace with the real WASM bundle.\n" +
      "Run: npm install  (in the BeatAnalyser directory)"
    );

    /**
     * Stub Aubio factory — resolves immediately with a no-op module
     * so the panel loads without crashing during development.
     */
    global.Aubio = function () {
      return Promise.resolve({
        Tempo: function (/*bufferSize, hopSize, sampleRate*/) {
          return {
            do:            function () {},
            getBeat:       function () { return false; },
            getBpm:        function () { return 0; },
            getConfidence: function () { return 0; },
            free:          function () {}
          };
        }
      });
    };
  }
}(typeof window !== "undefined" ? window : this));
