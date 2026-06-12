/**
 * Capture orchestration: turns "measure the X axis" into the M955/M956/G-code sequence, fetches the
 * resulting CSV and hands it to the analysis pipeline. All machine I/O is injected (sendCode /
 * upload / download), so every sequence is unit-testable without a printer and the module stays
 * store-agnostic; the Vue layer wires useMachineStore in.
 *
 * Two measurement modes (user-facing):
 *  - SIMPLE (default): pick an axis - we generate the motion ourselves. The swept excitation covers
 *    the whole frequency band in one run and is the recommended path.
 *  - ADVANCED: the user supplies their own move profile (the native flow the stock plugin offers);
 *    we arm the recorder around it.
 */
import { generateSweep, type SweepOptions, type SweepProgram } from "./sweep";

export interface MachineIO {
	/** Send a G-code line and resolve when it has completed (DWC sendCode semantics). */
	sendCode(code: string): Promise<string>;
	/** Upload a text file to the given full path (e.g. "0:/sys/resonanceLab/sweep.g"). */
	upload(path: string, content: string): Promise<void>;
	/** Download a text file by full path. */
	download(path: string): Promise<string>;
}

export interface AccelerometerRef {
	/** M956 P parameter (board CAN address, e.g. "0" or "121.0"). */
	id: string;
	/** Display label (board name). */
	label: string;
}

/** Discover configured accelerometers from the object model (M955 creates boards[].accelerometer). */
export function findAccelerometers(model: unknown): Array<AccelerometerRef> {
	const boards = (model as { boards?: Array<{ accelerometer?: unknown; canAddress?: number | null; shortName?: string; name?: string } | null> })?.boards ?? [];
	const found: Array<AccelerometerRef> = [];
	for (let i = 0; i < boards.length; i++) {
		const b = boards[i];
		if (b && b.accelerometer) {
			const can = b.canAddress ?? 0;
			found.push({ id: String(can), label: b.shortName || b.name || `Board ${can}` });
		}
	}
	return found;
}

export const SWEEP_PROGRAM_PATH = "0:/sys/resonanceLab-sweep.g";
export const CAPTURE_DIR = "0:/sys/accelerometer";

export interface SweepCaptureOptions extends SweepOptions {
	/** Which accelerometer to record from. */
	accelerometer: AccelerometerRef;
	/** Expected sample rate (Hz) used to size the capture; the CSV reports the real one. */
	expectedSampleRate?: number;
}

export interface CaptureRun {
	/** Full path of the CSV the firmware wrote. */
	csvPath: string;
	/** The generated program (for display: duration, pulse count, excursion). */
	program: SweepProgram;
}

/** Capture file name: stable prefix + axis + timestamp, so runs never overwrite each other. */
function captureName(kind: string, axis: string): string {
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	return `rlab-${kind}-${axis.toLowerCase()}-${stamp}.csv`;
}

/**
 * Run a swept-excitation measurement: upload the program, arm the recorder, execute, and return
 * where the CSV landed. The caller is responsible for confirming the machine is homed and the
 * sweep excursion fits the envelope (program.maxExcursion).
 */
export async function runSweepCapture(io: MachineIO, options: SweepCaptureOptions): Promise<CaptureRun> {
	const program = generateSweep(options);
	const name = captureName("sweep", options.axis);
	const csvPath = `${CAPTURE_DIR}/${name}`;

	await io.upload(SWEEP_PROGRAM_PATH, program.lines.join("\n") + "\n");

	// Size the capture to the program duration plus margin for the ring-down tail.
	const rate = options.expectedSampleRate ?? 1000;
	const samples = Math.min(200000, Math.ceil(program.durationSec * rate * 1.25));

	// M400 drains motion, M956 arms the recorder (A0 = start now, F names the file), M98 runs the
	// program; sendCode resolves when the whole line - including the macro - has completed.
	await io.sendCode(`M400 M956 P${options.accelerometer.id} S${samples} A0 F"${name}" M98 P"${SWEEP_PROGRAM_PATH}"`);
	return { csvPath, program };
}

export interface NativeCaptureOptions {
	accelerometer: AccelerometerRef;
	axis: string;
	/** Centre of travel on the axis (mm). */
	center: number;
	/** Half-span of the default test move (mm). */
	span?: number;
	/** Feedrate for the test moves (mm/min). */
	feedrate?: number;
	samples?: number;
	/** ADVANCED: explicit move lines (full G-code) replacing the generated default profile. */
	customMoves?: Array<string>;
}

/**
 * Run a native profile capture: arm the recorder, then either the simple generated out-and-back
 * profile (default) or the user's own moves (advanced).
 */
export async function runNativeCapture(io: MachineIO, options: NativeCaptureOptions): Promise<CaptureRun> {
	const axis = options.axis.toUpperCase();
	const span = options.span ?? 40;
	const feedrate = options.feedrate ?? 30000;
	const samples = options.samples ?? 1000;
	const name = captureName("move", options.axis);
	const csvPath = `${CAPTURE_DIR}/${name}`;

	const moves = options.customMoves ?? [
		`G1 ${axis}${options.center - span} F${feedrate}`,
		`G1 ${axis}${options.center + span} F${feedrate}`,
		`G1 ${axis}${options.center} F${feedrate}`,
	];
	// Move to the start, then arm and execute the profile in one line so recording brackets it.
	await io.sendCode(`G1 ${axis}${options.center - span} F${feedrate} M400`);
	await io.sendCode(`M956 P${options.accelerometer.id} S${samples} A0 F"${name}" ${moves.join(" ")} M400`);
	return {
		csvPath,
		program: { lines: moves, pulses: moves.length, durationSec: 0, maxExcursion: span },
	};
}

/** Download a finished capture's CSV text. */
export function downloadCapture(io: MachineIO, run: CaptureRun): Promise<string> {
	return io.download(run.csvPath);
}
