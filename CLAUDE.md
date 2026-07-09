# Resonance Lab — project reference

A DuetWebControl 3.7 Vue plugin for accelerometer-driven resonance/input-shaping tuning on
RepRapFirmware. Wholly new implementation — not a port of the stock Input Shaping plugin. All
analysis runs in the browser (parse → PSD → recommend, pure TS, no server-side processing). See
`README.md` for the user-facing feature list and `DESIGN.md` for the analysis-engine architecture;
this file is project-specific working notes for whoever (human or AI) is developing the plugin.

## Naming policy (strict)

Do **not** name Klipper, Shake&Tune, Frix(-x), or any other firmware ecosystem/tool anywhere in
code, comments, commit messages, or documentation — this project stands on RepRapFirmware/Duet
vocabulary and the general input-shaping engineering literature only. `grep -rniE
"klipper|shake.?tune|frix" src *.md package.json` should always come back clean; it has been violated
and cleaned up more than once, so re-check it after any doc rewrite.

## Architecture

- **Single lab page** (`src/ResonanceLabPage.vue`) — a left task rail (7 tasks, grouped into 4
  "goals" + a "Diagnostics" drawer of 3) drives a `method` ref; the right panel renders only that
  task's own params (a `TASKS` array holds each task's icon/`usesAxis`/`params`) plus a live
  `durationEstimate` and a result view specific to that task's output shape.
- **Tasks**: `sweep` (shaper calibration, can run several axes at once → combined recommendation),
  `belts` (CoreXY tension comparison), `profile` (speed-sweep vibration), `axescheck` (accelerometer
  orientation → `M955 I`), `excite` (fixed-frequency + spectrogram), `move` (quick native capture),
  `custom` (user-supplied G-code).
- **Analysis core** (`src/analysis/`, pure TS, fully unit-tested, zero Vue/store deps): `fft.ts`,
  `spectrum.ts` (Welch PSD), `shapers.ts` (RRF's MZV/ZVD/ZVDD/ZVDDD/EI2/EI3 per `AxisShaper.cpp`),
  `recommend.ts` (the tuning engine — `findBestShaper` single-axis, `findBestShaperCombined`
  multi-axis), `pipeline.ts` (capture → verdict seam), `peaks.ts`, `belts.ts`, `vibration.ts`,
  `axesMap.ts`/`orientation.ts`, `stft.ts` (spectrogram). See `DESIGN.md` for the full breakdown of
  what each module does and why.
- **Capture I/O** (`src/capture/`): `orchestrator.ts` turns a measurement request into the
  `M955`/`M956`/G-code sequence via an injected `MachineIO` interface (so every sequence is
  unit-testable without a printer — the Vue layer wires `useMachineStore` in), `sweep.ts` (G-code
  generator), `csv.ts` (RRF accelerometer CSV parser + `cropCaptureToDuration`).
- **DWC surfaces**: full page under Plugins, plus an embeddable `SummaryPanel.vue` published via
  `registerEmbeddableComponent` for Flexible Layouts dashboards.
- **`src/state.ts`**: shared reactive state (last result, method/axis selection, multi-axis/belt/
  profile/orientation results) so the page and the embeddable panel see the same session, and
  results persist across leaving/returning to the page.

## Known constraints and gotchas (checked against the firmware source — don't re-derive)

- **RRF's M593 input shaper is machine-wide, not per-axis.** A multi-axis sweep therefore computes
  ONE combined recommendation (`findBestShaperCombined`, worst-axis-and-worst-damping-ratio governs)
  rather than picking one axis's own best and ignoring the rest (confirmed in RRF's `Move.h`: one
  `AxisShaper` "currently just one for all axes").
- **RRF has no smoothing parameter, no smoothing report, and nothing acceleration-linked anywhere in
  its shaping path** (checked directly against `AxisShaper.cpp`/`Move.cpp`) — unlike the planner the
  original smoothing/max-accel estimate model was written for. Those figures were removed from all
  user-facing output; `estimateSmoothing` survives only as an internal, never-displayed tie-breaker
  in the shaper score (RRF's shaping genuinely is a convolution of delayed move-segment copies per
  impulse, so the relative penalty is still meaningful for *choosing between* shapers).
- **RRF has no way to stop an in-progress `M956` recording early** (checked in
  `Accelerometers.cpp`: the accelerometer task loop only exits at the requested sample count or an
  error; there is no stop/abort G-code). Because a CoreXY diagonal belt sweep finishes well before
  its kinematic worst-case duration estimate, sizing a recording from that estimate wastes time
  sampling idle silence — `runBeltCapture`'s self-sizing mode (pass no `samples`) instead oversizes
  to the kinematic estimate and self-times the REAL motion concurrently via the object model's
  busy→idle transition (`MachineIO.awaitBusy`/`awaitIdle`), then the caller crops the downloaded
  capture and caches the measured duration so repeat runs at the same parameters size precisely with
  no waste. This exists specifically because an earlier design (a separate unrecorded timing probe)
  visibly ran the same excitation profile twice in a row — don't reintroduce a separate probe.
- **The captured CSV itself always lands in `0:/sys/accelerometer/`, unconditionally** — RRF's M956
  `F` filename parameter is hardcoded to combine with that directory regardless of what a plugin
  requests (`ConfigureAccelerometer` in `Accelerometers.cpp`). Only the *generated program files*
  (the `.g` macros that drive the test motion) are placed under a configurable folder
  (`DEFAULT_PROGRAM_DIR` = `0:/sys/resonanceLab`, user-settable via the gear-icon settings dialog) —
  and only for the `sweep`/`belts`/`excite` tasks, which are the only ones that upload a program file
  at all (`move`/`custom`/`profile` send inline G-code with no uploaded file). Program files are
  best-effort deleted right after each capture completes, so that folder should be empty in normal
  operation, not accumulating.
- **`vue-i18n` reads a bare `@` as linked-message syntax** (`@:key`) — an unescaped `@` anywhere in
  `en.json` throws a compile error the first time the string renders, which blanks the *entire page*
  (not just that string). Always write a literal `@` as `{'@'}`. `test/i18n.test.ts` greps the whole
  message tree for this; keep it passing.
- **`vitest run` (and CI) exits non-zero on any unhandled promise rejection even when every test
  passes.** `test/smoke.test.ts` mounts the full page, so any `onMounted`/module-load side effect
  (e.g. the on-load update check) must swallow all failures rather than let one propagate.
- **`dwc-plugin-typecheck` gotcha**: copies `src/` into `<DWC>/src/plugins/_typecheck_<tag>/` and
  runs DWC's real `vue-tsc`. Interrupted runs leave stale `_typecheck_*` folders behind (Windows
  file-locking defeats the tool's own cleanup) — `rm -rf` them before *and after* every typecheck/
  build run, or a later run's errors will misleadingly reference a stale copy.
- **A currently-live upstream bug**: `dwc-plugin-runtime`'s `AboutDialog`/`HelpTip`/
  `PluginWidgetConfigForm` (hand-written render-function components, not SFCs) call
  `h("v-xxx", ...)` with a bare string tag. Vue 3 only auto-resolves a globally-registered component
  from a string tag via the SFC template compiler's `resolveComponent()` call — a hand-written render
  function bypasses that, so the About dialog and HelpTip tooltips silently render as inert, invisible
  custom HTML elements (no console warning either, since Vue never attempts resolution for a bare
  `h()` string call). Fixed in the local checkout of `dwc-plugin-runtime`
  (`C:\Users\live\Documents\Github\dwc-plugin-runtime`, `vc(name) => resolveComponent(name)` wrapping
  every such call) and copied into this repo's `node_modules` so it works today, but **not yet
  committed/tagged/pushed upstream** — a fresh `npm install` here will silently revert to the broken
  `v0.8.2` pin until that happens. `test/smoke.test.ts` has two permanent regression tests that will
  fail loudly if that happens ("About dialog actually renders...", "HelpTip renders a real Vuetify
  icon...") — check those first if either ever fails unexpectedly, don't assume it's a resonance-lab
  bug.

## Build / release

- `npm test` needs no DWC checkout (kit-based mount tests). `DWC_DIR=<path> npm run typecheck` /
  `npm run verify-build` need a real DuetWebControl checkout
  (`C:\Users\live\Documents\Github\DuetWebControl`, built against `v3.7-dev`).
- **`build.bat`** (Windows convenience wrapper, matches the convention used by
  `ClosedLoopTuningPlugin`/`thermal-frame-expansion-dwc-plugin`): builds via DWC's own
  `build-plugin-pkg` script and drops `ResonanceLab-<version>.zip` in the repo root. **Must have CRLF
  line endings** — LF-only (even though it's byte-identical in that regard to some sibling plugins'
  working `build.bat` files) triggered `cmd.exe` corruption in this environment (`setlocal`→`tlocal`,
  `set`→`t`, no error otherwise); if a `build.bat` mysteriously fails that way, convert its line
  endings. Invoke via `& cmd.exe /c "<full-path>\build.bat"` — a bare relative `cmd /c build.bat`
  failed to find the file from a PowerShell session in this environment.
- Bump `plugin.json` + `package.json` together for every build (including local test builds).
- Publicly released as of **v1.0.0**: tagging `v<version>` and pushing the tag triggers
  `release.yml`, which builds the ZIP against DWC and auto-publishes a GitHub Release with a
  generated changelog. The tag must match `plugin.json`'s version exactly (no `v` prefix inside the
  file) or the workflow fails fast rather than shipping a mismatched build.

## Testing conventions

- Pure analysis/capture logic lives in `src/analysis/` and `src/capture/` and is unit-tested
  directly in `test/*.test.ts` — no DOM, no mocking, `MachineIO` is injected so orchestrator
  sequences are tested with a fake IO object.
- Page-level Vue wiring (`ResonanceLabPage.vue`) is only smoke-tested (`test/smoke.test.ts`, via
  `dwc-plugin-test-kit`'s `mountInDwc`) for a handful of key render/interaction states — it is not
  exhaustively covered, consistent with the rest of this plugin family's testing depth.
- When verifying that a Vuetify component *actually renders* (not just that a click handler fires),
  remember dialogs teleport: check `document.body.innerHTML`, not `wrapper.html()` — the latter only
  covers the mounted component's own subtree and will show a false negative for anything inside a
  `<v-dialog>`.
