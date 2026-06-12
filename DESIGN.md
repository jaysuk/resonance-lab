# Resonance Lab — design & roadmap

A clean Vue 3 implementation of accelerometer-driven resonance tuning for RepRapFirmware, following
the Shake&Tune methodology. All analysis runs **in the browser** — no server-side processing, no
external tools. (DWC is static files served from the mainboard; there is nothing else to run on.)

## Terminology policy

This project stands on RepRapFirmware/Duet vocabulary and the input-shaping engineering literature
(ZV/ZVD/EI shapers, PSD, damping ratio). Sources we name: **RepRapFirmware** (`AxisShaper.cpp` for
the native shaper definitions, `M955`/`M956`/`M593` for hardware control) and **Shake&Tune** (the
measure → analyse → recommend → verify methodology). No other ecosystems are referenced in code,
comments or UI.

## Measurement modes (two ways to capture)

1. **Native profile capture** — RRF's own flow: configure the accelerometer (`M955`), record samples
   to CSV (`M956`) while the machine executes a move profile, then read the CSV from
   `0:/sys/accelerometer/`. This is the same data path the stock Input Shaping plugin uses, so
   existing captures remain analysable.
2. **Swept excitation** — generated G-code that oscillates one axis with constant-jerk pulses whose
   frequency rises continuously (default 5 → 135 Hz at 1 Hz/s, acceleration = 60 mm/s² per Hz,
   quarter-period segments `t = 0.25/f`, per-segment travel `d = a·t²`, direction alternating each
   cycle), recording throughout. This excites every frequency in the band in a single run and is
   what makes single-pass shaper calibration possible.

## Analysis core (`src/analysis/`, pure TS, no Vue, fully unit-tested)

- `fft.ts` — radix-2 FFT.
- `spectrum.ts` — Welch power spectral density: Kaiser(β=6) window sized from a 0.5 s window target
  (rounded up to a power of two), 50 % overlap, per-segment mean detrend, one-sided scaling; returns
  per-axis PSDs + their sum and the frequency bins.
- `shapers.ts` — RRF's native shaper set (**MZV, ZVD, ZVDD, ZVDDD, EI2, EI3**, per `AxisShaper.cpp`):
  impulse amplitudes/timings as functions of frequency + damping ratio.
- `recommend.ts` — the tuning engine: residual-vibration estimation of a shaper against a measured
  PSD (across pessimistic damping ratios 0.075/0.1/0.15), smoothing estimation, frequency scan with
  score = `smoothing · (vibr^1.5 + vibr·0.2 + 0.01)`, per-shaper best-frequency pick (within a 10 %
  vibration tolerance prefer the better score), cross-shaper selection (a more complex shaper must
  earn its keep: ≥20 % better score, or ≥5 % better score with ≥10 % less smoothing), recommended
  max acceleration (bisect to a 0.12 mm smoothing target), and frequency normalisation of the PSD.
- `peaks.ts` — resonance peak detection + damping-ratio estimation from half-power bandwidth
  (ζ ≈ Δf / 2f₀), used both for display and to refine recommendations.
- `csv.ts` *(M2)* — RRF accelerometer CSV parser (`M956` output, incl. overflow flags).
- `sweep.ts` *(M3)* — swept-excitation G-code generator with machine-limit guards.

## Feature milestones (Shake&Tune parity)

| # | Milestone | Maps to |
|---|-----------|---------|
| M1 | Analysis core (PSD, shapers, recommendations, peaks/damping) — **this commit** | foundation for everything |
| M2 | Native capture: CSV parsing, capture orchestration (M955/M956), sample manager | data in |
| M3 | Swept excitation runs (generated G-code, guarded; shaper disabled during test) | single-pass measurement |
| M4 | Shaper calibration view: PSD + per-shaper response graphs, plain-language recommendation, one-click `M593` apply + config save | AXES_SHAPER_CALIBRATION |
| M5 | Belt comparison: dual-belt capture, cross-correlation/similarity, tension guidance | COMPARE_BELTS_RESPONSES |
| M6 | Vibration profile: speed-sweep analysis, problem speed ranges | CREATE_VIBRATIONS_PROFILE |
| M7 | Fixed-frequency excitation + spectrogram; accelerometer orientation check | EXCITATE_AXIS_AT_FREQ, AXES_MAP_CALIBRATION |
| M8 | Verify loop (re-measure with shaper on), diagnostics UI, self-update wiring, FL summary panel live data | feature-complete → first release |

## Recommendation UX principle

Every analysis ends in **one sentence the user can act on** ("Apply MZV @ 42.5 Hz — removes ~95 % of
ringing with 0.08 mm smoothing; keep acceleration below 8200 mm/s²") with an Apply button, and the
detail (graphs, alternatives table) one click away. Never a wall of numbers with no verdict.
