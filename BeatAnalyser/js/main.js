/**
 * main.js — BeatAnalyser panel logic & UI event handling
 *
 * Depends on:
 *   window.cepBridge    (js/cepBridge.js)
 *   window.AudioAnalyser (js/audioAnalyser.js)
 *   aubio.js + essentia.js loaded in index.html before this script
 */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  DOM refs                                                            */
  /* ------------------------------------------------------------------ */

  var dom = {};

  function cacheDom() {
    dom.pickFileBtn      = document.getElementById("btn-pick-file");
    dom.analyseBtn       = document.getElementById("btn-analyse");
    dom.addMarkersBtn    = document.getElementById("btn-add-markers");
    dom.clearMarkersBtn  = document.getElementById("btn-clear-markers");
    dom.getClipsBtn      = document.getElementById("btn-get-clips");

    dom.filePathDisplay  = document.getElementById("file-path");
    dom.statusText       = document.getElementById("status");
    dom.bpmValue         = document.getElementById("bpm-value");
    dom.keyValue         = document.getElementById("key-value");
    dom.scaleValue       = document.getElementById("scale-value");
    dom.confidenceValue  = document.getElementById("confidence-value");
    dom.beatCount        = document.getElementById("beat-count");
    dom.clipsTable       = document.getElementById("clips-table");
    dom.resultsSection   = document.getElementById("results-section");
    dom.spinner          = document.getElementById("spinner");
  }

  /* ------------------------------------------------------------------ */
  /*  Application state                                                   */
  /* ------------------------------------------------------------------ */

  var state = {
    filePath:    null,
    arrayBuffer: null,
    analyser:    null,     // AudioAnalyser instance
    lastResult:  null      // { bpm, confidence, beats, key, scale, strength }
  };

  /* ------------------------------------------------------------------ */
  /*  Utility helpers                                                     */
  /* ------------------------------------------------------------------ */

  function setStatus(msg, isError) {
    dom.statusText.textContent = msg;
    dom.statusText.className   = isError ? "status error" : "status";
  }

  function setLoading(active) {
    dom.spinner.style.display  = active ? "inline-block" : "none";
    dom.analyseBtn.disabled    = active;
    dom.pickFileBtn.disabled   = active;
  }

  function clearResults() {
    dom.bpmValue.textContent        = "—";
    dom.keyValue.textContent        = "—";
    dom.scaleValue.textContent      = "—";
    dom.confidenceValue.textContent = "—";
    dom.beatCount.textContent       = "—";
    dom.resultsSection.classList.remove("has-results");
    state.lastResult = null;
  }

  function renderResults(result) {
    dom.bpmValue.textContent        = result.bpm.toFixed(1);
    dom.keyValue.textContent        = result.key    || "—";
    dom.scaleValue.textContent      = result.scale  || "—";
    dom.confidenceValue.textContent = (result.confidence * 100).toFixed(1) + "%";
    dom.beatCount.textContent       = (result.beats || []).length;
    dom.resultsSection.classList.add("has-results");
    state.lastResult = result;
  }

  function renderClipsTable(clips) {
    if (!clips || !clips.length) {
      dom.clipsTable.innerHTML = "<p class='empty'>No audio clips found in the active sequence.</p>";
      return;
    }

    var html =
      "<table>" +
        "<thead><tr>" +
          "<th>Track</th><th>Clip</th><th>Start</th><th>In</th><th>Out</th>" +
        "</tr></thead><tbody>";

    clips.forEach(function (clip) {
      html +=
        "<tr>" +
          "<td>" + clip.trackIndex + "</td>" +
          "<td title='" + escapeHtml(clip.filePath) + "'>" + escapeHtml(clip.name) + "</td>" +
          "<td>" + formatSeconds(clip.start) + "</td>" +
          "<td>" + formatSeconds(clip.inPoint) + "</td>" +
          "<td>" + formatSeconds(clip.outPoint) + "</td>" +
        "</tr>";
    });

    html += "</tbody></table>";
    dom.clipsTable.innerHTML = html;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatSeconds(sec) {
    var m = Math.floor(sec / 60);
    var s = (sec % 60).toFixed(2);
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* ------------------------------------------------------------------ */
  /*  File loading                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Loads audio from an ArrayBuffer via fetch (URL) or directly.
   * Stores the decoded AudioAnalyser on state.
   */
  function loadArrayBuffer(arrayBuffer) {
    setLoading(true);
    setStatus("Decoding audio…");
    return AudioAnalyser.fromArrayBuffer(arrayBuffer)
      .then(function (analyser) {
        state.analyser    = analyser;
        state.arrayBuffer = arrayBuffer;
        dom.analyseBtn.disabled = false;
        setStatus("Audio loaded. Click Analyse to detect BPM & key.");
      })
      .catch(function (err) {
        setStatus("Failed to decode audio: " + err.message, true);
        console.error(err);
      })
      .then(function () {
        setLoading(false);
      });
  }

  /* ------------------------------------------------------------------ */
  /*  Event handlers                                                      */
  /* ------------------------------------------------------------------ */

  /** Open Premiere's native file picker (ExtendScript) or browser input. */
  function onPickFile() {
    clearResults();

    if (cepBridge.isHosted) {
      // Running inside Premiere — use ExtendScript file dialog.
      cepBridge.pickAudioFile().then(function (filePath) {
        if (!filePath) return setStatus("No file selected.");
        state.filePath = filePath;
        dom.filePathDisplay.textContent = filePath;
        setStatus("Loading file via ExtendScript…");

        return cepBridge.readFileAsBase64(filePath).then(function (b64) {
          var binary = atob(b64);
          var bytes  = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          return loadArrayBuffer(bytes.buffer);
        });
      }).catch(function (err) {
        setStatus("Error reading file: " + err.message, true);
      });

    } else {
      // Browser fallback — use <input type="file">.
      var input    = document.createElement("input");
      input.type   = "file";
      input.accept = "audio/*";
      input.onchange = function () {
        var file = input.files[0];
        if (!file) return;
        state.filePath = file.name;
        dom.filePathDisplay.textContent = file.name;
        var reader = new FileReader();
        reader.onload = function (e) {
          loadArrayBuffer(e.target.result);
        };
        reader.readAsArrayBuffer(file);
      };
      input.click();
    }
  }

  /** Run analysis (BPM + key). */
  function onAnalyse() {
    if (!state.analyser) {
      return setStatus("Please load an audio file first.", true);
    }
    setLoading(true);
    setStatus("Analysing…");
    clearResults();

    state.analyser.analyse()
      .then(function (result) {
        renderResults(result);
        setStatus(
          "Done — " + result.bpm.toFixed(1) + " BPM  •  " +
          result.key + " " + result.scale
        );
      })
      .catch(function (err) {
        setStatus("Analysis failed: " + err.message, true);
        console.error(err);
      })
      .then(function () {
        setLoading(false);
      });
  }

  /** Write beat markers into the active Premiere sequence. */
  function onAddMarkers() {
    if (!state.lastResult || !state.lastResult.beats.length) {
      return setStatus("No beats available. Analyse audio first.", true);
    }
    setStatus("Adding markers to sequence…");
    cepBridge.addBeatMarkers(state.lastResult.beats, "Beat")
      .then(function (result) {
        setStatus("Added " + result.markersAdded + " beat markers to the timeline.");
      })
      .catch(function (err) {
        setStatus("Could not add markers: " + err.message, true);
      });
  }

  /** Remove all "Beat" markers from the active sequence. */
  function onClearMarkers() {
    setStatus("Removing beat markers…");
    cepBridge.removeBeatMarkers("Beat")
      .then(function (result) {
        setStatus("Removed " + result.markersRemoved + " beat markers.");
      })
      .catch(function (err) {
        setStatus("Could not remove markers: " + err.message, true);
      });
  }

  /** List all audio clips from the active sequence. */
  function onGetClips() {
    setStatus("Fetching clips from active sequence…");
    cepBridge.getAudioClips()
      .then(function (clips) {
        renderClipsTable(clips);
        setStatus("Found " + (clips ? clips.length : 0) + " audio clip(s).");
      })
      .catch(function (err) {
        setStatus("Could not get clips: " + err.message, true);
      });
  }

  /* ------------------------------------------------------------------ */
  /*  Initialise                                                          */
  /* ------------------------------------------------------------------ */

  function init() {
    cacheDom();

    // Show host info if inside Premiere
    if (cepBridge.isHosted) {
      cepBridge.getHostInfo().then(function (info) {
        if (info) {
          setStatus(info.appName + " " + info.version + " detected.");
        }
      }).catch(function () {});
    } else {
      setStatus("Running in browser preview mode (not connected to Premiere).");
    }

    // Wire up buttons
    dom.pickFileBtn.addEventListener("click",     onPickFile);
    dom.analyseBtn.addEventListener("click",      onAnalyse);
    dom.addMarkersBtn.addEventListener("click",   onAddMarkers);
    dom.clearMarkersBtn.addEventListener("click", onClearMarkers);
    dom.getClipsBtn.addEventListener("click",     onGetClips);

    // Disable analyse until a file is loaded
    dom.analyseBtn.disabled    = true;
    dom.addMarkersBtn.disabled = false;
    dom.clearMarkersBtn.disabled = false;

    // Drag-and-drop audio files onto the panel
    document.body.addEventListener("dragover", function (e) {
      e.preventDefault();
    });
    document.body.addEventListener("drop", function (e) {
      e.preventDefault();
      var file = e.dataTransfer.files[0];
      if (!file) return;
      if (!file.type.startsWith("audio/")) {
        return setStatus("Dropped file is not an audio file.", true);
      }
      state.filePath = file.name;
      dom.filePathDisplay.textContent = file.name;
      clearResults();
      var reader = new FileReader();
      reader.onload = function (ev) {
        loadArrayBuffer(ev.target.result);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Wait for the DOM to be ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

}());
