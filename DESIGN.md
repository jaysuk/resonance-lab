# Resonance Lab — design notes

A clean Vue 3 implementation of accelerometer-driven resonance tuning for RepRapFirmware. All
analysis runs **in the browser** — no server-side processing, no external tools. (DWC is static
files served from the mainboard; there is nothing else to run on.)

## Terminology policy

This project stands on RepRapFirmware/Duet vocabulary and the input-shaping engineering literature
(ZV/ZVD/EI shapers, PSD, damping ratio). Sources we name: **RepRapFirmware** (`AxisShaper.cpp` for
the native shaper definitions, `M955`/`M956`/`M593` for hardware control). No other firmware
ecosystems or their tools are referenced in code, comments, or documentation.

## Measurement modes

1. **Native profile capture** — RRF's own flow: configure the accelerometer (`M955`), record samples
   to CSV (`M956`) while the machine executes a move profile, then read the CSV from
   `0:/sys/accelerometer/`. This is the same data path the stock Input Shaping plugin uses, so
   existing captures remain analysable.
2. **Swept excitation** — generated G-code that oscillates one axis with constant-jerk pulses whose
   frequency rises continuously (default 5 → 135 Hz at 1 Hz/s, acceleration = 60 mm/s² per Hz,
   quarter-period segments `t = 0.25/f`, per-segment travel `d = a·t²`, direction alternating each
   cycle), recording throughout. This excites every frequency in the band in a single run and is
   what makes single-pass shaper calibration possible; it can also run on several axes in one job
   for a combined recommendation (see below).
3. **Belt diagonal sweep** — the swept excitation driven along a CoreXY diagonal (X+Y or X−Y) to
   excite one belt at a time; comparing the two spectra flags a tension imbalance vs a mechanical
   fault. See "Belt recording sizing" below for how the recording length is determined.
4. **Fixed-frequency excitation** — holds one frequency for a chosen duration, viewed as a
   spectrogram, to study a single suspicious peak found during calibration.
5. **Vibration profile** — constant-speed passes across a range of travel speeds, flagging feedrates
   that excite a resonance.
6. **Accelerometer orientation check** — one sharp move per horizontal axis with `M955` orientation
   neutralised to identity for the test, comparing which sensor channel carried each machine axis'
   motion to suggest the correct `M955 I` parameter.
7. **Motor quality** — a motor-isolating move (on core kinematics, the column of the kinematics
   forward matrix belonging to one motor; on other kinematics, Z alone) run at a range of constant
   speeds, measuring vibration at multiples of the motor's own full-step frequency. This measures the
   motor and driver themselves rather than the machine's structural response — see `motorHarmonics.ts`
   below. Analysis-only: it emits no `M970.3`/`M569.2` driver-correction G-code and needs no board or
   driver capability beyond `M955`/`M956` — unlike mode 8 below, it works on any RRF version.
8. **Motor waveform tuning** — a least-squares search (see `motorTuning.ts` below) for the
   current-waveform correction that minimises vibration at one harmonic of a motor's electrical
   cycle, then writes it with `M970.3` (phase stepping) or `M569.2` (the driver's sine table).
   Gated on RepRapFirmware **3.7.0-rc.1+** (fails closed on anything older or unparseable, per
   `firmwareVersion.ts`) — the command may simply not exist below that version. The driver chip
   itself (needed to know whether it supports a waveform correction at all) is identified by
   reading its IOIN register over `M569.2 R` (see `driverChip.ts`), since the object model carries
   no chip-type field.

## Single-accelerometer activation (RRF ≥3.7.0-rc.1)

RepRapFirmware 3.7.0-rc.1 changed `M955`/`M956` so that only **one** accelerometer can be active
machine-wide at a time, addressed by a `C` wiring string (with an optional CAN-address prefix) rather
than a board-driver `P`. Reconfiguring one — `M955 C"..."` — deletes and recreates the accelerometer
object, which resets its orientation to identity unless `I` is resupplied in the *same* command. This
matters a great deal for a tool-changer with a per-tool accelerometer, which previously just relied on
every board's accelerometer staying independently configured forever.

The plugin's answer has three parts, each solving a piece the object model can't:

- **Reactivation is unconditional and per-measurement.** Before every single capture (never "only when
  switching accelerometers"), the plugin sends a full `M955 C"..." I<n> Q<freq> R<res> S<rate>` line.
  Nothing in the object model says whether some other actor repointed the active accelerometer since
  the plugin's last capture, so the only safe assumption is none at all. The cost is one reconfigure
  per measurement (a CAN round trip plus a hardware probe for a toolboard); the alternative is
  measurement data silently mislabelled as coming from the wrong accelerometer.
- **Wiring (`C`/`Q`) is read from wherever it's actually written** — config.g, or (checked first) the
  measured accelerometer's own tool-change macro — since the object model carries no field for it at
  all; it only ever exists as literal G-code text. This is a read-only concern until the user chooses
  to persist a *new* association, at which point they explicitly pick the destination (see below);
  reading never writes anything the user didn't ask for.
- **Orientation is the plugin's own state**, not config.g's — the moment an orientation is applied at
  runtime (the same "apply now, save later" split that already existed before this firmware change),
  config.g's copy is stale. A `localStorage` registry, keyed by CAN address *and* the board's own
  `uniqueId` (so a physically swapped board can't inherit a stale value through a reused address), is
  what's actually resupplied on every reactivation.

Saving a wiring+orientation association so it survives a reboot always presents an explicit
config.g-vs-tool choice — deliberately never inferred from whether the accelerometer happens to be
tied to a known tool, since RRF's exclusive (not coexisting) single-active-accelerometer semantics
make the wrong guess here a correctness problem, not just an inconvenience. This reuses the same
scope-choice mechanism the shaper (`M593`) save already has, but with independently-written copy: an
`M593` "all tools" default coexists peacefully with any per-tool override, where an `M955` "all tools"
save is the *only* thing keeping any other accelerometer active at all.

## Analysis core (`src/analysis/`, pure TS, no Vue, fully unit-tested)

- `fft.ts` — radix-2 FFT.
- `spectrum.ts` — Welch power spectral density: Kaiser(β=6) window sized from a 0.5 s window target
  (rounded up to a power of two), 50 % overlap, per-segment mean detrend, one-sided scaling; returns
  per-axis PSDs + their sum and the frequency bins.
- `shapers.ts` — RRF's native shaper set (**MZV, ZVD, ZVDD, ZVDDD, EI2, EI3**, per `AxisShaper.cpp`):
  impulse amplitudes/timings as functions of frequency + damping ratio.
- `recommend.ts` — the tuning engine: residual-vibration estimation of a shaper against a measured
  PSD (across pessimistic damping ratios 0.075/0.1/0.15, plus the measured ratio when one resolved),
  frequency scan with score = `smoothing · (vibr^1.5 + vibr·0.2 + 0.01)`, per-shaper best-frequency
  pick (within a 10 % vibration tolerance, prefer the better score), cross-shaper selection (a more
  complex shaper must earn its keep: ≥20 % better score, or ≥5 % better score with ≥10 % less
  smoothing), and frequency normalisation of the PSD. `findBestShaperCombined` runs the same fit
  against several axes' spectra at once (worst axis + worst damping ratio governs at each candidate
  frequency), since RRF's `M593` shaper applies machine-wide — used when a calibration sweep covers
  more than one axis, so the plugin recommends one configuration that serves all of them rather than
  picking one axis's own best and ignoring the rest. **`smoothing` is an internal relative penalty
  only** (RRF genuinely convolves a delayed, scaled copy of a move's segments per shaper impulse, so
  it's a real tie-breaker for scoring), never surfaced to the user as a millimetre figure or turned
  into an acceleration recommendation — RRF has no smoothing parameter, no smoothing report, and
  nothing accel-linked anywhere in its shaping path (verified against the firmware source), unlike
  the planner this estimate's shape was originally modelled on.
- `pipeline.ts` — the seam from a raw capture to a verdict: parse → PSD → normalise → peaks → shaper
  recommendation (single-axis or, at the page layer, combined across axes).
- `peaks.ts` — resonance peak detection + damping-ratio estimation from half-power bandwidth
  (ζ ≈ Δf / 2f₀), used both for display and to refine recommendations.
- `belts.ts` — belt-pair comparison: shape similarity (Pearson correlation, restricted to wherever
  either belt actually responds — a wide requested band's shared near-zero tails would otherwise
  inflate the score) + energy ratio (whole requested band) decide matched / tension-imbalance /
  mechanical-mismatch.
- `vibration.ts` — speed-sweep vibration profile: flags problem feedrates that excite a resonance.
- `axesMap.ts` / `orientation.ts` — accelerometer orientation solver and single-axis dominant-channel
  check (suggests the `M955 I` parameter).
- `stft.ts` — short-time Fourier transform for the spectrogram view (separates true resonances,
  which light up as horizontal lines when the sweep crosses them, from excitation-following noise).
- `motorHarmonics.ts` — motor-quality analysis: refines the true full-step frequency around the
  nominal value (coarse FFT-bin search, then a fine phasor-rotation DFT scan), evaluates amplitudes at
  quarter-orders of it (a current-waveform error repeats once per electrical cycle, i.e. four full
  steps, so integer orders alone would miss it), converts to displacement in µm (`a / (2πf)²` —
  displacement, unlike acceleration, is speed-independent, so it's what can carry a fixed threshold),
  and clusters a speed sweep's harmonics by *absolute* frequency rather than by order (the machine's
  mechanical response depends only on absolute frequency, so this cancels the machine out of the
  comparison and leaves the motor's own behaviour). Orders map to causes the same way the stock DWC
  Input Shaping plugin's motor tuning tab does: 1× = detent torque/step ripple, 0.5× = coil current
  imbalance, 0.25×/0.75× = distorted current waveform.
- `motorTuning.ts` — the waveform-correction search: models a correction as a vector added to the
  motor's own (unknown) error vector, which makes the squared-amplitude response **linear** in four
  unknowns, so a least-squares fit over a handful of probe measurements finds the optimum in closed
  form (no iteration). Measures and fits both move directions separately then combines them, since a
  rotor-fixed error component shifts by the load angle and flips sign with direction. 10 probe moves
  per harmonic with a free phase (`M970.3`), 6 with phase constrained to 0/180 (`M569.2`'s sine
  table, which can't represent anything else).

Two small pure modules in `src/config/` support the tuning gate, independent of the config-editing
modules described under "Config persistence" in `CLAUDE.md`: `firmwareVersion.ts` (semver-ish
comparison that strips the STM32 port's parenthesised version suffix, e.g. `3.7.0-rc.1(CAN0)`,
before parsing - skipping that step would fail the gate closed on exactly the boards phase stepping
targets) and `driverChip.ts` (identifies a TMC chip from its IOIN register's VERSION byte, read over
`M569.2 R<addr>` - the same method as the sibling `duet-tmc-tuner` plugin, since the object model has
no chip-type field at all).

Capture I/O lives in `src/capture/`: `csv.ts` (RRF accelerometer CSV parser, incl. overflow flags,
and `cropCaptureToDuration` for oversized/self-timed recordings), `sweep.ts` (swept-excitation
G-code generator with machine-limit guards), `motorMoves.ts` (derives a Cartesian direction that
drives exactly one motor at a constant step rate from the kinematics forward matrix, plus the
trapezoidal-move math for its constant-speed window - and, for the tuning task, a round-trip
recording mode so both move directions are captured in one pass), and `orchestrator.ts` (turns a
measurement request into the `M955`/`M956`/G-code sequence via an injected `MachineIO`, so every
sequence is unit-testable without a printer). Generated program files (the `.g` macros that drive
the test motion) are uploaded to a configurable folder (`DEFAULT_PROGRAM_DIR` = `0:/sys/resonanceLab`,
overridable via `programDir` on the capture options and the page's Settings dialog) rather than bare
`0:/sys` - best-effort deleted right after each capture completes. The captured CSV itself is NOT
relocatable: RRF's M956 `F` filename is hardcoded to combine with `0:/sys/accelerometer/` regardless
of what a plugin passes (verified against `ConfigureAccelerometer` in the firmware source).

## Belt recording sizing

RRF has no G-code to stop an in-progress `M956` recording early (checked directly against the
firmware source: its accelerometer task loop only exits when the requested sample count is reached
or the sensor errors out). Since a CoreXY diagonal sweep finishes well before its kinematic
worst-case duration estimate, sizing a recording from that estimate wastes time sampling idle
silence. Instead: the first belt recorded at a given set of sweep parameters is deliberately
oversized to the kinematic estimate and self-times the real motion concurrently (the object model's
busy→idle transition, not `sendCode`'s resolution — unreliable for timing a long macro). The
downloaded capture is then cropped to the real duration, the measurement is cached (keyed by the
sweep parameters and axis centres), and the other belt — and any repeat run at the same parameters —
is sized precisely from it. This avoids re-running the same excitation profile twice (once to probe
timing, once to record) without risking truncating real data.

## Recommendation UX principle

Every analysis ends in **one sentence the user can act on** ("Apply MZV @ 42.5 Hz — removes ~95 % of
ringing") with an Apply button, and the detail (graphs, per-shaper comparison) one click away. Never
a wall of numbers with no verdict.
