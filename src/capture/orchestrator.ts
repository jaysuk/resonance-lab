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
import { generateFixedExcitation, generateSweep, type ShaperState, type SweepOptions, type SweepProgram } from "./sweep";
import { mapAccelerometers } from "./tools";

export interface MachineIO {
	/** Send a G-code line and resolve when it has completed (DWC sendCode semantics). */
	sendCode(code: string): Promise<string>;
	/** Upload a text file to the given full path (e.g. "0:/sys/resonanceLab/sweep.g"). */
	upload(path: string, content: string): Promise<void>;
	/** Download a text file by full path. */
	download(path: string): Promise<string>;
	/**
	 * Current value of the firmware's completed-sampling-run counter for this accelerometer
	 * (object model `boards[].accelerometer.runs`). Read just BEFORE arming the recorder; the
	 * firmware ticks it the instant it closes the CSV, which is the authoritative "done" signal.
	 * Optional: when absent (e.g. unit tests), downloadCapture falls back to polling the file.
	 */
	accelRuns?(accelId: string): number;
	/** Resolve once the run counter for `accelId` rises above `from`; reject after `timeoutMs`. */
	awaitAccelRun?(accelId: string, from: number, timeoutMs: number): Promise<void>;
	/**
	 * Resolve once the machine's motion has finished (object-model status back to idle). The recorder
	 * can close its file mid-motion if the sample count is reached before the moves end, so we also
	 * wait for the motion to actually stop before treating the capture as complete (and before showing
	 * results / starting the next axis). Optional; resolves on timeout rather than failing the capture.
	 */
	awaitIdle?(timeoutMs: number): Promise<void>;
	/**
	 * Resolve once the machine's motion status has left the idle set (object-model status becomes
	 * "busy"/"processing"/etc). Used to time a move by wall clock from when motion actually starts
	 * rather than from when `sendCode` merely returns (which does not reliably block until a long
	 * macro finishes - see `runBeltCapture`). Optional; resolves on timeout otherwise.
	 */
	awaitBusy?(timeoutMs: number): Promise<void>;
	/**
	 * Delete a file (e.g. a per-run uploaded program that's no longer needed). Optional and
	 * best-effort - callers swallow failures, since RRF may briefly still hold the file open.
	 */
	delete?(path: string): Promise<void>;
	/**
	 * Create a directory (e.g. the program-file folder, before the first upload each run). Optional
	 * and best-effort - callers swallow failures (it may already exist).
	 */
	makeDirectory?(path: string): Promise<void>;
}

export interface AccelerometerRef {
	/** M956 P parameter (board CAN address, e.g. "0" or "121.0"). */
	id: string;
	/** Display label (board name, or "T<n> <name> — <board>" when tied to a tool-changer tool). */
	label: string;
	/** Tool number this accelerometer's board is wired to, when derivable (see ./tools.ts). */
	toolNumber?: number;
	/** That tool's configured name (M563 P<n> S"<name>"), when it has one. */
	toolName?: string;
}

/**
 * Discover configured accelerometers from the object model (M955 creates boards[].accelerometer),
 * labelled by tool on a tool-changer. Delegates to ./tools.ts, which is worth reading before editing
 * this - the tool/board association isn't in the object model directly and has to be derived.
 */
export function findAccelerometers(model: unknown): Array<AccelerometerRef> {
	return mapAccelerometers(model);
}

/**
 * Parse the real sample rate (Hz) from an M955 status report, e.g. RRF's own wording:
 * "Accelerometer 0:0 type LIS3DH with orientation 20 samples at 1344Hz with 10-bit resolution, ...".
 * Anchored on "samples at" first so an unrelated number elsewhere in the report (board address,
 * orientation, resolution, SPI frequency) can never be mistaken for the sample rate; falls back to
 * the first bare "<n> Hz" if the firmware's wording ever changes. Returns 0 if nothing parses.
 */
export function parseAccelRateFromReport(reply: string): number {
	const anchored = /samples\s+at\s+(\d+(?:\.\d+)?)\s*Hz/i.exec(reply);
	const m = anchored ?? /(\d+(?:\.\d+)?)\s*Hz/i.exec(reply);
	return m ? Math.round(parseFloat(m[1])) : 0;
}

/**
 * Best-effort file delete: swallows all failures (RRF may briefly still hold the file open, or the
 * IO may not implement `delete` at all, e.g. unit tests). Used to clean up per-run uploaded program
 * files once they're no longer needed, so `0:/sys` doesn't accumulate one `.g` file per capture.
 */
async function deleteQuiet(io: MachineIO, path: string | undefined): Promise<void> {
	if (!path || !io.delete) {
		return;
	}
	try {
		await io.delete(path);
	} catch {
		// best-effort - not fatal
	}
}

/** Send a code and fail loudly if the firmware replied with an error (sendCode resolves either way). */
async function sendChecked(io: MachineIO, code: string): Promise<void> {
	const reply = await io.sendCode(code);
	if (/^Error:/im.test(reply)) {
		throw new Error(reply.trim());
	}
}

/**
 * Program files are PER-RUN: the firmware holds the macro file open while M98 executes, and
 * sendCode does NOT reliably block until a long macro completes - overwriting a shared filename
 * for the next run fails with "Cannot delete file because it is open" (live-printer finding).
 *
 * Uploaded into a dedicated subfolder (default `DEFAULT_PROGRAM_DIR`), not bare `0:/sys` - that
 * directory otherwise holds the machine's own config/homing files and shouldn't accumulate one
 * generated `.g` per capture alongside them. Configurable per-caller so the plugin's own setting can
 * override it; the folder is created (best-effort, idempotent) before the first upload each run.
 */
export const DEFAULT_PROGRAM_DIR = "0:/sys/resonanceLab";

export function sweepProgramPath(captureName: string, dir: string = DEFAULT_PROGRAM_DIR): string {
	return `${dir}/${captureName.replace(/\.csv$/, "")}.g`;
}
export const CAPTURE_DIR = "0:/sys/accelerometer";

/** Best-effort directory creation: swallows failures (e.g. it already exists). */
async function ensureDir(io: MachineIO, dir: string): Promise<void> {
	if (!io.makeDirectory) {
		return;
	}
	try {
		await io.makeDirectory(dir);
	} catch {
		// already exists, or the firmware/connector otherwise rejected it - not fatal, upload will
		// surface a real problem (e.g. a genuinely missing/invalid path) on its own.
	}
}

export interface SweepCaptureOptions extends SweepOptions {
	/** Which accelerometer to record from. */
	accelerometer: AccelerometerRef;
	/** Expected sample rate (Hz) used to size the capture; the CSV reports the real one. */
	expectedSampleRate?: number;
	/** Directory the generated program file is uploaded to. Defaults to DEFAULT_PROGRAM_DIR. */
	programDir?: string;
}

export interface CaptureRun {
	/** Full path of the CSV the firmware wrote. */
	csvPath: string;
	/** The generated program (for display: duration, pulse count, excursion). */
	program: SweepProgram;
	/** Accelerometer id (M956 P), kept so downloadCapture can watch its run counter. */
	accelId?: string;
	/** Run counter sampled just before arming; completion = counter rising above this. */
	runsBefore?: number;
	/** Per-run uploaded program file (if any) - downloadCapture best-effort deletes it once done. */
	progPath?: string;
	/**
	 * Real motion duration (seconds), measured concurrently while an unsized belt recording ran (see
	 * `runBeltCapture`). Undefined when the recording was precisely sized already, or when the
	 * busy/idle signals needed to measure it weren't available.
	 */
	motionSec?: number;
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

	const progPath = sweepProgramPath(name, options.programDir);
	await ensureDir(io, options.programDir ?? DEFAULT_PROGRAM_DIR);
	await io.upload(progPath, program.lines.join("\n") + "\n");

	// Size the capture to the program duration plus margin for the ring-down tail.
	const rate = options.expectedSampleRate ?? 1000;
	const samples = Math.min(200000, Math.ceil((program.durationSec + 2) * rate));

	// M400 drains motion, M956 arms the recorder (A0 = start now, F names the file), M98 runs the
	// program. sendCode resolving does NOT prove the recording finished (M956 flushes async), so
	// snapshot the run counter first and let downloadCapture wait for it to tick.
	const runsBefore = io.accelRuns?.(options.accelerometer.id);
	await sendChecked(io, `M400 M956 P${options.accelerometer.id} S${samples} A0 F"${name}" M98 P"${progPath}"`);
	return { csvPath, program, accelId: options.accelerometer.id, runsBefore, progPath };
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
	maxFeedrate?: number;
	expectedSampleRate?: number;
	/** Override the recording length (samples). Used when the real motion time has been measured. */
	samples?: number;
	/** Directory the generated program file is uploaded to. Defaults to DEFAULT_PROGRAM_DIR. */
	programDir?: string;
	/** Shaper configuration (read from the object model before the test) to restore once it's over. */
	restoreShaper?: ShaperState;
}

function beltProgram(options: BeltCaptureOptions): SweepProgram {
	return generateSweep({
		axis: "X",
		center: options.centerX,
		startFreq: options.startFreq,
		endFreq: options.endFreq,
		hzPerSec: options.hzPerSec,
		maxAccel: options.maxAccel,
		maxFeedrate: options.maxFeedrate,
		restoreShaper: options.restoreShaper,
		secondary: { axis: "Y", center: options.centerY, scale: options.belt === "a" ? 1 : -1 },
	});
}

/** The kinematic (worst-case) duration estimate for a belt sweep - the recording size `runBeltCapture` falls back to before the real motion time is known. */
export function beltEstimatedDurationSec(options: BeltCaptureOptions): number {
	return beltProgram(options).durationSec;
}

/**
 * Run one belt's diagonal swept excitation; call twice (belt a, belt b) and compareBelts the CSVs.
 *
 * Sizing: pass `options.samples` when the real motion duration is already known (from a previous
 * self-timed run at the same parameters, or a cached value - see ResonanceLabPage.vue) to record
 * precisely with no waste. Leave it undefined to have THIS run size itself generously (the kinematic
 * estimate, which over-states CoreXY diagonal moves) and self-time the REAL motion concurrently via
 * the object model's busy/idle transition (`MachineIO.awaitBusy`/`awaitIdle`) - not a separate
 * throwaway probe move beforehand (that used to record/move the same belt profile twice in a row).
 * Motion is confirmed to have actually started (busy) before waiting for idle, because calling
 * `awaitIdle` while the machine is still idle (not yet started moving) would otherwise resolve
 * immediately with a false zero. The returned `motionSec` lets the caller crop the downloaded
 * capture to the real duration (`cropCaptureToDuration` in ./csv) and size the OTHER belt precisely,
 * so only the very first (unsized) belt run pays the over-record cost - and only once per set of
 * sweep parameters, if the caller caches `motionSec` (RRF has no way to stop an in-progress M956
 * recording early, so this self-timed-oversize approach is the only way to avoid a separate probe
 * motion without risking truncating the real data).
 */
export async function runBeltCapture(io: MachineIO, options: BeltCaptureOptions): Promise<CaptureRun> {
	const program = beltProgram(options);
	const name = captureName(`belt${options.belt}`, "xy");
	const csvPath = `${CAPTURE_DIR}/${name}`;
	const progPath = sweepProgramPath(name, options.programDir);
	await ensureDir(io, options.programDir ?? DEFAULT_PROGRAM_DIR);
	await io.upload(progPath, program.lines.join("\n") + "\n");
	const rate = options.expectedSampleRate ?? 1000;
	const runsBefore = io.accelRuns?.(options.accelerometer.id);

	if (options.samples !== undefined) {
		await sendChecked(io, `M400 M956 P${options.accelerometer.id} S${options.samples} A0 F"${name}" M98 P"${progPath}"`);
		return { csvPath, program, accelId: options.accelerometer.id, runsBefore, progPath };
	}

	const oversizedSamples = Math.min(200000, Math.ceil((program.durationSec + 2) * rate));
	const sendPromise = sendChecked(io, `M400 M956 P${options.accelerometer.id} S${oversizedSamples} A0 F"${name}" M98 P"${progPath}"`);

	let motionSec: number | undefined;
	if (io.awaitBusy && io.awaitIdle) {
		try {
			await io.awaitBusy(5000);
			const t1 = Date.now();
			const budget = program.durationSec * 1.3 * 1000 + 10000;
			await io.awaitIdle(budget);
			motionSec = (Date.now() - t1) / 1000;
		} catch {
			// Never observed busy (very short move, or a status-polling gap) - motionSec stays
			// undefined; the caller keeps the full oversized capture uncropped.
		}
	}
	await sendPromise; // surface any G-code error
	return { csvPath, program, accelId: options.accelerometer.id, runsBefore, progPath, motionSec };
}

/**
 * Cross-check a recording's sizing rate against the rate a CSV trailer actually reports. Belt A is
 * sized from `readAccelRate`'s parse of the M955 report; if the firmware's real rate differs enough,
 * belt B should be resized from the measured motion time at the ACTUAL rate rather than repeating
 * the same over/under-record. Returns the original sample count unchanged when the two agree.
 */
export function resizeForActualRate(samples: number, motionSec: number, sizingRate: number, actualRate: number): number {
	if (sizingRate <= 0 || Math.abs(actualRate - sizingRate) / sizingRate <= 0.1) {
		return samples;
	}
	return Math.min(200000, Math.ceil((motionSec + 1.5) * actualRate));
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
 * profile (default) or the user's own moves (advanced). Whether to disable/restore input shaping
 * around this is the caller's call (see ResonanceLabPage.vue's withShaperDisabled) - this function
 * doesn't touch M593 itself, since it's shared by tasks that want that (move) and tasks that don't
 * ("custom", where the user's own G-code owns shaper state; the orientation check, which isn't a
 * resonance measurement at all).
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
	// Move to the start, then arm, dwell (clean pre-motion samples for gravity/noise floors), and
	// execute the profile in one line so recording brackets it.
	await sendChecked(io, `G1 ${axis}${options.center - span} F${feedrate} M400`);
	const runsBefore = io.accelRuns?.(options.accelerometer.id);
	await sendChecked(io, `M956 P${options.accelerometer.id} S${samples} A0 F"${name}" G4 P300 ${moves.join(" ")} M400`);
	return {
		csvPath,
		program: { lines: moves, pulses: moves.length, durationSec: 0, maxExcursion: span },
		accelId: options.accelerometer.id,
		runsBefore,
	};
}

/**
 * Download a capture's CSV once the firmware has finished writing it. M956 collects and flushes
 * asynchronously, so the G-code line completes before the file is closed.
 *
 * Preferred signal: the object-model run counter (`boards[].accelerometer.runs`) ticks the instant
 * the firmware closes the CSV - exact and duration-independent (this is how the stock Input Shaping
 * plugin does it). We snapshot it before arming (run.runsBefore) and wait for it to rise. Fallback
 * (no run-counter access, e.g. unit tests): poll the file until the rate/overflows trailer appears.
 */
export async function downloadCapture(io: MachineIO, run: CaptureRun, timeoutMs?: number, intervalMs = 750): Promise<string> {
	// The file is only closed once sampling completes, so the wait budget must scale with the test,
	// not a fixed 30s (a 5-135 Hz sweep is ~130s). The counter wait makes this only a safety net.
	const budget = timeoutMs ?? Math.max(30000, (run.program.durationSec + 30) * 1000 * 1.3);
	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	const { hasCaptureTrailer } = await import("./csv");

	if (io.awaitAccelRun && run.accelId !== undefined && typeof run.runsBefore === "number") {
		let ticked = true;
		try {
			await io.awaitAccelRun(run.accelId, run.runsBefore, budget);
		} catch {
			// Counter never advanced (firmware error / disconnect / unhomed abort): fall through and
			// make a best-effort read so the parser can surface the real problem.
			ticked = false;
		}
		// The recorder may close its file before the moves finish (sample count reached mid-motion);
		// wait for the machine to actually stop so we don't advance / show results while it's moving.
		if (io.awaitIdle) {
			try {
				await io.awaitIdle(budget);
			} catch { /* idle detection unavailable - proceed */ }
		}
		// Once the counter ticks the file is closed; a few quick reads cover filesystem visibility lag.
		let lastText = "";
		for (let attempt = 0; attempt < 6; attempt++) {
			try {
				lastText = await io.download(run.csvPath);
				if (hasCaptureTrailer(lastText)) {
					await deleteQuiet(io, run.progPath); // capture confirmed complete - the program is spent
					return lastText;
				}
			} catch {
				// Not visible yet.
			}
			await sleep(200);
		}
		if (lastText) {
			return lastText; // let the parser produce its specific error
		}
		throw new Error(ticked
			? `Capture file never appeared after sampling completed (${run.csvPath})`
			: `Capture did not complete within ${Math.round(budget / 1000)}s (${run.csvPath})`);
	}

	const deadline = Date.now() + budget;
	let lastText = "";
	for (;;) {
		try {
			lastText = await io.download(run.csvPath);
			if (hasCaptureTrailer(lastText)) {
				await deleteQuiet(io, run.progPath); // capture confirmed complete - the program is spent
				return lastText;
			}
		} catch {
			// File not created yet - keep waiting.
		}
		if (Date.now() >= deadline) {
			if (lastText) {
				return lastText; // let the parser produce its specific error
			}
			throw new Error(`Capture file did not appear within ${Math.round(budget / 1000)}s (${run.csvPath})`);
		}
		await sleep(intervalMs);
	}
}

/** Run a fixed-frequency excitation capture (study a single suspicious peak). */
export async function runFixedExcitation(io: MachineIO, options: SweepCaptureOptions & { freq: number; seconds?: number }): Promise<CaptureRun> {
	const program = generateFixedExcitation(options);
	const name = captureName(`fix${Math.round(options.freq)}`, options.axis);
	const csvPath = `${CAPTURE_DIR}/${name}`;
	const progPath = sweepProgramPath(name, options.programDir);
	await ensureDir(io, options.programDir ?? DEFAULT_PROGRAM_DIR);
	await io.upload(progPath, program.lines.join("\n") + "\n");
	const rate = options.expectedSampleRate ?? 1000;
	const samples = Math.min(200000, Math.ceil((program.durationSec + 2) * rate));
	const runsBefore = io.accelRuns?.(options.accelerometer.id);
	await sendChecked(io, `M400 M956 P${options.accelerometer.id} S${samples} A0 F"${name}" M98 P"${progPath}"`);
	return { csvPath, program, accelId: options.accelerometer.id, runsBefore, progPath };
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
	const runsBefore = io.accelRuns?.(options.accelerometer.id);
	await sendChecked(io,
		`M956 P${options.accelerometer.id} S${samples} A0 F"${name}" `
		+ `G1 ${axis}${options.center + span} F${f} G1 ${axis}${options.center - span} F${f} M400`,
	);
	return {
		csvPath,
		program: { lines: [], pulses: 2, durationSec: (4 * span) / options.speed, maxExcursion: span },
		accelId: options.accelerometer.id,
		runsBefore,
	};
}
