/**
 * audioAnalyser.js — Beat tracking + key detection
 *
 * Public API
 * ----------
 *   analyseAudio(arrayBuffer)
 *     → Promise<{ bpm, beatTimestamps, key, scale, keyStrength }>
 *
 *   arrayBuffer — ArrayBuffer of any browser-decodable audio (WAV, MP3, AAC, FLAC, OGG…)
 *
 * Dependencies
 * ------------
 *   window.aubio    — aubio.js WASM factory.
 *                     Shape:  aubio({ … }) → Promise<AubioModule>
 *                     AubioModule.Tempo(bufferSize, hopSize, sampleRate) → TempoTracker
 *
 *   window.Essentia — Essentia.js instance or factory.
 *                     Accepted shapes (both handled automatically):
 *                       (a) Already-initialised instance exposing .arrayToVector()
 *                       (b) Async factory: Essentia() → Promise<instance>
 *                     Required algorithms: Windowing, Spectrum, SpectralPeaks, HPCP, Key
 *
 * Internal pipeline
 * -----------------
 *   ArrayBuffer
 *     → decodeWithOfflineContext()   decode + mix-down to mono Float32Array     §2
 *     → assertNotSilent()            RMS guard before loading WASM              §3
 *     → resampleIfNeeded()           browser-quality resample to 44 100 Hz      §4
 *     ┌─────────────────────────────────────────────────── Promise.all ──────┐
 *     │  → runAubioTempo()           frame loop → beat timestamps, BPM       │ §5–6
 *     │  → computeChromaAndKey()     HPCP pipeline → key / scale / strength  │ §7–9
 *     └───────────────────────────────────────────────────────────────────────┘
 *     → merge and return combined result
 */

(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.analyseAudio = factory();
  }
}(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §1  Constants                                                      */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * aubio's Tempo tracker is designed and tested at 44 100 Hz.
   * Running it at another rate shifts its internal filter bank and
   * degrades accuracy, so we always resample to this rate before analysis.
   */
  var ANALYSIS_SAMPLE_RATE = 44100;

  /**
   * aubio Tempo parameter pair.
   *
   * bufferSize (window fed to the onset detection function):
   *   1024 samples ≈ 23 ms at 44 100 Hz — balances time and frequency
   *   resolution for typical music (60–200 BPM).
   *
   * hopSize (step between consecutive windows):
   *   512 samples = bufferSize / 2.  50 % overlap is the standard
   *   trade-off between temporal resolution and redundant computation.
   *   aubio's Tempo internally zero-pads its input to bufferSize, so
   *   feeding hopSize-length frames is correct.
   */
  var AUBIO_BUFFER_SIZE = 1024;
  var AUBIO_HOP_SIZE    = 512;

  /**
   * RMS amplitude below which a track is considered silent.
   * -60 dBFS ≈ 0.001.  Anything quieter is almost certainly a blank
   * region, a corrupt file, or a decode error producing all-zero samples.
   */
  var SILENCE_RMS_THRESHOLD = 0.001;

  /**
   * Minimum number of detected beats needed to compute a meaningful BPM.
   * Two beats define one inter-beat interval; fewer is not music.
   */
  var MIN_BEATS_FOR_BPM = 2;

  /* ── Chromagram / HPCP constants ──────────────────────────────────── */

  /**
   * Frame size for the STFT underlying HPCP computation.
   * 4096 samples ≈ 93 ms at 44 100 Hz.
   *
   * This matches Essentia's own KeyExtractor default.  Larger windows give
   * better frequency resolution for pitch-class detection (the lowest
   * chromagram bin, C2 ≈ 65 Hz, needs at least 1/65 s ≈ 680 samples of
   * window to resolve), while shorter windows would smear low harmonics.
   */
  var CHROMA_FRAME_SIZE = 4096;

  /**
   * Hop size between successive HPCP frames.
   * Set equal to CHROMA_FRAME_SIZE (no overlap) to match KeyExtractor and
   * reduce the number of WASM round-trips on long files.
   *
   * Key detection does not require sub-frame temporal resolution — the
   * tonal centre of a 4-bar phrase changes on the order of seconds, not
   * milliseconds — so non-overlapping frames are sufficient.
   */
  var CHROMA_HOP_SIZE = 4096;

  /**
   * Number of HPCP bins (pitch classes).
   * 36 = 3 bins per semitone.
   *
   * Why 36 rather than 12?
   * -----------------------
   * The Temperley key-detection profile compares the input chroma vector
   * against templates with subtle intra-semitone weighting.  Using 36 bins
   * preserves those sub-semitone nuances and is the Essentia default for
   * KeyExtractor.  The Key algorithm accepts pcpSize=36 directly.
   */
  var CHROMA_BIN_COUNT = 36;

  /**
   * Number of HPCP harmonics.
   * Each spectral peak is replicated at its 1st–8th harmonics before
   * mapping to the chroma bins, making the profile more robust to instruments
   * with strong upper partials (piano, guitar).  Matches Essentia default.
   */
  var CHROMA_HARMONICS = 8;

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §2  Decode + mono mix-down via OfflineAudioContext                 */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Decodes an ArrayBuffer and returns a mono Float32Array at the
   * source file's native sample rate.
   *
   * Why OfflineAudioContext instead of AudioContext.decodeAudioData?
   * ----------------------------------------------------------------
   * AudioContext.decodeAudioData works fine for decoding, but creating
   * a persistent AudioContext solely to decode is wasteful — it allocates
   * an audio output pipeline that is never actually used.  OfflineAudioContext
   * is purpose-built for offline rendering: no output device, no persistent
   * state, garbage-collected as soon as we drop the reference.
   *
   * The mix-down to mono is done by connecting the source through a
   * ChannelMergerNode configured for 1 output channel, which sums all
   * input channels using the browser's own equal-power downmix matrix
   * (ITU-R BS.775 for 5.1, simple average for stereo).  This is more
   * correct than the manual arithmetic approach because the browser uses
   * the same matrix it applies during normal playback.
   *
   * @param  {ArrayBuffer} arrayBuffer
   * @returns {Promise<{ pcm: Float32Array, sampleRate: number }>}
   */
  function decodeWithOfflineContext(arrayBuffer) {
    /*
     * We need to know the duration before we can construct the
     * OfflineAudioContext (it requires a length in frames).  The only
     * way to get that without a live AudioContext is a short two-pass
     * approach: decode once with a throwaway AudioContext to read
     * metadata, then re-render through OfflineAudioContext.
     *
     * In practice, the "throwaway" decodeAudioData call is cheap — it
     * does not start any audio hardware — and browsers pool the decoding
     * work so the second call returns from cache.
     */

    // Step 1 — probe duration and channel count via a minimal AudioContext.
    //          We need a fresh slice because decodeAudioData detaches the
    //          buffer it receives (Transferable semantics in some browsers).
    var probeBuf = arrayBuffer.slice(0);

    var AudioCtx  = window.AudioContext || window.webkitAudioContext;
    var probeCtx  = new AudioCtx();

    return new Promise(function (resolve, reject) {
      probeCtx.decodeAudioData(probeBuf, resolve, function (err) {
        // DOMException from decodeAudioData has no useful `.message` in all
        // browsers, so we construct a descriptive error ourselves.
        reject(new AudioDecodeError(
          "The audio file could not be decoded. " +
          "Supported formats depend on the browser/CEF engine: " +
          "WAV, MP3, AAC, OGG, FLAC. " +
          "Raw PCM, MIDI, and video-only files are not supported. " +
          "(Original error: " + (err ? err.message || err : "unknown") + ")"
        ));
      });
    })
    .then(function (probeBuffer) {
      probeCtx.close();   // release the audio output chain

      var nChannels  = probeBuffer.numberOfChannels;
      var nativeSR   = probeBuffer.sampleRate;
      var lengthFrames = probeBuffer.length;

      /*
       * Step 2 — render to mono via OfflineAudioContext.
       *
       * OfflineAudioContext(channels, lengthFrames, sampleRate)
       * We request 1 channel so the context's channel count matches our
       * mono output.  The ChannelMergerNode (1 output channel, N inputs)
       * performs the downmix.
       */
      var offlineCtx = new OfflineAudioContext(
        1,            // output: mono
        lengthFrames,
        nativeSR      // keep native rate here; resample separately if needed
      );

      var source = offlineCtx.createBufferSource();
      source.buffer = probeBuffer;

      if (nChannels === 1) {
        // Already mono — wire directly to destination.
        source.connect(offlineCtx.destination);
      } else {
        /*
         * Multi-channel → mono downmix.
         *
         * ChannelMergerNode is misnamed for this use case — what we actually
         * want is a downmix, which we achieve by:
         *   1. Creating a GainNode with channelCount=1 and
         *      channelCountMode="explicit" + channelInterpretation="speakers".
         *      The Web Audio spec mandates that the browser applies its
         *      standard downmix matrix when a node with fewer output channels
         *      than input channels is connected this way.
         */
        var downmix = offlineCtx.createGain();
        downmix.channelCount          = 1;
        downmix.channelCountMode      = "explicit";
        downmix.channelInterpretation = "speakers";

        source.connect(downmix);
        downmix.connect(offlineCtx.destination);
      }

      source.start(0);

      return offlineCtx.startRendering();
    })
    .then(function (renderedBuffer) {
      return {
        pcm:        renderedBuffer.getChannelData(0),  // mono Float32Array
        sampleRate: renderedBuffer.sampleRate
      };
    });
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §3  Silent-track guard                                             */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Computes the RMS amplitude of a Float32Array.
   * RMS = sqrt( mean( x[i]^2 ) )
   *
   * We use RMS rather than peak because a file can have occasional loud
   * transients while the bulk of the signal is silence (e.g. a clip with
   * a single clap at the very end).  RMS captures overall energy.
   *
   * @param  {Float32Array} pcm
   * @returns {number}
   */
  function computeRms(pcm) {
    var sumSq = 0;
    for (var i = 0; i < pcm.length; i++) {
      sumSq += pcm[i] * pcm[i];
    }
    return Math.sqrt(sumSq / pcm.length);
  }

  /**
   * Throws SilentTrackError when the decoded audio is below the silence
   * threshold — before we spend time loading the WASM module or running
   * the analysis loop.
   *
   * @param  {Float32Array} pcm
   * @throws {SilentTrackError}
   */
  function assertNotSilent(pcm) {
    if (pcm.length === 0) {
      throw new SilentTrackError("Decoded audio has zero length.");
    }
    var rms = computeRms(pcm);
    if (rms < SILENCE_RMS_THRESHOLD) {
      throw new SilentTrackError(
        "Audio track appears to be silent (RMS " + rms.toExponential(2) +
        " < threshold " + SILENCE_RMS_THRESHOLD + "). " +
        "Check that the clip is not muted, offline, or a blank region."
      );
    }
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §4  Resample to ANALYSIS_SAMPLE_RATE via OfflineAudioContext       */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Resamples a mono PCM buffer to ANALYSIS_SAMPLE_RATE using the
   * browser/CEF's built-in resampler (Speex or similar quality resampler,
   * not linear interpolation).
   *
   * Why not linear interpolation (as in the previous implementation)?
   * -----------------------------------------------------------------
   * Linear interpolation introduces aliasing artefacts at frequencies
   * above half the output Nyquist — audible as harshness, and more
   * importantly, detectable by aubio's onset filters as false transients.
   * The browser resampler applies a proper anti-aliasing filter.
   *
   * We trigger the resample by creating an AudioBuffer at the source rate
   * and rendering it through an OfflineAudioContext at the target rate.
   * The OfflineAudioContext constructor handles the rate conversion.
   *
   * @param  {Float32Array} pcm         Mono samples at sourceSampleRate.
   * @param  {number}       sourceSampleRate
   * @returns {Promise<Float32Array>}   Mono samples at ANALYSIS_SAMPLE_RATE.
   */
  function resampleIfNeeded(pcm, sourceSampleRate) {
    if (sourceSampleRate === ANALYSIS_SAMPLE_RATE) {
      return Promise.resolve(pcm);
    }

    // We need a throwaway AudioContext to create an AudioBuffer.
    // AudioBuffer constructor (new AudioBuffer({…})) is available in modern
    // browsers but NOT in older CEF builds, so we use the createBuffer path.
    var AudioCtx    = window.AudioContext || window.webkitAudioContext;
    var helperCtx   = new AudioCtx();

    var srcBuffer   = helperCtx.createBuffer(1, pcm.length, sourceSampleRate);
    srcBuffer.copyToChannel(pcm, 0);
    helperCtx.close();

    var outLength   = Math.ceil(pcm.length * ANALYSIS_SAMPLE_RATE / sourceSampleRate);
    var offlineCtx  = new OfflineAudioContext(1, outLength, ANALYSIS_SAMPLE_RATE);
    var source      = offlineCtx.createBufferSource();
    source.buffer   = srcBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);

    return offlineCtx.startRendering().then(function (rendered) {
      return rendered.getChannelData(0);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §5  aubio Tempo tracking                                           */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Loads the aubio WASM module, constructing it only once per page load.
   * Subsequent calls return the cached module.
   */
  var _aubioModulePromise = null;

  function loadAubioModule() {
    if (_aubioModulePromise) return _aubioModulePromise;

    if (typeof window.aubio === "undefined") {
      return Promise.reject(new Error(
        "window.aubio is not defined. " +
        "Ensure lib/aubio.js is loaded in index.html before audioAnalyser.js."
      ));
    }

    /*
     * aubio.js exports a factory function: aubio({ … }) → Promise<Module>.
     * We call it with an empty options object — all defaults are correct for
     * our use case (WASM loaded from the same directory, no custom memory).
     */
    _aubioModulePromise = window.aubio({});
    return _aubioModulePromise;
  }

  /**
   * Synchronous inner loop for aubio Tempo tracking.
   * Extracted from runAubioTempo so the retry path can reuse the same loop
   * without re-loading the WASM module (which is a singleton singleton).
   *
   * aubio Tempo constructor forms
   * ------------------------------
   * 3-arg: Tempo(bufferSize, hopSize, sampleRate)          — default onset method
   * 4-arg: Tempo(method, bufferSize, hopSize, sampleRate)  — explicit onset method
   *
   * Known onset method names (passed as the 4-arg first parameter):
   *   "default"  — energy + spectral flux combined (default)
   *   "hfc"      — high-frequency content
   *   "complex"  — complex-domain onset
   *   "phase"    — phase deviation
   *   "specdiff" — spectral difference
   *   "kl"       — Kullback-Leibler divergence
   *   "mkl"      — modified KL
   *   "specflux" — spectral flux
   *   "yinfft"   — YIN pitch estimator adapted for onset detection;
   *                works well on material where energy/flux methods miss
   *                onsets (e.g. sustained tones, heavy reverb, low-tempo material)
   *
   * @param  {AubioModule} aubioModule  Resolved WASM module from loadAubioModule().
   * @param  {Float32Array} pcm         Mono samples at ANALYSIS_SAMPLE_RATE.
   * @param  {number}       sampleRate  Must equal ANALYSIS_SAMPLE_RATE.
   * @param  {string|null}  method      Onset method name, or null for default.
   * @returns {{ bpm: number, beatTimestamps: Float32Array }}
   * @throws  {InsufficientBeatsError}  propagated from deriveBpm when < MIN_BEATS_FOR_BPM.
   */
  function _runTempoLoop(aubioModule, pcm, sampleRate) {
    // aubiojs@0.2.x only supports the 3-argument constructor.
    // The 4-argument (method, bufferSize, hopSize, sampleRate) form was removed.
    var tempo = new aubioModule.Tempo(AUBIO_BUFFER_SIZE, AUBIO_HOP_SIZE, sampleRate);

    var beatTimesMs = [];
    var numFrames   = Math.floor(pcm.length / AUBIO_HOP_SIZE);

    for (var i = 0; i < numFrames; i++) {
      var frameStart = i * AUBIO_HOP_SIZE;
      var frame      = pcm.slice(frameStart, frameStart + AUBIO_HOP_SIZE);

      // aubiojs v0.2.x: tempo.do() returns 1 when a beat is detected, 0 otherwise.
      // Older v0.1.x had a separate tempo.getBeat() method which no longer exists.
      var isBeat = tempo.do(frame);

      if (isBeat) {
        // getLastMs() returns the beat position in ms from the stream start
        // (not relative to the current frame) — sub-frame accurate.
        // Fall back to frame midpoint if the method is absent in a future build.
        var ms = typeof tempo.getLastMs === "function"
          ? tempo.getLastMs()
          : ((frameStart + AUBIO_HOP_SIZE / 2) / sampleRate) * 1000;
        beatTimesMs.push(ms);
      }
    }

    // deriveBpm throws InsufficientBeatsError when < MIN_BEATS_FOR_BPM beats.
    var bpm = deriveBpm(beatTimesMs, sampleRate);

    // Emscripten uses .delete() to free heap memory; .free() was an older alias.
    if (typeof tempo.delete === "function") tempo.delete();
    else if (typeof tempo.free === "function") tempo.free();

    var beatTimestamps = new Float32Array(beatTimesMs.length);
    for (var j = 0; j < beatTimesMs.length; j++) {
      beatTimestamps[j] = beatTimesMs[j] / 1000;
    }

    return { bpm: bpm, beatTimestamps: beatTimestamps };
  }

  /**
   * Runs aubio's Tempo tracker over mono PCM data.
   *
   * Primary onset method: "default" (energy + spectral flux).
   * Fallback onset method: "yinfft" — used automatically if the primary
   * method returns 0 or NaN BPM, or throws InsufficientBeatsError.
   *
   * The yinfft method uses YIN pitch-based onset detection and is more
   * sensitive to material where energy/flux onsets are weak or ambiguous
   * (e.g. heavily reverberant recordings, sustained-tone music, very
   * slow tempos, or acoustic material with smooth attack envelopes).
   *
   * @param  {Float32Array} pcm         Mono at ANALYSIS_SAMPLE_RATE.
   * @param  {number}       sampleRate  Must equal ANALYSIS_SAMPLE_RATE.
   * @returns {Promise<{ bpm: number, beatTimestamps: Float32Array }>}
   */
  function runAubioTempo(pcm, sampleRate) {
    return loadAubioModule().then(function (aubioModule) {
      var result;

      try {
        result = _runTempoLoop(aubioModule, pcm, sampleRate);

        // Guard against degenerate BPM values.
        if (!result.bpm || isNaN(result.bpm) || result.bpm === 0) {
          throw new InsufficientBeatsError(
            "aubio Tempo returned degenerate BPM (" + result.bpm + "). " +
            "The clip may have no clear rhythmic pulse, or may be too short."
          );
        }

        return result;

      } catch (err) {
        // Re-throw so the caller can surface the error in the UI.
        throw err;
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §6  BPM derivation from inter-beat intervals                       */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Computes BPM from a list of beat timestamps (in milliseconds).
   *
   * Why not use aubio's getBpm()?
   * ------------------------------
   * aubio's getBpm() returns the instantaneous BPM estimate after each
   * frame — it is a running average that can drift significantly at the
   * start (before enough beats are detected) and at tempo changes.
   * Averaging those per-frame values accumulates the drift.
   *
   * The IBI (inter-beat interval) median approach is more robust:
   *   1. Compute all IBIs: IBI[i] = beatTimes[i+1] - beatTimes[i]  (in ms)
   *   2. Take the median IBI (not mean) to reject outliers from false
   *      positives or missed beats.
   *   3. BPM = 60 000 / medianIBI
   *
   * The median is preferred over mean because a single doubled IBI (missed
   * beat) or halved IBI (false double) shifts the mean by ~1 BPM but does
   * not shift the median at all, provided < 50 % of beats are affected.
   *
   * @param  {number[]} beatTimesMs  Beat positions in milliseconds.
   * @param  {number}   sampleRate   Used only for the error message.
   * @returns {number}  BPM rounded to two decimal places.
   * @throws  {InsufficientBeatsError}
   */
  function deriveBpm(beatTimesMs, sampleRate) {
    if (beatTimesMs.length < MIN_BEATS_FOR_BPM) {
      throw new InsufficientBeatsError(
        "Only " + beatTimesMs.length + " beat(s) detected " +
        "(minimum " + MIN_BEATS_FOR_BPM + " required to compute BPM). " +
        "The audio may be too short, the tempo too slow, or the signal " +
        "too quiet after the silence check. " +
        "Analysis parameters: bufferSize=" + AUBIO_BUFFER_SIZE +
        ", hopSize=" + AUBIO_HOP_SIZE +
        ", sampleRate=" + sampleRate + "."
      );
    }

    // Build inter-beat interval array.
    var ibis = [];
    for (var i = 1; i < beatTimesMs.length; i++) {
      ibis.push(beatTimesMs[i] - beatTimesMs[i - 1]);
    }

    // Compute median IBI.
    ibis.sort(function (a, b) { return a - b; });
    var mid        = Math.floor(ibis.length / 2);
    var medianIbi  = ibis.length % 2 === 0
      ? (ibis[mid - 1] + ibis[mid]) / 2
      : ibis[mid];

    var bpm = 60000 / medianIbi;

    // Sanity-clamp: physically plausible music range is 20–400 BPM.
    // Values outside this range indicate analysis failure rather than
    // an exotic tempo, so we surface a warning but still return the value.
    if (bpm < 20 || bpm > 400) {
      console.warn(
        "[audioAnalyser] Derived BPM " + bpm.toFixed(2) +
        " is outside the expected range (20–400 BPM). " +
        "Results may be inaccurate for this material."
      );
    }

    return Math.round(bpm * 100) / 100;  // two decimal places
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §7  Essentia WASM loader                                           */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Initialises the Essentia.js instance once and caches the Promise.
   *
   * window.Essentia accepted shapes
   * --------------------------------
   * The essentia.js bundle can be consumed in two ways depending on how
   * index.html loads and initialises it:
   *
   *   (a) Pre-initialised instance
   *       window.Essentia is already a fully constructed Essentia object
   *       (i.e. `new Essentia(EssentiaWASM)` was called during page load).
   *       Detection: typeof window.Essentia.arrayToVector === 'function'
   *
   *   (b) Async factory function
   *       window.Essentia is a function that returns a Promise resolving
   *       to an Essentia instance (e.g. the IIFE bundle's default export).
   *       Detection: typeof window.Essentia === 'function'
   *
   * In both cases the resolved value is an object with:
   *   .arrayToVector(Float32Array) → VectorFloat
   *   .vectorToArray(VectorFloat)  → Float32Array
   *   .Windowing(…), .Spectrum(…), .SpectralPeaks(…), .HPCP(…), .Key(…)
   *
   * @returns {Promise<EssentiaInstance>}
   */
  var _essentiaPromise = null;

  function loadEssentia() {
    if (_essentiaPromise) return _essentiaPromise;

    if (typeof window.Essentia === "undefined") {
      return Promise.reject(new Error(
        "window.Essentia is not defined. " +
        "Ensure lib/essentia.js is loaded in index.html before audioAnalyser.js. " +
        "window.Essentia must be either an initialised Essentia instance " +
        "or an async factory function returning one."
      ));
    }

    if (typeof window.Essentia.arrayToVector === "function") {
      // Shape (a) — already initialised, use directly.
      _essentiaPromise = Promise.resolve(window.Essentia);
    } else if (typeof window.Essentia === "function") {
      // Shape (b) — factory; call it and normalise to Promise.
      _essentiaPromise = Promise.resolve(window.Essentia()).then(function (result) {
        // Some factories return the instance directly (non-Promise); others
        // return a Promise.  Promise.resolve() flattens both cases.
        if (!result || typeof result.arrayToVector !== "function") {
          throw new Error(
            "window.Essentia() did not return a valid Essentia instance. " +
            "Expected an object with an arrayToVector() method."
          );
        }
        return result;
      });
    } else {
      return Promise.reject(new Error(
        "window.Essentia has an unrecognised shape (not a function and not an " +
        "instance with arrayToVector). Check your essentia.js bundle and " +
        "initialisation code in index.html."
      ));
    }

    return _essentiaPromise;
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §8  Chromagram computation — HPCP pipeline                        */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Computes a mean HPCP (Harmonic Pitch Class Profile) vector from a
   * mono PCM buffer using Essentia's standard KeyExtractor-equivalent
   * pipeline: Windowing → Spectrum → SpectralPeaks → HPCP.
   *
   * What is HPCP?
   * -------------
   * HPCP is Essentia's chromagram.  Each of the CHROMA_BIN_COUNT bins
   * (default 36 = 3 per semitone × 12 semitones) holds the summed energy
   * of all spectral peaks that map to the corresponding pitch class, weighted
   * by a squared-cosine function and replicated across CHROMA_HARMONICS
   * upper harmonics.  Averaging across all frames gives a single vector
   * that summarises the tonal content of the whole file.
   *
   * Pipeline per frame
   * ------------------
   *  1. Windowing   — apply a Hann window to suppress spectral leakage.
   *                   zeroPhase=false keeps the window centred in time
   *                   (not phase-shifted), which is correct for magnitude
   *                   spectrum analysis (phase doesn't matter for HPCP).
   *
   *  2. Spectrum    — compute the real-valued magnitude spectrum via FFT.
   *                   Output length = frameSize / 2 + 1 (positive freqs only).
   *
   *  3. SpectralPeaks — find local maxima above a magnitude threshold.
   *                   'byFrequency' ordering is required by HPCP (it
   *                   expects peaks sorted ascending by frequency).
   *                   Frequency band: 20 Hz (below piano range excluded) to
   *                   3500 Hz (upper harmonic content; HPCP ignores higher
   *                   peaks anyway due to reference/window parameters).
   *
   *  4. HPCP        — map spectral peaks to 36-bin chroma using the
   *                   squared-cosine weighting function, accounting for
   *                   harmonics 1–8 of each peak.
   *                   'unitMax' normalisation keeps all frames on a
   *                   comparable scale regardless of overall level.
   *
   * Memory management
   * -----------------
   * Every VectorFloat allocated on the WASM heap via arrayToVector() or
   * returned by an Essentia algorithm must be explicitly .delete()'d.
   * Failure to do so leaks WASM memory — there is no GC for the WASM heap.
   * Each frame's intermediate vectors are deleted before the next iteration.
   *
   * @param  {Float32Array} pcm        Mono samples at ANALYSIS_SAMPLE_RATE.
   * @param  {number}       sampleRate Must equal ANALYSIS_SAMPLE_RATE.
   * @returns {Promise<Float32Array>}  Mean HPCP vector (length = CHROMA_BIN_COUNT).
   * @throws  {KeyDetectionError}      If no valid harmonic frames found.
   */
  function computeChromagram(pcm, sampleRate) {
    return loadEssentia().then(function (essentia) {
      var frameSize = CHROMA_FRAME_SIZE;
      var hopSize   = CHROMA_HOP_SIZE;
      var binCount  = CHROMA_BIN_COUNT;

      var hpcpAccum  = new Float32Array(binCount);
      var validFrames = 0;
      var numFrames   = Math.floor((pcm.length - frameSize) / hopSize) + 1;

      for (var i = 0; i < numFrames; i++) {
        var start = i * hopSize;

        // Build the frame, zero-padding the final partial frame if needed.
        var frameData;
        if (start + frameSize <= pcm.length) {
          frameData = pcm.slice(start, start + frameSize);
        } else {
          frameData = new Float32Array(frameSize);
          frameData.set(pcm.subarray(start));
        }

        // ── 1. Windowing (Hann) ─────────────────────────────────────────
        var frameVec  = essentia.arrayToVector(frameData);
        var windowed  = essentia.Windowing(
          frameVec,
          true,    // normalize: scale by 1/N so level doesn't affect HPCP
          0,       // zeroPadding: none (frame is already frameSize)
          "hann",  // type
          false    // zeroPhase: false → standard causal window
        );
        frameVec.delete();

        // ── 2. Magnitude spectrum (real FFT, positive freqs only) ────────
        var spectrumResult = essentia.Spectrum(windowed.frame, frameSize);
        windowed.frame.delete();

        // ── 3. Spectral peaks ────────────────────────────────────────────
        //
        // magnitudeThreshold = 0.0001:
        //   Rejects noise-floor peaks (–80 dBFS) without cutting real harmonics.
        //   A stricter threshold risks missing quiet overtones of soft instruments.
        //
        // maxPeaks = 60:
        //   Matches Essentia KeyExtractor default; enough peaks to capture
        //   complex chords without including too much noise.
        //
        // orderBy = 'byFrequency':
        //   HPCP requires peaks sorted ascending by frequency — Essentia
        //   will throw an assertion error if they arrive in magnitude order.
        //
        var peaksResult = essentia.SpectralPeaks(
          spectrumResult.spectrum,
          0.0001,        // magnitudeThreshold
          3500,          // maxFrequency (Hz) — matches HPCP maxFrequency
          60,            // maxPeaks
          20,            // minFrequency (Hz)
          "byFrequency", // orderBy — required by HPCP
          sampleRate
        );
        spectrumResult.spectrum.delete();

        // Skip silent / unpitched frames (no peaks above threshold).
        var freqArray = essentia.vectorToArray(peaksResult.frequencies);
        if (freqArray.length === 0) {
          peaksResult.frequencies.delete();
          peaksResult.magnitudes.delete();
          continue;
        }

        // ── 4. HPCP (Harmonic Pitch Class Profile) ───────────────────────
        //
        // harmonics = CHROMA_HARMONICS (8):
        //   Each peak is replicated at f*2, f*3, … f*9 before bin mapping,
        //   making the profile robust to instruments with strong upper partials.
        //
        // normalized = 'unitMax':
        //   Divides each HPCP vector by its maximum value, keeping all frames
        //   on the same [0,1] scale regardless of recording level.
        //   Alternative 'unitSum' would be distorted by sparse peak frames.
        //
        // weightType = 'squaredCosine':
        //   Applies a squared-cosine envelope around each bin's centre
        //   frequency, smoothly distributing energy between adjacent bins
        //   rather than hard-assigning to a single bin.
        //
        // referenceFrequency = 440:
        //   A4 = 440 Hz anchors the bin positions.  Essentia's HPCP
        //   assumes standard Western tuning; detuned recordings may need
        //   a tuning-estimation pre-pass (not implemented here).
        //
        var hpcpResult = essentia.HPCP(
          peaksResult.frequencies,
          peaksResult.magnitudes,
          true,              // bandPreset
          500,               // bandSplitFrequency (Hz, splits low/high bands in preset)
          CHROMA_HARMONICS,  // harmonics
          3500,              // maxFrequency (Hz)
          false,             // maxShifted
          20,                // minFrequency (Hz)
          false,             // nonLinear
          "unitMax",         // normalized
          440,               // referenceFrequency (Hz)
          sampleRate,
          binCount,          // size = 36
          500,               // splitFrequency (Hz, used when bandPreset=true)
          "squaredCosine",   // weightType
          1                  // windowSize (semitones, controls bin width)
        );
        peaksResult.frequencies.delete();
        peaksResult.magnitudes.delete();

        // Accumulate HPCP bins into the running sum.
        var hpcpData = essentia.vectorToArray(hpcpResult.hpcp);
        hpcpResult.hpcp.delete();

        for (var b = 0; b < binCount; b++) {
          hpcpAccum[b] += hpcpData[b];
        }
        validFrames++;
      }

      if (validFrames === 0) {
        throw new KeyDetectionError(
          "No valid harmonic frames found during chromagram computation. " +
          "The audio may contain only noise, silence, or unpitched transients " +
          "with no spectral peaks above the detection threshold. " +
          "Analysis parameters: frameSize=" + frameSize +
          ", hopSize=" + hopSize +
          ", sampleRate=" + sampleRate + "."
        );
      }

      // Normalise the accumulator → mean HPCP across all valid frames.
      for (var b = 0; b < binCount; b++) {
        hpcpAccum[b] /= validFrames;
      }

      return hpcpAccum;
    });
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §9  Key detection — Essentia Key algorithm (Temperley profile)     */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Runs Essentia's Key algorithm over a mean HPCP vector to determine
   * the musical key and scale using the Temperley profile.
   *
   * Key algorithm internals
   * -----------------------
   * The Key algorithm scores the input PCP vector against a set of
   * major/minor templates (one per pitch class × scale = 24 hypotheses)
   * using a dot-product similarity.  The template with the highest score
   * wins; `strength` is that normalised score.
   *
   * Profile choice: Temperley
   * -------------------------
   * Essentia ships several key-detection profiles:
   *
   *   'temperley'    — Temperley (2001).  Weights derived empirically from
   *                    a corpus of Western tonal music.  Best general-purpose
   *                    accuracy on pop, rock, classical.
   *
   *   'krumhansl'    — Krumhansl & Kessler (1982).  Earlier psychoacoustic
   *                    model; slightly less accurate on modern pop.
   *
   *   'edma'         — Pitch-class distribution model; better for modal music.
   *
   *   'bgate'        — Pitch-class profile from Bgate (2009).
   *
   * We use 'temperley' as it performs best on mainstream Western music,
   * which covers the majority of video-editing use cases.
   *
   * Parameter rationale
   * -------------------
   *   numHarmonics = 4:
   *     The Key algorithm internally weights harmonics 1–4 of each key
   *     degree when comparing against the PCP.  4 is the Essentia default
   *     and balances richness vs. overtone crosstalk.
   *
   *   pcpSize = CHROMA_BIN_COUNT (36):
   *     Must match the HPCP vector length passed in.
   *
   *   slope = 0.6:
   *     Controls the steepness of the harmonic weighting falloff.
   *     Higher values down-weight upper harmonics more aggressively.
   *     0.6 is the Essentia default for Temperley.
   *
   *   useMajMin = false:
   *     When true, the algorithm considers only the relative major/minor
   *     pair rather than all 24 keys.  false gives the full search.
   *
   *   useThreeChords = true:
   *     Weights the I, IV, and V chords of each key more heavily, which
   *     improves accuracy for music that establishes key via functional
   *     harmony (most Western pop/rock).
   *
   * @param  {Float32Array} meanHpcp   Output of computeChromagram().
   * @returns {Promise<{ key, scale, keyStrength }>}
   */
  function runKeyDetection(meanHpcp) {
    return loadEssentia().then(function (essentia) {
      var hpcpVec = essentia.arrayToVector(meanHpcp);

      var result = essentia.Key(
        hpcpVec,
        4,               // numHarmonics
        CHROMA_BIN_COUNT, // pcpSize = 36
        "temperley",     // profileType
        0.6,             // slope
        false,           // useMajMin
        true             // useThreeChords
      );

      hpcpVec.delete();

      // strength comes back as a raw float; round to 4 d.p. for clean JSON.
      return {
        key:         result.key,
        scale:       result.scale,
        keyStrength: Math.round(result.strength * 10000) / 10000
      };
    });
  }

  /**
   * Convenience wrapper: decode chromagram then run key detection.
   * This is what analyseAudio() calls; the two steps are kept separate so
   * each can be unit-tested independently.
   *
   * @param  {Float32Array} pcm
   * @param  {number}       sampleRate
   * @returns {Promise<{ key, scale, keyStrength }>}
   */
  /**
   * Runs key detection via a Web Worker (essentiaWorker.js) to avoid CEP's
   * main-thread WASM compilation restriction on buffers > 4 KB.
   * Falls back to the in-process path if Workers are unavailable.
   */
  function computeChromaAndKey(pcm, sampleRate) {
    if (typeof Worker === "undefined") {
      // Fallback for environments without Worker support.
      return computeChromagram(pcm, sampleRate).then(runKeyDetection);
    }

    return new Promise(function (resolve, reject) {
      var worker;
      try {
        worker = new Worker("js/essentiaWorker.js");
      } catch (e) {
        // Worker creation failed — fall back to in-process.
        return computeChromagram(pcm, sampleRate).then(runKeyDetection).then(resolve, reject);
      }

      var timeout = setTimeout(function () {
        worker.terminate();
        reject(new Error("Key detection worker timed out after 60 s."));
      }, 60000);

      worker.onmessage = function (e) {
        clearTimeout(timeout);
        worker.terminate();
        var data = e.data;
        if (data.type === "keyResult") {
          resolve(data.result);
        } else {
          reject(new Error(data.message || "Key detection worker error."));
        }
      };

      worker.onerror = function (e) {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error("Key detection worker error: " + (e.message || e)));
      };

      // Transfer the PCM buffer to the worker (zero-copy).
      var transferBuf = pcm.buffer.slice(0);
      worker.postMessage(
        { type: "analyseKey", pcm: new Float32Array(transferBuf), sampleRate: sampleRate },
        [transferBuf]
      );
    });
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §10  Named error classes                                           */
  /* ═══════════════════════════════════════════════════════════════════ */

  /*
   * Custom error types let callers distinguish failure modes with
   * `err instanceof AudioDecodeError` instead of string-matching messages.
   * We extend Error manually (no class syntax) for ES5 compatibility.
   */

  function AudioDecodeError(message) {
    this.name    = "AudioDecodeError";
    this.message = message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, AudioDecodeError);
  }
  AudioDecodeError.prototype = Object.create(Error.prototype);
  AudioDecodeError.prototype.constructor = AudioDecodeError;

  function SilentTrackError(message) {
    this.name    = "SilentTrackError";
    this.message = message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, SilentTrackError);
  }
  SilentTrackError.prototype = Object.create(Error.prototype);
  SilentTrackError.prototype.constructor = SilentTrackError;

  function InsufficientBeatsError(message) {
    this.name    = "InsufficientBeatsError";
    this.message = message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, InsufficientBeatsError);
  }
  InsufficientBeatsError.prototype = Object.create(Error.prototype);
  InsufficientBeatsError.prototype.constructor = InsufficientBeatsError;

  /**
   * Thrown when the HPCP pipeline finds no valid harmonic frames,
   * making key detection impossible (e.g. pure noise, drums-only track,
   * or a file that passed the RMS silence check but has no pitched content).
   */
  function KeyDetectionError(message) {
    this.name    = "KeyDetectionError";
    this.message = message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, KeyDetectionError);
  }
  KeyDetectionError.prototype = Object.create(Error.prototype);
  KeyDetectionError.prototype.constructor = KeyDetectionError;

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §11  Public entry point                                            */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Analyses an audio file and returns its tempo, beat grid, and musical key.
   *
   * @param  {ArrayBuffer} arrayBuffer
   *   Raw bytes of any browser-decodable audio format (WAV, MP3, AAC, OGG, FLAC).
   *   Obtain via:
   *     • fetch(url).then(r => r.arrayBuffer())
   *     • FileReader.readAsArrayBuffer(file)
   *     • cepBridge.readFileAsBase64() → atob() → Uint8Array → .buffer
   *
   * @returns {Promise<{
   *   bpm:            number,        — stable tempo in BPM (2 d.p.)
   *   beatTimestamps: Float32Array,  — beat onset times in seconds
   *   key:            string,        — e.g. "C", "F#", "Bb"
   *   scale:          string,        — "major" or "minor"
   *   keyStrength:    number         — similarity score [0, 1], 4 d.p.
   * }>}
   *
   * @throws {AudioDecodeError}       unsupported format or corrupt file
   * @throws {SilentTrackError}       RMS below silence threshold
   * @throws {InsufficientBeatsError} fewer than MIN_BEATS_FOR_BPM beats found
   * @throws {KeyDetectionError}      no harmonic content; key detection impossible
   * @throws {TypeError}              input is not an ArrayBuffer
   *
   * Usage example:
   *   analyseAudio(buffer)
   *     .then(function (result) {
   *       console.log(result.bpm);               // e.g. 128.00
   *       console.log(result.beatTimestamps[0]); // e.g. 0.3481  (seconds)
   *       console.log(result.key);               // e.g. "A"
   *       console.log(result.scale);             // e.g. "minor"
   *       console.log(result.keyStrength);       // e.g. 0.8732
   *     })
   *     .catch(function (err) {
   *       if (err instanceof analyseAudio.SilentTrackError) { … }
   *       if (err instanceof analyseAudio.KeyDetectionError) { … }
   *     });
   */
  async function analyseAudio(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer)) {
      throw new TypeError(
        "analyseAudio expects an ArrayBuffer. Received: " +
        Object.prototype.toString.call(arrayBuffer)
      );
    }
    if (arrayBuffer.byteLength === 0) {
      throw new AudioDecodeError("ArrayBuffer is empty (0 bytes).");
    }

    // Step 1 — decode to mono PCM at the file's native sample rate.
    var decoded = await decodeWithOfflineContext(arrayBuffer);

    // Step 2 — reject silent / corrupt files before loading WASM modules.
    assertNotSilent(decoded.pcm);

    // Step 3 — resample to the shared analysis rate (no-op if already 44 100 Hz).
    //          Both aubio and Essentia operate on this same buffer.
    var pcm = await resampleIfNeeded(decoded.pcm, decoded.sampleRate);

    // Step 4 — run beat tracking (aubio) and key detection (Essentia) in parallel.
    //
    // Why parallel?
    //   Both tasks read from the same immutable `pcm` Float32Array and write
    //   to independent WASM heap allocations.  There is no shared mutable
    //   state between them, so Promise.all is safe and cuts total wall-clock
    //   time roughly in half on a warm WASM module.
    //
    // Note on the `pcm` buffer:
    //   Float32Array.slice() (used in both loops) returns a *copy*, so each
    //   WASM call receives its own heap buffer.  The underlying `pcm` view is
    //   only read, never written, by either task.
    //
    var results = await Promise.all([
      runAubioTempo(pcm, ANALYSIS_SAMPLE_RATE),
      computeChromaAndKey(pcm, ANALYSIS_SAMPLE_RATE).catch(function (err) {
        // Key detection is non-fatal. CEP panels restrict synchronous WASM
        // compilation on the main thread; essentia.js may fail to initialise
        // in some host environments. BPM analysis proceeds regardless.
        console.warn("[audioAnalyser] Key detection unavailable: " + err.message);
        return { key: "\u2014", scale: "\u2014", keyStrength: 0 };
      })
    ]);

    var tempoResult = results[0];
    var keyResult   = results[1];

    return {
      bpm:            tempoResult.bpm,
      beatTimestamps: tempoResult.beatTimestamps,
      key:            keyResult.key,
      scale:          keyResult.scale,
      keyStrength:    keyResult.keyStrength
    };
  }

  // Expose named error classes as properties so callers can instanceof-check
  // without a separate import.
  analyseAudio.AudioDecodeError       = AudioDecodeError;
  analyseAudio.SilentTrackError       = SilentTrackError;
  analyseAudio.InsufficientBeatsError = InsufficientBeatsError;
  analyseAudio.KeyDetectionError      = KeyDetectionError;

  return analyseAudio;
}));
