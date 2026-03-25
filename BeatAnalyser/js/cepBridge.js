/**
 * cepBridge.js — Thin wrapper around CSInterface
 *
 * Provides promise-based helpers so the rest of the panel code
 * never has to touch CSInterface directly or wrangle callbacks.
 */

(function (global) {
  "use strict";

  /* CSInterface is loaded from the Adobe CEP SDK (not bundled here).
   * In a browser preview context it will be undefined — the bridge
   * degrades gracefully so UI development can happen outside Premiere. */
  var cs = (typeof CSInterface !== "undefined") ? new CSInterface() : null;

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                    */
  /* ------------------------------------------------------------------ */

  /** Wrap CSInterface.evalScript in a Promise. */
  function evalScript(fnCall) {
    return new Promise(function (resolve, reject) {
      if (!cs) {
        console.warn("[cepBridge] CSInterface not available — returning mock null.");
        return resolve(null);
      }
      cs.evalScript(fnCall, function (result) {
        if (result === "EvalScript error.") {
          return reject(new Error("ExtendScript error for call: " + fnCall));
        }
        // All hostScript functions return JSON strings.
        try {
          var parsed = JSON.parse(result);
          if (parsed && parsed.success === false) {
            return reject(new Error(parsed.error || "Unknown ExtendScript error."));
          }
          resolve(parsed && parsed.data !== undefined ? parsed.data : parsed);
        } catch (e) {
          // Non-JSON response — return raw string.
          resolve(result);
        }
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                          */
  /* ------------------------------------------------------------------ */

  var bridge = {

    /** True when running inside a real CEP panel. */
    isHosted: !!cs,

    /** Returns info about the currently active Premiere Pro sequence. */
    getActiveSequenceInfo: function () {
      return evalScript("getActiveSequenceInfo()");
    },

    /** Returns all audio clips from the active sequence. */
    getAudioClips: function () {
      return evalScript("getAudioClips()");
    },

    /**
     * Writes beat markers into the active sequence.
     * @param {number[]} beats  Array of beat positions in seconds.
     * @param {string}   label  Marker label prefix (default "Beat").
     */
    addBeatMarkers: function (beats, label) {
      var beatsJSON = JSON.stringify(beats);
      var lbl       = label || "Beat";
      return evalScript(
        "addBeatMarkers(" +
          JSON.stringify(beatsJSON) + ", " +
          JSON.stringify(lbl) +
        ")"
      );
    },

    /**
     * Removes beat markers whose names start with the given prefix.
     * @param {string} prefix  Default "Beat".
     */
    removeBeatMarkers: function (prefix) {
      return evalScript("removeBeatMarkers(" + JSON.stringify(prefix || "Beat") + ")");
    },

    /** Returns Premiere Pro host application info. */
    getHostInfo: function () {
      return evalScript("getHostInfo()");
    },

    /**
     * Opens a native file picker and resolves with the chosen path,
     * or null if the user cancelled.
     */
    pickAudioFile: function () {
      return new Promise(function (resolve) {
        if (!cs) return resolve(null);
        cs.evalScript(
          "var f = File.openDialog('Select audio file', 'Audio:*.wav,*.mp3,*.aif,*.aiff,*.flac,*.ogg'); f ? f.fsName : ''",
          function (result) {
            resolve(result || null);
          }
        );
      });
    },

    /**
     * Reads a local file as a base64-encoded string via ExtendScript.
     * Useful for loading audio data into the WASM analyser.
     * @param {string} filePath  Absolute OS path.
     */
    readFileAsBase64: function (filePath) {
      var script =
        "(function(){" +
          "var f = new File(" + JSON.stringify(filePath) + ");" +
          "f.encoding = 'BINARY';" +
          "f.open('r');" +
          "var raw = f.read();" +
          "f.close();" +
          "return btoa(raw);" +
        "})()";
      return evalScript(script);
    },

    /** Emits a CEP event to all extensions (useful for cross-panel comms). */
    dispatchEvent: function (eventType, data) {
      if (!cs) return;
      var event    = new CSEvent(eventType, "APPLICATION");
      event.data   = JSON.stringify(data);
      cs.dispatchEvent(event);
    },

    /** Registers a listener for an application-level CEP event. */
    addEventListener: function (eventType, callback) {
      if (!cs) return;
      cs.addEventListener(eventType, function (event) {
        try {
          callback(JSON.parse(event.data));
        } catch (e) {
          callback(event.data);
        }
      });
    }
  };

  /* Expose as module or global */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = bridge;
  } else {
    global.cepBridge = bridge;
  }

}(typeof window !== "undefined" ? window : this));
