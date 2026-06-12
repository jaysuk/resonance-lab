/**
 * The tuning engine: given a measured vibration spectrum (PSD), evaluate every RRF shaper across a
 * frequency scan and recommend the configuration that best removes ringing without over-smoothing -
 * the Shake&Tune methodology, computed entirely in the browser.
 *
 * Key ideas:
 *  - a shaper's residual vibration at each frequency is the closed-form response of its impulse
 *    train against a damped oscillator; weighting that by the measured PSD gives "how much of THIS
 *    machine's ringing survives";
 *  - the true damping ratio is unknown, so residuals are evaluated across pessimistic ratios
 *    (0.075 / 0.1 / 0.15) and the worst case is used;
 *  - smoothing estimates how much the shaper rounds corners/shrinks detail, so the score
 *    `smoothing * (vibr^1.5 + vibr*0.2 + 0.01)` punishes both leftover ringing and mush;
 *  - a more complex shaper must EARN its extra smoothing/latency: it only displaces a simpler one
 *    on a clearly better score.
 */
import { SHAPERS, type ShaperDefinition, type ShaperImpulses, type ShaperName } from "./shapers";

export const DEFAULT_DAMPING_RATIO = 0.1;
export const MIN_FREQ = 5;
export const MAX_FREQ = 200;
export const MAX_SHAPER_FREQ = 150;
export const TEST_DAMPING_RATIOS = [0.075, 0.1, 0.15];
/** "Removed" means reduced 20x below the spectrum's peak. */
export const VIBRATION_REDUCTION = 20;
/** Smoothing budget (mm) used when deriving the recommended max acceleration. */
export const TARGET_SMOOTHING = 0.12;

export interface ShaperFit {
	name: ShaperName;
	/** Best target frequency for this shaper type (Hz). */
	freq: number;
	/** Worst-case fraction of vibration energy remaining (0..1). */
	vibrations: number;
	/** Estimated smoothing in mm (at the reference accel/scv). */
	smoothing: number;
	/** Combined score (lower is better). */
	score: number;
	/** Recommended acceleration ceiling (mm/s^2) to stay within the smoothing budget. */
	maxAccel: number;
	/** Worst-case shaper response per freq bin (for graphing), aligned with the fit's freqBins. */
	vals: Float64Array;
}

export interface RecommendationResult {
	/** All shaper types' best fits, in SHAPERS order. */
	allShapers: Array<ShaperFit>;
	/** The recommended one. */
	best: ShaperFit;
	/** Frequency bins the fits were evaluated on (<= maxFreq). */
	freqBins: Float64Array;
}

/** Residual vibration of a shaper at each test frequency for one assumed damping ratio. */
export function estimateShaperResponse(shaper: ShaperImpulses, dampingRatio: number, freqs: ArrayLike<number>): Float64Array {
	const A = shaper.amplitudes;
	const T = shaper.delays;
	const n = A.length;
	let sumA = 0;
	for (const a of A) {
		sumA += a;
	}
	const invD = 1 / sumA;
	const tLast = T[n - 1];
	const out = new Float64Array(freqs.length);
	for (let fi = 0; fi < freqs.length; fi++) {
		const omega = 2 * Math.PI * freqs[fi];
		const damping = dampingRatio * omega;
		const omegaD = omega * Math.sqrt(1 - dampingRatio * dampingRatio);
		let s = 0;
		let c = 0;
		for (let i = 0; i < n; i++) {
			const w = A[i] * Math.exp(-damping * (tLast - T[i]));
			s += w * Math.sin(omegaD * T[i]);
			c += w * Math.cos(omegaD * T[i]);
		}
		out[fi] = Math.sqrt(s * s + c * c) * invD;
	}
	return out;
}

/** Fraction of the PSD's significant vibration energy a shaper leaves behind. */
export function estimateRemainingVibrations(
	shaper: ShaperImpulses, dampingRatio: number, freqBins: ArrayLike<number>, psd: ArrayLike<number>,
): { remaining: number; vals: Float64Array } {
	const vals = estimateShaperResponse(shaper, dampingRatio, freqBins);
	let psdMax = 0;
	for (let i = 0; i < psd.length; i++) {
		if (psd[i] > psdMax) {
			psdMax = psd[i];
		}
	}
	const threshold = psdMax / VIBRATION_REDUCTION;
	let remaining = 0;
	let total = 0;
	for (let i = 0; i < freqBins.length; i++) {
		remaining += Math.max(vals[i] * psd[i] - threshold, 0);
		total += Math.max(psd[i] - threshold, 0);
	}
	return { remaining: total > 0 ? remaining / total : 0, vals };
}

/**
 * Smoothing (mm) a shaper introduces: worst-case position offset across a 90deg corner and a 180deg
 * reversal at the reference acceleration and "speed change" velocity.
 */
export function estimateSmoothing(shaper: ShaperImpulses, accel = 5000, scv = 5): number {
	const A = shaper.amplitudes;
	const T = shaper.delays;
	let sumA = 0;
	let ts = 0;
	for (let i = 0; i < A.length; i++) {
		sumA += A[i];
		ts += A[i] * T[i];
	}
	ts /= sumA;
	const halfAccel = accel * 0.5;
	let offset90 = 0;
	let offset180 = 0;
	for (let i = 0; i < A.length; i++) {
		const dt = T[i] - ts;
		offset90 += A[i] * (scv + halfAccel * dt) * dt;
		offset180 += A[i] * halfAccel * dt * dt;
	}
	offset90 = (Math.abs(offset90) * Math.SQRT2) / sumA;
	offset180 /= sumA;
	return Math.max(offset90, offset180);
}

/** Highest acceleration that keeps this shaper's smoothing within the budget (binary search). */
export function recommendedMaxAccel(shaper: ShaperImpulses, targetSmoothing = TARGET_SMOOTHING, scv = 5): number {
	let lo = 100;
	let hi = 100000;
	if (estimateSmoothing(shaper, hi, scv) <= targetSmoothing) {
		return hi;
	}
	if (estimateSmoothing(shaper, lo, scv) > targetSmoothing) {
		return lo;
	}
	for (let i = 0; i < 40; i++) {
		const mid = (lo + hi) / 2;
		if (estimateSmoothing(shaper, mid, scv) <= targetSmoothing) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return Math.floor(lo / 100) * 100;
}

/**
 * Normalise a PSD for shaper fitting: weight down by frequency (displacement, not acceleration,
 * is what shows on a print) and suppress the unreliable region below 2x MIN_FREQ.
 */
export function normalizeToFrequencies(freqBins: ArrayLike<number>, psd: ArrayLike<number>): Float64Array {
	const out = new Float64Array(psd.length);
	const lowFreq = 2 * MIN_FREQ;
	for (let i = 0; i < psd.length; i++) {
		out[i] = psd[i] / (freqBins[i] + 0.1);
		if (freqBins[i] < lowFreq) {
			const ratio = lowFreq / (freqBins[i] + 0.1);
			out[i] *= Math.exp(-(ratio * ratio) + 1);
		}
	}
	return out;
}

export interface FitOptions {
	dampingRatio?: number;
	testDampingRatios?: Array<number>;
	maxFreq?: number;
	maxSmoothing?: number;
	scv?: number;
}

/** Scan a frequency range for one shaper type and return its best fit. */
export function fitShaper(cfg: ShaperDefinition, freqBins: ArrayLike<number>, psd: ArrayLike<number>, options: FitOptions = {}): ShaperFit | null {
	const dampingRatio = options.dampingRatio ?? DEFAULT_DAMPING_RATIO;
	const testRatios = options.testDampingRatios ?? TEST_DAMPING_RATIOS;
	const maxFreq = options.maxFreq ?? MAX_FREQ;
	const scv = options.scv ?? 5;

	// Restrict the spectrum to the useful band.
	const bins: Array<number> = [];
	const power: Array<number> = [];
	for (let i = 0; i < freqBins.length; i++) {
		if (freqBins[i] <= maxFreq) {
			bins.push(freqBins[i]);
			power.push(psd[i]);
		}
	}

	interface Candidate { freq: number; vibrations: number; smoothing: number; score: number; vals: Float64Array }
	const candidates: Array<Candidate> = [];

	// Scan top-down so equal-vibration ties resolve to the higher (less smoothing) frequency.
	for (let f = MAX_SHAPER_FREQ; f >= cfg.minFreq; f -= 0.2) {
		const shaper = cfg.init(f, dampingRatio);
		const smoothing = estimateSmoothing(shaper, 5000, scv);
		if (options.maxSmoothing && smoothing > options.maxSmoothing && candidates.length > 0) {
			break; // smoothing only grows as frequency falls
		}
		let worst = 0;
		const vals = new Float64Array(bins.length);
		for (const ratio of testRatios) {
			const { remaining, vals: v } = estimateRemainingVibrations(shaper, ratio, bins, power);
			for (let i = 0; i < vals.length; i++) {
				if (v[i] > vals[i]) {
					vals[i] = v[i];
				}
			}
			if (remaining > worst) {
				worst = remaining;
			}
		}
		const score = smoothing * (Math.pow(worst, 1.5) + worst * 0.2 + 0.01);
		candidates.push({ freq: f, vibrations: worst, smoothing, score, vals });
	}
	if (candidates.length === 0) {
		return null;
	}

	// Among near-minimal-vibration candidates, pick the best score.
	let minVibr = Infinity;
	for (const c of candidates) {
		if (c.vibrations < minVibr) {
			minVibr = c.vibrations;
		}
	}
	let selected: Candidate | null = null;
	for (const c of candidates) {
		if (c.vibrations <= minVibr * 1.1 + 0.0005 && (selected === null || c.score < selected.score)) {
			selected = c;
		}
	}
	const s = selected!;
	return {
		name: cfg.name,
		freq: s.freq,
		vibrations: s.vibrations,
		smoothing: s.smoothing,
		score: s.score,
		maxAccel: recommendedMaxAccel(cfg.init(s.freq, dampingRatio), TARGET_SMOOTHING, scv),
		vals: s.vals,
	};
}

/** Fit every shaper type and pick the recommendation (simpler shapers win unless clearly beaten). */
export function findBestShaper(freqBins: ArrayLike<number>, psd: ArrayLike<number>, options: FitOptions = {}): RecommendationResult | null {
	const maxFreq = options.maxFreq ?? MAX_FREQ;
	const bins: Array<number> = [];
	for (let i = 0; i < freqBins.length; i++) {
		if (freqBins[i] <= maxFreq) {
			bins.push(freqBins[i]);
		}
	}

	const all: Array<ShaperFit> = [];
	let best: ShaperFit | null = null;
	for (const cfg of SHAPERS) {
		const fit = fitShaper(cfg, freqBins, psd, options);
		if (!fit) {
			continue;
		}
		all.push(fit);
		if (
			best === null
			|| fit.score * 1.2 < best.score
			|| (fit.score * 1.05 < best.score && fit.smoothing * 1.1 < best.smoothing)
		) {
			best = fit;
		}
	}
	if (!best) {
		return null;
	}
	return { allShapers: all, best, freqBins: Float64Array.from(bins) };
}
