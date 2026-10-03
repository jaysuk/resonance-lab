/**
 * Diagnostics log of the motor-tuning task: every capture a survey, tune or verify took, with what each one
 * read at every analysed order and which corrections were live on the driver at the time. Kept in memory
 * and exported as one JSON file so a run can be inspected afterwards (is an order's scatter random? does a
 * correction on one harmonic move another? did the fundamental the analysis locked onto drift?).
 * Pure - no Vue, no printer, no DOM.
 */
import { combineAxes, type MotorHarmonics } from "./motorHarmonics";
import { harmonicOrder, TUNE_HARMONICS } from "./motorTunePlan";

export const DIAGNOSTICS_SCHEMA = 1;

/** Most runs kept in memory; each is a few dozen captures of a few hundred numbers. */
export const MAX_LOGGED_RUNS = 20;

export interface DiagCorrection {
	harmonic: number;
	magnitude: number;
	phase: number;
}

/** One move direction's analysis, as the search sees it. */
export interface DiagLeg {
	/** Full-step frequency (Hz) the analysis located itself - if it wanders between captures, so do the readings. */
	fundamental: number;
	orders: Array<number>;
	frequencies: Array<number>;
	/** Root-sum-square across channels per order (g): the figure every decision is made on. */
	combined: Array<number>;
	/** Per channel, per order (g). */
	channels: Array<Array<number>>;
	/** Background level per channel (g); null when the analysis carried none. */
	noiseFloor: Array<number> | null;
}

export type DiagCaptureKind = "survey" | "baseline" | "probe" | "final" | "verify-off" | "verify-on";

/** What a caller says about a capture it is about to take. */
export interface DiagLabel {
	kind: DiagCaptureKind;
	/** Harmonic being searched (baseline/probe), and the correction being probed on it. */
	harmonic?: number;
	magnitude?: number;
	phase?: number;
	/** Every correction live on the driver when the capture was taken. */
	applied: Array<DiagCorrection>;
}

export interface DiagCapture extends DiagLabel {
	seq: number;
	at: string;
	/** Sampling rate the recording actually ran at (Hz) and its length in samples. */
	samplingRate: number;
	sampleCount: number;
	overflows: number;
	/** 1 for the first take of a capture; higher when it was retaken because the analysis' lock was an outlier. */
	attempt: number;
	/** True for a take that was thrown away and retaken - kept in the file, left out of `scatter`. */
	rejected: boolean;
	/** How far (relative) this take's lock was from the median of the run's earlier ones; 0 when none to compare with. */
	lockDeviation: number;
	legs: Array<DiagLeg>;
	/** Mean of both legs' combined amplitude at every harmonic S1..S16 that was analysed (g), keyed "S<n>". */
	readings: Record<string, number>;
}

export type DiagRunKind = "survey" | "tune" | "verify";

export interface DiagRun {
	kind: DiagRunKind;
	startedAt: string;
	finishedAt?: string;
	outcome?: "completed" | "cancelled" | "error";
	error?: string;
	/** Everything about the setup that could explain a reading: motor, speed, firmware, chip, prior corrections. */
	context: Record<string, unknown>;
	captures: Array<DiagCapture>;
	/** The run's own conclusion (survey rows, per-harmonic search results, verification, codes). */
	result?: unknown;
}

/** Six significant digits: far below any scatter worth seeing, and keeps the file small. */
function round(x: number): number {
	return Number.isFinite(x) ? Number(x.toPrecision(6)) : x;
}

export function serializeLeg(h: MotorHarmonics): DiagLeg {
	return {
		fundamental: round(h.fundamental),
		orders: [...h.orders],
		frequencies: h.frequencies.map(round),
		combined: Array.from(combineAxes(h), round),
		channels: h.amplitudes.map((ch) => Array.from(ch, round)),
		noiseFloor: h.noiseFloor ? Array.from(h.noiseFloor, round) : null,
	};
}

/** Mean over the legs of the combined amplitude at each harmonic whose order every leg analysed. */
export function harmonicReadings(legs: ReadonlyArray<MotorHarmonics>): Record<string, number> {
	const out: Record<string, number> = {};
	if (legs.length === 0) {
		return out;
	}
	const combined = legs.map((leg) => combineAxes(leg));
	for (const harmonic of TUNE_HARMONICS) {
		const order = harmonicOrder(harmonic);
		const indices = legs.map((leg) => leg.orders.indexOf(order));
		if (indices.every((i) => i >= 0)) {
			out[`S${harmonic}`] = round(combined.reduce((sum, c, k) => sum + c[indices[k]], 0) / legs.length);
		}
	}
	return out;
}

export function startRun(kind: DiagRunKind, context: Record<string, unknown>, now = new Date()): DiagRun {
	return { kind, startedAt: now.toISOString(), context, captures: [] };
}

export function recordCapture(
	run: DiagRun,
	label: DiagLabel,
	capture: {
		legs: ReadonlyArray<MotorHarmonics>; samplingRate: number; sampleCount: number; overflows: number;
		attempt?: number; rejected?: boolean; lockDeviation?: number;
	},
	now = new Date(),
): void {
	run.captures.push({
		...label,
		applied: label.applied.map((c) => ({ ...c })),
		seq: run.captures.length + 1,
		at: now.toISOString(),
		samplingRate: round(capture.samplingRate),
		sampleCount: capture.sampleCount,
		overflows: capture.overflows,
		attempt: capture.attempt ?? 1,
		rejected: capture.rejected ?? false,
		lockDeviation: round(capture.lockDeviation ?? 0),
		legs: capture.legs.map(serializeLeg),
		readings: harmonicReadings(capture.legs),
	});
}

export function finishRun(run: DiagRun, outcome: NonNullable<DiagRun["outcome"]>, error?: string, now = new Date()): void {
	run.finishedAt = now.toISOString();
	run.outcome = outcome;
	if (error) {
		run.error = error;
	}
}

/** Append a run, dropping the oldest beyond `MAX_LOGGED_RUNS`. */
export function pushRun(runs: Array<DiagRun>, run: DiagRun): void {
	runs.push(run);
	while (runs.length > MAX_LOGGED_RUNS) {
		runs.shift();
	}
}

/** Mean and sample standard deviation of one harmonic's reading over the captures of a run that match `filter` (default: every take that was kept). */
export function readingStats(run: DiagRun, harmonic: number, filter: (c: DiagCapture) => boolean = (c) => !c.rejected):
	{ n: number; mean: number; stdev: number | null } | null {
	const values = run.captures.filter(filter).map((c) => c.readings[`S${harmonic}`]).filter((v) => v !== undefined);
	if (values.length === 0) {
		return null;
	}
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	const stdev = values.length > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)) : null;
	return { n: values.length, mean, stdev };
}

/**
 * The file a user sends for interpretation. `scatter` pre-computes, for each survey run, every harmonic's
 * mean and standard deviation across the survey captures - the raw `readings` of each capture are all still there.
 */
export function buildDiagnosticsExport(runs: ReadonlyArray<DiagRun>, meta: Record<string, unknown>, now = new Date()): Record<string, unknown> {
	return {
		schema: DIAGNOSTICS_SCHEMA,
		generator: "Resonance Lab motor-tuning diagnostics",
		exportedAt: now.toISOString(),
		meta,
		notes: [
			"readings: mean over both move directions of the combined (root-sum-square across channels) amplitude in g at order S/4.",
			"applied: the corrections live on the driver when that capture was taken (a harmonic's own baseline probe has it at J0).",
			"legs[].fundamental: the full-step frequency the analysis located; legs[].noiseFloor: median amplitude between adjacent orders; legs[].frequencies: where each order's strongest line was found within the read band.",
			"rejected: a take thrown away because its fundamental lock disagreed with the run's earlier ones (lockDeviation, relative) - it was retaken (attempt) and is excluded from scatter.",
		],
		runs: runs.map((run) => ({
			...run,
			scatter: run.kind === "survey"
				? Object.fromEntries(TUNE_HARMONICS.map((h) => [`S${h}`, readingStats(run, h)]).filter(([, v]) => v !== null))
				: undefined,
		})),
	};
}
