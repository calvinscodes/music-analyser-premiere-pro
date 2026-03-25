/**
 * hostScript.jsx — ExtendScript host-side API for BeatAnalyser
 *
 * Runs inside the Premiere Pro scripting engine (ExtendScript / ES3).
 * Called from the panel via CSInterface.evalScript().
 *
 * All public functions return a JSON string so the CEP panel can
 * parse results with JSON.parse() in the browser context.
 */

/* ------------------------------------------------------------------ */
/*  Utilities                                                           */
/* ------------------------------------------------------------------ */

/** Serialise a plain object to JSON without native JSON (ES3 safe). */
function toJSON(obj) {
  return JSON.stringify(obj); // CEP's ExtendScript engine includes JSON
}

function errorJSON(message) {
  return toJSON({ success: false, error: message });
}

function okJSON(data) {
  return toJSON({ success: true, data: data });
}

/* ------------------------------------------------------------------ */
/*  Project / sequence helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * Returns basic info about the active sequence.
 * @returns {string} JSON
 */
function getActiveSequenceInfo() {
  try {
    var project = app.project;
    if (!project) return errorJSON("No project open.");

    var seq = project.activeSequence;
    if (!seq) return errorJSON("No active sequence.");

    return okJSON({
      name:       seq.name,
      id:         seq.sequenceID,
      frameRate:  seq.timebase,          // ticks per frame
      duration:   seq.end.seconds,       // seconds
      videoTracks: seq.videoTracks.numTracks,
      audioTracks: seq.audioTracks.numTracks
    });
  } catch (e) {
    return errorJSON(e.message);
  }
}

/**
 * Returns all audio clip file paths on all audio tracks of the active sequence.
 * @returns {string} JSON array of { trackIndex, clipIndex, name, filePath, inPoint, outPoint }
 */
function getAudioClips() {
  try {
    var project = app.project;
    if (!project) return errorJSON("No project open.");

    var seq = project.activeSequence;
    if (!seq) return errorJSON("No active sequence.");

    var clips = [];

    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var track = seq.audioTracks[t];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        var filePath = "";
        try {
          filePath = clip.projectItem.getMediaPath();
        } catch (pathErr) {
          filePath = "(unavailable)";
        }

        clips.push({
          trackIndex: t,
          clipIndex:  c,
          name:       clip.name,
          filePath:   filePath,
          inPoint:    clip.inPoint.seconds,
          outPoint:   clip.outPoint.seconds,
          start:      clip.start.seconds
        });
      }
    }

    return okJSON(clips);
  } catch (e) {
    return errorJSON(e.message);
  }
}

/**
 * Adds markers to the active sequence at the given beat times (seconds).
 * @param {string} beatsJSON  JSON array of numbers, e.g. "[1.0, 2.0, 3.0]"
 * @param {string} label      Optional marker label prefix (default "Beat")
 * @returns {string} JSON
 */
function addBeatMarkers(beatsJSON, label) {
  try {
    var beats = JSON.parse(beatsJSON);
    if (!beats || !beats.length) return errorJSON("No beat times provided.");

    var seq = app.project.activeSequence;
    if (!seq) return errorJSON("No active sequence.");

    label = label || "Beat";

    var markers = seq.markers;
    var added   = 0;

    for (var i = 0; i < beats.length; i++) {
      var t = beats[i];
      var tc = Time();
      tc.seconds = t;
      var m = markers.createMarker(tc.ticks);
      m.name    = label + " " + (i + 1);
      m.type    = "Comment";
      added++;
    }

    return okJSON({ markersAdded: added });
  } catch (e) {
    return errorJSON(e.message);
  }
}

/**
 * Removes all sequence markers whose name starts with the given prefix.
 * @param {string} prefix  e.g. "Beat"
 * @returns {string} JSON
 */
function removeBeatMarkers(prefix) {
  try {
    prefix = prefix || "Beat";
    var seq = app.project.activeSequence;
    if (!seq) return errorJSON("No active sequence.");

    var markers = seq.markers;
    var removed = 0;
    var m = markers.getFirstMarker();

    while (m !== undefined) {
      var next = markers.getNextMarker(m);
      if (m.name.indexOf(prefix) === 0) {
        markers.deleteMarker(m);
        removed++;
      }
      m = next;
    }

    return okJSON({ markersRemoved: removed });
  } catch (e) {
    return errorJSON(e.message);
  }
}

/**
 * Returns Premiere Pro / CEP host app version information.
 * @returns {string} JSON
 */
function getHostInfo() {
  try {
    return okJSON({
      appName:    app.appName,
      version:    app.version,
      buildNumber: app.buildNumber
    });
  } catch (e) {
    return errorJSON(e.message);
  }
}
