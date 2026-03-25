/**
 * essentia.js — WASM bundle stub
 *
 * This file is a placeholder. Replace it with the real essentia.js WASM bundle.
 *
 * Obtain the real bundle via one of:
 *   npm install essentia.js        # then copy node_modules/essentia.js/dist/essentia.js
 *   https://github.com/MTG/essentia.js/releases
 *
 * The real module exposes:
 *   EssentiaWASM() → Promise<WASMModule>
 *
 * WASMModule.EssentiaJS(debug: boolean) → EssentiaInstance
 *   .arrayToVector(Float32Array) → VectorFloat
 *   .KeyExtractor(signal, ...params) → { key: string, scale: string, strength: number }
 *
 * Run `npm install` in the BeatAnalyser directory to auto-copy the real file
 * via the postinstall script (scripts/copyWasm.js).
 */

/* global window */
(function (global) {
  "use strict";

  if (typeof global.EssentiaWASM === "undefined") {
    console.warn(
      "[BeatAnalyser] essentia.js stub loaded — replace with the real WASM bundle.\n" +
      "Run: npm install  (in the BeatAnalyser directory)"
    );

    /**
     * Stub EssentiaWASM factory — resolves with a no-op module
     * so the panel loads without crashing during development.
     */
    global.EssentiaWASM = function () {
      return Promise.resolve({
        EssentiaJS: function (/*debug*/) {
          return {
            arrayToVector: function (arr) {
              return { data: arr, delete: function () {} };
            },
            KeyExtractor: function () {
              return { key: "C", scale: "major", strength: 0 };
            }
          };
        }
      });
    };
  }
}(typeof window !== "undefined" ? window : this));
