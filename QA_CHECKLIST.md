# Beat Analyser — Manual QA Checklist

Use this document for a structured manual test pass before releasing a new build.
Work through each section in order; later sections depend on earlier ones passing.

Mark each item **[ ]** → **[x]** (pass) or **[~]** (partial / needs follow-up).

**Build under test:** `_______________`
**Premiere Pro version:** `_______________`
**OS / platform:** `_______________`
**Tester:** `_______________`
**Date:** `_______________`

---

## §1 — Environment Setup

> Prerequisites: `npm install` completed, WASM bundles present in `lib/`,
> `PlayerDebugMode` registry/plist key set, symlink created.
> See `SETUP.md` for instructions.

- [ ] **1.1** `lib/aubio.js` exists and is > 10 KB
  - `ls -lh BeatAnalyser/lib/aubio.js` → expected ≥ 400 KB
- [ ] **1.2** `lib/essentia.js` exists and is > 10 KB
  - `ls -lh BeatAnalyser/lib/essentia.js` → expected ≥ 5 MB
- [ ] **1.3** Symlink (or copy) is present in the CEP extensions directory
  - **Windows:** `dir /AL "%APPDATA%\Adobe\CEP\extensions\BeatAnalyser"`
  - **macOS:** `ls -la ~/Library/Application\ Support/Adobe/CEP/extensions/BeatAnalyser`
- [ ] **1.4** PlayerDebugMode registry/plist key is set to `"1"` for CSXS.11
  - **Windows:** `reg query "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode`
  - **macOS:** `defaults read com.adobe.CSXS.11 PlayerDebugMode`

---

## §2 — Panel Loading

### 2a. Open in Premiere Pro

- [ ] **2.1** Launch Adobe Premiere Pro (version 2021 / v15.0 or later).
- [ ] **2.2** Open an existing project **or** create a new project with a sequence.
- [ ] **2.3** Navigate to **Window → Extensions** — confirm "Beat Analyser" appears
  in the submenu.
  - **Fail indicator:** item absent → check PlayerDebugMode (§1.4) and symlink
    (§1.3), then fully quit and restart Premiere.
- [ ] **2.4** Click **Beat Analyser** — panel opens and is visible.
- [ ] **2.5** Panel header reads "Beat Analyser" with the SVG waveform icon.
- [ ] **2.6** "Analyse Active Clip" button is present and **enabled**.
- [ ] **2.7** "Place Beat Markers" button is present and **disabled** (greyed out).
- [ ] **2.8** "Export Timeline" button is present and **enabled**.
- [ ] **2.9** Log area shows a connection message, e.g.
  `"Connected: Adobe Premiere Pro 15.x.x"` (or similar for your version).
- [ ] **2.10** Host version is shown in the panel footer (e.g. `"Adobe Premiere Pro 15.4.0"`).

### 2b. DevTools sanity check

- [ ] **2.11** Open Chrome/Edge, navigate to `http://localhost:8789`.
  - Confirm the Beat Analyser panel appears as an inspectable target.
- [ ] **2.12** Open the DevTools Console — **no** uncaught JavaScript errors on load.
- [ ] **2.13** Network tab shows no failed resource loads (aubio.js, essentia.js,
  main.js, cepBridge.js, audioAnalyser.js loaded with HTTP 200 or from cache).

---

## §3 — 120 BPM Reference Track (Known BPM)

> **Test asset:** A rendered click track or metronome recording at exactly
> **120.00 BPM**, minimum 30 seconds, saved as a WAV or MP3.
> Place it on an **audio track (A1)** in an open sequence.
>
> Acceptable BPM tolerance: ± 1.0 BPM (i.e. 119.00 – 121.00 BPM).

- [ ] **3.1** Place the 120 BPM reference file on A1 of the active sequence.
- [ ] **3.2** Click **"Analyse Active Clip"**.
- [ ] **3.3** Spinner appears inside the button; button label changes to
  "Analysing…"; button is disabled while analysis runs.
- [ ] **3.4** Log shows `"Getting active clip from sequence…"` then the clip name
  (e.g. `"click_120bpm.wav (A1)"`).
- [ ] **3.5** Log shows `"Reading audio: click_120bpm.wav"`.
- [ ] **3.6** Log shows `"Running analysis (BPM + key detection)…"`.
- [ ] **3.7** Analysis completes without error (no red log entries).
- [ ] **3.8** **BPM display** shows a value between **119.00 and 121.00**.
  - Record actual value: `___________`
- [ ] **3.9** Beat count display shows a plausible value.
  - 30 s at 120 BPM ≈ 60 beats; 60 s ≈ 120 beats; 3 min ≈ 360 beats.
  - Acceptable range: ± 5 beats of expected.
  - Record expected / actual: `expected _____ / actual _____`
- [ ] **3.10** "Place Beat Markers" button is now **enabled**.
- [ ] **3.11** Spinner disappears; button label reverts to "Analyse Active Clip".
- [ ] **3.12** Success log entry shows `"120.00 BPM · <key> · <N> beats"`.

### 3a. aubio yinfft fallback (optional — only if 3.8 fails)

> Skip this section if §3.8 passes. If BPM came back as 0 or NaN:

- [ ] **3.13** Open DevTools Console — confirm warning:
  `"[audioAnalyser] Default onset method failed: … retrying with yinfft…"`
- [ ] **3.14** After retry, BPM display shows a plausible value (not 0 / NaN).
- [ ] **3.15** No `InsufficientBeatsError` in the log.

---

## §4 — Minor Key Detection (A Minor Reference)

> **Test asset:** A recording clearly in **A minor** (e.g. a simple A minor
> chord progression or scale). Minimum 20 seconds.
> Place it on **A1** of a sequence.
>
> Acceptable: key = "A", scale = "minor", keyStrength ≥ 0.50.

- [ ] **4.1** Place the A minor reference file on A1.
- [ ] **4.2** Click **"Analyse Active Clip"**.
- [ ] **4.3** Analysis completes without error.
- [ ] **4.4** **Key display** reads **"A Minor"** (capital A, capitalised scale).
  - Record actual: `___________`
- [ ] **4.5** Key strength bar is partially or fully filled.
- [ ] **4.6** Key strength value ≥ **0.50** (recorded: `_______`).
- [ ] **4.7** If strength ≥ 0.75: results card has the `.is-strong` class applied
  (strength bar turns green / success colour).
  - Inspect in DevTools → Elements → `#results-section` classList.
- [ ] **4.8** Hidden compat output `#key-value` contains `"A"`, `#scale-value`
  contains `"minor"`, `#confidence-value` contains a numeric string.

### 4a. Contrast — major key track

- [ ] **4.9** Repeat with a track clearly in **C major**.
- [ ] **4.10** Key display reads **"C Major"**.
- [ ] **4.11** Scale shown is **"Major"** (not "minor").

---

## §5 — Beat Marker Placement

> Prerequisite: §3 passed. The 120 BPM reference track has been analysed and
> "Place Beat Markers" is enabled.

### 5a. Marker count

- [ ] **5.1** Note the **beat count** shown in the panel (e.g. 60 beats for 30 s clip).
  Record: `_______`
- [ ] **5.2** Click **"Place Beat Markers"**.
- [ ] **5.3** Log shows `"Fetching sequence frame rate…"` then sequence metadata.
- [ ] **5.4** Log shows `"Placing N markers…"`.
- [ ] **5.5** Log shows success: `"Placed N beat markers"`.
- [ ] **5.6** Open the **Markers panel** (Marker → Markers panel or Window → Markers)
  — confirm marker count matches the beat count shown in §5.1.
  - Record actual marker count in Premiere: `_______`
  - Difference ≤ 2 (timing rounding): **pass**.

### 5b. Marker labels

- [ ] **5.7** First marker in the Markers panel is labelled **"Beat 1"**.
- [ ] **5.8** Second marker is labelled **"Beat 2"**.
- [ ] **5.9** Last marker is labelled **"Beat N"** where N = beat count from §5.1.
- [ ] **5.10** Marker **Comments** field contains a string like:
  `"BeatAnalyser — frame 30 @ 25fps — 1.2000s"`.
- [ ] **5.11** All markers are of type **Comment** (green marker in timeline).

### 5c. Re-run replaces, not accumulates

- [ ] **5.12** Click **"Analyse Active Clip"** again (same file).
- [ ] **5.13** Click **"Place Beat Markers"** again.
- [ ] **5.14** Log shows `"Placed N beat markers (replaced M existing)"` where M > 0.
- [ ] **5.15** Total marker count in Premiere is the **same** as after §5.6
  (no duplicate markers from the second run).

### 5d. Clear markers

- [ ] **5.16** Click the **"Clear"** button (next to Place Beat Markers).
- [ ] **5.17** Log shows `"Removed N beat markers"`.
- [ ] **5.18** Markers panel in Premiere is **empty** (or contains only non-Beat markers).

### 5e. Marker limit (> 999 beats) — if applicable

> Skip if beat count < 999. To force-test: analyse a long high-BPM track
> (e.g. 200 BPM × 6 min = ~1200 beats).

- [ ] **5.19** After analysis of a > 999 beat track, log shows a **yellow warning**:
  `"N beats detected — Premiere Pro supports up to 999 markers…"`
- [ ] **5.20** Click **"Place Beat Markers"**.
- [ ] **5.21** Log shows another yellow warning with beat count and stride prompt.
- [ ] **5.22** A log entry appears with three inline buttons:
  **Every beat (N)**, **Every 2nd (N/2)**, **Every 4th (N/4)**.
- [ ] **5.23** Click **"Every 2nd"**.
- [ ] **5.24** Chooser row disappears from the log.
- [ ] **5.25** Log shows `"Stride: Every 2nd — N/2 markers will be placed."` then
  `"Placing N/2 markers (every 2 beats)…"`.
- [ ] **5.26** Actual markers placed ≤ 999.
- [ ] **5.27** After clearing and clicking "Place Beat Markers" again, the stride
  chooser **reappears** (stride resets when analysis is cleared).

---

## §6 — Export Timeline

> Prerequisite: An active sequence is open with at least one clip.
> AME (Adobe Media Encoder) must be installed.

### 6a. Extension validation

- [ ] **6.1** Enter a path ending in **`.avi`** (invalid extension) in the export
  path field (e.g. `C:\Users\test\output.avi` or `~/Desktop/output.avi`).
- [ ] **6.2** Click **"Export Timeline"**.
- [ ] **6.3** Log shows a **red error** containing:
  `"Export path must end in .mp4, .mov, or .mxf — got: .avi"`.
- [ ] **6.4** Export is **not** triggered (AME does not open).
- [ ] **6.5** Repeat with a path with **no extension** (e.g. `output`).
- [ ] **6.6** Log shows `"got: (no extension)"`.

### 6b. Valid export

- [ ] **6.7** Enter a valid path ending in `.mp4` pointing to a writable directory
  that **already exists** (e.g. `C:\Users\test\output.mp4` or `~/Desktop/output.mp4`).
- [ ] **6.8** Click **"Export Timeline"**.
- [ ] **6.9** AME launches (if not already open) and the job appears in its queue.
- [ ] **6.10** Log shows green success: `"Export queued — "<sequence name>" → output.mp4  (AME job <id>)"`.
- [ ] **6.11** AME begins encoding. Allow it to complete.
- [ ] **6.12** Output file exists on disk at the specified path.
- [ ] **6.13** Output file is playable (opens in VLC / QuickTime / Windows Media Player).

### 6c. Browse button

- [ ] **6.14** Click the **"…"** browse button.
- [ ] **6.15** A native Save dialog appears (Premiere Pro's `File.saveDialog`).
- [ ] **6.16** Choose a `.mp4` destination and confirm.
- [ ] **6.17** The export path input field populates with the chosen path.

### 6d. Non-existent directory

- [ ] **6.18** Enter a path whose parent directory does **not** exist
  (e.g. `C:\NoSuchFolder\output.mp4`).
- [ ] **6.19** Click **"Export Timeline"**.
- [ ] **6.20** Log shows a red error referencing the missing directory
  (from ExtendScript: `"Output directory does not exist: …"`).

---

## §7 — Error States

### 7a. No active sequence

> Reproduce by having no sequences open in Premiere, or by closing all sequence tabs.

- [ ] **7.1** Close all sequence tabs (or create a project with no sequences).
- [ ] **7.2** Click **"Analyse Active Clip"**.
- [ ] **7.3** Log shows a **red error** message containing:
  `"No active sequence"` (or similar wording about clicking a sequence tab).
- [ ] **7.4** The results display is **not** populated (BPM remains "—").
- [ ] **7.5** "Place Beat Markers" remains **disabled**.

### 7b. No project open

> Reproduce by starting Premiere Pro and clicking Analyse before opening a project.

- [ ] **7.6** Start Premiere Pro. Do **not** open a project.
- [ ] **7.7** Open Beat Analyser, click **"Analyse Active Clip"**.
- [ ] **7.8** Log shows red error: `"No project is currently open."` (or similar).

### 7c. Silent clip

> Reproduce by creating a 10-second clip of pure digital silence (all-zero WAV).
> Place it on A1 of a sequence.

- [ ] **7.9** Place the silent clip on A1. Analyse it.
- [ ] **7.10** Log shows a **red error** message containing `"silent"` or `"RMS"`.
- [ ] **7.11** No crash or hang (error is caught and displayed cleanly).
- [ ] **7.12** "Place Beat Markers" remains disabled.
- [ ] **7.13** Clicking **"Analyse Active Clip"** again (with a valid clip) recovers
  normally — the error state does not persist.

### 7d. Unsupported audio format

> Reproduce with a file the CEF Web Audio API cannot decode.
> Options: a raw `.pcm` binary, a MIDI file renamed to `.wav`,
> or a video-only `.mp4` with no audio stream.

- [ ] **7.14** Place the unsupported file on A1. Analyse it.
- [ ] **7.15** Log shows a **red error** mentioning `"Unsupported audio format"` or
  `"could not be decoded"`.
- [ ] **7.16** No crash; panel remains responsive.

### 7e. Offline / missing clip

> Reproduce by relinking a project item to a non-existent file path, or by
> disconnecting the drive containing the media, then analysing.

- [ ] **7.17** Trigger the offline condition. Analyse.
- [ ] **7.18** Log shows a red error referencing a file-read failure
  (`"Could not read file"` or similar) with a hint about the clip being offline.
- [ ] **7.19** Panel remains responsive.

### 7f. Video-file clip (A/V container on video track)

> Reproduce by placing an `.mp4` or `.mov` A/V file **only on V1** (no A1 component).
> The clip carries audio inside the video container.

- [ ] **7.20** Place an `.mp4` A/V file on V1 only. Analyse.
- [ ] **7.21** Log shows a **yellow warning**:
  `"Source is a video file — audio will be extracted by the Web Audio decoder…"`
- [ ] **7.22** Analysis still completes (Web Audio API can decode MP4/AAC).
- [ ] **7.23** BPM and key results are displayed.

### 7g. Linked A/V clip (video on V1, audio on A1)

> Standard editing setup: drag an A/V clip to the timeline, Premiere splits it
> into a linked video clip on V1 and an audio clip on A1.

- [ ] **7.24** Place a linked A/V clip (standard drag from Project panel).
- [ ] **7.25** Analyse. Log shows the clip was resolved from `"A1"` (not `"V1"`).
- [ ] **7.26** Log shows `"Using linked audio component (A1) from the video clip on V1."`.
- [ ] **7.27** BPM and key results are correct.

---

## §8 — Drag-and-Drop (Browser / Dev Mode)

> This section tests the drag-and-drop workflow that bypasses cepBridge.
> Can be tested from within Premiere Pro or from a plain browser preview.

- [ ] **8.1** Drag a valid MP3 or WAV file from the OS file manager onto the panel.
- [ ] **8.2** Panel overlay (`body.drag-over::after`) appears while dragging over
  the panel.
- [ ] **8.3** On drop, log shows `"Loading dropped file: <filename>"`.
- [ ] **8.4** Analysis runs and results are shown.
- [ ] **8.5** Drag a **non-audio file** (e.g. a `.txt`) onto the panel.
- [ ] **8.6** Log shows red error: `"Dropped item is not an audio file"`.
- [ ] **8.7** The drag-over overlay disappears correctly after drop (no stuck overlay).

---

## §9 — Results Display

- [ ] **9.1** BPM value uses exactly **2 decimal places** (e.g. `120.00`, not `120` or `120.001`).
- [ ] **9.2** Key display capitalises scale correctly: **"A Minor"**, not "A minor" or "A MINOR".
- [ ] **9.3** Beat count shows `"N beats detected"`.
- [ ] **9.4** Key strength bar width visually matches the numeric strength value.
- [ ] **9.5** Strength value is displayed as a decimal to 2 d.p. (e.g. `"0.87"`).
- [ ] **9.6** ARIA `aria-valuenow` on the strength track element equals
  `Math.round(strength * 100)` — verify in DevTools → Elements.
- [ ] **9.7** Running a second analysis (different file) **replaces** the previous
  results (not appends to them).

---

## §10 — Browser Preview (No Premiere Pro)

> Open `BeatAnalyser/index.html` directly in Chrome (requires
> `--allow-file-access-from-files` or a local HTTP server).

- [ ] **10.1** Panel loads without JS errors.
- [ ] **10.2** Log shows `"Browser preview — Premiere Pro not connected."` (yellow).
- [ ] **10.3** Clicking **"Analyse Active Clip"** opens the browser file picker.
- [ ] **10.4** Selecting a valid audio file runs the full analysis and shows results.
- [ ] **10.5** "Place Beat Markers" button enables after analysis.
- [ ] **10.6** Clicking "Place Beat Markers" logs a CEP error (expected in browser mode:
  `"CEP environment error: CSInterface not available"` or similar).
- [ ] **10.7** Drag-and-drop onto the panel body works (§8 checks apply).

---

## §11 — Performance Baseline

> These are not pass/fail items — record the times to catch regressions.

| File | Duration | BPM | Analysis time |
|---|---|---|---|
| 120 BPM click track (WAV, 44.1 kHz) | 60 s | 120.00 | _______ s |
| Mixed pop track (MP3, 128 kbps) | 3 min | _______ | _______ s |
| Orchestral track (WAV, 48 kHz) | 5 min | _______ | _______ s |

- [ ] **11.1** 60-second WAV at 44.1 kHz: analysis completes in < **10 seconds**.
- [ ] **11.2** 3-minute MP3: analysis completes in < **30 seconds**.
- [ ] **11.3** Panel remains responsive (no UI freeze visible) during analysis
  (button disabled, spinner animating, log entries appear progressively).

---

## §12 — Sign-off

| Item | Pass / Fail / N/A | Notes |
|---|---|---|
| §2 Panel Loading | | |
| §3 120 BPM Track | | |
| §4 Minor Key Detection | | |
| §5 Beat Marker Placement | | |
| §6 Export Timeline | | |
| §7 Error States | | |
| §8 Drag-and-Drop | | |
| §9 Results Display | | |
| §10 Browser Preview | | |
| §11 Performance | | |

**Overall result:** ☐ PASS — ready for release  ☐ FAIL — see notes below

**Issues found:**

```
(list any failures with §.item number and description)
```

**Tester sign-off:** `_______________`
**Date:** `_______________`
