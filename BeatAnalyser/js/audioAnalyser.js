/**
 * audioAnalyser.js — BPM & musical key detection
 *
 * Uses:
 *   • aubio.js  (WASM) — beat tracking / BPM via AubioTempoTracker
 *   • essentia.js (WASM) — key detection via EssentiaWASM
 *
 * Both WASM bundles are expected to be loaded in index.html before
 * this module is evaluated (they expose globals `Module` / `EssentiaWASM`).
 *
 * Public API (all async):
 *   AudioAnalyser.fromArrayBuffer(arrayBuffer) → instance
 *   instance.detectBPM()   → { bpm, confidence, beats: number[] }
 *   instance.detectKey()   → { key, scale, strength }
 *   instance.analyse()     → { bpm, confidence, beats, key, scale, strength }
 */

(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  Constants                                                           */
  /* ------------------------------------------------------------------ */

  var AUBIO_HOP_SIZE    = 512;
  var AUBIO_BUFFER_SIZE = 1024;
  var SAMPLE_RATE       = 44100;

  /* ------------------------------------------------------------------ */
  /*  AudioContext singleton                                              */
  /* ------------------------------------------------------------------ */

  var _audioCtx = null;
  function getAudioContext() {
    if (!_audioCtx) {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SAMPLE_RATE
      });
    }
    return _audioCtx;
  }

  /* ------------------------------------------------------------------ */
  /*  Decode audio to mono Float32Array at SAMPLE_RATE                   */
  /* ------------------------------------------------------------------ */

  function decodeAudio(arrayBuffer) {
    return new Promise(function (resolve, reject) {
      var ctx = getAudioContext();
      ctx.decodeAudioData(
        arrayBuffer,
        function (audioBuffer) {
          // Mix down to mono
          var nChannels = audioBuffer.numberOfChannels;
          var length    = audioBuffer.length;
          var mono      = new Float32Array(length);

          for (var ch = 0; ch < nChannels; ch++) {
            var channel = audioBuffer.getChannelData(ch);
            for (var i = 0; i < length; i++) {
              mono[i] += channel[i];
            }
          }
          if (nChannels > 1) {
            for (var j = 0; j < length; j++) {
              mono[j] /= nChannels;
            }
          }
          resolve({ mono: mono, sampleRate: audioBuffer.sampleRate });
        },
        reject
      );
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Resample to a target sample rate (linear interpolation)            */
  /* ------------------------------------------------------------------ */

  function resample(mono, fromRate, toRate) {
    if (fromRate === toRate) return mono;
    var ratio  = fromRate / toRate;
    var outLen = Math.floor(mono.length / ratio);
    var out    = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos   = i * ratio;
      var idx   = Math.floor(pos);
      var frac  = pos - idx;
      var a     = mono[idx]     || 0;
      var b     = mono[idx + 1] || 0;
      out[i]    = a + frac * (b - a);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  BPM detection via aubio.js                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Runs Aubio tempo tracking over a mono Float32Array.
   * Returns { bpm, confidence, beats } where beats is an array of
   * onset times in seconds.
   *
   * Requires the aubio.js WASM module to expose `Aubio` on window.
   */
  function detectBPMWithAubio(mono, sampleRate) {
    return new Promise(function (resolve, reject) {
      if (typeof Aubio === "undefined") {
        return reject(new Error("aubio.js is not loaded."));
      }

      Aubio().then(function (aubio) {
        var tempo = new aubio.Tempo(
          AUBIO_BUFFER_SIZE,
          AUBIO_HOP_SIZE,
          sampleRate
        );

        var beats      = [];
        var bpmSum     = 0;
        var bpmCount   = 0;
        var confidence = 0;

        var numFrames = Math.floor(mono.length / AUBIO_HOP_SIZE);

        for (var i = 0; i < numFrames; i++) {
          var frame = mono.slice(i * AUBIO_HOP_SIZE, (i + 1) * AUBIO_HOP_SIZE);
          tempo.do(frame);

          if (tempo.getBeat()) {
            var beatTime = (i * AUBIO_HOP_SIZE) / sampleRate;
            beats.push(parseFloat(beatTime.toFixed(4)));
          }

          var bpm = tempo.getBpm();
          if (bpm > 0) {
            bpmSum   += bpm;
            bpmCount += 1;
            confidence = tempo.getConfidence();
          }
        }

        var avgBpm = bpmCount > 0 ? bpmSum / bpmCount : 0;
        tempo.free();

        resolve({
          bpm:        parseFloat(avgBpm.toFixed(2)),
          confidence: parseFloat(confidence.toFixed(4)),
          beats:      beats
        });
      }).catch(reject);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Key detection via essentia.js                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Detects musical key using Essentia's KeyExtractor algorithm.
   * Returns { key, scale, strength }.
   *
   * Requires the essentia.js WASM module (`EssentiaWASM` global).
   */
  function detectKeyWithEssentia(mono, sampleRate) {
    return new Promise(function (resolve, reject) {
      if (typeof EssentiaWASM === "undefined") {
        return reject(new Error("essentia.js is not loaded."));
      }

      EssentiaWASM().then(function (wasmModule) {
        var Essentia = wasmModule.EssentiaJS;
        var essentia = new Essentia(false /* debugger off */);

        // Essentia expects a VectorFloat input
        var inputVector = essentia.arrayToVector(mono);

        var result = essentia.KeyExtractor(
          inputVector,
          true,          // averageDetuningCorrection
          4096,          // frameSize
          4096,          // hopSize (set equal to avoid re-framing issues)
          12,            // hpcpSize
          3500,          // maxFrequency
          60,            // maximumSpectralPeaks
          25,            // minFrequency
          0.2,           // pcpThreshold
          "bgate",       // profileType
          sampleRate,
          0.0001,        // spectralPeaksThreshold
          400,           // tuningFrequency (Hz, will be refined)
          "cosine",      // weightType
          "none"         // windowType
        );

        inputVector.delete();

        resolve({
          key:      result.key,
          scale:    result.scale,
          strength: parseFloat(result.strength.toFixed(4))
        });
      }).catch(reject);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Public AudioAnalyser class                                          */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Float32Array} mono        Mono audio samples at SAMPLE_RATE.
   * @param {number}       sampleRate
   */
  function AudioAnalyser(mono, sampleRate) {
    this._mono       = mono;
    this._sampleRate = sampleRate;
  }

  /**
   * Factory — decodes an ArrayBuffer and returns an AudioAnalyser instance.
   * @param  {ArrayBuffer} arrayBuffer
   * @returns {Promise<AudioAnalyser>}
   */
  AudioAnalyser.fromArrayBuffer = function (arrayBuffer) {
    return decodeAudio(arrayBuffer).then(function (result) {
      var mono = resample(result.mono, result.sampleRate, SAMPLE_RATE);
      return new AudioAnalyser(mono, SAMPLE_RATE);
    });
  };

  /** @returns {Promise<{ bpm, confidence, beats }>} */
  AudioAnalyser.prototype.detectBPM = function () {
    return detectBPMWithAubio(this._mono, this._sampleRate);
  };

  /** @returns {Promise<{ key, scale, strength }>} */
  AudioAnalyser.prototype.detectKey = function () {
    return detectKeyWithEssentia(this._mono, this._sampleRate);
  };

  /**
   * Runs BPM and key detection in parallel.
   * @returns {Promise<{ bpm, confidence, beats, key, scale, strength }>}
   */
  AudioAnalyser.prototype.analyse = function () {
    return Promise.all([
      this.detectBPM(),
      this.detectKey()
    ]).then(function (results) {
      return Object.assign({}, results[0], results[1]);
    });
  };

  /* ------------------------------------------------------------------ */
  /*  Module export                                                       */
  /* ------------------------------------------------------------------ */

  if (typeof module !== "undefined" && module.exports) {
    module.exports = AudioAnalyser;
  } else {
    global.AudioAnalyser = AudioAnalyser;
  }

}(typeof window !== "undefined" ? window : this));
