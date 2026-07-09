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

Capture I/O lives in `src/capture/`: `csv.ts` (RRF accelerometer CSV parser, incl. overflow flags,
and `cropCaptureToDuration` for oversized/self-timed recordings), `sweep.ts` (swept-excitation
G-code generator with machine-limit guards), and `orchestrator.ts` (turns a measurement request into
the `M955`/`M956`/G-code sequence via an injected `MachineIO`, so every sequence is unit-testable
without a printer). Generated program files (the `.g` macros that drive the test motion) are
uploaded to a configurable folder (`DEFAULT_PROGRAM_DIR` = `0:/sys/resonanceLab`, overridable via
`programDir` on the capture options and the page's Settings dialog) rather than bare `0:/sys` -
best-effort deleted right after each capture completes. The captured CSV itself is NOT relocatable:
RRF's M956 `F` filename is hardcoded to combine with `0:/sys/accelerometer/` regardless of what a
plugin passes (verified against `ConfigureAccelerometer` in the firmware source).

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
