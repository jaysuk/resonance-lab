/**
 * Which M955/M956 scheme the machine speaks: `legacy` (before 3.7.0-rc.1: `P` is a board.driver id),
 * `single` (3.7.0-rc.1: `P0` + `C`, one active accelerometer machine-wide) or `multi` (3.7.0-rc.1+1
 * and later: `P` is one of up to 10 slots).
 *
 * Decided by the MAINBOARD's firmware alone, never by the firmware of the board an accelerometer is
 * connected to. `M955`/`M956` are executed on the mainboard first: `P` is `MustSee` and range-limited
 * there, `C` is parsed there, and the slot table (`configs[]` / `sensors.accelerometers[]`) lives
 * there (RepRapFirmware `Accelerometers.cpp`, `ConfigureAccelerometer`/`StartAccelerometer`) - a remote
 * board only receives the already-validated parameters over CAN. So on a mixed-version machine the
 * mainboard's rules apply to every accelerometer whatever its own board runs: a legacy `P<board.driver>`
 * line is always rejected by an updated mainboard, and a toolboard that hasn't been updated just ignores
 * the `C`/`Q` it doesn't know. (An earlier version gated on the accelerometer's own board, on the
 * strength of a field report that turned out to have another cause.)
 */
// The /firmware subpath, not the bare "dwc-gcode-core" root specifier: DWC 3.6's older webpack/TS build
// can't resolve the root ("." export has no "require" condition for this ESM-only package).
import { firmwareAtLeast } from "dwc-gcode-core/firmware";
import { listAccelModelEntries } from "../capture/tools";
import { MIN_ACCEL_FIRMWARE, MIN_MULTI_ACCEL_FIRMWARE } from "./firmwareVersion";

export type AccelScheme = "legacy" | "single" | "multi";

export function accelScheme(model: unknown): AccelScheme {
	// An object model that reports slots is multi-accelerometer firmware by definition, whatever version
	// string it carries (3.7.0-rc.1+3 straddles the change).
	if (listAccelModelEntries(model).some((e) => e.slot !== undefined)) {
		return "multi";
	}
	const mainboard = (model as { boards?: Array<{ firmwareVersion?: string } | null> } | null)?.boards?.[0]?.firmwareVersion ?? null;
	if (firmwareAtLeast(mainboard, MIN_MULTI_ACCEL_FIRMWARE)) {
		return "multi";
	}
	return firmwareAtLeast(mainboard, MIN_ACCEL_FIRMWARE) ? "single" : "legacy";
}
