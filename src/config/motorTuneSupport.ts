/**
 * What the object model says about whether a motor's driver can carry a waveform correction, and
 * which command carries it - pure, so it's testable against plain model fixtures. The `motortune`
 * task's own page logic (`core/useResonanceLab.ts`) only wires these into refs.
 *
 * There is deliberately NO board list here. DuetWebControl's own Input Shaping plugin keeps one
 * (`MB6HC`, `EXP3HC`, `EXP1HCL`, `M23CL`, `TOOLINDX`, and it has already grown once), and this
 * plugin used to mirror the idea; instead a driver is judged by what it does: the firmware version
 * of the mainboard and of the driver's own board (`MIN_TUNE_FIRMWARE`), the command choice below, and
 * a runtime probe of `M970.3`/`M569.2` before anything is written. Every board DWC lists - including
 * the closed-loop toolboards (1HCL = `EXP1HCL`, `M23CL`) and the INDX toolboard (`TOOLINDX`) - passes
 * on those terms with no per-board entry, and so does any board added later.
 */
import { firmwareAtLeast } from "dwc-gcode-core/firmware";
import { MIN_TUNE_FIRMWARE } from "./firmwareVersion";

interface ModelDriverRef { board?: number | null; driver?: number }
interface ModelAxis { letter?: string; phaseStep?: boolean | null; drivers?: Array<ModelDriverRef> }
interface ModelBoardDriver { config?: { mode?: unknown } | null }
interface ModelBoard {
	canAddress?: number | null;
	firmwareVersion?: string;
	drivers?: Array<ModelBoardDriver | null>;
}
interface TuneModel {
	boards?: Array<ModelBoard | null>;
	move?: { axes?: Array<ModelAxis> };
}

/** RRF's `DriverMode` values that mean the driver commutates in software (`direct` = field-oriented
 *  control, which is what closed-loop and phase stepping both run in; `assistedOpen` as DWC names the
 *  assisted open-loop variant). Reported as the enum's integer, or by name on some connectors. */
const SOFTWARE_COMMUTATION_MODES: ReadonlyArray<unknown> = [4, 5, "direct", "assistedOpen"];

/** Whether a `boards[].drivers[].config.mode` value means software commutation. */
export function isSoftwareCommutationMode(mode: unknown): boolean {
	return SOFTWARE_COMMUTATION_MODES.includes(mode);
}

function axisFor(model: TuneModel, motor: string): ModelAxis | undefined {
	return model.move?.axes?.find((a) => a.letter === motor);
}

function boardFor(model: TuneModel, canAddress: number): ModelBoard | undefined {
	return model.boards?.find((b) => b && (b.canAddress ?? 0) === canAddress) ?? undefined;
}

/** Firmware version of the board carrying `motor`'s first driver (the mainboard when board is 0/absent). */
export function driverBoardFirmware(model: unknown, motor: string): string | null {
	const m = model as TuneModel;
	const boardId = axisFor(m, motor)?.drivers?.[0]?.board ?? 0;
	return boardFor(m, boardId)?.firmwareVersion ?? null;
}

/**
 * Whether the tune task is offered at all: the mainboard AND the driver's own board (which may be a
 * CAN expansion or toolboard) must both be new enough, for at least one of `motors`. Fails closed -
 * missing/unparseable firmware means unsupported, never "assume it's fine".
 */
export function motorTuneSupported(model: unknown, motors: Array<string>): boolean {
	const mainboard = (model as TuneModel).boards?.[0]?.firmwareVersion ?? null;
	if (!firmwareAtLeast(mainboard, MIN_TUNE_FIRMWARE)) {
		return false;
	}
	return motors.some((motor) => firmwareAtLeast(driverBoardFirmware(model, motor), MIN_TUNE_FIRMWARE));
}

/**
 * Whether `motor`'s driver commutates in software, so its correction is a free-phase `M970.3` (harmonics
 * 2 and 4) rather than an `M569.2` sine-table entry (harmonic 4 only, phase 0/180). True for an axis in
 * phase stepping, and - as DWC's Input Shaping plugin does - for a driver running in `direct` mode
 * (closed loop, or assisted open loop), whose `axis.phaseStep` is false but which still takes `M970.3`.
 */
export function usesFreePhaseCorrection(model: unknown, motor: string): boolean {
	const m = model as TuneModel;
	const axis = axisFor(m, motor);
	if (axis?.phaseStep === true) {
		return true;
	}
	const driver = axis?.drivers?.[0];
	if (!driver || typeof driver.driver !== "number") {
		return false;
	}
	const config = boardFor(m, driver.board ?? 0)?.drivers?.[driver.driver]?.config;
	return isSoftwareCommutationMode(config?.mode);
}
