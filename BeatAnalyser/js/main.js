/**
 * main.js — Beat Analyser panel: UI wiring and workflow orchestration
 *
 * Depends on (loaded before this script in index.html):
 *   window.cepBridge    — js/cepBridge.js
 *   window.analyseAudio — js/audioAnalyser.js
 *
 * Workflow
 * --------
 *   Analyse Active Clip
 *     cepBridge.getAudioFilePath()          §6a
 *       → cepBridge.readFileAsArrayBuffer() §6b
 *         → analyseAudio(arrayBuffer)       §6c
 *           → renderResults()               §6d
 *
 *   Place Beat Markers
 *     cepBridge.getActiveSequenceInfo()     §7
 *       → cepBridge.sendMarkersToTimeline() §7
 *
 *   Export Timeline
 *     cepBridge.exportTimeline()            §8
 */

(function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §1  Constants                                                      */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Premiere Pro's internal clock resolution: 254 016 000 000 ticks/second.
   * Dividing by sequence.timebase (ticks/frame) gives raw frames-per-second.
   */
  var TICKS_PER_SECOND = 254016000000;

  /**
   * Standard frame rates to snap to when deriving FPS from the timebase.
   * The derived FPS is only used for the marker comment text in hostScript,
   * so approximate snapping is fine.
   */
  var STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

  /**
   * keyStrength threshold above which the results card gains the
   * .is-strong modifier (strength bar turns green).
   */
  var STRONG_KEY_THRESHOLD = 0.75;

  /**
   * Premiere Pro allows at most 999 markers per sequence.
   * Attempting to place more will silently drop the excess or produce
   * confusing behaviour in older builds.  When beat count exceeds this
   * threshold we prompt the user to choose a placement stride.
   */
  var PREMIERE_MARKER_LIMIT = 999;

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §2  DOM cache                                                      */
  /* ═══════════════════════════════════════════════════════════════════ */

  var dom = {};

  function cacheDom() {
    // ── Buttons ──────────────────────────────────────────────────────
    dom.analyseBtn      = document.getElementById("btn-analyse");
    dom.analyseBtnLabel = document.getElementById("btn-analyse-label");
    dom.addMarkersBtn   = document.getElementById("btn-add-markers");
    dom.clearMarkersBtn = document.getElementById("btn-clear-markers");
    dom.browseExportBtn = document.getElementById("btn-browse-export");
    dom.exportBtn       = document.getElementById("btn-export");

    // ── Inputs / displays ────────────────────────────────────────────
    dom.filePathDisplay = document.getElementById("file-path");
    dom.exportPath      = document.getElementById("export-path");
    dom.hostVersion     = document.getElementById("host-version");

    // ── Spinner (inside the Analyse button) ──────────────────────────
    dom.spinner         = document.getElementById("spinner");

    // ── Results card ─────────────────────────────────────────────────
    dom.resultsSection  = document.getElementById("results-section");
    dom.bpmValue        = document.getElementById("bpm-value");
    dom.keyDisplay      = document.getElementById("key-display");
    dom.strengthFill    = document.getElementById("key-strength-fill");
    dom.strengthValue   = document.getElementById("key-strength-value");
    // The strength track is the direct parent of the fill div.
    dom.strengthTrack   = dom.strengthFill ? dom.strengthFill.parentElement : null;
    dom.beatCount       = document.getElementById("beat-count");

    // ── Hidden compatibility outputs (used by legacy code paths) ─────
    dom.keyValue        = document.getElementById("key-value");
    dom.scaleValue      = document.getElementById("scale-value");
    dom.confidenceValue = document.getElementById("confidence-value");

    // ── Status / log ─────────────────────────────────────────────────
    dom.statusText      = document.getElementById("status");
    dom.log             = document.getElementById("log");
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §3  Application state                                              */
  /* ═══════════════════════════════════════════════════════════════════ */

  var state = {
    /** Absolute OS path of the last successfully loaded clip. */
    filePath:       null,

    /** BPM from the last successful analysis. */
    bpm:            null,

    /**
     * Beat onset times in seconds from the last analysis.
     * Float32Array — passed directly to cepBridge.sendMarkersToTimeline().
     */
    beatTimestamps: null,

    /** Full result object returned by analyseAudio(). */
    lastResult:     null,

    /**
     * Stride for marker placement when beat count exceeds PREMIERE_MARKER_LIMIT.
     *   1 = every beat  (default)
     *   2 = every 2nd beat
     *   4 = every 4th beat
     * Reset to 1 on clearResults() so a fresh analysis always starts unstrided.
     */
    markerStride:   1
  };

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §4  Utility helpers                                                */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Returns the filename component of a path (works for both / and \ separators).
   * @param  {string} path
   * @returns {string}
   */
  function basename(path) {
    if (!path) return "";
    return path.replace(/\\/g, "/").split("/").pop() || path;
  }

  /**
   * Capitalises the first character of a string.
   * Used to turn "major"/"minor" into "Major"/"Minor".
   */
  function capitalise(str) {
    if (!str) return str || "";
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Converts a Premiere Pro sequence timebase (ticks per frame) to FPS,
   * snapping to the nearest standard frame rate.
   *
   * @param  {string|number} timebase  Ticks per frame (sequence.timebase).
   * @returns {number}                 FPS (e.g. 25, 29.97, 23.976).
   */
  function ticksToFps(timebase) {
    var tpf = parseInt(timebase, 10);
    if (!tpf || tpf <= 0) return 25;

    var rawFps = TICKS_PER_SECOND / tpf;

    return STANDARD_FPS.reduce(function (closest, fps) {
      return Math.abs(fps - rawFps) < Math.abs(closest - rawFps) ? fps : closest;
    });
  }

  /* ─── Loading state ──────────────────────────────────────────────── */

  /**
   * Toggles the loading/busy state of the panel.
   *
   * When active:
   *   - The Analyse button is disabled and its label changes to "Analysing…"
   *   - The inline spinner becomes visible
   *
   * @param {boolean} active
   */
  function setLoading(active) {
    dom.spinner.style.display         = active ? "inline-block" : "none";
    dom.analyseBtn.disabled           = active;
    dom.analyseBtnLabel.textContent   = active ? "Analysing…" : "Analyse Active Clip";
  }

  /* ─── Status line (legacy single-line, synced from appendLog) ────── */

  /**
   * Updates the #status single-line display.
   * Called automatically by appendLog(); rarely needed directly.
   */
  function setStatus(message, isError) {
    if (!dom.statusText) return;
    dom.statusText.textContent = message;
    dom.statusText.className   = "log-status" + (isError ? " error" : "");
  }

  /* ─── Log area ───────────────────────────────────────────────────── */

  /**
   * Appends a new entry to the #log list and scrolls it into view.
   * Also syncs the legacy #status element.
   *
   * @param {string} message
   * @param {"info"|"success"|"warn"|"error"} [type="info"]
   */
  function appendLog(message, type) {
    type = type || "info";

    var li = document.createElement("li");
    li.className   = "log-entry log-entry--" + type;
    li.textContent = message;
    dom.log.appendChild(li);

    // Keep the latest entry visible.
    dom.log.scrollTop = dom.log.scrollHeight;

    // Mirror to the single-line legacy status element.
    setStatus(message, type === "error");
  }

  /* ─── Results display ────────────────────────────────────────────── */

  /**
   * Resets all result displays to their placeholder "—" state and
   * disables the Place Beat Markers button.
   * Does NOT clear the log.
   */
  function clearResults() {
    dom.bpmValue.textContent      = "—";
    dom.keyDisplay.textContent    = "—";
    dom.strengthFill.style.width  = "0%";
    dom.strengthValue.textContent = "—";
    dom.beatCount.textContent     = "— beats detected";

    if (dom.strengthTrack) {
      dom.strengthTrack.setAttribute("aria-valuenow", "0");
    }

    // Hidden compat outputs
    if (dom.keyValue)        dom.keyValue.textContent        = "";
    if (dom.scaleValue)      dom.scaleValue.textContent      = "";
    if (dom.confidenceValue) dom.confidenceValue.textContent = "";

    dom.resultsSection.classList.remove("has-results", "is-strong");

    dom.addMarkersBtn.disabled = true;
    dom.addMarkersBtn.setAttribute("aria-disabled", "true");

    state.beatTimestamps = null;
    state.lastResult     = null;
    state.markerStride   = 1;
  }

  /**
   * Populates all result displays from an analyseAudio() result object.
   * Enables the Place Beat Markers button and sets CSS state classes.
   *
   * @param {{ bpm, beatTimestamps, key, scale, keyStrength }} result
   */
  function renderResults(result) {
    var bpm       = result.bpm;
    var key       = result.key       || "?";
    var scale     = result.scale     || "?";
    var strength  = result.keyStrength;
    var beats     = result.beatTimestamps;

    // ── BPM ────────────────────────────────────────────────────────
    dom.bpmValue.textContent = bpm.toFixed(2);

    // ── Key + Scale combined ("A Minor", "C# Major") ───────────────
    dom.keyDisplay.textContent = key + " " + capitalise(scale);

    // ── Key strength bar ───────────────────────────────────────────
    var strengthPct = (strength * 100).toFixed(1);
    dom.strengthFill.style.width  = strengthPct + "%";
    dom.strengthValue.textContent = strength.toFixed(2);

    if (dom.strengthTrack) {
      dom.strengthTrack.setAttribute("aria-valuenow", Math.round(strength * 100));
    }

    // ── Beat count ─────────────────────────────────────────────────
    dom.beatCount.textContent = beats.length + " beats detected";

    // ── Hidden compat outputs ──────────────────────────────────────
    if (dom.keyValue)        dom.keyValue.textContent        = key;
    if (dom.scaleValue)      dom.scaleValue.textContent      = scale;
    if (dom.confidenceValue) dom.confidenceValue.textContent = strength.toFixed(4);

    // ── CSS state ─────────────────────────────────────────────────
    dom.resultsSection.classList.add("has-results");
    dom.resultsSection.classList.toggle("is-strong", strength >= STRONG_KEY_THRESHOLD);
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §5  Error handling                                                 */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Maps any error thrown by cepBridge or analyseAudio to a short,
   * user-readable log message and appends it as an "error" entry.
   *
   * Uses instanceof checks against the typed error classes exposed on
   * cepBridge.errors and analyseAudio.* so each failure mode gets a
   * specific, actionable message rather than a raw exception string.
   *
   * @param {Error} err
   */
  function handleError(err) {
    if (!err) {
      appendLog("An unknown error occurred.", "error");
      return;
    }

    console.error("[BeatAnalyser]", err);

    // Shorthand references — both may be absent in unit-test contexts.
    var be = (cepBridge && cepBridge.errors)                        || {};
    var ae = (typeof analyseAudio === "function" && analyseAudio)   || {};

    // ── cepBridge errors ───────────────────────────────────────────
    if (be.HostScriptError && err instanceof be.HostScriptError) {
      appendLog("Premiere Pro error: " + err.hostError, "error");
      return;
    }
    if (be.FileReadError && err instanceof be.FileReadError) {
      var fileHint = "";
      if (err.code === "ENOENT")  fileHint = " The clip may be offline in the project.";
      if (err.code === "EACCES")  fileHint = " Check the file's read permissions.";
      if (err.code === "EISDIR")  fileHint = " The path points to a folder, not a file.";
      appendLog("Could not read file: " + err.message + fileHint, "error");
      return;
    }
    if (be.BridgeError && err instanceof be.BridgeError) {
      appendLog("CEP environment error: " + err.message, "error");
      return;
    }
    if (be.EvalScriptError && err instanceof be.EvalScriptError) {
      appendLog(
        "ExtendScript threw an uncaught exception. " +
        "Open Window → Extensions → CEP DevTools for the stack trace.",
        "error"
      );
      return;
    }

    // ── analyseAudio errors ────────────────────────────────────────
    if (ae.AudioDecodeError && err instanceof ae.AudioDecodeError) {
      appendLog(
        "Unsupported audio format. " +
        "Supported: WAV, MP3, AAC, OGG, FLAC.",
        "error"
      );
      return;
    }
    if (ae.SilentTrackError && err instanceof ae.SilentTrackError) {
      appendLog(
        "Track appears to be silent. " +
        "Check the clip is not muted and is not a blank region.",
        "error"
      );
      return;
    }
    if (ae.InsufficientBeatsError && err instanceof ae.InsufficientBeatsError) {
      appendLog(
        "Too few beats detected. " +
        "Try a longer clip or one with a more prominent rhythmic pulse.",
        "error"
      );
      return;
    }
    if (ae.KeyDetectionError && err instanceof ae.KeyDetectionError) {
      appendLog(
        "Key detection failed — no harmonic content found. " +
        "This may be a drums-only or pure-noise clip.",
        "error"
      );
      return;
    }

    // ── Fallback ───────────────────────────────────────────────────
    appendLog(err.message || String(err), "error");
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §6  Analyse Active Clip workflow                                   */
  /* ═══════════════════════════════════════════════════════════════════ */

  /* ── §6a  Get source file path ───────────────────────────────────── */

  /**
   * Calls getActiveSequenceAudioPath() via cepBridge and updates the
   * clip-path display to show the clip name + track slot.
   *
   * @returns {Promise<string>}  Resolved absolute OS path of the source file.
   */
  async function loadHostedClip() {
    appendLog("Getting active clip from sequence…");

    var pathResult = await cepBridge.getAudioFilePath();

    // pathResult: { filePath, clipName, trackType, trackIndex, isVideoFile, … }
    var filePath = pathResult.filePath;
    var label    = pathResult.clipName +
                   " (" + (pathResult.trackType === "audio" ? "A" : "V") +
                   (pathResult.trackIndex + 1) + ")";

    dom.filePathDisplay.textContent = label;
    dom.filePathDisplay.title       = filePath;
    state.filePath                  = filePath;

    if (pathResult.isVideoFile) {
      appendLog(
        "Source is a video file — audio will be extracted by the Web Audio decoder. " +
        "For best results use a lossless or high-bitrate audio-only clip.",
        "warn"
      );
    }
    if (pathResult.linkedFromVideo) {
      appendLog(
        "Using linked audio component (A" + (pathResult.trackIndex + 1) + ") " +
        "from the video clip on V" + (pathResult.trackIndex + 1) + "."
      );
    }

    return filePath;
  }

  /* ── §6b  Browser fallback file picker ──────────────────────────── */

  /**
   * Opens a browser <input type="file"> picker and resolves with the
   * chosen file's ArrayBuffer, or null if the user cancels.
   *
   * Used when running outside Premiere Pro (browser / dev mode).
   *
   * @returns {Promise<ArrayBuffer|null>}
   */
  function pickFileInBrowser() {
    return new Promise(function (resolve) {
      var input    = document.createElement("input");
      input.type   = "file";
      input.accept = "audio/wav,audio/mpeg,audio/mp3,audio/ogg,audio/flac,audio/aac,audio/*";

      input.onchange = function () {
        var file = input.files[0];
        if (!file) return resolve(null);

        dom.filePathDisplay.textContent = file.name;
        dom.filePathDisplay.title       = file.name;
        state.filePath                  = file.name;

        var reader    = new FileReader();
        reader.onload = function (e) { resolve(e.target.result); };
        reader.onerror = function ()  { resolve(null); };
        reader.readAsArrayBuffer(file);
      };

      // oncancel is supported in modern browsers but not all CEF builds.
      input.oncancel = function () { resolve(null); };

      input.click();
    });
  }

  /* ── §6c + §6d  Run analysis, store state, render results ──────── */

  /**
   * Runs analyseAudio() on a decoded ArrayBuffer, stores the result in
   * `state`, renders all result displays, and enables Place Beat Markers.
   *
   * Separated from the file-loading step so drag-and-drop can reuse it.
   *
   * @param  {ArrayBuffer} arrayBuffer
   * @returns {Promise<void>}
   */
  async function runAnalysis(arrayBuffer) {
    appendLog("Running analysis (BPM + key detection)…");
    dom.resultsSection.classList.add("is-loading");

    var result = await analyseAudio(arrayBuffer);

    // §6e  Store globally
    state.bpm            = result.bpm;
    state.beatTimestamps = result.beatTimestamps;
    state.lastResult     = result;

    // §6d  Render
    renderResults(result);

    appendLog(
      result.bpm.toFixed(2) + " BPM  ·  " +
      result.key + " " + capitalise(result.scale) + "  ·  " +
      result.beatTimestamps.length + " beats",
      "success"
    );

    // Warn when beat count exceeds Premiere Pro's per-sequence marker limit.
    // The user will be prompted to choose a stride in onPlaceMarkers().
    if (result.beatTimestamps.length > PREMIERE_MARKER_LIMIT) {
      appendLog(
        result.beatTimestamps.length + " beats detected — Premiere Pro supports " +
        "up to " + PREMIERE_MARKER_LIMIT + " markers per sequence. " +
        "You will be prompted to choose a stride when placing markers.",
        "warn"
      );
    }

    // §6f  Enable Place Beat Markers
    dom.addMarkersBtn.disabled = false;
    dom.addMarkersBtn.setAttribute("aria-disabled", "false");
  }

  /**
   * Appends an inline stride-chooser to the log when beat count exceeds the
   * Premiere Pro marker limit.
   *
   * Creates three buttons ("Every beat / Every 2nd / Every 4th") as children
   * of a log entry.  Clicking a button stores the chosen stride in `state`
   * and calls onPlaceMarkers() to resume the placement flow.
   *
   * Uses inline styles on the buttons so no CSS class changes are needed.
   *
   * @param {number} beatCount  Total number of detected beats.
   */
  function showStrideChooser(beatCount) {
    var li = document.createElement("li");
    li.className = "log-entry log-entry--warn";

    var label = document.createElement("span");
    label.textContent = "Place markers on: ";
    li.appendChild(label);

    var options = [
      { label: "Every beat",    stride: 1 },
      { label: "Every 2nd",     stride: 2 },
      { label: "Every 4th",     stride: 4 }
    ];

    options.forEach(function (opt) {
      var count = Math.ceil(beatCount / opt.stride);
      var btn   = document.createElement("button");
      btn.textContent = opt.label + " (" + count + ")";
      btn.style.cssText =
        "margin-left:6px; padding:2px 7px; font-size:11px;" +
        "cursor:pointer; background:var(--bg-raised,#3c3c3c);" +
        "color:var(--text-primary,#e0e0e0); border:1px solid var(--border,#4a4a4a);" +
        "border-radius:3px;";

      btn.addEventListener("click", function () {
        state.markerStride = opt.stride;
        // Remove the chooser row so the log doesn't accumulate on re-click.
        if (li.parentNode) li.parentNode.removeChild(li);
        appendLog(
          "Stride: " + opt.label + " — " + count + " marker" +
          (count !== 1 ? "s" : "") + " will be placed.",
          "info"
        );
        onPlaceMarkers();
      });

      li.appendChild(btn);
    });

    dom.log.appendChild(li);
    dom.log.scrollTop = dom.log.scrollHeight;
  }

  /* ── Primary button handler ─────────────────────────────────────── */

  /**
   * "Analyse Active Clip" click handler.
   *
   * Hosted flow   (inside Premiere):
   *   getAudioFilePath() → readFileAsArrayBuffer() → runAnalysis()
   *
   * Browser flow  (dev / no CSInterface):
   *   <input type="file"> picker        → runAnalysis()
   */
  async function onAnalyse() {
    clearResults();
    setLoading(true);

    try {
      var arrayBuffer;

      if (cepBridge.isHosted) {
        // §6a — get path from active sequence
        var filePath = await loadHostedClip();

        // §6b — read file bytes via cep_node
        appendLog("Reading audio: " + basename(filePath));
        arrayBuffer = await cepBridge.readFileAsArrayBuffer(filePath);

      } else {
        // Browser / dev fallback
        appendLog("Browser mode — select an audio file…", "info");
        arrayBuffer = await pickFileInBrowser();

        if (!arrayBuffer) {
          appendLog("No file selected.");
          return;   // finally still runs
        }
      }

      // §6c + §6d — analyse and render
      await runAnalysis(arrayBuffer);

    } catch (err) {
      handleError(err);
      clearResults();
    } finally {
      dom.resultsSection.classList.remove("is-loading");
      setLoading(false);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §7  Place / clear beat markers                                     */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * "Place Beat Markers" click handler.
   *
   * 1. Fetches the active sequence info to derive the frame rate.
   *    Frame rate failure is non-fatal — markers are placed in seconds
   *    regardless; FPS is only used for the marker comment text.
   * 2. Calls cepBridge.sendMarkersToTimeline() with the stored timestamps.
   */
  async function onPlaceMarkers() {
    if (!state.beatTimestamps || state.beatTimestamps.length === 0) {
      appendLog("No beat data available. Run analysis first.", "error");
      return;
    }

    var beatCount = state.beatTimestamps.length;

    // If beat count exceeds Premiere's marker limit and the user hasn't yet
    // chosen a stride, pause and present the stride chooser.
    if (beatCount > PREMIERE_MARKER_LIMIT && state.markerStride === 1) {
      appendLog(
        beatCount + " beats exceeds Premiere Pro's " + PREMIERE_MARKER_LIMIT +
        "-marker limit. Choose a placement stride below:",
        "warn"
      );
      showStrideChooser(beatCount);
      return;
    }

    // Apply stride: keep only every Nth beat.
    var timestamps;
    if (state.markerStride > 1) {
      var strided = [];
      for (var si = 0; si < beatCount; si += state.markerStride) {
        strided.push(state.beatTimestamps[si]);
      }
      timestamps = new Float32Array(strided);
    } else {
      timestamps = state.beatTimestamps;
    }

    // Step 1 — derive frame rate from sequence metadata.
    var frameRate = 0;
    try {
      appendLog("Fetching sequence frame rate…");
      var seqInfo = await cepBridge.getActiveSequenceInfo();
      if (seqInfo && seqInfo.timebase) {
        frameRate = ticksToFps(seqInfo.timebase);
        appendLog(
          "Sequence: \u201c" + seqInfo.name + "\u201d  " + frameRate + " fps  " +
          seqInfo.duration.toFixed(2) + "s"
        );
      }
    } catch (seqErr) {
      // Non-fatal: continue without frame-rate info.
      appendLog(
        "Could not read sequence frame rate — markers will still be placed correctly.",
        "warn"
      );
    }

    // Step 2 — write markers.
    appendLog(
      "Placing " + timestamps.length + " marker" +
      (timestamps.length !== 1 ? "s" : "") +
      (state.markerStride > 1 ? " (every " + state.markerStride + " beats)" : "") +
      "…"
    );

    try {
      var result = await cepBridge.sendMarkersToTimeline(timestamps, frameRate);

      var msg = "Placed " + result.placed +
                " beat marker" + (result.placed !== 1 ? "s" : "");
      if (result.removed  > 0) msg += " (replaced " + result.removed + " existing)";
      if (result.skipped  > 0) msg += ", " + result.skipped + " skipped (out of range)";

      appendLog(msg, "success");

    } catch (err) {
      handleError(err);
    }
  }

  /**
   * "Clear" button handler.
   * Removes all sequence markers whose names begin with "Beat".
   */
  async function onClearMarkers() {
    appendLog("Clearing beat markers from sequence…");
    try {
      var result = await cepBridge.removeBeatMarkers("Beat");
      appendLog(
        result.markersRemoved > 0
          ? "Removed " + result.markersRemoved +
            " beat marker" + (result.markersRemoved !== 1 ? "s" : "")
          : "No beat markers found in the active sequence.",
        result.markersRemoved > 0 ? "success" : "info"
      );
    } catch (err) {
      handleError(err);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §8  Export timeline                                                */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * "Export Timeline" click handler.
   * Validates the output path field then calls cepBridge.exportTimeline().
   */
  /**
   * Valid container extensions accepted by Adobe Media Encoder when exporting
   * a sequence.  MXF covers both OP1a (audio+video) and D-10 variants.
   * The check is case-insensitive to handle .MP4 / .MOV etc. from Windows paths.
   */
  var VALID_EXPORT_EXT = /\.(mp4|mov|mxf)$/i;

  async function onExport() {
    var outputPath = dom.exportPath.value.trim();

    if (!outputPath) {
      appendLog("Enter an output file path before exporting.", "error");
      dom.exportPath.focus();
      return;
    }

    if (!VALID_EXPORT_EXT.test(outputPath)) {
      var ext = outputPath.lastIndexOf(".") !== -1
        ? outputPath.slice(outputPath.lastIndexOf("."))
        : "(no extension)";
      appendLog(
        "Export path must end in .mp4, .mov, or .mxf — got: " + ext + ". " +
        "Update the path or use the \u2026 browse button to choose a destination.",
        "error"
      );
      dom.exportPath.focus();
      return;
    }

    appendLog("Queuing AME export: " + basename(outputPath) + "…");

    try {
      var result = await cepBridge.exportTimeline(outputPath);
      appendLog(
        "Export queued — "" + result.sequenceName + "" → " +
        basename(result.outputPath) +
        "  (AME job " + result.jobID + ")",
        "success"
      );
    } catch (err) {
      handleError(err);
    }
  }

  /**
   * "…" browse button handler.
   * Opens an ExtendScript save-file dialog to choose the export destination.
   * No-ops in browser / dev mode (save dialogs require CEP).
   */
  function onBrowseExport() {
    if (!cepBridge.isHosted) {
      appendLog("Save dialog requires Premiere Pro.", "warn");
      return;
    }

    /*
     * We use evalScript() directly with an inline expression because there is
     * no dedicated hostScript function for save dialogs — it is a one-liner
     * that does not need the { success, data } envelope.
     * The result is a raw path string (or empty string on cancel).
     */
    cepBridge.evalScript(
      "var _sf = File.saveDialog(" +
        "'Choose export destination'," +
        "'MP4:*.mp4,MOV:*.mov,MXF:*.mxf,AVI:*.avi'" +
      "); _sf ? _sf.fsName : ''"
    ).then(function (path) {
      if (path && path.trim()) {
        dom.exportPath.value = path.trim();
      }
    }).catch(function (err) {
      appendLog("Save dialog failed: " + err.message, "error");
    });
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §9  Drag-and-drop                                                  */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Wires drag-and-drop for audio files onto the panel body.
   *
   * The CSS class "drag-over" on <body> triggers the overlay defined in
   * styles.css (body.drag-over::after).
   *
   * Dropped files bypass cepBridge and are read via FileReader, making
   * drag-and-drop work in both hosted and browser-preview modes.
   */
  function wireDragAndDrop() {
    document.body.addEventListener("dragover", function (e) {
      e.preventDefault();
      document.body.classList.add("drag-over");
    });

    document.body.addEventListener("dragleave", function (e) {
      /*
       * Only remove the class when the pointer leaves the document entirely.
       * relatedTarget is null when leaving to outside the window; it points
       * to the documentElement briefly as the pointer crosses the window edge
       * on some platforms.
       */
      if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
        document.body.classList.remove("drag-over");
      }
    });

    document.body.addEventListener("drop", function (e) {
      e.preventDefault();
      document.body.classList.remove("drag-over");

      var file = e.dataTransfer && e.dataTransfer.files[0];
      if (!file) return;

      if (!file.type.startsWith("audio/")) {
        appendLog(
          "Dropped item is not an audio file: " + (file.name || "(unknown)"),
          "error"
        );
        return;
      }

      appendLog("Loading dropped file: " + file.name);
      dom.filePathDisplay.textContent = file.name;
      dom.filePathDisplay.title       = file.name;
      state.filePath                  = file.name;

      clearResults();
      setLoading(true);

      var reader    = new FileReader();
      reader.onload = function (ev) {
        runAnalysis(ev.target.result)
          .catch(function (err) {
            handleError(err);
            clearResults();
          })
          .then(function () {
            dom.resultsSection.classList.remove("is-loading");
            setLoading(false);
          });
      };
      reader.onerror = function () {
        appendLog("FileReader failed to read the dropped file.", "error");
        setLoading(false);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §10  Initialisation                                                */
  /* ═══════════════════════════════════════════════════════════════════ */

  function init() {
    cacheDom();
    clearResults();  // set initial disabled / placeholder state

    // ── Host info ─────────────────────────────────────────────────
    if (cepBridge.isHosted) {
      cepBridge.getHostInfo()
        .then(function (info) {
          if (info) {
            dom.hostVersion.textContent = info.appName + " " + info.version;
          }
          appendLog("Connected: " + (info ? info.appName + " " + info.version : "Premiere Pro"));
        })
        .catch(function () {
          appendLog("Connected to Premiere Pro.");
        });
    } else {
      appendLog("Browser preview — Premiere Pro not connected.", "warn");
    }

    // ── Button event listeners ────────────────────────────────────
    dom.analyseBtn.addEventListener("click",      onAnalyse);
    dom.addMarkersBtn.addEventListener("click",   onPlaceMarkers);
    dom.clearMarkersBtn.addEventListener("click", onClearMarkers);
    dom.exportBtn.addEventListener("click",       onExport);
    dom.browseExportBtn.addEventListener("click", onBrowseExport);

    // Press Enter in the export path field to trigger the export.
    dom.exportPath.addEventListener("keydown", function (e) {
      if (e.key === "Enter") onExport();
    });

    // ── Drag-and-drop ─────────────────────────────────────────────
    wireDragAndDrop();
  }

  // Defer init until the DOM is fully parsed.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

}());
