/**
 * audioAnalyser.js — Beat tracking via aubio.js + Web Audio API
 *
 * Public API
 * ----------
 *   analyseAudio(input) → Promise<{ bpm: number, beatTimestamps: Float32Array }>
 *
 *   input  — ArrayBuffer of any browser-decodable audio (WAV, MP3, AAC, FLAC, OGG…)
 *
 * Dependencies
 * ------------
 *   window.aubio  — aubio.js WASM factory, loaded in index.html before this script.
 *                   Expected shape:  aubio({ … }) → Promise<AubioModule>
 *                   AubioModule.Tempo(bufferSize, hopSize, sampleRate) → TempoTracker
 *
 * Internal pipeline
 * -----------------
 *   ArrayBuffer
 *     → decodeWithOfflineContext()   decode + mix-down to mono Float32Array
 *     → assertNotSilent()            throw early on silent / empty tracks
 *     → resampleIfNeeded()           bring to ANALYSIS_SAMPLE_RATE via OfflineAudioContext
 *     → runAubioTempo()              hop through PCM frames, collect beat events
 *     → deriveBpm()                  compute stable BPM from inter-beat intervals
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
   * Runs aubio's Tempo tracker over mono PCM data using the "default" method.
   *
   * aubio Tempo internals
   * ---------------------
   * The Tempo object implements a phase-vocoder-based beat tracker using the
   * "default" onset detection function (a combination of energy-based and
   * spectral-flux detection).  Each call to tempo.do(frame) feeds a hopSize-
   * length window of samples.  The tracker accumulates phase information
   * across calls — hence the sequential loop; frames cannot be parallelised.
   *
   * Beat timestamp derivation
   * -------------------------
   * tempo.getLastMs() returns the position of the detected beat *within the
   * current frame* in milliseconds from the start of the audio.  This is
   * more accurate than computing the beat time from the frame index alone
   * because aubio interpolates the exact onset position within the hop window
   * using phase information.
   *
   * Beat position formula (frame-index-only fallback):
   *   beatTime = (frameIndex * hopSize) / sampleRate
   * But getLastMs() / 1000 is always preferred as it sub-frame-accurate.
   *
   * @param  {Float32Array} pcm         Mono at ANALYSIS_SAMPLE_RATE.
   * @param  {number}       sampleRate  Must equal ANALYSIS_SAMPLE_RATE.
   * @returns {Promise<{ bpm: number, beatTimestamps: Float32Array }>}
   */
  function runAubioTempo(pcm, sampleRate) {
    return loadAubioModule().then(function (aubioModule) {
      var tempo = new aubioModule.Tempo(
        AUBIO_BUFFER_SIZE,
        AUBIO_HOP_SIZE,
        sampleRate
      );

      var beatTimesMs = [];   // beat positions in milliseconds (from aubio)
      var numFrames   = Math.floor(pcm.length / AUBIO_HOP_SIZE);

      /*
       * Pre-allocate a reusable hop-sized Float32Array to avoid creating
       * a new typed array on every iteration.  pcm.subarray() returns a
       * view (no copy), but aubio.js's WASM binding may require a copy
       * depending on whether it accepts non-WASM-heap buffers.
       * Using slice() here for maximum compatibility.
       */
      for (var i = 0; i < numFrames; i++) {
        var frameStart = i * AUBIO_HOP_SIZE;
        var frame      = pcm.slice(frameStart, frameStart + AUBIO_HOP_SIZE);

        tempo.do(frame);

        if (tempo.getBeat()) {
          /*
           * getLastMs() returns the beat position in ms from the start of
           * the stream, not relative to the current frame.  It is the most
           * accurate timestamp aubio can provide.
           */
          beatTimesMs.push(tempo.getLastMs());
        }
      }

      /*
       * Compute stable BPM from collected beat timestamps.
       * This is deferred to deriveBpm() which uses inter-beat intervals
       * rather than aubio's running getBpm() average (see §6 for rationale).
       */
      var bpm = deriveBpm(beatTimesMs, sampleRate);

      tempo.free();  // release WASM heap allocation

      // Convert ms array → Float32Array of seconds for the public API.
      var beatTimestamps = new Float32Array(beatTimesMs.length);
      for (var j = 0; j < beatTimesMs.length; j++) {
        beatTimestamps[j] = beatTimesMs[j] / 1000;
      }

      return { bpm: bpm, beatTimestamps: beatTimestamps };
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
  /*  §7  Named error classes                                            */
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

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §8  Public entry point                                             */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Analyses an audio file and returns its tempo and beat grid.
   *
   * @param  {ArrayBuffer} arrayBuffer
   *   Raw bytes of any browser-decodable audio format (WAV, MP3, AAC,
   *   OGG, FLAC).  Obtain this via:
   *     • fetch(url).then(r => r.arrayBuffer())
   *     • FileReader.readAsArrayBuffer(file)
   *     • cepBridge.readFileAsBase64() → atob() → Uint8Array → .buffer
   *
   * @returns {Promise<{ bpm: number, beatTimestamps: Float32Array }>}
   *   bpm            — stable tempo in beats per minute (2 d.p.)
   *   beatTimestamps — onset times in seconds as a Float32Array,
   *                    suitable for direct use with placeMarkersAtTimecodes()
   *
   * @throws {AudioDecodeError}       unsupported format or corrupt file
   * @throws {SilentTrackError}       audio is below the silence threshold
   * @throws {InsufficientBeatsError} fewer than MIN_BEATS_FOR_BPM detected
   * @throws {Error}                  window.aubio not loaded, or other runtime fault
   *
   * Usage example:
   *   analyseAudio(buffer)
   *     .then(function(result) {
   *       console.log(result.bpm);               // e.g. 128.00
   *       console.log(result.beatTimestamps[0]);  // e.g. 0.3481
   *     })
   *     .catch(function(err) {
   *       if (err instanceof SilentTrackError) { … }
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

    // Step 2 — reject silent / corrupt files before spinning up WASM.
    assertNotSilent(decoded.pcm);

    // Step 3 — resample to aubio's expected rate (no-op if already 44 100 Hz).
    var pcm = await resampleIfNeeded(decoded.pcm, decoded.sampleRate);

    // Step 4 — run beat tracker.
    return runAubioTempo(pcm, ANALYSIS_SAMPLE_RATE);
  }

  // Attach named error classes as properties so callers can reference them
  // without importing separately.
  analyseAudio.AudioDecodeError       = AudioDecodeError;
  analyseAudio.SilentTrackError       = SilentTrackError;
  analyseAudio.InsufficientBeatsError = InsufficientBeatsError;

  return analyseAudio;
}));
