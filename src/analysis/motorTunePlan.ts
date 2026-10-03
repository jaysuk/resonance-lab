/**
 * Planning for a multi-harmonic motor waveform tune: which electrical harmonics exist, which of the
 * selected ones can actually be run (correction slots, Nyquist), what a survey capture says about
 * them, and how many moves the whole run costs. Pure - no Vue, no printer.
 *
 * A harmonic S of the firmware's electrical-angle correction is full-step order S/4: the firmware
 * adds J*sin(S*theta + O) to the electrical angle theta (4096 units per electrical cycle, four full
 * steps), and the rotor follows the angle of the field vector, so to first order the correction
 * acts only on order S/4. That is what the least-squares model in motorTuning.ts assumes.
 */
import { combineAxes, LOW_DISPLACEMENT_UM, type MotorHarmonics, toDisplacementUm } from "./motorHarmonics";
import { getMovesPerHarmonic, type PhaseCorrection } from "./motorTuning";

/**
 * Harmonics offered for tuning. 1 = coil current offset, 2 = coil gain imbalance, 4 = waveform
 * distortion / detent, 3 and 5-16 = higher-order distortion - everything the firmware accepts (S1-S16,
 * order S/4, so S16 is order 4). Every one is a first-order-valid target (see the note above), but most
 * sit above Nyquist at a useful speed and a driver holds only four corrections, so which ones are worth
 * tuning is decided by a survey of all of them (`surveyHarmonics` / `pickTopHarmonics`).
 */
export const TUNE_HARMONICS: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** Harmonics tuned when the user hasn't chosen (the two DWC's own tune dialog offers). */
export const DEFAULT_TUNE_HARMONICS: ReadonlyArray<number> = [2, 4];

/** Correction entries the firmware holds per driver (`MaxPhaseCorrectionHarmonics`). */
export const MAX_CORRECTION_SLOTS = 4;

/** Margin on the full-step frequency, matching analyzeMotorHarmonics' default fundamental search range. */
const NYQUIST_MARGIN = 1.05;

/** Full-step order of harmonic S. */
export function harmonicOrder(harmonic: number): number {
	return harmonic / 4;
}

/**
 * Whether harmonic S can be measured at this full-step frequency. The fundamental is always located
 * first (order 1), so orders below 1 are bounded by the fundamental, not by themselves.
 */
export function harmonicFeasible(harmonic: number, fullStepHz: number, sampleRate: number): boolean {
	return Math.max(1, harmonicOrder(harmonic)) * fullStepHz * NYQUIST_MARGIN < sampleRate / 2;
}

export type SkipReason = "slots" | "nyquist" | "unmeasurable";

export interface SkippedHarmonic {
	harmonic: number;
	reason: SkipReason;
}

export interface HarmonicPlan {
	/** Harmonics to run, in the order given. */
	run: Array<number>;
	skipped: Array<SkippedHarmonic>;
}

export interface HarmonicPlanInput {
	selected: ReadonlyArray<number>;
	/** Corrections the driver already holds (from the probe reply). */
	existing: ReadonlyArray<PhaseCorrection>;
	sampleRate: number;
	fullStepHz: number;
	maxSlots?: number;
}

/**
 * Decide which selected harmonics can run. Existing entries for harmonics NOT being tuned keep their
 * slot for the whole run. A selected harmonic that already has an entry reuses it (its baseline probe
 * writes J0, which frees that very slot), so it costs nothing extra. Harmonics skipped for Nyquist
 * take no slot.
 */
export function planHarmonics(input: HarmonicPlanInput): HarmonicPlan {
	const { selected, existing, sampleRate, fullStepHz, maxSlots = MAX_CORRECTION_SLOTS } = input;
	const wanted = Array.from(new Set(selected));
	const existingHarmonics = new Set(existing.map((c) => c.harmonic));
	const heldByOthers = Array.from(existingHarmonics).filter((h) => !wanted.includes(h)).length;

	const skipped: Array<SkippedHarmonic> = [];
	const feasible: Array<number> = [];
	for (const harmonic of wanted) {
		if (!TUNE_HARMONICS.includes(harmonic)) {
			skipped.push({ harmonic, reason: "unmeasurable" });
		} else if (!harmonicFeasible(harmonic, fullStepHz, sampleRate)) {
			skipped.push({ harmonic, reason: "nyquist" });
		} else {
			feasible.push(harmonic);
		}
	}

	// Reusers first: they are free, so a shortage of slots never costs the user one of them.
	let freeSlots = maxSlots - heldByOthers - feasible.filter((h) => existingHarmonics.has(h)).length;
	const admitted = new Set<number>();
	for (const harmonic of feasible) {
		if (existingHarmonics.has(harmonic)) {
			admitted.add(harmonic);
		} else if (freeSlots > 0) {
			freeSlots--;
			admitted.add(harmonic);
		} else {
			skipped.push({ harmonic, reason: "slots" });
		}
	}
	return { run: feasible.filter((h) => admitted.has(h)), skipped };
}

/**
 * Amplitude (g, root-sum-square across channels) at harmonic S's order. Throws instead of returning
 * zero when the order isn't in the analysis: analyzeMotorHarmonics silently drops orders above
 * Nyquist or beyond what it was asked for, and a quiet zero would make every probe read identical,
 * degenerate the fit and report a confident "no improvement".
 */
export function orderAmplitude(analysis: MotorHarmonics, harmonic: number): number {
	const index = analysis.orders.indexOf(harmonicOrder(harmonic));
	if (index < 0) {
		throw new Error(`Order ${harmonicOrder(harmonic)} (harmonic ${harmonic}) was not analysed - it is above the accelerometer's Nyquist frequency or beyond the orders requested`);
	}
	return combineAxes(analysis)[index];
}

/**
 * A harmonic must stand this far above the background level (median amplitude between orders) to be
 * worth a tuning search: below it the probes would mostly measure noise, and the fit has nothing to
 * converge on. The tuning analysis reads orders AND background gaps as the strongest line in a band
 * (fundamentalLock.ts's READ_TOLERANCE), so the background figure is a band maximum, about 2.7 times what a
 * single-bin median was (field data, same captures on both estimators: S4 7.6 -> 2.7, S1 10.3 -> 3.9, S2 50.8 ->
 * 18.3), while an order with no signal still reads about 1x it. A band maximum also scatters far less than a
 * single bin, so 2x clears a noise-only order with room to spare; the old 3x of a single-bin median would now
 * demand roughly 8x and drop a real, correctable line (S4 at 0.0135 g, which tuning cut by 61%).
 */
export const SURVEY_MIN_SNR = 2;

/**
 * Captures a survey takes of the uncorrected motor. Several, because a weak order can read several times
 * higher or lower from one capture to the next (field data: S1 0.0189 then 0.0063 on the same motor), and a
 * correction can only be told apart from that if the scatter is known - which one capture cannot say.
 */
export const SURVEY_REPEATS = 5;

/**
 * An order must read at least this many times its own capture-to-capture standard deviation to be offered for
 * tuning: the search adopts a correction only when it beats the baseline by more than the scatter, so an order
 * scattering by more than about a fifth of its own level leaves no room for a measurable gain.
 */
export const SURVEY_MIN_STABILITY = 5;

export interface SurveyRow {
	harmonic: number;
	order: number;
	frequency: number;
	/** Mean amplitude over the survey's captures. */
	amplitude: number;
	displacementUm: number;
	/** False when the order lies above the accelerometer's Nyquist frequency at this speed - there is no
	 *  reading at all, which is different from a quiet one. */
	measurable: boolean;
	/** Amplitude over the background level; null when the analysis carried no noise estimate. */
	snr: number | null;
	/** No clear signal at THIS speed - the machine's response depends on absolute frequency, so it says
	 *  nothing about whether the harmonic is worth tuning at another speed. Judged on signal over noise,
	 *  not on displacement: displacement falls with frequency squared, so a displacement cut-off would
	 *  skip every high harmonic however clean its signal. */
	quiet: boolean;
	/** How many captures the reading is the mean of. */
	captures: number;
	/** Standard deviation of the amplitude across captures; null for a single capture (no scatter to measure). */
	stdev: number | null;
	/** Amplitude over its own capture-to-capture standard deviation (Infinity when identical); null for a single capture. */
	stability: number | null;
	/** Repeatable enough to tune: stability at least SURVEY_MIN_STABILITY, or a single capture (nothing to judge). */
	stable: boolean;
}

/** One order read off one capture's analyses (one per move direction): mean amplitude and frequency, and background. */
function readOrder(analyses: Array<MotorHarmonics>, harmonic: number): { amplitude: number; frequency: number; noise: number | null } | null {
	const order = harmonicOrder(harmonic);
	if (analyses.some((a) => !a.orders.includes(order))) {
		return null;
	}
	return {
		amplitude: analyses.reduce((sum, a) => sum + orderAmplitude(a, harmonic), 0) / analyses.length,
		frequency: analyses.reduce((sum, a) => sum + a.frequencies[a.orders.indexOf(order)], 0) / analyses.length,
		noise: analyses.every((a) => a.noiseFloor)
			? analyses.reduce((sum, a) => sum + Math.hypot(...Array.from(a.noiseFloor!)), 0) / analyses.length
			: null,
	};
}

/**
 * Measure the given harmonics on repeated captures of the uncorrected motor (each capture is one analysis per
 * move direction, averaged - the same way the search itself does) and rank them: those that clear the
 * background AND repeat, most repeatable first; then those that are clear but scatter too much to tune; then
 * the quiet ones; then the ones that could not be measured at all. A harmonic above Nyquist at this speed gets
 * a row with `measurable: false` rather than throwing, so a survey of all sixteen works at any speed and says
 * plainly which ones it could not see. One capture gives the plain single-reading survey (no scatter judged).
 */
export function surveyRepeated(captures: Array<MotorHarmonics | Array<MotorHarmonics>>, harmonics: ReadonlyArray<number>): Array<SurveyRow> {
	const perCapture = captures.map((legs) => (Array.isArray(legs) ? legs : [legs]));
	const rows = harmonics.map((harmonic): SurveyRow => {
		const order = harmonicOrder(harmonic);
		const reads = perCapture.map((analyses) => readOrder(analyses, harmonic));
		if (reads.length === 0 || reads.some((r) => r === null)) {
			return {
				harmonic, order, frequency: 0, amplitude: 0, displacementUm: 0, measurable: false, snr: null, quiet: false,
				captures: reads.length, stdev: null, stability: null, stable: true,
			};
		}
		const got = reads as Array<NonNullable<ReturnType<typeof readOrder>>>;
		const n = got.length;
		const amplitude = got.reduce((sum, r) => sum + r.amplitude, 0) / n;
		const frequency = got.reduce((sum, r) => sum + r.frequency, 0) / n;
		const displacementUm = toDisplacementUm(amplitude, frequency);
		const noise = got.every((r) => r.noise !== null) ? got.reduce((sum, r) => sum + r.noise!, 0) / n : null;
		const snr = noise === null ? null : (noise > 0 ? amplitude / noise : Infinity);
		const stdev = n > 1 ? Math.sqrt(got.reduce((sum, r) => sum + (r.amplitude - amplitude) ** 2, 0) / (n - 1)) : null;
		const stability = stdev === null ? null : (stdev > 0 ? amplitude / stdev : Infinity);
		return {
			harmonic, order, frequency, amplitude, displacementUm, measurable: true, snr,
			quiet: snr === null ? displacementUm < LOW_DISPLACEMENT_UM : snr < SURVEY_MIN_SNR,
			captures: n, stdev, stability, stable: stability === null || stability >= SURVEY_MIN_STABILITY,
		};
	});
	const score = (r: SurveyRow): number => r.stability ?? r.snr ?? r.displacementUm;
	const tier = (r: SurveyRow): number => (!r.measurable ? 3 : r.quiet ? 2 : r.stable ? 0 : 1);
	return rows.sort((a, b) => tier(a) - tier(b) || (tier(a) === 3 ? a.harmonic - b.harmonic : score(b) - score(a)));
}

/** A survey of one capture - see `surveyRepeated`. */
export function surveyHarmonics(legs: MotorHarmonics | Array<MotorHarmonics>, harmonics: ReadonlyArray<number>): Array<SurveyRow> {
	return surveyRepeated([legs], harmonics);
}

/**
 * The harmonics worth tuning from a survey: those that cleared the background, strongest first, at most
 * `slots` of them - a driver holds only that many corrections at once, so the rest are left out however
 * clean their signal, and those too scattered between captures to tune. Ranked on repeatability (signal over
 * its own scatter), not displacement: tunability is about signal,
 * and displacement falls with frequency squared (see SurveyRow.quiet). The order returned is also the
 * order to tune in - the most valuable harmonic first, so a cancelled run keeps the best result.
 */
export function pickTopHarmonics(rows: ReadonlyArray<SurveyRow>, slots = MAX_CORRECTION_SLOTS): Array<number> {
	return rows.filter((r) => r.measurable && !r.quiet && r.stable).slice(0, slots).map((r) => r.harmonic);
}

/** Total capture count of a run: every harmonic's search, the optional survey, and the final verification. */
export function estimateTuneMoves(harmonicCount: number, constrainPhase: boolean, survey: boolean): number {
	if (harmonicCount <= 0) {
		return 0;
	}
	return harmonicCount * getMovesPerHarmonic(constrainPhase) + (survey ? 1 : 0) + 1;
}

/** A rise in a tuned harmonic's amplitude must be at least this fraction of its untuned baseline to count. */
const VERIFY_MIN_RISE_OF_BASELINE = 0.1;

/**
 * Whether a tuned harmonic got noticeably worse when measured again with every correction in place:
 * more than `ratio` times what its own search measured, AND by at least a tenth of the untuned
 * baseline. The second condition stops a harmonic that was tuned almost to the noise floor from being
 * flagged by ordinary capture-to-capture scatter.
 */
export function verifyRegressed(verified: number, searched: number, baseline: number, ratio: number): boolean {
	return verified > searched * ratio && verified - searched > baseline * VERIFY_MIN_RISE_OF_BASELINE;
}

/** A tuned harmonic whose amplitude moved by less than this fraction between the off and on measurements is within scatter. */
export const TUNE_CHECK_CHANGE = 0.2;

export type TuneCheckOutcome = "better" | "unchanged" | "worse";

export interface TuneCheckRow {
	harmonic: number;
	/** Amplitude (g) of this harmonic's order with every correction off. */
	off: number;
	/** The same with the corrections on. */
	on: number;
	/** (on - off) / off: negative means the correction removed vibration. */
	change: number;
	outcome: TuneCheckOutcome;
}

/** Judge one harmonic's off/on pair; a move under `TUNE_CHECK_CHANGE` is scatter, not an effect. */
export function classifyTuneCheck(harmonic: number, off: number, on: number): TuneCheckRow {
	const change = off > 0 ? (on - off) / off : 0;
	const outcome: TuneCheckOutcome = Math.abs(change) <= TUNE_CHECK_CHANGE ? "unchanged" : change < 0 ? "better" : "worse";
	return { harmonic, off, on, change, outcome };
}
