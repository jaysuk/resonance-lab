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

/**
 * Minimum firmware for `motortune` (`M970.3` / `M569.2`'s waveform-correction sub-command), needed on
 * both the mainboard and the driver's own board. A third constant rather than a reuse of
 * `MIN_ACCEL_FIRMWARE`, for the same reason that one isn't shared with the multi-accelerometer gate:
 * they gate unrelated capabilities that only coincide on a release. Note a mainboard without local
 * phase stepping (Duet 3 Mini 5+, MB6XD) only gained `M970`/`M970.3` - to configure phase stepping on
 * CAN-connected drivers - in 3.7.0-rc.2; on those it passes this gate but the runtime probe in the
 * tuning run reports the driver as unsupported until then.
 */
export const MIN_TUNE_FIRMWARE = "3.7.0-rc.1";

/**
 * Minimum firmware for the `spi.cs.acc` / `int.acc` pin names on the SPI-accelerometer toolboards
 * (see `accelBoards.ts`) - needed on both the mainboard and that board.
 */
export const MIN_SPI_ACCEL_FIRMWARE = "3.7.0-rc.2";
