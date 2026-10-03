# Plan: extend `motortune` for phase-stepping drivers

Status: implemented 2026-10-03 (phases 1-4 and the docs; Phase 5 and hardware validation outstanding). Written 2026-10-03 from a review of RepRapFirmware `3.7-dev`
(`2859e5577`) and Duet3Expansion (`3.7.0-rc.2+1`); revised the same day after checking each finding
against both firmware trees and this repo's code.

## Scope

- **In scope:** tune more electrical harmonics than the current 2 and 4 on drivers that take `M970.3`
  (phase stepping, closed loop, assisted open loop). Add an optional survey step so only harmonics
  worth tuning are tuned.
- **Out of scope:** Kv, Ka, `M906` and `M917`. The commanded current is
  `hold + (1 - hold) * min(1, signal/256)`, where `hold` is the `M917` standstill percentage. At a
  typical ~80% hold, Kv/Ka only govern the last 20% of the range, and the accelerometer cannot see
  lost steps, so tuning them is poor value for real risk. (This formula is not re-verified here; see
  Phase 5.)
- `M569.2` sine-table drivers stay at harmonic 4 only; the firmware cannot represent more.
- **Optional extra:** a read-only status panel (Phase 5).

## What the code review found

1. **The 2-and-4 limit is borrowed, not derived.** DWC's tune dialog offers only 2 and 4
   (`TuneMotorDialog.vue`), and our `tuneHarmonicList` (`src/core/useResonanceLab.ts`) came in with the
   original commit `ea97ddd`, which mirrored it. The firmware accepts `S1`–`S16`
   (`MaxPhaseCorrectionHarmonic = 16` in both RRF's and Duet3Expansion's `PhaseStep.h`).
2. **The fit model holds for any harmonic S.** The firmware adds
   `J·sin(S·θ + O)` to the electrical angle θ before the sine/cosine (`PhaseStep::GetCorrection`,
   `PhaseStep::SetMotorPhase`), with θ in 4096 units per electrical cycle, so S maps to full-step
   order S/4. Seen per coil this is phase modulation and produces current sidebands at S±1, but the
   rotor follows the *angle* of the field vector, and that angle error is exactly `J·sin(Sθ + O)`: a
   single harmonic at S. To first order the correction therefore acts only on order S/4 for every S,
   which is what the least-squares model in `src/analysis/motorTuning.ts` assumes. The second-order
   term (at 2S) scales with J², and J is capped at 4° (~0.07 rad), so it is negligible. Closed-loop
   drivers use the same correction path (Duet3Expansion `ClosedLoop.cpp` calls
   `PhaseStep::GetCorrection`).
   - Because angle errors from separate harmonics add, tuned harmonics should barely disturb each
     other. The final verification capture (Phase 2) checks this rather than assumes it.
   - **What is unproven is signal strength, not the model:** orders 0.25, 0.75, 1.5 and 2 may carry
     too little vibration to tune on a given machine. The runtime survey and the existing "adopt only
     if it beats baseline" guard in `tuneHarmonic` cover that, so no separate pre-implementation
     experiment is needed; the hardware validation below confirms it.
3. **Silent-zero hazard.** `measureOnce` calls `analyzeMotorHarmonics(..., 1)`, which only yields
   orders 0.25, 0.5, 0.75 and 1. `orders.indexOf(harmonic / 4)` returns -1 for harmonics 6 and 8 and
   the code then substitutes amplitude 0. Every probe would read zero, the fit would degenerate, and
   the run would report "no improvement". `analyzeMotorHarmonics` also silently drops any order above
   Nyquist (its `numOrders` cap), which produces the same -1. Both must fail loudly.
4. **Nyquist limit per harmonic.** The default tune speed targets a 400 Hz full-step frequency, so
   order 2.0 would sit at 800 Hz, above Nyquist for most sampling rates (a 1344 Hz LIS3DH has a
   672 Hz Nyquist). The fail-fast check in the `motortune` branch only guards order 1.
5. **Correction slots are limited.** The firmware allows 4 entries per driver
   (`MaxPhaseCorrectionHarmonics`, same in both trees) and the probe reply already lists what the
   user has. A fifth write fails mid-run with "already has 4 correction harmonics". Note that each
   harmonic's baseline probe writes `J0`, which *frees* that harmonic's own slot (`PhaseStep.cpp`'s
   `ConfigureCorrection`), so a selected harmonic always reuses its existing slot.
6. **Fundamental refinement depends on `numHarmonics`.** `analyzeMotorHarmonics` sums energy over
   `numHarmonics` full-step multiples when refining the fundamental (both the coarse and the fine
   search). Raising it to reach orders above 1 changes how existing S=2/4 runs locate the
   fundamental.
7. **Cost.** Each harmonic is 10 round-trip captures, so four harmonics is 40 moves. A cheap survey
   that skips quiet harmonics can pay for itself.

## Phase 1: pure logic (`src/analysis`, no Vue)

All unit-testable with no printer:

- **Harmonic catalogue:** `{1, 2, 3, 4, 6, 8}`, plus `harmonicOrder(h) = h / 4`. 1 = coil current
  offset, 2 = coil gain imbalance, 4 = waveform distortion/detent, 3/6/8 = higher-order distortion.
  Higher S is accepted by the firmware but lands above Nyquist at any useful speed.
- **`planHarmonics({ selected, existing, sampleRate, fullStepHz, maxSlots: 4 })`** returns the
  harmonics to run and the skipped ones with a reason (`slots`, `nyquist`, `unmeasurable`).
  Existing entries not in the selection count against the 4 slots; a selected harmonic that already
  has an entry reuses that slot (its baseline `J0` frees it), so it costs nothing extra. A harmonic
  is feasible only if `h/4 * fullStepHz * 1.05 < Nyquist`.
- **`maxTuneSpeed(selected, motor, sampleRate)`**: the speed cap set by the *highest* selected
  harmonic, `(hmax/4) * fullStepHz * 1.05 < Nyquist`. Generalises `maxSpeedForRate`, which only
  covers order 1.
- **Analysing higher orders without moving the fundamental:** keep the fundamental search at
  `numHarmonics = 1`, as today, and evaluate the extra orders at exact multiples of the refined
  fundamental. Either split `analyzeMotorHarmonics` into "refine fundamental" and "evaluate orders",
  or give it a separate `searchHarmonics` parameter (default 1 for this path). Do not just raise
  `numHarmonics`, which changes S=2/4 behaviour (finding 6).
- **`surveyHarmonics(analysis, move)`** converts each order to displacement with the existing
  `toDisplacementUm`, ranks them, and flags anything under the existing 0.5 µm "low" threshold as
  *quiet at this speed*, not as "not worth tuning". The machine's response depends on absolute
  frequency, so a harmonic quiet at one speed can be loud at another.
- **`estimateTuneMoves(harmonicCount, constrain, survey)`** includes the survey and final-verify
  moves.
- **Loud failure** in the measurement path: `measureOnce` asserts that the order is present and
  throws if it isn't, instead of returning 0. Keep this as a runtime assertion even though the
  planner also checks, since `analyzeMotorHarmonics` can drop orders on its own (finding 3).

## Phase 2: composable changes (`src/core/useResonanceLab.ts`, written once)

- Replace `tuneHarmonicList` with a selected-harmonics ref (default `[2, 4]`) and a computed
  availability list carrying each harmonic's disabled reason.
- Run order:
  1. Probe and snapshot existing corrections, as today.
  2. **Fail fast** before any write if the slot plan or speed plan is infeasible, saying which
     harmonics to drop. Extend the existing Nyquist check at the top of the `motortune` branch to
     the highest selected order.
  3. Optional survey capture (off by default); it pre-selects loud harmonics and the user can
     override.
  4. Tune each selected harmonic with the existing `tuneHarmonic`.
  5. **One final verification capture** measuring all selected orders together, to confirm tuned
     harmonics did not disturb each other.
- Keep the safety rule: snapshot the prior correction before the first write; restore on
  cancel/error/Discard. `restoreCorrections` must cover exactly the harmonics written.
- Default test speed: the highest speed `maxTuneSpeed` allows for the selected set, capped at the
  existing ~400 Hz full-step target. Re-default when the selection changes, unless the user has
  typed a speed.
- Do not touch the chip-detection watcher; it must stay keyed on the motor letter.

## Phase 3: UI (both templates, parallel edits)

- Add `tuneHarmonics` to the `motortune` entry in `TASKS`.
- In `src/ui37/ResonanceLabPage.vue` and `src/ui36/ResonanceLabPage.vue`: a harmonic chip group shown
  only when `tunePhaseStepping` is true, disabled chips with a short reason, a live move count, and a
  "Survey first" toggle (off by default).
- Result view: before/after per harmonic, plus the verification row. Survey results read "quiet at
  this speed" rather than "not worth tuning".
- i18n keys in `en.json`; any literal `@` must be written `{'@'}`.

## Phase 4: tests

- Extend `test/motorTuning.test.ts`: planner, slot arithmetic, Nyquist gating, survey ranking.
- Slot cases: four existing entries with one of them selected (runs, since its slot is reused); four
  existing entries none selected (skipped with `slots`); three existing plus two new selected (one
  skipped).
- `maxTuneSpeed`: the cap follows the highest selected harmonic.
- Regression test that a missing order throws, both for an unrequested order and for one dropped
  above Nyquist.
- Regression test that S=2/4 analysis results (refined fundamental and amplitudes) are unchanged by
  the higher-order analysis path.
- Smoke test that the chip group renders only for phase-stepping drivers.
- Run the existing `test/i18n.test.ts`.

## Phase 5 (optional): read-only status panel

- Parse `M970.1` / `M970.2` replies for Kv and Ka per axis (not in the object model; RRF's reply
  carries `Kv=…, Ka=…`, defaults 1000 / 50000), plus the hold percentage.
- Show the effective current fraction at the user's own speed and acceleration, and warn on clipping
  at 100%.
- Verify the current formula (Scope) and the units on hardware first. The expansion firmware's step
  clock is 750 kHz; a back-of-envelope figure of ~26% at 100 mm/s (Kv=1000) needs checking against a
  real reading.

## Docs and release hygiene

- Update `CLAUDE.md` (harmonic set, the 4-slot rule and baseline slot reuse, the silent-zero hazard,
  why S maps to order S/4 and why the fit model holds for every S, keeping the fundamental search at
  one harmonic), `README.md` and `DESIGN.md`.
- Re-run the naming-policy grep from `CLAUDE.md`.
- Bump `plugin.json` and `package.json` together.
- `DWC_DIR=... npm run typecheck`, then clear any `_typecheck_*` leftovers.
- Build both ZIPs (`build.bat`, `build36.bat`).
- No new top-level `src/` directory is planned, so `scripts/stage-dwc36.mjs`'s `INCLUDE` should not
  need a change; confirm when implementing.

## Hardware validation

- **Machine:** STM32H7 board with TMC5160 axes; a TMC2240 axis if available.
- **Not verified from source:** the STM32 port is not in the RRF checkout reviewed (only MB6HC
  defines `SUPPORT_PHASE_STEPPING` there), so its phase-stepping behaviour is taken from the user's
  report.
- **TMC2240 over UART:** the waveform write is unsupported on that link (see `CLAUDE.md`); the runtime
  probe stays the real gate.
- **Acceptance:**
  - Signal check: with the survey on, orders 0.25, 0.75, 1.5 and 2 show above the noise floor on at
    least one axis at a speed under Nyquist. If one never does on any axis, drop it from the
    catalogue rather than ship a harmonic that cannot be tuned.
  - A tuned run measurably lowers the targeted orders, confirmed by the verification capture.
  - The verification capture shows no regression on orders tuned earlier in the run.
  - Cancel and error paths leave the original corrections restored.
  - Nothing is left in `0:/sys/accelerometer/`.

## Risks

- Some harmonics are too quiet to tune on real machines: they get dropped from the catalogue after
  hardware validation. The feature still delivers the survey, the planner and the safety fixes.
- Harmonics interact more than the first-order analysis predicts. Mitigation: the final verification
  pass, with an optional second sweep if it shows a regression.
- Longer runs are more exposed to drift and thermal change. Baseline re-measurement per harmonic
  already exists in `tuneHarmonic`.

## Decisions

1. No separate pre-implementation experiment: the fit model is valid for every S (finding 2), and
   signal strength is checked during hardware validation.
2. Survey step: opt-in until hardware validation shows it pays off.
3. Status panel: deferred to a later pass.
