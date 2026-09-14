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
  task rail (9 tasks, up to 6 "goals" (`motortune` only when the firmware gate below passes) + a
  "Diagnostics" drawer of 3) drives a `method` ref; the right panel renders only that task's own
  params (a `TASKS` array holds each task's icon/`usesAxis`/`params`) plus a live `durationEstimate`
  and a result view specific to that task's output shape.
- **Tasks**: `sweep` (shaper calibration, can run several axes at once → combined recommendation),
  `belts` (CoreXY tension comparison), `profile` (speed-sweep vibration), `axescheck` (accelerometer
  orientation → `M955 I`), `motor` (motor-quality harmonic analysis — see below), `motortune` (motor
  waveform-correction search — see below, gated on RRF ≥3.7.0-rc.1), `excite` (fixed-frequency +
  spectrogram), `move` (quick native capture), `custom` (user-supplied G-code).
- **`motor` task** (`src/analysis/motorHarmonics.ts`, `src/capture/motorMoves.ts`) — measures the
  motor and driver themselves rather than the machine's structural response, unlike every other task.
  Runs a motor-isolating move (on core kinematics, the column of `move.kinematics.forwardMatrix`
  belonging to one motor — `inverseMatrix * forwardMatrix` is the identity, so that column is exactly
  the Cartesian direction that drives only that motor; on other kinematics, Z alone) at a range of
  constant speeds, and evaluates vibration at quarter-multiples of the motor's full-step frequency (a
  current-waveform error repeats once per electrical cycle, i.e. four full steps): 1× = detent
  torque/step ripple, 0.5× = coil current imbalance, 0.25×/0.75× = distorted current waveform. Reports
  displacement in µm (`a / (2πf)²`), not acceleration, since displacement alone is speed-independent
  and can carry a fixed threshold (<0.5 µm low, <2 µm moderate, else high). A speed sweep is clustered
  by *absolute* frequency across the recordings (not by order), because the machine's mechanical
  response depends only on absolute frequency — this cancels the machine out and isolates the motor.
  **Analysis only**: emits no `M970.3`/`M569.2` driver-correction G-code and needs no board/driver
  capability beyond `M955`/`M956` — unlike the stock DWC Input Shaping plugin's motor-tuning tab, which
  is gated to MB6HC-class boards because *writing* a correction needs phase stepping; this task's
  *measurement* half needs nothing of the kind, so it isn't gated at all. Test speed is capped by
  `maxSpeedForRate` so the full-step frequency (with its ±5% search margin) stays below the
  accelerometer's Nyquist frequency; a motor whose axis doesn't report `microstepping.value` is
  omitted from the motor picker entirely rather than assuming 16, since a wrong assumed microstepping
  would produce a confident analysis at the wrong frequency.
- **`motortune` task** (`src/analysis/motorTuning.ts`, `src/config/firmwareVersion.ts`,
  `src/config/driverChip.ts`) — searches for and writes a motor's current-waveform correction, unlike
  `motor`'s analysis-only measurement. **Gated on `boards[].firmwareVersion` ≥ `3.7.0-rc.1` on both
  the mainboard and the driver's own board** (fails closed on missing/unparseable versions — the task
  is hidden from the rail entirely below that version, not merely disabled, since `M970.3`/`M569.2`'s
  waveform-correction sub-command may not exist in older firmware at all). The STM32 port appends a
  parenthesised suffix to its version string (`3.7.0-rc.1(CAN0)`, `3.7.0-beta.1(no 3rd order
  motion)` — with a space, despite `Version.h`'s own comment claiming otherwise); `firmwareVersion.ts`
  strips it before parsing, or every STM32H7 board — the main phase-stepping platform — would fail
  the gate. **Never hardcode a board list** (checked: the stock DWC plugin's own list has already
  grown once, `["MB6HC"]` → `["MB6HC","EXP3HC","EXP1HCL","M23CL"]`, and the object model carries no
  driver chip-type field to check against anyway) — command choice comes from `axis.phaseStep`
  (`M970.3`, free phase, harmonics 2 & 4, if true; else `M569.2`'s sine table, phase constrained to
  0/180, harmonic 4 only — harmonic 2/coil-imbalance isn't representable there) and a runtime
  query-form probe before any write. The chip itself (informative only, never gating) is identified
  by reading its IOIN register's VERSION byte over `M569.2 P<drv> R<addr>` (UART parts at `0x06`, SPI
  at `0x04`) — the same method the sibling `duet-tmc-tuner` plugin uses, since this is the only
  reliable way to tell a TMC5160/2240 (has a waveform correction) from a TMC2208/2209 (doesn't) on
  the STM32 port. **The first such register read after a page load is often stale** (RRF returns a
  cached/empty value before the driver is actually read) — `detectChip()` retries up to 4× with a
  200 ms gap; don't remove that loop. The search itself models a correction as a vector added to the
  motor's own error vector, making the squared-amplitude response linear in four unknowns, so a
  least-squares fit finds the optimum in closed form; both move directions are measured and fit
  separately then combined, since a rotor-fixed error component shifts by the load angle and flips
  sign with direction. **Always snapshots the driver's prior correction from the probe reply before
  the first write, and restores it on cancel/error/Discard** — a partially-tuned driver left behind
  after an abort is silent and the user has no way to know. `M970.3`/`M569.2` reach CAN-connected
  expansion-board drivers too (confirmed: the CAN message table for `M970.3` lives in the separate
  `Duet3D/CANlib` repo, not RepRapFirmware itself — a missing `EutProcessM970Point3`-style handler in
  the firmware repo proves nothing, since generic CAN commands are table-driven in CANlib).
- **Single-accelerometer activation (RRF ≥3.7.0-rc.1, `src/config/accelWiring.ts`,
  `src/config/firmwareVersion.ts`'s `MIN_ACCEL_FIRMWARE`)** — `81d68e1` collapsed `M955`/`M956` to
  exactly one active accelerometer machine-wide: `C` (with an optional `<canAddress>.` prefix) is
  mandatory in `M955`, and **every `M955 C"..."` — local or remote — deletes and recreates the
  accelerometer object**, resetting orientation to identity unless `I` is resupplied in the *same*
  command (`I` is now only ever read inside the `gb.Seen('C')` branch — a bare `M955 P<id> I<n>`, with
  no `C`, is a silent no-op on this firmware). Same `firmwareAtLeast` machinery as `motortune` but a
  **separate** constant (`MIN_ACCEL_FIRMWARE`, not `MIN_TUNE_FIRMWARE`) since the two gate unrelated
  capabilities that only coincide on this release. Below the gate every code path is byte-identical to
  pre-`81d68e1` behaviour.
  - **`P0` is mandatory in `M955` AND `M956`, in EVERY form (configure, query, arm) — never omitted,
    even alongside `C`.** Confirmed directly against RRF source (`Accelerometers.cpp`'s
    `ConfigureAccelerometer`/`StartAccelerometer`, both `gb.MustSee('P')` unconditionally before
    anything else), not the changelog: it describes `P` as "zero or omitted (it defaults to zero)",
    which is not accurate to the shipped implementation. `GetLimitedUIValue('P', ActualMaxAccelerometers)`
    then caps it to `[0, 1)` — i.e. **the only legal value is literally `0`**; the plugin's own
    `AccelerometerRef.id` (`"<canAddress>.0"`/`"0"`, an internal board-identifying key) must never be
    sent as `P` verbatim once this scheme applies, only ever as the string `"0"`.
    - `useResonanceLab.ts`'s `buildActivationCode`/`buildActivationCodeWithOrientation` and
      `machineConfig.ts`'s `planAccelSave` all build `M955 P0 C"..."`; `planAccelSave`'s edit path
      additionally self-heals a line saved by an earlier (pre-fix) version of this plugin that lacked
      `P0` (`setParam` appends a missing token), since an unfixed line breaks config.g's own boot-time
      `M955` too, independent of anything this plugin sends at runtime.
    - `orchestrator.ts`'s six capture functions send `M956 P0 ...` (never a bare `M956 ...`) whenever
      `activationCode` is set; legacy firmware keeps sending the old board.driver-shaped id, unchanged.
    - `readAccelOrientation`/`readAccelRate` used to send a bare query `M955 P<accelId>` with the OLD
      board.driver-shaped id (e.g. `"121.0"`) - always invalid once `GetLimitedUIValue` caps P to
      `{0}`, and moot regardless, since RRF's query path reports on whichever board its OWN
      `configs[0].boardAddress` bookkeeping currently points at (whichever board a `M955 C` last
      targeted), not on whatever id is passed as `P`. Fixed to read the object model directly instead
      (`liveAccelState(canAddress)`, the same source `buildActivationCode` already trusts) on
      new-scheme firmware — `boards[N].accelerometer` is populated per board independently of which
      one is globally active, so it answers "this board's own configured orientation/rate" correctly
      without a G-code round trip at all. Legacy firmware keeps the original G-code query, unchanged.
    - Two DISTINCT real-world symptoms this class of bug produced, from one field report (a Duet3D
      developer, RC1 on both mainboard and toolboard - ruling out a firmware-version mismatch as the
      cause): `Error M955: missing parameter 'P'` (the activation line omitting P entirely) and
      separately `Error M955: parameter 'P' too high` (`readAccelOrientation`/`readAccelRate` sending
      the old board.driver id, e.g. `121`, against a cap of `{0}`). An earlier pass at this fix
      mis-attributed the first symptom to a mainboard/toolboard firmware mismatch instead - see below.
  - **Also gated per-accelerometer on THAT accelerometer's own board firmware
    (`useResonanceLab.ts`'s `usesNewAccelSchemeFor(canAddress)`, `machineConfig.ts`'s
    `firmwareUsesNewAccelScheme(host, canAddress)`) — never `boards[0]` (the mainboard) alone.** A
    remote `M955` (its `C` carries a CAN-address prefix) is forwarded whole to the board that prefix
    names and parsed there by THAT board's own firmware, which is flashed and updated independently of
    the mainboard's, so this is still the more correct check in general. **This was NOT, however, what
    explained the field report above** - that reporter had RC1 on both boards; a real fix (P0 above)
    turned out to have nothing to do with per-board firmware. Kept because the underlying property
    (a toolboard's firmware CAN genuinely lag the mainboard's) is real, just not what was seen here.
  - **`useResonanceLab.ts`'s `buildActivationCode` reissues the full `M955 C"..." I<n> Q<freq> R<res>
    S<rate>` line before *every single measurement*, unconditionally** — never "skip if already
    active", since nothing tells this plugin whether another actor repointed the active accelerometer
    since the last capture. `orchestrator.ts`'s six capture functions take this as an optional
    `activationCode` string and, when present, send it and THEN sample `runsBefore` (never the other
    way — sampling first would snapshot the about-to-be-deleted object's run counter, and completion
    detection would silently fall back to file polling on every single capture, forever).
  - **The `C`/`Q` wiring string appears in no object-model field anywhere** — it only ever exists as
    the text of an `M955` line in config.g or a tool's own `tpost<N>.g`. `machineConfig.ts`'s
    `findExistingWiring` checks that tool's `tpost<N>.g` first (cheap — reading costs nothing), then
    falls back to config.g; the same lookup is shared by activation (every capture) and by saving
    (below), so the two can never disagree about where the wiring lives. Its file-text cache is
    invalidated by this plugin's own writes (`applyEditPlan` calls `invalidateGcodeCache`), or a save
    followed immediately by a re-measurement would silently reapply the pre-save orientation.
  - **Orientation is this plugin's own state, never config.g's** — config.g's `I` goes stale the
    instant an orientation is applied at runtime only (true since before this feature existed).
    Persisted in `state.ts`'s `loadOrientationRegistry`/`saveOrientationEntry` (localStorage key
    `resonanceLab.accelOrientation`), keyed by **CAN address AND `boards[].uniqueId`** so a physically
    swapped board can't inherit a stale orientation just because its CAN address was reused; seeded
    opportunistically from the live object model the first time a board is seen each session.
  - **Saving always asks where — config.g ("all tools") or that accelerometer's own `tpost<N>.g`
    ("this tool only") — never inferred from `accel.toolNumber` or any other guess at machine type**
    (`machineConfig.ts`'s `planAccelSave`, reusing the existing shaper-scope dialog/`ShaperScope`
    mechanism, gated on `accelItems.length > 1` — **not** `isToolChanger`, which reports whether the
    tool↔accelerometer *derivation* succeeded and stays false on exactly the multi-accelerometer,
    mismatched-`M563 D` machines documented above that most need the warning). There is no
    orientation-only save any more: since reconfiguring resets orientation, the persisted line is
    always the complete `M955 C"..." I<n>Q<freq>`, replacing the old `planOrientationSave`. The two
    destinations carry materially different consequences and must never share copy: config.g becomes
    the boot-time default *regardless of which tool is mounted* (and, if another board's `M955 C` line
    is already there, silently displaces it — named specifically via a `notes` array, the same
    cross-file-conflict mechanism `M593`'s tpost saves already use, escalated in severity since this
    case is destructive rather than merely overridden-on-next-pickup); `tpost<N>.g` reactivates this
    accelerometer on *every real pickup of that tool for the rest of the machine's life* (a hardware
    check plus a CAN round-trip for a toolboard), the same per-pickup cost `M593`'s own tpost save
    already has, just newly expensive here. `R`/`S` are deliberately never persisted — they're a
    capture's own session sampling settings, not durable machine config.
- **Multi-accelerometer support (RRF ≥3.7.0-rc.1+1, `src/config/firmwareVersion.ts`'s
  `MIN_MULTI_ACCEL_FIRMWARE`)** — RepRapFirmware commit `ee3c80b` (RepRapFirmware) /
  `73549e0` (Duet3Expansion) raises `MaxAccelerometers` from 1 to 10: `M955`'s `P` now selects one of up
  to 10 independent slots (`configs[accelerometerNumber]`) instead of being pinned to `0`, so up to 10
  *different* boards can each hold their own slot simultaneously (a board still gets only ONE slot —
  RRF rejects reusing a board across two: "accelerometer on board %u is already in use as accelerometer
  %u"). `P`/`C` are both still `gb.MustSee`-mandatory in both `M955` and `M956` (unchanged from the
  single-slot era) — only the legal *range* of `P` changed, from `{0}` to `[0, 10)`. Everything below
  the `MIN_ACCEL_FIRMWARE` gate (legacy) is untouched; everything between `MIN_ACCEL_FIRMWARE` and
  `MIN_MULTI_ACCEL_FIRMWARE` (the single-slot era documented above) is also untouched and still applies
  verbatim to firmware in that narrow range — this section only describes what changes at
  `MIN_MULTI_ACCEL_FIRMWARE` and above.
  - **RRF reports this exact version string: `"3.7.0-rc.1+1"`** — a real semver build-metadata suffix
    (`+N`), which semver itself defines as precedence-*neutral* and which this project's own
    `parseFirmwareVersion` used to discard outright (`s.split("+")[0]`) before this feature existed.
    Duet3D is using it as a genuine sequential counter within one prerelease tag instead (confirmed by
    diffing `Version.h` across two consecutive firmware commits — both bump only this number), so
    `ParsedVersion` now carries an optional `build` field and `compareFirmwareVersions` adds it as a
    final tiebreaker *after* the existing prerelease-length comparison. Don't re-drop the `+N` suffix
    as "just metadata" - for this firmware line it's load-bearing.
  - **A board's assigned slot number exists NOWHERE in the object model — only in the text of its own
    `M955` line in config.g/`tpost<N>.g`.** Confirmed: neither firmware commit touches any object-model
    file (`gh api .../commits/<sha> --jq '.files[].filename' | grep objectmodel` is empty for both, and
    the new code's own comment reads `// TODO add configuration info ... to the object model`).
    `boards[].accelerometer` stays singular per board (correct — a board still only ever has one slot)
    but carries no field naming *which* slot number that is. `accelWiring.ts`'s `AccelWiring` gained a
    `slot: number` field for this reason (parsed from the line's own `P` token, defaulting to `0` when
    absent — deliberately correct for both eras: a single-slot line's `P` was always `0` anyway, so
    every call site can read `wiring.slot` unconditionally with no separate multi-vs-single branch).
    `findAllAccelWiring` (plural) is the multi-slot-aware sibling of the existing single-line lookups,
    for scanning a whole file for every M955 line at once (used by slot-assignment and migration below).
  - **Saving now always goes to config.g — the "this tool only / all tools" scope dialog is skipped
    entirely for boards on this firmware** (`useResonanceLab.ts`'s `usesMultiAccelSchemeFor`,
    `saveOrientationToConfig` calls `chooseShaperScope("all")` directly rather than opening the dialog).
    Each board gets its own independent slot in config.g now, so the single-slot era's real dilemma
    (only one board can be the boot-time default; everyone else needs a tpost re-assert) no longer
    applies — there's no second meaningful option left to offer. `machineConfig.ts`'s `planAccelSave`
    picks the board's EXISTING slot if config.g already has one for it (edit in place, keeping the
    orientation-reset semantics above), else the lowest slot 0-9 not already used by another board in
    config.g (`lowestFreeSlot`) — never reused across two different boards, since RRF itself rejects that.
  - **Migration hazard for existing tool-changer installs, and the offered fix.** Every "this tool
    only" save from BEFORE this feature existed wrote a full `M955 P0 C"..."` line into that tool's own
    `tpost<N>.g` (`P` could only ever be `0` back then). On a machine upgraded to this firmware, picking
    up any such tool still resends literally `P0` — silently reassigning slot 0 away from whatever
    config.g just assigned there, no error, just wrong axis data on the next capture. `useResonanceLab.ts`
    watches for this (`strayAccelLines`, gated on the tool-changer having at least one board already on
    this firmware) and surfaces a dismissible banner; confirming it (`machineConfig.ts`'s
    `planAccelMigration`) strikes every stray line out of its own `tpost<N>.g` (`buildRemovalPlan` — one
    removal plan per affected FILE, all its stray lines removed together, diff built directly from the
    known removed indices rather than through `dwc-gcode-core/edit`'s `diffLines`, which explicitly only
    handles an edited-line-and/or-appended-lines shape, never a removal) and adds each board into
    config.g with its own slot (reusing that board's existing config.g slot if it has one, tracking
    slot assignments made earlier in the SAME migration batch so two boards being migrated together
    never collide). Orientation is carried over from each stray line's own `I` value as a one-time
    read (`orientationOf`) — this does NOT contradict "config.g's `I` is never trusted as an ongoing
    source of truth" above, since there is no orientation-registry entry yet for a board that's never
    been reactivated under this scheme; the file's own last-written value is the only thing worth
    preserving. Removals are applied before additions, so a failure partway through a multi-board
    migration never leaves a board deleted from tpost *and* missing from config.g at once.
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
- **Config persistence** (`src/config/`): the pure, line-preserving G-code file editor (parse/find/
  edit one parameter or one directive/append/diff) moved to `dwc-gcode-core/edit` (2026-09-14,
  `github:jaysuk/dwc-gcode-core#v0.2.0` — see `docs/gcode-core-plan.md` in duet-gcode-postprocessor),
  merged with duet-calibration-wizard's copy of the same file; this repo's own `gcodeEdit.ts` and its
  test are deleted, no Vue or host imports either way, exhaustively unit-tested upstream now instead
  of here. `machineConfig.ts` is the thin host-injected
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
  significant; round-tripping it through `Number()` would silently corrupt it. `dwc-gcode-core/edit` and
  `machineConfig.ts`'s `planAccelSave` treat it as an opaque string throughout for this reason.
- **`M955` carries hardware wiring alongside orientation** — `P` (id), `C` (SPI CS pins), `Q` (SPI
  frequency), `I` (orientation) — confirmed in `Accelerometers.cpp`. Saving an orientation to
  config.g therefore edits only the `I` token in place (`dwc-gcode-core/edit`'s `setParam`, which masks
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
