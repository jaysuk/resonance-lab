/**
 * Keeping the motor-tuning analysis on the right frequency. Every order is measured at a multiple of the
 * full-step frequency the analysis locks onto, and with only order 1 under Nyquist that lock rests on one
 * weak line (SNR ~4). Field data (a 400 Hz full-step capture at 1380 Hz): the lock wandered by about a
 * hertz between back-to-back captures, and a spectral line a fraction of a hertz wide read 4x low
 * whenever it did - which an uncorrected baseline cannot be told from an improvement. Three defences live here:
 *  - a narrow search window around the commanded frequency, widened only if the lock ends on its edge;
 *  - a read band around each order (`READ_TOLERANCE`), so a lock that is off by a hertz still finds the line;
 *  - a per-run tracker that flags a capture whose lock disagrees with the run's earlier ones, for a retake,
 *    and says at the end whether the lock was trustworthy at all;
 *  - once a run has agreeing locks, a hint: later captures search only a hair around that reference. Needed
 *    because tuning order 1 (S4) removes the very line the search locks onto - field data at 620 Hz: order 1
 *    fell from 0.0135 g to 0.0045 g under correction and one leg's lock then jumped 2-3% (604.8 / 632.5 Hz),
 *    halving every reading in the capture. The motor's speed is fixed for the run; its line does not move.
 * Pure - no Vue, no printer, no DOM.
 */
import { analyzeMotorHarmonics, type MotorHarmonics } from "./motorHarmonics";

/** Relative half-width of the fundamental search around the commanded full-step frequency (+-0.5%). */
export const LOCK_SEARCH_RANGE = 0.005;

/** Relative half-width of the search around a hint (the run's established lock): +-0.1% = 0.6 Hz at 620 Hz, give or take the FFT bin the search is rounded to. */
export const LOCK_HINT_RANGE = 0.001;

/** Locks a leg needs on record before its median is trusted as a hint. */
export const MIN_HINT_OBSERVATIONS = 3;

/** The wide window a lock that ended on the edge of the narrow one is repeated in (the analysis' own default). */
export const LOCK_FALLBACK_RANGE = 0.05;

/**
 * Relative half-width of the band each order is read over. The locks seen in the field sat within -0.3% to
 * +0.2% of the commanded frequency, so +-0.4% covers them at every order.
 */
export const READ_TOLERANCE = 0.004;

/** A capture whose lock is this far (relative) from the median of the run's earlier locks is an outlier. 0.15% = 0.6 Hz at 400 Hz. */
export const LOCK_OUTLIER_REL = 0.0015;

/** A leg's typical lock this far (relative) from the commanded frequency is worth telling the user about. */
export const LOCK_NOMINAL_WARN_REL = 0.003;

/** Retakes of one capture whose lock was an outlier, before the last attempt is accepted anyway. */
export const MAX_LOCK_RETAKES = 2;

/**
 * Analyse one move direction for the tuning tasks: a narrow lock window, a read band, and - if the lock
 * ended on the window's edge - the same analysis again in the wide window, in case the accelerometer's
 * real sampling rate differs from the configured one by more than the narrow window allows.
 * With a `hint` (the run's established lock for this direction) the search is confined to a hair around it
 * and never widened: a weak or corrected order 1 must not be allowed to pull the lock away.
 */
export function analyzeTuneLeg(
	channels: Array<ArrayLike<number>>, sampleRate: number, nominalHz: number, evaluateHarmonics: number, hint?: number,
): MotorHarmonics {
	if (hint !== undefined && hint > 0) {
		try {
			return analyzeMotorHarmonics(channels, sampleRate, hint, 1, LOCK_HINT_RANGE, 4, evaluateHarmonics, READ_TOLERANCE);
		} catch {
			// a hint too close to Nyquist for its own window - fall through to the nominal search
		}
	}
	const narrow = analyzeMotorHarmonics(channels, sampleRate, nominalHz, 1, LOCK_SEARCH_RANGE, 4, evaluateHarmonics, READ_TOLERANCE);
	if (!narrow.lockedAtEdge) {
		return narrow;
	}
	try {
		return analyzeMotorHarmonics(channels, sampleRate, nominalHz, 1, LOCK_FALLBACK_RANGE, 4, evaluateHarmonics, READ_TOLERANCE);
	} catch {
		return narrow; // the wide window reaches Nyquist - keep what the narrow one found
	}
}

export interface LockCheck {
	/** True when a leg's lock disagrees with the run's earlier ones by more than `LOCK_OUTLIER_REL`. */
	outlier: boolean;
	/** Largest relative deviation across the legs (0 when there is nothing to compare against yet). */
	deviation: number;
}

export type LockWarning =
	/** The lock was still disagreeing with itself after the retakes. */
	| { kind: "unsteady"; captures: number }
	/** The typical lock is far from the commanded frequency: wrong steps/mm or microstepping, or a sampling rate that differs from M955's. */
	| { kind: "offNominal"; found: number; expected: number; percent: number };

export interface LockSummary {
	nominalHz: number;
	/** Per move direction: the median lock over every capture seen, and how far it is from nominal (relative, signed). */
	legs: Array<{ median: number; deviation: number; captures: number }>;
	captures: number;
	/** Captures that had to be retaken because their lock was an outlier. */
	retakes: number;
	/** Captures accepted although their lock was still an outlier after the retakes. */
	unsteady: number;
	warnings: Array<LockWarning>;
}

function median(values: ReadonlyArray<number>): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Remembers every lock a run has seen, per move direction (the two directions legitimately lock a few tenths
 * of a percent apart, so each is compared with its own history). The reference for a new capture is the
 * median of everything seen before it, rejected captures included - if the first capture was the odd one out,
 * the later ones still outvote it.
 */
export class LockTracker {
	private readonly seen: Array<Array<number>> = [];
	private retakes = 0;
	private unsteady = 0;
	private captures = 0;
	private readonly seeded: number;

	/** `seed`: per-direction locks from an earlier run at the same speed (a survey), counted as established. */
	constructor(private readonly nominalHz: number, seed: ReadonlyArray<number> = []) {
		seed.forEach((f, leg) => {
			this.seen[leg] = Array.from({ length: MIN_HINT_OBSERVATIONS }, () => f);
		});
		this.seeded = seed.length > 0 ? MIN_HINT_OBSERVATIONS : 0;
	}

	/** The run's established lock for a move direction, or undefined until enough captures agree on one. */
	reference(leg: number): number | undefined {
		const history = this.seen[leg];
		return history && history.length >= MIN_HINT_OBSERVATIONS ? median(history) : undefined;
	}

	/** Compare a capture's per-leg fundamentals with the history. Does not record them. */
	check(fundamentals: ReadonlyArray<number>): LockCheck {
		let deviation = 0;
		fundamentals.forEach((f, leg) => {
			const history = this.seen[leg];
			if (history && history.length > 0) {
				const reference = median(history);
				deviation = Math.max(deviation, Math.abs(f - reference) / reference);
			}
		});
		return { outlier: deviation > LOCK_OUTLIER_REL, deviation };
	}

	/** Add a capture's locks to the history. `stillOutlier`: it is accepted although its lock is an outlier (retakes used up). */
	record(fundamentals: ReadonlyArray<number>, opts: { stillOutlier?: boolean } = {}): void {
		fundamentals.forEach((f, leg) => {
			(this.seen[leg] ??= []).push(f);
		});
		this.captures++;
		if (opts.stillOutlier) {
			this.unsteady++;
		}
	}

	/** Note that a capture was thrown away and taken again. */
	noteRetake(): void {
		this.retakes++;
	}

	summary(): LockSummary {
		const legs = this.seen.map((history) => {
			const m = median(history);
			return { median: m, deviation: (m - this.nominalHz) / this.nominalHz, captures: history.length - this.seeded };
		});
		const warnings: Array<LockWarning> = [];
		if (this.unsteady > 0) {
			warnings.push({ kind: "unsteady", captures: this.unsteady });
		}
		const worst = legs.reduce<LockSummary["legs"][number] | null>((w, l) => (w === null || Math.abs(l.deviation) > Math.abs(w.deviation) ? l : w), null);
		if (worst && Math.abs(worst.deviation) > LOCK_NOMINAL_WARN_REL) {
			warnings.push({ kind: "offNominal", found: worst.median, expected: this.nominalHz, percent: Math.abs(worst.deviation) * 100 });
		}
		return { nominalHz: this.nominalHz, legs, captures: this.captures, retakes: this.retakes, unsteady: this.unsteady, warnings };
	}
}
