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
 * Returns true when the file extension indicates a container format that
 * carries video (and thus may or may not carry an audio stream separately).
 *
 * Used by getActiveSequenceAudioPath() to annotate results so the panel
 * can warn the user that the Web Audio API will extract audio on-the-fly
 * from the video container.
 *
 * @param  {string} filePath
 * @returns {boolean}
 */
function _isVideoExtension(filePath) {
  if (!filePath) return false;
  return /\.(mp4|m4v|mov|mxf|avi|mkv|r3d|braw|mts|m2ts|ts|wmv|dv|f4v|flv|3gp)$/i
    .test(filePath);
}

/**
 * Searches the sequence's audio tracks for a clip whose projectItem is the
 * same object as videoClipProjectItem (Premiere links A/V track items by
 * sharing a single ProjectItem reference).
 *
 * Called when the best candidate clip comes from a video track, so we can
 * return the audio-track component (same file, same in/out points) instead.
 * This ensures the Web Audio API receives a path that is unambiguously an
 * audio-bearing media item rather than a generic video container.
 *
 * @param  {Sequence}    seq
 * @param  {ProjectItem} videoClipProjectItem  Reference to match against.
 * @returns {Object|null}  scanTracks-shaped payload, or null if not found.
 */
function _findLinkedAudioComponent(seq, videoClipProjectItem) {
  for (var t = 0; t < seq.audioTracks.numTracks; t++) {
    var track = seq.audioTracks[t];
    if (!track.clips || track.clips.numItems === 0) continue;

    for (var c = 0; c < track.clips.numItems; c++) {
      var clip = track.clips[c];
      if (!clip.projectItem) continue;

      // Linked A/V clips in Premiere share the same ProjectItem instance.
      if (clip.projectItem === videoClipProjectItem) {
        var filePath = "";
        try {
          filePath = clip.projectItem.getMediaPath();
        } catch (e) {
          continue;
        }
        if (!filePath || filePath === "(unavailable)") continue;

        return {
          filePath:       filePath,
          clipName:       clip.name,
          trackType:      "audio",   // audio-track component, even though source is A/V
          trackIndex:     t,
          clipIndex:      c,
          startSeconds:   clip.start.seconds,
          inSeconds:      clip.inPoint.seconds,
          outSeconds:     clip.outPoint.seconds,
          isVideoFile:    _isVideoExtension(filePath),  // true for .mp4/.mov/etc.
          linkedFromVideo: true   // flags that we resolved this via the video clip link
        };
      }
    }
  }
  return null;
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
/*  §2  importAndPlaceAudioOnTrack                                     */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * Imports an audio file into the active Premiere Pro project (or reuses the
 * existing project item when the file is already imported) and places it on
 * the specified audio track at the first available gap after any existing
 * content on that track.
 *
 * How Premiere clip placement works from ExtendScript
 * ---------------------------------------------------
 * Premiere exposes `Track.insertClip(projectItem, startTimeSeconds)`.
 * "Insert" at a time beyond the last clip is equivalent to an append —
 * no existing content is shifted.  We calculate the end time of the last
 * clip on the target track and use that as the insertion point, so dropped
 * clips accumulate sequentially on each successive drop.
 *
 * Duplicate-import handling
 * -------------------------
 * `app.project.importFiles()` imports the file even if it is already in the
 * project, creating a duplicate item.  We therefore first search all project
 * items for a matching `getMediaPath()` and only call `importFiles()` when
 * no match is found.  The search is recursive so files inside bins are found.
 *
 * @param {string} filePath          Absolute OS-native path to the audio file.
 * @param {number} targetTrackIndex  0-based audio track index (0 = A1, 1 = A2).
 *
 * Return payload (success):
 *   {
 *     placed:       true,
 *     clipName:     string,   // project item name
 *     trackIndex:   number,   // same as targetTrackIndex
 *     trackLabel:   string,   // e.g. "A2"
 *     startSeconds: number,   // clip start position in the sequence
 *     filePath:     string    // normalised OS path
 *   }
 *
 * @returns {string} JSON envelope
 */
function importAndPlaceAudioOnTrack(filePath, targetTrackIndex) {
  try {
    /* ── Guards ────────────────────────────────────────────────────── */
    if (!app.project) return _err("No project is currently open.");
    var seq = app.project.activeSequence;
    if (!seq) {
      return _err(
        "No active sequence. Click a sequence tab in the timeline to make it active."
      );
    }

    if (typeof filePath !== "string" || filePath === "") {
      return _err("importAndPlaceAudioOnTrack: filePath must be a non-empty string.");
    }

    var audioFile = new File(filePath);
    if (!audioFile.exists) {
      return _err("File not found: " + filePath);
    }

    // Use the OS-normalised path throughout to avoid mixed-slash issues.
    var normPath = audioFile.fsName;

    var trackIdx = parseInt(targetTrackIndex);
    if (isNaN(trackIdx) || trackIdx < 0) trackIdx = 1;   // default to A2

    if (trackIdx >= seq.audioTracks.numTracks) {
      return _err(
        "Audio track A" + (trackIdx + 1) + " does not exist. " +
        "The sequence only has " + seq.audioTracks.numTracks + " audio track(s). " +
        "Add more audio tracks via Sequence \u2192 Add Tracks."
      );
    }

    /* ── Find existing project item by media path ──────────────────── */
    function findItemByPath(binItem, targetPath) {
      for (var i = 0; i < binItem.children.numItems; i++) {
        var child = binItem.children[i];
        var childPath = "";
        try { childPath = child.getMediaPath(); } catch (e) {}
        if (childPath === targetPath) return child;
        // Recurse into bins (children with their own children collection).
        if (child.children && child.children.numItems > 0) {
          var found = findItemByPath(child, targetPath);
          if (found) return found;
        }
      }
      return null;
    }

    var projectItem = findItemByPath(app.project.rootItem, normPath);

    /* ── Import if not already present ────────────────────────────── */
    if (!projectItem) {
      // importFiles(paths, suppressUI, targetBin, importAsNumberedStill)
      app.project.importFiles(
        [normPath],
        true,                    // suppressUI — no import dialog
        app.project.rootItem,    // import into the root bin
        false                    // not a numbered still sequence
      );
      projectItem = findItemByPath(app.project.rootItem, normPath);
    }

    if (!projectItem) {
      return _err(
        "Import appeared to succeed but the item could not be located in the " +
        "project panel.  Try File \u2192 Import manually: " + normPath
      );
    }

    /* ── Find insertion time: end of last clip on target track ──────── */
    var targetTrack   = seq.audioTracks[trackIdx];
    var insertSeconds = 0;

    if (targetTrack.clips && targetTrack.clips.numItems > 0) {
      for (var c = 0; c < targetTrack.clips.numItems; c++) {
        var clipEnd = targetTrack.clips[c].end.seconds;
        if (clipEnd > insertSeconds) insertSeconds = clipEnd;
      }
    }

    /* ── Place clip on track ──────────────────────────────────────── */
    // Track.insertClip(projectItem, startTimeInSeconds)
    // Inserting at or beyond the last clip end is a non-destructive append.
    targetTrack.insertClip(projectItem, insertSeconds);

    /* ── Read back actual start time of placed clip ────────────────── */
    // The placed clip is the one whose start is nearest to insertSeconds.
    var placedStartSeconds = insertSeconds;
    if (targetTrack.clips && targetTrack.clips.numItems > 0) {
      for (var d = 0; d < targetTrack.clips.numItems; d++) {
        var tc = targetTrack.clips[d];
        if (Math.abs(tc.start.seconds - insertSeconds) < 0.1) {
          placedStartSeconds = tc.start.seconds;
          break;
        }
      }
    }

    return _ok({
      placed:       true,
      clipName:     projectItem.name,
      trackIndex:   trackIdx,
      trackLabel:   "A" + (trackIdx + 1),
      startSeconds: placedStartSeconds,
      filePath:     normPath
    });

  } catch (e) {
    return _err(e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  §3  getActiveSequenceAudioPath                                     */
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
  // ── Explicit upfront guards (return JSON error objects, not exceptions) ──
  //
  // Returning _err() here rather than relying on _requireActiveSequence() to
  // throw makes it explicit that "no sequence" is an expected, non-fatal
  // condition that the panel should present as a clear user message.
  if (!app.project) {
    return _err("No project is currently open.");
  }
  var seq = app.project.activeSequence;
  if (!seq) {
    return _err(
      "No active sequence. Click a sequence tab in the timeline panel " +
      "to make it active, then try again."
    );
  }

  try {
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
            outSeconds:   clip.outPoint.seconds,
            isVideoFile:  _isVideoExtension(filePath)
          };
        }
      }
      return null;
    }

    // Prefer a dedicated audio track clip.
    var result = scanTracks(seq.audioTracks, "audio");

    if (!result) {
      // Fall back to a video track clip.
      // For A/V files on video tracks, attempt to resolve the linked audio
      // component on the audio tracks first — it carries the same source
      // file but its track type is "audio", which makes the clip origin
      // clearer to the panel.
      var videoResult = scanTracks(seq.videoTracks, "video");

      if (videoResult) {
        // Try to locate the audio-track component that is linked to this
        // video clip (they share the same ProjectItem reference in Premiere).
        var linkedAudio = _findLinkedAudioComponent(seq, videoResult.clip
          ? videoResult.clip.projectItem  // would be set if we stored the ref
          : null);
        // Note: scanTracks doesn't return the clip object, only derived fields.
        // Re-find the clip projectItem for the linked-audio search.
        var vTrack = seq.videoTracks[videoResult.trackIndex];
        var vClip  = vTrack && vTrack.clips ? vTrack.clips[videoResult.clipIndex] : null;
        if (vClip && vClip.projectItem) {
          linkedAudio = _findLinkedAudioComponent(seq, vClip.projectItem);
        }

        result = linkedAudio || videoResult;
      }
    }

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
/**
 * clearBeatMarkers — removes all Beat markers from the active sequence.
 * Called before the first batch when placing markers in multiple evalScript calls.
 */
function clearBeatMarkers() {
  try {
    var seq = _requireActiveSequence();
    var markers = seq.markers;
    var removed = 0;
    var beatLabelRe = /^Beat \d+$/;
    var cursor = markers.getFirstMarker();
    while (cursor !== undefined) {
      var next = markers.getNextMarker(cursor);
      if (beatLabelRe.test(cursor.name)) { markers.deleteMarker(cursor); removed++; }
      cursor = next;
    }
    return _ok({ removed: removed });
  } catch (e) {
    return _err(e.message);
  }
}

function placeMarkersAtTimecodes(timecodeArrayJSON, sequenceFrameRate, markerOffset) {
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
    // markerOffset is the beat number to start labelling from (for batching).
    var labelOffset = parseInt(markerOffset, 10) || 0;

    var seqDurationSeconds = seq.end.seconds;

    /* ── markers (no clearing here — caller invokes clearBeatMarkers first) */
    var markers  = seq.markers;
    var removed  = 0;
    var beatLabelRe = /^Beat \d+$/;

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

      // Clamp check: skip markers beyond sequence end.
      // Guard: seqDurationSeconds can read back as 0 in newer Premiere builds
      // before the timeline has fully updated — skip the check in that case
      // so markers are not wrongly rejected.
      if (seqDurationSeconds > 0 && seconds > seqDurationSeconds) {
        skipped++;
        outOfBounds.push(seconds);
        continue;
      }

      var ticks  = _secondsToTicks(seconds);
      var marker = markers.createMarker(ticks);

      marker.name     = "Beat " + (labelOffset + placed + 1);  // "Beat 1", "Beat 2", …
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
