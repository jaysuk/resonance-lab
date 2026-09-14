/**
 * Firmware-version thresholds specific to this plugin's own features. General parsing/comparison
 * (`parseFirmwareVersion`/`compareFirmwareVersions`/`firmwareAtLeast`) moved to `dwc-gcode-core`
 * 2026-09-14 — see `duet-gcode-postprocessor/docs/gcode-core-plan.md` for the merge this repo's own
 * copy (the newer of two diverged ones) became the base of. Kept here rather than folded into that
 * package's own `FEATURES` table: these two names are this plugin's own vocabulary for gating its
 * own UI, not general RRF facts a different consumer would reach for under the same name.
 */

/**
 * Minimum firmware for RRF's single-accelerometer M955/M956 scheme (P capped at 0, C mandatory and
 * CAN-address-prefixed, exactly one accelerometer active machine-wide). A separate constant from any
 * other feature's own minimum (e.g. motortune's) even where they coincide today - they gate unrelated
 * firmware capabilities that only happen to share a threshold on this release.
 */
export const MIN_ACCEL_FIRMWARE = "3.7.0-rc.1";

/**
 * Minimum firmware for RRF's multi-accelerometer scheme (up to 10 independent slots, `P` selects
 * which one, instead of being capped to `0`) - `RepRapFirmware@ee3c80b`/`Duet3Expansion@73549e0`,
 * both landed the day after `MIN_ACCEL_FIRMWARE` itself and both reporting `"3.7.0-rc.1+1"`. A
 * SEPARATE constant from `MIN_ACCEL_FIRMWARE`: a board can satisfy the first without the second
 * (plain rc.1, still single-slot) - they gate genuinely different capabilities that happen to be one
 * firmware release apart. Relies on `dwc-gcode-core`'s `compareFirmwareVersions`'s "+N" build-number
 * tiebreaker (see its `ParsedVersion.build`) - without it this string would compare equal to plain
 * "3.7.0-rc.1".
 */
export const MIN_MULTI_ACCEL_FIRMWARE = "3.7.0-rc.1+1";
