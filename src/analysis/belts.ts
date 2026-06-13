/**
 * Belt comparison for CoreXY-style machines: excite each belt with the same diagonal sweep, then
 * compare the two spectra. Well-matched belts produce near-identical curves; a tension imbalance
 * shifts/scales one curve while keeping its shape; a mechanical fault (bad bearing, rubbing path)
 * changes the shape itself.
 */
import { parseAccelCsv, type AccelCapture } from "../capture/csv";
import { findPeaks } from "./peaks";
import { welchPsd } from "./spectrum";

export type BeltVerdict = "matched" | "tension" | "mismatch";

export interface BeltComparison {
	freqs: Float64Array;
	psdA: Float64Array;
	psdB: Float64Array;
	/** Shape similarity of the two spectra (Pearson correlation, 0..1 clamped). */
	similarity: number;
	/** Total vibration energy ratio A/B (1 = balanced; far from 1 = tension imbalance). */
	energyRatio: number;
	peakA: number;
	peakB: number;
	verdict: BeltVerdict;
}

function bandOf(capture: AccelCapture, maxFreq: number): { freqs: Float64Array; psd: Float64Array } {
	const { freqs, psdSum } = welchPsd(capture.channels, capture.samplingRate);
	let n = 0;
	while (n < freqs.length && freqs[n] <= maxFreq) {
		n++;
	}
	return { freqs: freqs.slice(0, n), psd: psdSum.slice(0, n) };
}

/** Linear resample of (xs, ys) onto the target xs grid. */
function resample(xs: Float64Array, ys: Float64Array, target: Float64Array): Float64Array {
	const out = new Float64Array(target.length);
	let j = 0;
	for (let i = 0; i < target.length; i++) {
		const x = target[i];
		while (j < xs.length - 2 && xs[j + 1] < x) {
			j++;
		}
		const x0 = xs[j];
		const x1 = xs[j + 1] ?? x0;
		const t = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0;
		out[i] = ys[j] + t * ((ys[j + 1] ?? ys[j]) - ys[j]);
	}
	return out;
}

export function compareBelts(a: AccelCapture, b: AccelCapture, maxFreq = 200): BeltComparison {
	const A = bandOf(a, maxFreq);
	const Braw = bandOf(b, maxFreq);
	const psdB = a.samplingRate === b.samplingRate ? Braw.psd : resample(Braw.freqs, Braw.psd, A.freqs);

	// Pearson correlation = shape similarity independent of overall amplitude.
	const n = Math.min(A.psd.length, psdB.length);
	let ma = 0;
	let mb = 0;
	for (let i = 0; i < n; i++) {
		ma += A.psd[i];
		mb += psdB[i];
	}
	ma /= n;
	mb /= n;
	let cov = 0;
	let va = 0;
	let vb = 0;
	for (let i = 0; i < n; i++) {
		const da = A.psd[i] - ma;
		const db = psdB[i] - mb;
		cov += da * db;
		va += da * da;
		vb += db * db;
	}
	const similarity = va > 0 && vb > 0 ? Math.max(0, cov / Math.sqrt(va * vb)) : 0;
	const energyRatio = mb > 0 ? ma / mb : 1;

	const peaksA = findPeaks(A.freqs, A.psd);
	const peaksB = findPeaks(A.freqs, psdB);
	const peakA = peaksA[0]?.freq ?? 0;
	const peakB = peaksB[0]?.freq ?? 0;

	// A high shape correlation already implies the peaks line up; an extra single-dominant-peak
	// proximity gate is brittle on multi-peak plateaus (the two belts can pick different sub-peaks
	// of the same shared ridge) and would wrongly demote a clearly-matched pair to "tension".
	const balanced = energyRatio >= 0.7 && energyRatio <= 1.4;
	const verdict: BeltVerdict = similarity >= 0.8 && balanced
		? "matched"
		: similarity >= 0.6
			? "tension"
			: "mismatch";

	return { freqs: A.freqs, psdA: A.psd, psdB, similarity, energyRatio, peakA, peakB, verdict };
}

/** Convenience: compare straight from two capture CSV texts. */
export function compareBeltCsvs(csvA: string, csvB: string, maxFreq = 200): BeltComparison {
	return compareBelts(parseAccelCsv(csvA), parseAccelCsv(csvB), maxFreq);
}
