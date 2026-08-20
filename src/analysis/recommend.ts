/**
 * The tuning engine: given a measured vibration spectrum (PSD), evaluate every RRF shaper across a
 * frequency scan and recommend the configuration that best removes ringing without over-smoothing,
 * computed entirely in the browser.
 *
 * Key ideas:
 *  - a shaper's residual vibration at each frequency is the closed-form response of its impulse
 *    train against a damped oscillator; weighting that by the measured PSD gives "how much of THIS
 *    machine's ringing survives";
 *  - the true damping ratio is unknown, so residuals are evaluated across pessimistic ratios
 *    (0.075 / 0.1 / 0.15) and the worst case is used;
 *  - `smoothing` is an internal relative penalty for long impulse trains (RRF really does convolve
 *    delayed copies of a move, so more/later impulses genuinely round corners more) used only to
 *    break ties in `score`; it is not calibrated to RRF's jerk-based planner and must never be shown
 *    to the user as a millimetre figure or turned into an acceleration recommendation;
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

export interface ShaperFit {
	name: ShaperName;
	/** Best target frequency for this shaper type (Hz). */
	freq: number;
	/** The damping ratio (M593 S) the impulse train was actually built with - `options.dampingRatio`
	 *  when given (e.g. a measured zeta), else `DEFAULT_DAMPING_RATIO`. This is what RRF needs to
	 *  reproduce the same shaper, not just a score input - surfaced so "Apply"/"Save to config.g"
	 *  can send a complete M593 line instead of leaving S to RRF's own firmware default. */
	dampingRatio: number;
	/** Worst-case fraction of vibration energy remaining (0..1). */
	vibrations: number;
	/** Internal relative smoothing penalty (tie-breaker only - see file header). Not user-facing. */
	smoothing: number;
	/** Combined score (lower is better). */
	score: number;
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
	/** Lower bound of the band the fit is scored against (Hz). Default: 0 (no floor). */
	minFreq?: number;
	maxFreq?: number;
	scv?: number;
}

/** Scan a frequency range for one shaper type and return its best fit. */
export function fitShaper(cfg: ShaperDefinition, freqBins: ArrayLike<number>, psd: ArrayLike<number>, options: FitOptions = {}): ShaperFit | null {
	const dampingRatio = options.dampingRatio ?? DEFAULT_DAMPING_RATIO;
	const testRatios = options.testDampingRatios ?? TEST_DAMPING_RATIOS;
	const minFreq = options.minFreq ?? 0;
	const maxFreq = options.maxFreq ?? MAX_FREQ;
	const scv = options.scv ?? 5;

	// Restrict the spectrum to the useful band.
	const bins: Array<number> = [];
	const power: Array<number> = [];
	for (let i = 0; i < freqBins.length; i++) {
		if (freqBins[i] >= minFreq && freqBins[i] <= maxFreq) {
			bins.push(freqBins[i]);
			power.push(psd[i]);
		}
	}

	interface Candidate { freq: number; vibrations: number; smoothing: number; score: number; vals: Float64Array }
	const candidates: Array<Candidate> = [];

	// Scan top-down so equal-vibration ties resolve to the higher (less smoothing) frequency. Capped
	// to the tested band too - recommending a frequency the sweep never actually excited would be
	// extrapolating beyond measured data.
	for (let f = Math.min(MAX_SHAPER_FREQ, maxFreq); f >= Math.max(cfg.minFreq, minFreq); f -= 0.2) {
		const shaper = cfg.init(f, dampingRatio);
		const smoothing = estimateSmoothing(shaper, 5000, scv);
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
		dampingRatio,
		vibrations: s.vibrations,
		smoothing: s.smoothing,
		score: s.score,
		vals: s.vals,
	};
}

/** Fit every shaper type and pick the recommendation (simpler shapers win unless clearly beaten). */
export function findBestShaper(freqBins: ArrayLike<number>, psd: ArrayLike<number>, options: FitOptions = {}): RecommendationResult | null {
	const minFreq = options.minFreq ?? 0;
	const maxFreq = options.maxFreq ?? MAX_FREQ;
	const bins: Array<number> = [];
	for (let i = 0; i < freqBins.length; i++) {
		if (freqBins[i] >= minFreq && freqBins[i] <= maxFreq) {
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

/** One axis's normalised spectrum to feed into `findBestShaperCombined`. */
export interface AxisSpectrum {
	axis: string;
	freqBins: ArrayLike<number>;
	psd: ArrayLike<number>;
}

export interface CombinedShaperFit extends ShaperFit {
	/** Worst-case remaining vibration per input axis at the chosen freq (same order as `spectra`). */
	perAxis: Array<{ axis: string; vibrations: number }>;
}

export interface CombinedRecommendationResult {
	/** All shaper types' best combined fits, in SHAPERS order. */
	allShapers: Array<CombinedShaperFit>;
	/** The recommended one. */
	best: CombinedShaperFit;
}

/**
 * Scan a frequency range for one shaper type against several axes' spectra at once. Each axis keeps
 * its own frequency bins (no resampling needed - `estimateRemainingVibrations` takes bins per call),
 * and at each candidate frequency the worst axis (and worst test damping ratio) governs, since RRF
 * applies one M593 shaper machine-wide (see findBestShaper's header note).
 */
function fitShaperCombined(cfg: ShaperDefinition, spectra: Array<AxisSpectrum>, options: FitOptions = {}): CombinedShaperFit | null {
	const dampingRatio = options.dampingRatio ?? DEFAULT_DAMPING_RATIO;
	const testRatios = options.testDampingRatios ?? TEST_DAMPING_RATIOS;
	const minFreq = options.minFreq ?? 0;
	const maxFreq = options.maxFreq ?? MAX_FREQ;
	const scv = options.scv ?? 5;

	// Restrict each axis's spectrum to the useful band; each axis keeps its own bins.
	const bands = spectra.map((s) => {
		const bins: Array<number> = [];
		const power: Array<number> = [];
		for (let i = 0; i < s.freqBins.length; i++) {
			if (s.freqBins[i] >= minFreq && s.freqBins[i] <= maxFreq) {
				bins.push(s.freqBins[i]);
				power.push(s.psd[i]);
			}
		}
		return { axis: s.axis, bins, power };
	});

	interface Candidate {
		freq: number; vibrations: number; smoothing: number; score: number;
		perAxis: Array<{ axis: string; vibrations: number }>;
	}
	const candidates: Array<Candidate> = [];

	// Capped to the tested band, same reasoning as fitShaper: don't recommend a frequency the sweep
	// never actually excited.
	for (let f = Math.min(MAX_SHAPER_FREQ, maxFreq); f >= Math.max(cfg.minFreq, minFreq); f -= 0.2) {
		const shaper = cfg.init(f, dampingRatio);
		const smoothing = estimateSmoothing(shaper, 5000, scv);
		let worst = 0;
		const perAxis: Array<{ axis: string; vibrations: number }> = [];
		for (const band of bands) {
			let axisWorst = 0;
			for (const ratio of testRatios) {
				const { remaining } = estimateRemainingVibrations(shaper, ratio, band.bins, band.power);
				if (remaining > axisWorst) {
					axisWorst = remaining;
				}
			}
			perAxis.push({ axis: band.axis, vibrations: axisWorst });
			if (axisWorst > worst) {
				worst = axisWorst;
			}
		}
		const score = smoothing * (Math.pow(worst, 1.5) + worst * 0.2 + 0.01);
		candidates.push({ freq: f, vibrations: worst, smoothing, score, perAxis });
	}
	if (candidates.length === 0) {
		return null;
	}

	// Among near-minimal-vibration candidates (worst axis), pick the best score.
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
		dampingRatio,
		vibrations: s.vibrations,
		smoothing: s.smoothing,
		score: s.score,
		vals: new Float64Array(0), // no combined response curve is drawn; single-axis Inspect has it
		perAxis: s.perAxis,
	};
}

/**
 * Fit every shaper type against several axes' spectra at once and recommend the one that best
 * serves all of them (worst axis governs). RRF's M593 shaper applies to every axis, so when a
 * multi-axis sweep finds different resonances per axis, this is the single recommendation to
 * apply rather than picking one axis's own best and ignoring the rest.
 */
export function findBestShaperCombined(spectra: Array<AxisSpectrum>, options: FitOptions = {}): CombinedRecommendationResult | null {
	if (spectra.length === 0) {
		return null;
	}
	const all: Array<CombinedShaperFit> = [];
	let best: CombinedShaperFit | null = null;
	for (const cfg of SHAPERS) {
		const fit = fitShaperCombined(cfg, spectra, options);
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
	return { allShapers: all, best };
}
