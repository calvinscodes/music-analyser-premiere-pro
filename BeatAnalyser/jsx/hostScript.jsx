/**
 * hostScript.jsx — ExtendScript host-side API for BeatAnalyser
 *
 * Execution context: Adobe Premiere Pro ExtendScript engine (ES3 + DOM extensions).
 * Entry point:       loaded by CEP via <ScriptPath> in manifest.xml.
 * Call pattern:      CSInterface.evalScript("functionName(args)", callback)
 *
 * Return convention
 * -----------------
 * Every public function returns a JSON *string* shaped as either:
 *   { "success": true,  "data": <payload> }
 *   { "success": false, "error": "<message>" }
 *
 * The panel side parses this with JSON.parse() and inspects `.success`.
 *
 * ExtendScript / CEP gotchas captured here
 * -----------------------------------------
 * • Time objects must be constructed via "new Time()" — the bare "Time()"
 *   call (no new) returns undefined in some host builds.
 * • Marker.type must be the string "Comment" (not an enum integer) when
 *   set through the DOM API in Premiere 2021+.
 * • sequence.timebase returns ticks-per-frame as a *string*, not a number.
 * • AME encoder presets accessed via app.encoder require AME to be running;
 *   the script launches it on-demand via app.encoder.launchEncoder().
 * • All file paths on Windows use back-slashes internally but
 *   File.fsName normalises them for you.
 */

/* ═══════════════════════════════════════════════════════════════════ */
/*  §0  JSON shim (safety net for very old CEP builds)                 */
/* ═══════════════════════════════════════════════════════════════════ */

/*
 * CEP 7+ ships a JSON implementation in the ExtendScript engine, but we
 * guard against ancient installs just in case.
 */
if (typeof JSON === "undefined") {
  // Minimal stringify — only handles the object shapes we actually produce.
  JSON = {
    stringify: function (v) {
      if (v === null)              return "null";
      if (typeof v === "boolean")  return v ? "true" : "false";
      if (typeof v === "number")   return isFinite(v) ? String(v) : "null";
      if (typeof v === "string")   return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
      if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(JSON.stringify(v[i]));
        return "[" + a.join(",") + "]";
      }
      var pairs = [];
      for (var k in v) {
        if (v.hasOwnProperty(k)) pairs.push(JSON.stringify(k) + ":" + JSON.stringify(v[k]));
      }
      return "{" + pairs.join(",") + "}";
    },
    parse: function (s) { return eval("(" + s + ")"); } // ES3-safe eval parse
  };
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  §1  Internal helpers                                               */
/* ═══════════════════════════════════════════════════════════════════ */

function _ok(data) {
  return JSON.stringify({ success: true, data: data });
}

function _err(message) {
  return JSON.stringify({ success: false, error: String(message) });
}

/**
 * Returns app.project, throwing a descriptive error when no project is open.
 * @throws {Error}
 */
function _requireProject() {
  if (!app.project) throw new Error("No project is currently open.");
  return app.project;
}

/**
 * Returns the active sequence, throwing a descriptive error when absent.
 * @throws {Error}
 */
function _requireActiveSequence() {
  var project = _requireProject();
  var seq = project.activeSequence;
  if (!seq) throw new Error("No active sequence. Open or click a sequence in the timeline.");
  return seq;
}

/**
 * Converts seconds (float) to a Premiere Pro ticks string via a Time object.
 *
 * Premiere's marker API accepts either:
 *   (a) a raw ticks integer / string, or
 *   (b) a Time object
 * We use approach (a) — construct a Time, set .seconds, read back .ticks —
 * because the ticks value already accounts for the project's tick resolution
 * (254016000000 ticks/second in all modern Premiere builds).
 *
 * @param  {number} seconds
 * @returns {string} ticks as a string (safe for large 64-bit-ish values)
 */
function _secondsToTicks(seconds) {
  var t = new Time();
  t.seconds = seconds;
  return t.ticks;
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  §2  getActiveSequenceAudioPath                                     */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * Finds the first clip that has a resolvable source file path from the
 * active sequence and returns that path.
 *
 * Search order:
 *   1. Audio tracks A1…An, clips left-to-right.
 *   2. If no audio track clip has a path, fall back to video tracks V1…Vn.
 *      (Video clips can carry audio when the source is a mixed A/V file.)
 *
 * Return payload:
 *   {
 *     filePath:    string,   // OS-native absolute path
 *     clipName:    string,   // clip label shown in the timeline
 *     trackType:   "audio" | "video",
 *     trackIndex:  number,
 *     clipIndex:   number,
 *     startSeconds: number,
 *     inSeconds:    number,
 *     outSeconds:   number
 *   }
 *
 * @returns {string} JSON envelope
 */
function getActiveSequenceAudioPath() {
  try {
    var seq = _requireActiveSequence();

    /**
     * Inner scan — walks one TrackCollection looking for the first clip
     * whose projectItem exposes a non-empty media path.
     *
     * @param  {TrackCollection} trackCollection
     * @param  {string}          trackType  "audio" | "video"
     * @returns {Object|null}  plain object or null
     */
    function scanTracks(trackCollection, trackType) {
      for (var t = 0; t < trackCollection.numTracks; t++) {
        var track = trackCollection[t];

        // Some tracks are empty or have no clips property (e.g. submix tracks).
        if (!track.clips || track.clips.numItems === 0) continue;

        for (var c = 0; c < track.clips.numItems; c++) {
          var clip = track.clips[c];

          // Guard: offline / title clips have no projectItem.
          if (!clip.projectItem) continue;

          var filePath = "";
          try {
            filePath = clip.projectItem.getMediaPath();
          } catch (e) {
            // getMediaPath() throws on synthetic clips (bars&tone, colour mattes…)
            continue;
          }

          // Reject empty strings and placeholder text some builds return.
          if (!filePath || filePath === "(unavailable)") continue;

          return {
            filePath:     filePath,
            clipName:     clip.name,
            trackType:    trackType,
            trackIndex:   t,
            clipIndex:    c,
            startSeconds: clip.start.seconds,
            inSeconds:    clip.inPoint.seconds,
            outSeconds:   clip.outPoint.seconds
          };
        }
      }
      return null;
    }

    // Prefer a dedicated audio track clip; fall back to a video track clip
    // (which may be an A/V file the panel can still decode for audio content).
    var result = scanTracks(seq.audioTracks, "audio")
              || scanTracks(seq.videoTracks, "video");

    if (!result) {
      return _err(
        "No clips with a resolvable source file found in the active sequence. " +
        "Ensure at least one clip is not offline and is not a synthetic source " +
        "(colour matte, bars & tone, title, etc.)."
      );
    }

    return _ok(result);

  } catch (e) {
    return _err(e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  §3  placeMarkersAtTimecodes                                        */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * Places sequence markers at the given beat positions.
 *
 * Each marker is labelled "Beat 1", "Beat 2", … and uses the "Comment"
 * type so it appears as a standard green marker in the timeline.
 *
 * Duplicate-prevention: before inserting, any existing markers whose names
 * match /^Beat \d+$/ are removed so re-running analysis doesn't stack markers.
 *
 * @param {string} timecodeArrayJSON
 *   JSON-stringified array of beat positions in *seconds* (float).
 *   Example: "[0.512, 1.024, 1.536]"
 *
 * @param {number|string} sequenceFrameRate
 *   Frames-per-second of the sequence (e.g. 23.976, 25, 29.97, 48, 50, 60).
 *   Used only for validation / rounding — the ticks conversion is done via
 *   the Time object which already knows the project's internal resolution,
 *   so sub-frame accuracy is preserved regardless of frame rate.
 *
 * Return payload:
 *   {
 *     placed:   number,   // markers successfully written
 *     skipped:  number,   // timecodes outside sequence bounds — skipped
 *     removed:  number,   // pre-existing "Beat N" markers cleared
 *     outOfBounds: number[]  // the skipped timecodes (seconds)
 *   }
 *
 * @returns {string} JSON envelope
 */
function placeMarkersAtTimecodes(timecodeArrayJSON, sequenceFrameRate) {
  try {
    var seq = _requireActiveSequence();

    /* ── parse & validate input ──────────────────────────────────────── */
    var timecodes;
    try {
      timecodes = JSON.parse(timecodeArrayJSON);
    } catch (parseErr) {
      return _err("timecodeArrayJSON is not valid JSON: " + parseErr.message);
    }

    if (!(timecodes instanceof Array) || timecodes.length === 0) {
      return _err("timecodeArrayJSON must be a non-empty JSON array of numbers.");
    }

    var fps = parseFloat(sequenceFrameRate) || 0;
    // sequenceFrameRate is informational; a bad value doesn't block placement.

    var seqDurationSeconds = seq.end.seconds;

    /* ── remove existing Beat markers ───────────────────────────────── */
    var markers  = seq.markers;
    var removed  = 0;
    var beatLabelRe = /^Beat \d+$/;  // ExtendScript has RegExp

    var cursor = markers.getFirstMarker();
    while (cursor !== undefined) {
      var nextCursor = markers.getNextMarker(cursor);
      if (beatLabelRe.test(cursor.name)) {
        markers.deleteMarker(cursor);
        removed++;
      }
      cursor = nextCursor;
    }

    /* ── insert new markers ─────────────────────────────────────────── */
    var placed      = 0;
    var skipped     = 0;
    var outOfBounds = [];

    for (var i = 0; i < timecodes.length; i++) {
      var seconds = parseFloat(timecodes[i]);

      if (isNaN(seconds) || seconds < 0) {
        skipped++;
        outOfBounds.push(timecodes[i]);
        continue;
      }

      // Clamp check: marker beyond sequence end would be invisible / confusing.
      if (seconds > seqDurationSeconds) {
        skipped++;
        outOfBounds.push(seconds);
        continue;
      }

      var ticks  = _secondsToTicks(seconds);
      var marker = markers.createMarker(ticks);

      marker.name     = "Beat " + (placed + 1);  // "Beat 1", "Beat 2", …
      marker.type     = "Comment";                // green marker in timeline
      marker.comments = "BeatAnalyser — " +
                        (fps > 0 ? ("frame " + Math.round(seconds * fps) + " @ " + fps + "fps — ") : "") +
                        seconds.toFixed(4) + "s";

      placed++;
    }

    return _ok({
      placed:      placed,
      skipped:     skipped,
      removed:     removed,
      outOfBounds: outOfBounds
    });

  } catch (e) {
    return _err(e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  §4  exportSequenceWithMarkers                                      */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * Exports the active sequence through Adobe Media Encoder using the
 * sequence's own current export settings (i.e. "Match Sequence Settings").
 *
 * How Premiere → AME export works from ExtendScript
 * --------------------------------------------------
 * Premiere exposes app.encoder (an EncoderWrapper) in CEP/ExtendScript.
 * The call chain is:
 *
 *   1. app.encoder.launchEncoder()          — start AME if not running
 *   2. app.encoder.encodeSequence(          — queue the job
 *        sequence,
 *        outputFilePath,
 *        presetPath,            // "" = match sequence settings
 *        workAreaType,          // 0 = entire sequence
 *        removeFromQueue        // false = leave in AME queue after encode
 *      )
 *   3. app.encoder.startBatch()             — begin encoding
 *
 * "Match sequence settings" is triggered by passing an empty string ("") as
 * the preset path.  Premiere internally maps this to the current sequence
 * export format/codec without requiring a .epr preset file.
 *
 * WorkAreaType values (Premiere Pro DOM):
 *   0 — Entire Sequence
 *   1 — Work Area (in/out points)
 *   2 — Custom range
 *
 * @param {string} outputPath
 *   Absolute OS path for the output file, including extension.
 *   Example: "/Users/alex/Desktop/export.mp4"
 *   The directory must already exist; AME will not create intermediate folders.
 *
 * Return payload (success):
 *   {
 *     queued:     true,
 *     outputPath: string,   // the path passed in (normalised)
 *     sequenceName: string
 *   }
 *
 * @returns {string} JSON envelope
 */
function exportSequenceWithMarkers(outputPath) {
  try {
    var seq = _requireActiveSequence();

    /* ── validate outputPath ─────────────────────────────────────────── */
    if (typeof outputPath !== "string" || outputPath === "") {
      return _err("outputPath must be a non-empty string.");
    }

    // Normalise path separators and check that the parent directory exists.
    var outputFile  = new File(outputPath);
    var parentFolder = outputFile.parent;

    if (!parentFolder.exists) {
      return _err(
        "Output directory does not exist: " + parentFolder.fsName + ". " +
        "Create the directory before exporting."
      );
    }

    // Use the normalised OS-native path for AME (avoids mixed-slash issues on Windows).
    var normalisedPath = outputFile.fsName;

    /* ── check encoder availability ─────────────────────────────────── */
    if (typeof app.encoder === "undefined") {
      return _err(
        "app.encoder is not available. This API requires Premiere Pro 2020 (v14) " +
        "or later. Ensure the project is open and not in Safe Mode."
      );
    }

    /* ── launch AME (no-op if already running) ───────────────────────── */
    app.encoder.launchEncoder();

    /* ── queue the encode job ────────────────────────────────────────── */
    //
    // encodeSequence signature (Premiere DOM):
    //   encodeSequence(
    //     sequence        : Sequence,
    //     outputFilePath  : string,
    //     presetPath      : string,   // "" → match sequence settings
    //     workAreaType    : number,   // 0 = entire sequence
    //     removeOnCompletion : boolean
    //   ) : string  — returns a job ID string, or throws on failure
    //
    var jobID = app.encoder.encodeSequence(
      seq,
      normalisedPath,
      "",     // preset path: "" = match sequence settings (no .epr needed)
      0,      // workAreaType: 0 = entire sequence
      false   // keep job in AME queue after completion (useful for review)
    );

    /* ── start the AME batch queue ───────────────────────────────────── */
    // startBatch() is non-blocking from ExtendScript's perspective — AME
    // encodes asynchronously.  The panel should inform the user to watch
    // AME's progress window rather than expecting a completion callback here.
    app.encoder.startBatch();

    return _ok({
      queued:       true,
      jobID:        jobID || "(unknown)",
      outputPath:   normalisedPath,
      sequenceName: seq.name
    });

  } catch (e) {
    // encodeSequence throws a generic "Error" on preset mismatch or when AME
    // fails to launch — surface the raw message so the panel can show it.
    return _err(e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  §5  Kept helpers (used by cepBridge.js)                            */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * Returns basic info about the active sequence.
 * @returns {string} JSON
 */
function getActiveSequenceInfo() {
  try {
    var seq = _requireActiveSequence();
    return _ok({
      name:        seq.name,
      id:          seq.sequenceID,
      timebase:    seq.timebase,          // ticks-per-frame (string)
      duration:    seq.end.seconds,
      videoTracks: seq.videoTracks.numTracks,
      audioTracks: seq.audioTracks.numTracks
    });
  } catch (e) {
    return _err(e.message);
  }
}

/**
 * Returns Premiere Pro host application version info.
 * @returns {string} JSON
 */
function getHostInfo() {
  try {
    return _ok({
      appName:     app.appName,
      version:     app.version,
      buildNumber: app.buildNumber
    });
  } catch (e) {
    return _err(e.message);
  }
}
