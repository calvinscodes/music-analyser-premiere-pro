/**
 * cepBridge.js — Async wrapper around CSInterface + cep_node file I/O
 *
 * Public API
 * ----------
 *   evalScript(funcName, ...args)              → Promise<any>
 *   getAudioFilePath()                         → Promise<AudioPathResult>
 *   sendMarkersToTimeline(timestamps, fps)     → Promise<MarkerResult>
 *   exportTimeline(outputPath)                 → Promise<ExportResult>
 *   readFileAsArrayBuffer(filePath)            → Promise<ArrayBuffer>
 *
 * Also kept for main.js compatibility:
 *   isHosted                                   Boolean
 *   getHostInfo()                              → Promise<HostInfo>
 *   getActiveSequenceInfo()                    → Promise<SequenceInfo>
 *   pickAudioFile()                            → Promise<string|null>
 *   removeBeatMarkers(prefix)                  → Promise<{markersRemoved}>
 *   getAudioClips()                            → Promise<Clip[]>
 *
 * Error types (accessible as cepBridge.errors.*):
 *   EvalScriptError    — CEP signalled an uncaught ExtendScript exception
 *   HostScriptError    — hostScript.jsx returned { success: false }
 *   FileReadError      — cep_node fs.readFile failed
 *   BridgeError        — CEP environment not available for the requested op
 */

(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.cepBridge = factory();
  }
}(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §1  Runtime detection                                              */
  /* ═══════════════════════════════════════════════════════════════════ */

  /*
   * CSInterface — Adobe CEP host communication SDK.
   * Null when the panel is opened in a plain browser (dev mode).
   */
  var _cs = (typeof CSInterface !== "undefined") ? new CSInterface() : null;

  /*
   * cep_node — CEP's embedded Node.js runtime.
   *
   * In CEP 8+ / CEP 11, cep_node is injected into the panel's JS context
   * automatically when the CEF process initialises.  It exposes:
   *
   *   cep_node.require(id)    — Node.js require(), scoped to the extension
   *   cep_node.process        — Node.js process object
   *   cep_node.__dirname      — absolute path to the extension root
   *
   * If the panel is opened outside Premiere (browser preview), cep_node
   * is undefined and readFileAsArrayBuffer() will reject with a BridgeError.
   *
   * Note: the manifest.xml --mixed-context flag is required for cep_node to
   * bridge between the V8 (browser) and Node.js heaps.  Without it, the
   * cep_node global exists but require() calls throw.
   */
  var _cepNode = (typeof cep_node !== "undefined") ? cep_node : null;

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §2  Named error types                                              */
  /* ═══════════════════════════════════════════════════════════════════ */

  /*
   * ES5-compatible Error subclasses.  Exposed on cepBridge.errors so
   * callers can write:
   *   err instanceof cepBridge.errors.HostScriptError
   */

  function EvalScriptError(message, callString) {
    this.name       = "EvalScriptError";
    this.message    = message;
    this.callString = callString || "";
    if (Error.captureStackTrace) Error.captureStackTrace(this, EvalScriptError);
  }
  EvalScriptError.prototype = Object.create(Error.prototype);

  /**
   * Thrown when hostScript.jsx returns { success: false, error: "…" }.
   * `hostError` is the error string from ExtendScript.
   * `callString` is the ExtendScript expression that was evaluated.
   */
  function HostScriptError(hostError, callString) {
    this.name       = "HostScriptError";
    this.message    = "ExtendScript reported: " + hostError;
    this.hostError  = hostError;
    this.callString = callString || "";
    if (Error.captureStackTrace) Error.captureStackTrace(this, HostScriptError);
  }
  HostScriptError.prototype = Object.create(Error.prototype);

  /**
   * Thrown when cep_node fs.readFile() fails.
   * `code` is the Node.js error code (e.g. "ENOENT", "EACCES").
   */
  function FileReadError(message, code) {
    this.name    = "FileReadError";
    this.message = message;
    this.code    = code || "UNKNOWN";
    if (Error.captureStackTrace) Error.captureStackTrace(this, FileReadError);
  }
  FileReadError.prototype = Object.create(Error.prototype);

  /** Thrown when a CEP capability (CSInterface, cep_node) is not available. */
  function BridgeError(message) {
    this.name    = "BridgeError";
    this.message = message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, BridgeError);
  }
  BridgeError.prototype = Object.create(Error.prototype);

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §3  Argument serialisation                                         */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Converts a single JS value to a string that is a valid ExtendScript
   * literal, suitable for embedding in a function-call expression string.
   *
   * Mapping:
   *   undefined      → "undefined"   (ExtendScript keyword, not JSON)
   *   null           → "null"
   *   boolean        → "true" / "false"
   *   number         → e.g. "128.00", "29.97"
   *   string         → double-quoted, JSON-escaped, e.g. '"hello"'
   *   Array/Object   → JSON literal, e.g. "[1,2,3]" or '{"k":"v"}'
   *
   * Why not JSON.stringify for everything?
   * ----------------------------------------
   * JSON.stringify(undefined) returns the JS value undefined (not the string
   * "undefined"), which would produce a hole in the args array and ultimately
   * an empty slot in the call string (syntax error in ExtendScript).
   * We handle undefined explicitly.
   *
   * @param  {*} arg
   * @returns {string}
   */
  function serializeArg(arg) {
    if (arg === undefined) return "undefined";
    return JSON.stringify(arg);
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §4  Core evalScript                                                */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Builds an ExtendScript function-call string from `funcName` and `args`,
   * evaluates it via CSInterface.evalScript, and returns a Promise.
   *
   * Call-string construction
   * ------------------------
   *   evalScript("placeMarkersAtTimecodes", "[0.5,1.0]", 25)
   *   → ExtendScript expression: placeMarkersAtTimecodes("[0.5,1.0]", 25)
   *
   * Each arg is passed through serializeArg() so:
   *   • Strings are wrapped in double quotes and JSON-escaped.
   *   • Numbers, booleans, null, arrays, and objects are inlined verbatim.
   *
   * Result handling
   * ---------------
   * All hostScript.jsx functions return a JSON envelope:
   *   { "success": true,  "data": <payload> }
   *   { "success": false, "error": "<message>" }
   *
   * This function:
   *   1. Detects the CEP hard-error sentinel "EvalScript error." and rejects
   *      with EvalScriptError.
   *   2. JSON.parses the result string.
   *   3. If parsed.success === false, rejects with HostScriptError.
   *   4. Resolves with parsed.data (unwrapping the envelope).
   *   5. Falls back to resolving with the raw string for non-envelope responses
   *      (e.g. an inline ExtendScript expression that returns a plain value).
   *
   * Dev-mode behaviour (no CSInterface)
   * ------------------------------------
   * When running outside Premiere Pro, _cs is null.  The Promise resolves
   * with null and logs the call so UI development can continue without a host.
   *
   * @param  {string} funcName   ExtendScript function name (no parentheses).
   * @param  {...*}   args       Arguments to pass.  Each is serialized to a
   *                             JS literal via serializeArg().
   * @returns {Promise<any>}
   * @throws  {EvalScriptError}  CEP signalled an uncaught ExtendScript error.
   * @throws  {HostScriptError}  hostScript returned { success: false }.
   */
  function evalScript(funcName) {
    // Collect rest args manually for ES5 compatibility in the outer IIFE,
    // while still accepting the rest-param style at the call site when the
    // runtime supports it (CEP 11 / Chromium 88+ does).
    var args       = Array.prototype.slice.call(arguments, 1);
    var argLiterals = args.map(serializeArg);
    var callString  = funcName + "(" + argLiterals.join(", ") + ")";

    return new Promise(function (resolve, reject) {
      if (!_cs) {
        console.warn("[cepBridge] evalScript — no CSInterface, returning null for:", callString);
        return resolve(null);
      }

      _cs.evalScript(callString, function (result) {
        /* ── Hard ExtendScript error ──────────────────────────────── */
        if (result === "EvalScript error.") {
          return reject(new EvalScriptError(
            "ExtendScript threw an uncaught exception. " +
            "Open the CEP devtools console for the stack trace.",
            callString
          ));
        }

        /* ── Try to parse as our { success, data/error } envelope ── */
        var parsed;
        try {
          parsed = JSON.parse(result);
        } catch (_) {
          // Not JSON (e.g. a raw string or number from an inline expression).
          return resolve(result);
        }

        if (parsed !== null && typeof parsed === "object" && parsed.success === false) {
          return reject(new HostScriptError(
            parsed.error || "Unknown error in ExtendScript.",
            callString
          ));
        }

        /*
         * Unwrap the envelope when present.
         * Guards against the edge case where `data` is legitimately `undefined`
         * (JSON key exists but value is null) — we return null in that case.
         */
        if (parsed !== null && typeof parsed === "object" && "data" in parsed) {
          return resolve(parsed.data);
        }

        // Bare JSON value (no envelope) — resolve as-is.
        resolve(parsed);
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §5  Named ExtendScript wrappers                                    */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Finds the first audio (or A/V) clip in the active sequence and returns
   * its source file path along with clip metadata.
   *
   * Delegates to: hostScript.jsx → getActiveSequenceAudioPath()
   *
   * @returns {Promise<{
   *   filePath:     string,
   *   clipName:     string,
   *   trackType:    "audio"|"video",
   *   trackIndex:   number,
   *   clipIndex:    number,
   *   startSeconds: number,
   *   inSeconds:    number,
   *   outSeconds:   number
   * }>}
   */
  function getAudioFilePath() {
    return evalScript("getActiveSequenceAudioPath");
  }

  /**
   * Places beat markers on the active sequence timeline.
   *
   * Converts a Float32Array (or any iterable of numbers) to a JSON string
   * before passing to ExtendScript.  JSON.stringify does not serialise
   * Float32Array correctly (it produces "{}"), so Array.from() is required.
   *
   * Delegates to: hostScript.jsx → placeMarkersAtTimecodes(timecodeArrayJSON, fps)
   *
   * @param  {Float32Array|number[]} beatTimestamps  Beat positions in seconds.
   * @param  {number}                frameRate       Sequence FPS (e.g. 25, 29.97).
   *                                                 Passed to ExtendScript for the
   *                                                 frame-number comment on each marker.
   * @returns {Promise<{
   *   placed:      number,
   *   skipped:     number,
   *   removed:     number,
   *   outOfBounds: number[]
   * }>}
   */
  function sendMarkersToTimeline(beatTimestamps, frameRate) {
    /*
     * hostScript.placeMarkersAtTimecodes expects its first argument to be a
     * JSON *string* (it calls JSON.parse() on it internally).
     *
     * Our evalScript serialises each arg with JSON.stringify, so:
     *   timecodeJson  = '[ 0.5, 1.0 ]'      (a JS string)
     *   serializeArg(timecodeJson) = '"[ 0.5, 1.0 ]"'   (quoted string literal)
     *
     * ExtendScript therefore receives:
     *   placeMarkersAtTimecodes("[ 0.5, 1.0 ]", 25)
     * and JSON.parse("[ 0.5, 1.0 ]") → [0.5, 1.0]  ✓
     */
    // Round to 3 decimal places (1 ms precision) before serialising.
    // CEP's evalScript has a ~8 KB string limit per call; full float64 precision
    // (e.g. 1.6544218063354492) on 300+ timestamps easily exceeds it.
    var rounded = Array.from(beatTimestamps).map(function (t) {
      return Math.round(t * 1000) / 1000;
    });
    var timecodeJson = JSON.stringify(rounded);
    return evalScript("placeMarkersAtTimecodes", timecodeJson, frameRate);
  }

  /**
   * Imports an audio file into the active Premiere Pro project and places it
   * on the specified audio track at the first available position after any
   * existing content on that track.
   *
   * If the file is already in the project it is reused (no duplicate import).
   * The clip is appended after the last existing clip on the target track, or
   * placed at the sequence start when the track is empty.
   *
   * Delegates to: hostScript.jsx → importAndPlaceAudioOnTrack(filePath, trackIdx)
   *
   * @param  {string} filePath     Absolute OS-native path to the audio file.
   * @param  {number} [trackIndex=1]  0-based audio track index (default 1 = A2).
   * @returns {Promise<{
   *   placed:       boolean,
   *   clipName:     string,
   *   trackIndex:   number,
   *   trackLabel:   string,   // e.g. "A2"
   *   startSeconds: number,
   *   filePath:     string
   * }>}
   */
  function placeAudioOnTimeline(filePath, trackIndex) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      return Promise.reject(new BridgeError(
        "placeAudioOnTimeline: filePath must be a non-empty string."
      ));
    }
    var idx = (typeof trackIndex === "number" && trackIndex >= 0) ? trackIndex : 1;
    return evalScript("importAndPlaceAudioOnTrack", filePath, idx);
  }

  /**
   * Triggers an Adobe Media Encoder export of the active sequence.
   * Kept for backwards compatibility; not wired in the default UI.
   * AME is launched if not already running.
   *
   * Delegates to: hostScript.jsx → exportSequenceWithMarkers(outputPath)
   *
   * @param  {string} outputPath  Absolute OS path including filename + extension.
   * @returns {Promise<{ queued, jobID, outputPath, sequenceName }>}
   */
  function exportTimeline(outputPath) {
    if (typeof outputPath !== "string" || outputPath.trim() === "") {
      return Promise.reject(new BridgeError(
        "exportTimeline: outputPath must be a non-empty string."
      ));
    }
    return evalScript("exportSequenceWithMarkers", outputPath);
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §6  File I/O via cep_node                                          */
  /* ═══════════════════════════════════════════════════════════════════ */

  /**
   * Reads a local audio file and returns its bytes as an ArrayBuffer,
   * ready to pass directly to analyseAudio() / Web Audio decodeAudioData().
   *
   * Why cep_node instead of other approaches?
   * -----------------------------------------
   * CEP panels have three file-read paths:
   *
   *   (a) cep.fs.readFile()      — Synchronous, CEP-native, max ~100 MB safely.
   *                                Returns a base64 string; caller must atob()
   *                                + convert to ArrayBuffer (extra copy, slower).
   *
   *   (b) ExtendScript File.read() — Runs in the host scripting engine.
   *                                  Returns base64 (binary mode); large files
   *                                  can stall Premiere's UI thread.
   *
   *   (c) cep_node fs.readFile() — True async Node.js I/O.  Returns a Buffer
   *                                that maps directly to ArrayBuffer with a
   *                                single .slice() call.  Non-blocking, handles
   *                                large files (24-bit WAV at 96 kHz > 100 MB)
   *                                without freezing Premiere or the panel UI.
   *
   * We use (c).  The `--mixed-context` flag in manifest.xml bridges the Node.js
   * heap into the browser context, making cep_node available.
   *
   * Buffer → ArrayBuffer note
   * -------------------------
   * Node.js allocates Buffers from a shared memory pool (slab allocation).
   * This means `nodeBuffer.buffer` may be an ArrayBuffer much larger than the
   * file, with `nodeBuffer.byteOffset > 0`.  Passing the raw `.buffer` to
   * decodeAudioData would silently include garbage bytes from the pool.
   *
   * We call:
   *   nodeBuffer.buffer.slice(byteOffset, byteOffset + byteLength)
   * to extract an independently-owned, zero-offset ArrayBuffer of exactly
   * `byteLength` bytes.  This is always safe regardless of Node.js version or
   * pool state.
   *
   * @param  {string} filePath  Absolute OS-native path to the audio file.
   * @returns {Promise<ArrayBuffer>}
   * @throws  {BridgeError}    cep_node unavailable (not running inside CEP).
   * @throws  {FileReadError}  File not found, permission denied, or I/O error.
   */
  function readFileAsArrayBuffer(filePath) {
    return new Promise(function (resolve, reject) {

      /* ── Check cep_node availability ──────────────────────────────── */
      if (!_cepNode) {
        return reject(new BridgeError(
          "readFileAsArrayBuffer: cep_node is not available. " +
          "This function requires a CEP panel running inside Premiere Pro. " +
          "Ensure --mixed-context is set in CSXS/manifest.xml CEFCommandLine."
        ));
      }

      /* ── Acquire Node.js fs module ────────────────────────────────── */
      var fs;
      try {
        fs = _cepNode.require("fs");
      } catch (requireErr) {
        return reject(new BridgeError(
          "readFileAsArrayBuffer: cep_node.require('fs') failed. " +
          "This usually means --mixed-context is missing from the CEF command line. " +
          "Original error: " + requireErr.message
        ));
      }

      if (typeof filePath !== "string" || filePath.trim() === "") {
        return reject(new BridgeError(
          "readFileAsArrayBuffer: filePath must be a non-empty string."
        ));
      }

      /* ── Read the file ────────────────────────────────────────────── */
      fs.readFile(filePath, function (err, nodeBuffer) {
        if (err) {
          /*
           * Map Node.js error codes to descriptive, actionable messages.
           *
           * ENOENT — file doesn't exist; getAudioFilePath() returned a stale path.
           * EACCES — OS-level read permission denied; unusual for media files
           *          but can happen on network shares or strict sandboxes.
           * EISDIR — caller passed a directory path instead of a file.
           */
          var code = err.code || "UNKNOWN";
          var hint = "";
          if (code === "ENOENT") {
            hint = " The path returned by getAudioFilePath() may be stale. " +
                   "Check that the clip is still online in the project.";
          } else if (code === "EACCES") {
            hint = " Check file permissions. " +
                   "If the file is on a network share, ensure the OS user has read access.";
          } else if (code === "EISDIR") {
            hint = " The path points to a directory, not a file.";
          }
          return reject(new FileReadError(
            "Could not read \"" + filePath + "\": " + err.message + "." + hint,
            code
          ));
        }

        /* ── Convert Node.js Buffer → dedicated ArrayBuffer ──────────── */
        var arrayBuffer;
        try {
          arrayBuffer = nodeBuffer.buffer.slice(
            nodeBuffer.byteOffset,
            nodeBuffer.byteOffset + nodeBuffer.byteLength
          );
        } catch (sliceErr) {
          return reject(new FileReadError(
            "Read succeeded but Buffer → ArrayBuffer conversion failed: " +
            sliceErr.message,
            "CONVERT_ERROR"
          ));
        }

        resolve(arrayBuffer);
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §7  Compatibility shims (used by existing main.js)                 */
  /* ═══════════════════════════════════════════════════════════════════ */

  function getHostInfo() {
    return evalScript("getHostInfo");
  }

  function getActiveSequenceInfo() {
    return evalScript("getActiveSequenceInfo");
  }

  function getAudioClips() {
    return evalScript("getAudioClips");
  }

  function removeBeatMarkers(prefix) {
    return evalScript("removeBeatMarkers", prefix || "Beat");
  }

  /**
   * Opens Premiere Pro's native file-open dialog (via ExtendScript) and
   * resolves with the chosen path, or null if the user cancelled.
   *
   * Uses an inline ExtendScript expression rather than a named hostScript
   * function because it is a one-liner that doesn't need the { success, data }
   * envelope — the dialog either returns a path string or an empty string.
   */
  function pickAudioFile() {
    return new Promise(function (resolve) {
      if (!_cs) return resolve(null);
      _cs.evalScript(
        "var _f = File.openDialog(" +
          "'Select audio file'," +
          "'Audio:*.wav,*.mp3,*.aif,*.aiff,*.flac,*.ogg,*.m4a'" +
        "); _f ? _f.fsName : ''",
        function (result) {
          resolve(result && result.trim() !== "" ? result.trim() : null);
        }
      );
    });
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  §8  Public API                                                     */
  /* ═══════════════════════════════════════════════════════════════════ */

  var bridge = {
    /**
     * True when running inside a CEP panel with a live CSInterface.
     * False in browser / test environments.
     */
    isHosted: !!_cs,

    /**
     * True when cep_node (Node.js) is available.
     * Required for readFileAsArrayBuffer().
     */
    isNodeAvailable: !!_cepNode,

    // ── Core ───────────────────────────────────────────────────────────
    evalScript:           evalScript,

    // ── Primary API ────────────────────────────────────────────────────
    getAudioFilePath:      getAudioFilePath,
    sendMarkersToTimeline: sendMarkersToTimeline,
    placeAudioOnTimeline:  placeAudioOnTimeline,
    exportTimeline:        exportTimeline,       // kept; not wired in default UI
    readFileAsArrayBuffer: readFileAsArrayBuffer,

    // ── Compatibility (used by main.js) ────────────────────────────────
    getHostInfo:          getHostInfo,
    getActiveSequenceInfo: getActiveSequenceInfo,
    getAudioClips:        getAudioClips,
    removeBeatMarkers:    removeBeatMarkers,
    pickAudioFile:        pickAudioFile,

    // ── Error types for instanceof checks ─────────────────────────────
    errors: {
      EvalScriptError: EvalScriptError,
      HostScriptError: HostScriptError,
      FileReadError:   FileReadError,
      BridgeError:     BridgeError
    }
  };

  return bridge;
}));
