/**
 * Resonance peak detection and damping-ratio estimation from a PSD - used for display ("your X
 * axis rings at 42.5 Hz"), for refining recommendations, and later for belt comparison and
 * fixed-frequency excitation analysis.
 */

export interface ResonancePeak {
	/** Peak frequency (Hz). */
	freq: number;
	/** PSD value at the peak. */
	power: number;
	/** Relative height vs the spectrum's maximum (0..1). */
	relative: number;
	/** Damping ratio estimated from the half-power bandwidth, if resolvable. */
	dampingRatio?: number;
}

/**
 * Find significant local maxima: above `threshold` x the global max, separated by at least
 * `minSeparationHz`. Returns peaks sorted by power, strongest first.
 */
export function findPeaks(freqs: ArrayLike<number>, psd: ArrayLike<number>, threshold = 0.05, minSeparationHz = 3): Array<ResonancePeak> {
	const n = psd.length;
	let max = 0;
	for (let i = 0; i < n; i++) {
		if (psd[i] > max) {
			max = psd[i];
		}
	}
	if (max <= 0) {
		return [];
	}
	const floor = max * threshold;
	const peaks: Array<ResonancePeak> = [];
	for (let i = 1; i < n - 1; i++) {
		if (psd[i] >= floor && psd[i] > psd[i - 1] && psd[i] >= psd[i + 1]) {
			peaks.push({ freq: freqs[i], power: psd[i], relative: psd[i] / max, dampingRatio: estimateDampingAt(freqs, psd, i) });
		}
	}
	peaks.sort((a, b) => b.power - a.power);
	// Enforce separation, keeping the strongest of each cluster.
	const kept: Array<ResonancePeak> = [];
	for (const p of peaks) {
		if (kept.every((k) => Math.abs(k.freq - p.freq) >= minSeparationHz)) {
			kept.push(p);
		}
	}
	return kept;
}

/**
 * Half-power-bandwidth damping estimate at a peak: zeta ~= (f2 - f1) / (2 * f0), where f1/f2 are
 * where the PSD falls to half the peak power on each side. Returns undefined when the bandwidth
 * isn't resolvable (peak at the spectrum edge or overlapping a neighbour).
 */
export function estimateDampingAt(freqs: ArrayLike<number>, psd: ArrayLike<number>, peakIndex: number): number | undefined {
	const half = psd[peakIndex] / 2;
	let f1: number | undefined;
	let f2: number | undefined;
	for (let i = peakIndex; i > 0; i--) {
		if (psd[i - 1] > psd[peakIndex]) {
			return undefined; // ran into a bigger neighbour before dropping to half power
		}
		if (psd[i] >= half && psd[i - 1] < half) {
			// Linear interpolation between the bins straddling the half-power level.
			const t = (half - psd[i - 1]) / (psd[i] - psd[i - 1]);
			f1 = freqs[i - 1] + t * (freqs[i] - freqs[i - 1]);
			break;
		}
	}
	for (let i = peakIndex; i < psd.length - 1; i++) {
		if (psd[i + 1] > psd[peakIndex]) {
			return undefined;
		}
		if (psd[i] >= half && psd[i + 1] < half) {
			const t = (psd[i] - half) / (psd[i] - psd[i + 1]);
			f2 = freqs[i] + t * (freqs[i + 1] - freqs[i]);
			break;
		}
	}
	if (f1 === undefined || f2 === undefined) {
		return undefined;
	}
	const zeta = (f2 - f1) / (2 * freqs[peakIndex]);
	return zeta > 0 && zeta < 1 ? zeta : undefined;
}
