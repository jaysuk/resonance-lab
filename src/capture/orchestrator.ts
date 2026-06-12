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
import { generateFixedExcitation, generateSweep, type SweepOptions, type SweepProgram } from "./sweep";

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
			// M955/M956 address an accelerometer as <canAddress>.<index> for CAN boards (e.g. P124.0);
			// only the mainboard's own accelerometer is plain P0.
			found.push({ id: can > 0 ? `${can}.0` : "0", label: b.shortName || b.name || `Board ${can}` });
		}
	}
	return found;
}


/** Send a code and fail loudly if the firmware replied with an error (sendCode resolves either way). */
async function sendChecked(io: MachineIO, code: string): Promise<void> {
	const reply = await io.sendCode(code);
	if (/^Error:/im.test(reply)) {
		throw new Error(reply.trim());
	}
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
	await sendChecked(io, `M400 M956 P${options.accelerometer.id} S${samples} A0 F"${name}" M98 P"${SWEEP_PROGRAM_PATH}"`);
	return { csvPath, program };
}

export interface BeltCaptureOptions {
	accelerometer: AccelerometerRef;
	/** Which belt of the CoreXY pair: "a" = X+Y diagonal, "b" = X-Y diagonal. */
	belt: "a" | "b";
	centerX: number;
	centerY: number;
	startFreq?: number;
	endFreq?: number;
	hzPerSec?: number;
	maxAccel?: number;
	expectedSampleRate?: number;
}

/** Run one belt's diagonal swept excitation; call twice (belt a, belt b) and compareBelts the CSVs. */
export async function runBeltCapture(io: MachineIO, options: BeltCaptureOptions): Promise<CaptureRun> {
	const program = generateSweep({
		axis: "X",
		center: options.centerX,
		startFreq: options.startFreq,
		endFreq: options.endFreq,
		hzPerSec: options.hzPerSec,
		maxAccel: options.maxAccel,
		secondary: { axis: "Y", center: options.centerY, scale: options.belt === "a" ? 1 : -1 },
	});
	const name = captureName(`belt${options.belt}`, "xy");
	const csvPath = `${CAPTURE_DIR}/${name}`;
	await io.upload(SWEEP_PROGRAM_PATH, program.lines.join("\n") + "\n");
	const rate = options.expectedSampleRate ?? 1000;
	const samples = Math.min(200000, Math.ceil(program.durationSec * rate * 1.25));
	await sendChecked(io, `M400 M956 P${options.accelerometer.id} S${samples} A0 F"${name}" M98 P"${SWEEP_PROGRAM_PATH}"`);
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
	await sendChecked(io, `G1 ${axis}${options.center - span} F${feedrate} M400`);
	await sendChecked(io, `M956 P${options.accelerometer.id} S${samples} A0 F"${name}" ${moves.join(" ")} M400`);
	return {
		csvPath,
		program: { lines: moves, pulses: moves.length, durationSec: 0, maxExcursion: span },
	};
}

/**
 * Download a capture's CSV, waiting for the firmware to finish writing it. M956 collects and
 * flushes asynchronously - the G-code line completes before the file is closed, so an immediate
 * download sees a missing or truncated file. Poll until the rate/overflows trailer appears.
 */
export async function downloadCapture(io: MachineIO, run: CaptureRun, timeoutMs = 30000, intervalMs = 750): Promise<string> {
	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	const { hasCaptureTrailer } = await import("./csv");
	const deadline = Date.now() + timeoutMs;
	let lastText = "";
	for (;;) {
		try {
			lastText = await io.download(run.csvPath);
			if (hasCaptureTrailer(lastText)) {
				return lastText;
			}
		} catch {
			// File not created yet - keep waiting.
		}
		if (Date.now() >= deadline) {
			if (lastText) {
				return lastText; // let the parser produce its specific error
			}
			throw new Error(`Capture file did not appear within ${Math.round(timeoutMs / 1000)}s (${run.csvPath})`);
		}
		await sleep(intervalMs);
	}
}

/** Run a fixed-frequency excitation capture (study a single suspicious peak). */
export async function runFixedExcitation(io: MachineIO, options: SweepCaptureOptions & { freq: number; seconds?: number }): Promise<CaptureRun> {
	const program = generateFixedExcitation(options);
	const name = captureName(`fix${Math.round(options.freq)}`, options.axis);
	const csvPath = `${CAPTURE_DIR}/${name}`;
	await io.upload(SWEEP_PROGRAM_PATH, program.lines.join("\n") + "\n");
	const rate = options.expectedSampleRate ?? 1000;
	const samples = Math.min(200000, Math.ceil(program.durationSec * rate * 1.25));
	await sendChecked(io, `M400 M956 P${options.accelerometer.id} S${samples} A0 F"${name}" M98 P"${SWEEP_PROGRAM_PATH}"`);
	return { csvPath, program };
}

export interface SpeedPointCaptureOptions {
	accelerometer: AccelerometerRef;
	axis: string;
	center: number;
	/** Travel speed for this point (mm/s). */
	speed: number;
	/** Half-span of the constant-speed pass (mm). */
	span?: number;
	expectedSampleRate?: number;
}

/**
 * Record one vibration-profile point: a constant-speed out-and-back pass on the axis at `speed`,
 * recorded throughout. Call once per speed step and feed the CSVs to buildVibrationProfile.
 */
export async function runSpeedPointCapture(io: MachineIO, options: SpeedPointCaptureOptions): Promise<CaptureRun> {
	const axis = options.axis.toUpperCase();
	const span = options.span ?? 60;
	const f = Math.max(60, Math.round(options.speed * 60)); // mm/s -> mm/min
	const name = captureName(`speed${Math.round(options.speed)}`, options.axis);
	const csvPath = `${CAPTURE_DIR}/${name}`;
	const rate = options.expectedSampleRate ?? 1000;
	// Out + back at constant speed, plus margin for accel/decel phases.
	const samples = Math.min(200000, Math.ceil(((4 * span) / options.speed) * rate * 1.3));
	await sendChecked(io, `G1 ${axis}${options.center - span} F30000 M400`);
	await sendChecked(io, 
		`M956 P${options.accelerometer.id} S${samples} A0 F"${name}" `
		+ `G1 ${axis}${options.center + span} F${f} G1 ${axis}${options.center - span} F${f} M400`,
	);
	return { csvPath, program: { lines: [], pulses: 2, durationSec: (4 * span) / options.speed, maxExcursion: span } };
}
