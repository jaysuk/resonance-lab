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

**Two DWC generations are supported from one source tree.** DWC 3.7 (Vue 3 / Vuetify 4 / Pinia /
Vite) and DWC 3.6 (Vue 2.7 / Vuetify 2 / Vuex 3 / webpack) share everything except the markup:

```
src/
  analysis/  capture/  config/  state.ts  updateCheck.ts  i18n/   ← shared, version-neutral
  core/host.ts            HostAdapter: the ~12-call seam onto DWC
  core/useResonanceLab.ts ALL page behaviour, host-injected (~1300 lines)
  ui37/                   Vuetify 4 template + Pinia host + index.ts + SummaryPanel
  ui36/                   Vuetify 2 template + Vuex host + index.ts + AboutDialog/HelpTip
  index.ts                re-exports ui37 (what a plain build.bat ships)
```

**`scripts/stage-dwc36.mjs` has its own hardcoded list of which shared top-level directories to
copy** (`INCLUDE`) — a new shared directory under `src/` (like `config/`) needs adding there too, or
`build36.bat` fails with `Module not found` for anything that imports it, while `build.bat`/tests/
typecheck all stay green (they don't go through the staging step). Caught once already; check this
first if only the 3.6 build breaks after adding a new shared module.

- **Only the template differs.** Vue 2.7 backported the Composition API, so `core/useResonanceLab.ts`
  compiles unchanged against both. When adding a feature, the logic goes in the composable *once*;
  only the two templates need parallel edits. Both pages destructure the same binding list.
- **`HostAdapter`** (`src/core/host.ts`) is the only place either DWC's stores are touched:
  `model`/`isConnected` (reactive reads — they must stay live, the composable's `watch`es depend on
  it), `sendCode`/`upload`/`download`/`delete`/`makeDirectory`/`getFileList`/`installPlugin`,
  `notify`, `t`. 3.7 wires Pinia; 3.6 wires Vuex + `@/utils/notifications`.
- **3.6 differences that are not negotiable**: `registerRoute` comes from `@/routes` (not
  `@/plugins`); there is no `registerPluginMessages` (so `ui36/index.ts` calls vue-i18n 8's
  `i18n.mergeLocaleMessage` with the *same* `plugins.resonanceLab.*` keys, and `i18n/en.json` stays
  shared); there is no `registerEmbeddableComponent`, so the Flexible-Layouts summary panel is
  **3.7-only**; and `dwc-plugin-runtime`'s `AboutDialog`/`HelpTip` are Vue 3-only, so `ui36/` has its
  own ~80-line Vuetify 2 versions. That package's *pure* modules are still shared — but only via deep
  subpath imports (`dwc-plugin-runtime/diagnostics` etc.), never the barrel, which re-exports Vue 3
  components and would break the Vue 2 build.
- **Single lab page** (`src/ui37/ResonanceLabPage.vue`, `src/ui36/ResonanceLabPage.vue`) — a left
  task rail (7 tasks, grouped into 4 "goals" + a "Diagnostics" drawer of 3) drives a `method` ref;
  the right panel renders only that task's own params (a `TASKS` array holds each task's
  icon/`usesAxis`/`params`) plus a live `durationEstimate` and a result view specific to that task's
  output shape.
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
  unit-testable without a printer — the `HostAdapter` supplies the real I/O), `sweep.ts` (G-code
  generator), `csv.ts` (RRF accelerometer CSV parser + `cropCaptureToDuration`), `tools.ts`
  (tool-changer support — see below).
- **Config persistence** (`src/config/`): `gcodeEdit.ts` is a pure, line-preserving G-code file
  editor (parse/find/edit one parameter or one directive/append/diff — no Vue or host imports, so
  it's exhaustively unit-tested without a printer); `machineConfig.ts` is the thin host-injected
  layer that reads config.g/`tpost<N>.g`, builds a preview+diff, and on confirmation backs up the
  original file (`<path>.rlab-<timestamp>.bak`) before writing. Used to persist a measured
  accelerometer orientation or a recommended shaper past a reboot, which `M955`/`M593` sent at
  runtime alone do not survive.
- **DWC surfaces**: full page under Plugins on both generations, plus (3.7 only) an embeddable
  `ui37/SummaryPanel.vue` published via `registerEmbeddableComponent` for Flexible Layouts.
- **`src/state.ts`**: shared reactive state, keyed **per tool** (`activeTool`, `-1` = no tool
  changer / no tool mounted) so sweeping T0 then T1 on a tool-changer doesn't discard T0's result —
  `lastResult`/`multiResults`/`combinedRec`/`orientationResult`/`beltResult`/`profileResult` are all
  writable `computed`s over a `Map<toolNumber, ToolSession>`, so the rest of the app (and the
  embeddable summary panel, which reads `lastResult` directly and never runs `useResonanceLab`)
  keeps working unchanged. **Vue 2.7 does not observe native `Map.set()` through a `ref`** (checked
  empirically, not from docs — Vue 3's Proxy-based reactivity does, Vue 2.7's does not) so every
  write replaces `sessions.value` wholesale with a new `Map` rather than mutating it in place; this
  is the one part of this file that must not be "simplified" back to in-place mutation, or the DWC
  3.6 build silently stops updating the UI on a tool change while 3.7 keeps working fine.
- **The `selectedAccel` → `activeTool` sync watcher in `useResonanceLab.ts` needs `{ immediate:
  true }`.** The accelerometer picker's auto-select chain is three watchers: `accelItems` (immediate,
  calls `autoSelectAccel()` synchronously on setup), `currentToolNumber` (follows tool changes), and a
  plain `watch(selectedAccel, v => { activeTool.value = v?.toolNumber ?? -1 })` that mirrors the pick
  into per-tool state. Without `immediate` on that third watcher, it never observes the *initial*
  synchronous write `autoSelectAccel()` made during the first watcher's own immediate run (it wasn't
  registered yet when that write happened), so `activeTool` sticks at state.ts's `-1` default until
  some later change to `selectedAccel` happens to fire it — which surfaced as a tool-changer's "save
  shaper" dialog offering "T-1 only" as a real button (`planShaperSave` now also rejects a negative
  `toolNumber`, not just `null`, as a second line of defence). If a fourth watcher is ever chained onto
  `selectedAccel`, check whether it needs the same flag.
- **`tools.ts`'s tool↔accelerometer derivation is only as good as config.g's own consistency.** It
  reads `tools[N].extruders[0]` to find the driving board — if a tool's `M563 ... D<n>` extruder index
  doesn't actually match the board its `H`/`F` params point at (e.g. a copy-paste `D2` left over from
  another tool's definition), the derivation faithfully reproduces that mismatch: it resolves the
  *wrong* board (often the mainboard) and the real toolboard's accelerometer shows up unlabelled. This
  is a config.g bug, not a plugin bug, but it presents identically to a broken derivation — cross-check
  the tool's `D`/`H`/`F` params against each other before assuming the code is wrong.

## Known constraints and gotchas (checked against the firmware source — don't re-derive)

- **RRF's M593 input shaper is machine-wide, not per-axis.** A multi-axis sweep therefore computes
  ONE combined recommendation (`findBestShaperCombined`, worst-axis-and-worst-damping-ratio governs)
  rather than picking one axis's own best and ignoring the rest (confirmed in RRF's `Move.h`: one
  `AxisShaper` "currently just one for all axes"). This is also why "save this shaper for one tool
  only" (the config.g save scope dialog) can't mean a per-tool M593 setting — there isn't one. It
  means writing M593 into that tool's own `tpost<N>.g` (RRF's `GCodes.h`: `TPOST "tpost"`), so it's
  re-asserted machine-wide every time that tool is picked up, and left alone (falling back to
  whatever config.g set) whenever a different tool is mounted.
- **A `Tool` has no accelerometer field in the object model.** `src/capture/tools.ts` derives the
  tool↔accelerometer mapping by hand: `tools[N].extruders[0]` → `move.extruders[i].driver.board` (a
  `DriverId`, `.board` = CAN address) → the `boards[]` entry with that `canAddress` → its
  `accelerometer`. Verified against `@duet3d/objectmodel`'s type declarations, not guessed. A board
  that doesn't resolve to any tool's first extruder (a plain mainboard-only machine, or a
  non-standard setup) falls back to labelling by board name alone — existing single-accelerometer
  users see no change.
- **`M955`'s `I` orientation parameter is a string, not a number** (RRF concatenates two face-index
  digits, e.g. `"06"` — `src/analysis/axesMap.ts`'s `iParam: string | null`). A leading zero is
  significant; round-tripping it through `Number()` would silently corrupt it. `gcodeEdit.ts` and
  `machineConfig.ts`'s `planOrientationSave` treat it as an opaque string throughout for this reason.
- **`M955` carries hardware wiring alongside orientation** — `P` (id), `C` (SPI CS pins), `Q` (SPI
  frequency), `I` (orientation) — confirmed in `Accelerometers.cpp`. Saving an orientation to
  config.g therefore edits only the `I` token in place (`gcodeEdit.ts`'s `setParam`, which masks
  quoted spans before searching so it can't be fooled by a digit inside a `C"^spi.cs1"`-style pin
  name); it never rewrites the whole line, which would silently discard `C`/`Q`.
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
- **`DWC_DIR` must point at the 3.7 checkout for typechecking, ALWAYS**
  (`C:\Users\live\Documents\Github\DuetWebControl`). `npm run typecheck` goes through
  `scripts/typecheck.mjs` rather than calling the kit binary directly, for two reasons:
  - **It excludes `src/ui36`.** The kit copies the whole of `src/` into the DWC tree and runs
    `vue-tsc`; the 3.6 sources import `@/store`, `@/routes` and `@/utils/notifications`, none of
    which exist in a 3.7 checkout, so they produce ~20 errors that are not bugs. The wrapper stages a
    temp plugin dir omitting the dirs listed in `dwcTypecheckIgnore` (package.json) and points the
    stock kit at it — the kit takes a plugin directory as its first argument. The 3.6 tree is
    type-checked by its own build instead (`build36.bat` runs fork-ts-checker in the 3.6 toolchain).
  - **It refuses to run without a compiler.** Pointing `DWC_DIR` at a 3.6 checkout used to give a
    confident, entirely fictional "Type-check passed": DWC 3.6 ships no `vue-tsc`, the command
    failed, no output line matched the kit's temp-folder name, and it concluded there were no errors.
    The wrapper pre-checks for the `vue-tsc` binary and exits 2. A silent false pass is worse than no
    check, because it is indistinguishable from a real one.
- **`dwc-plugin-runtime`'s `AboutDialog`/`HelpTip`/`PluginWidgetConfigForm`** are hand-written
  render-function components, not SFCs, so their `h("v-xxx", ...)` calls need an explicit
  `resolveComponent` — Vue 3 only auto-resolves a globally-registered component from a string tag via
  the SFC template compiler. Without it they render as inert, invisible custom elements with no
  console warning. Fixed in the published runtime as of v0.8.5+; `test/smoke.test.ts` has two
  permanent regression tests ("About dialog actually renders...", "HelpTip renders a real Vuetify
  icon...") that fail loudly if a future version regresses it — check those first if either ever
  fails unexpectedly, don't assume it's a resonance-lab bug.
- **The 3.6 build needs `dwc-plugin-runtime`'s subpath exports and its `typesVersions` shim**, both
  present in the published v0.8.7. DWC 3.6's `tsconfig` uses `moduleResolution: "node"`, which
  ignores the `exports` map entirely, so `typesVersions` (`{"*": {"*": ["dist/*"]}}`) is the only
  thing that lets a `dwc-plugin-runtime/<sub>` import resolve its *types* there — without it every
  one fails with TS2307. Don't drop below 0.8.7.
- **A release ships two ZIPs, and the update checker must not mix them up.** `checkForUpdate`
  defaults to the first asset matching `/\.zip$/i` (first-match-wins over `release.assets` in upload
  order), which would offer a 3.6 user the Vue 3 package. Each host therefore sets `assetPattern`
  (`ui37`: negative lookaheads excluding `-dwc36.zip` **and** `-srcmap.zip`; `ui36`: only
  `-dwc36.zip`) and `updateCheck.ts` passes it through. If a third target is ever added, that pattern
  is the thing to update. `scripts/release-footer.mjs` likewise emits one `dwc-plugin-update` metadata
  comment per asset.
- **The DWC 3.7 build also emits a `-srcmap.zip` alongside the real package** (`dwc-plugin-verify-
  build`'s underlying `build-plugin-pkg.js` writes both). It must never reach the GitHub Release: it
  alphabetically uploads *before* the plain `.zip`, so a 3.7 `assetPattern` that didn't also exclude it
  let `checkForUpdate` match the sourcemap archive first and offer it as an "update" (v1.1.0 shipped
  this way before it was caught and fixed). `scripts/verify-build.mjs` deliberately leaves it in the
  build's temp stage rather than copying it out — see below.

## Build / release

- `npm test` needs no DWC checkout (kit-based mount tests). `DWC_DIR=<path> npm run typecheck` /
  `npm run verify-build` need a real DuetWebControl checkout
  (`C:\Users\live\Documents\Github\DuetWebControl`, built against `v3.7-dev`). Both skip `src/ui36`
  (via `dwcTypecheckIgnore` in `package.json`) because those sources only resolve against a 3.6 tree;
  the 3.6 UI is type-checked/built by its own build instead (`build36.bat`, `fork-ts-checker`).
- **`verify-build` has its own scoping wrapper, `scripts/verify-build.mjs`, mirroring
  `scripts/typecheck.mjs` — this is not optional.** The stock `dwc-plugin-verify-build` builds
  whichever `pluginDir` it's pointed at whole; before this wrapper existed, CI ran it unwrapped
  against the real repo root and it type-checked/bundled `src/ui36` against the DWC 3.7 checkout too,
  failing on the same `@/store`/`@/routes`/Vuetify-prop-type errors `typecheck.mjs` was already built
  to avoid (this broke the very first v1.1.0 CI run — `npm run typecheck` passing locally is not
  evidence `npm run verify-build` will). The wrapper stages a temp `src/` excluding
  `dwcTypecheckIgnore`, copies `plugin.json`, and **symlinks `node_modules` from the repo root into
  the stage** — without that symlink, DWC's `build-plugin-pkg.js` sees a `package.json` with no
  adjacent `node_modules`, decides dependencies are "missing", and tries `npm install` inside the
  stage, which has no lockfile context and fails outright in CI/sandboxed environments with no
  network. (Confirmed empirically that `rmSync(stage, {recursive:true})` only unlinks a symlinked
  child, never recurses into or deletes the target — safe to clean up the stage afterwards.)
  Because the ZIP is built *inside* that stage, the wrapper must copy it (but not its `-srcmap.zip`
  sibling, see above) back out to the repo root before deleting the stage, or `release.yml`'s
  `plugin/ResonanceLab-*.zip` glob finds nothing for the 3.7 asset (this also broke v1.1.0's first
  publish attempt — the release had only the 3.6 ZIP attached).
- **Two builds, two ZIPs.** Both must be produced and tested for a release that claims 3.6 support:
  - **`build.bat`** → `ResonanceLab-<version>.zip` (DWC 3.7+, `dwcVersion: 3.7`).
  - **`build36.bat`** → `ResonanceLab-<version>-dwc36.zip` (DWC 3.6, `dwcVersion: 3.6`). It first
    runs `scripts/stage-dwc36.mjs`, which assembles a temp tree of the shared core + `ui36/` with a
    generated `src/index.ts`. Staging exists because DWC's builder always compiles `<pluginDir>/src`
    and would otherwise try (and instantly fail) to compile `ui37/`.
  - The staging step also **vendors `chart.js` and `dwc-plugin-runtime` (plus their dependency
    closure) into `src/node_modules/` of the staged tree.** This is not incidental: DWC 3.6 ships
    chart.js **2.9**, two majors behind what these charts need (`chart.js/auto` doesn't exist there),
    and installing v4 into the checkout would break DWC's own graphs. Webpack resolves package
    imports by walking up from the importing file, so a `node_modules` inside the plugin's own source
    folder wins over the checkout's. It also means `build36.bat` works against **any** clean 3.6
    checkout with no manual preparation.
- Both `.bat` files **must have CRLF line endings** — LF-only (even though it's byte-identical in
  that regard to some sibling plugins' working `build.bat` files) triggered `cmd.exe` corruption in
  this environment (`setlocal`→`tlocal`, `set`→`t`, no error otherwise); if a `.bat` mysteriously
  fails that way, convert its line endings. Invoke via `& cmd.exe /c "<full-path>\build.bat"` — a
  bare relative `cmd /c build.bat` failed to find the file from a PowerShell session here.
- **Stale plugin copies in a DWC tree cause phantom errors.** `build-plugin-pkg` copies the plugin
  into `<DWC>/src/plugins/<id>/` and an interrupted run leaves it there, so the *next* build compiles
  dead code and reports errors against lines that no longer exist (this also applies to sibling
  plugins — a leftover `ClosedLoopTuning` copy in the 3.6 tree produced dozens of unrelated errors).
  `build36.bat` clears its own copy before and after; delete others by hand if output looks wrong.
- Bump `plugin.json` + `package.json` together for every build (including local test builds). The
  single `plugin.json` serves both targets: `dwcVersion: "auto-major"` is resolved by whichever DWC
  does the building, so there is no second manifest to keep in sync.
- Publicly released as of **v1.0.0**: tagging `v<version>` and pushing the tag triggers
  `release.yml`, which builds the ZIP against DWC and auto-publishes a GitHub Release with a
  generated changelog. The tag must match `plugin.json`'s version exactly (no `v` prefix inside the
  file) or the workflow fails fast rather than shipping a mismatched build.
- **Fixing a tag whose Release run failed before publishing anything is a tag move, not a version
  bump.** If no GitHub Release exists yet for that tag (check `gh release view v<x>` — a failed
  `release.yml` run stops before the publish step), a normal follow-up commit + `git tag -f
  v<version>` + `git push origin v<version> --force` reuses the same version with no history rewrite
  needed on `main` (only the tag ref moves). Once a Release *has* published successfully, bump the
  version instead — don't move a tag out from under a real release.
- **`softprops/action-gh-release` does not delete stray assets on a republish.** Re-running
  `release.yml` against a moved tag re-uploads/overwrites whatever's in its current `files:` glob, but
  leaves any previously-uploaded asset that glob no longer matches (e.g. a `-srcmap.zip` uploaded by
  an earlier, buggier run) still attached. After moving a tag to fix a bad release, diff
  `gh release view v<x> --json assets` against what should actually ship and `gh release delete-asset`
  anything left over by hand.

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
