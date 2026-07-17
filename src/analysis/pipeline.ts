/**
 * One call from raw capture to verdict: parse -> PSD -> normalise -> peaks -> shaper
 * recommendation. This is the seam the UI consumes; everything below it is pure and tested.
 */
import { type AccelCapture } from "../capture/csv";
import { findPeaks, type ResonancePeak } from "./peaks";
import { findBestShaper, MAX_FREQ, normalizeToFrequencies, TEST_DAMPING_RATIOS, type RecommendationResult } from "./recommend";
import { welchPsd, type PsdResult } from "./spectrum";

export interface CaptureAnalysis {
	/** Raw spectral estimate (per channel + sum). */
	spectrum: PsdResult;
	/** Frequency-normalised sum PSD the recommendation ran on. */
	normalized: Float64Array;
	/** Significant resonance peaks, strongest first (with damping estimates where resolvable). */
	peaks: Array<ResonancePeak>;
	/** Shaper recommendation, or null when the spectrum is empty/flat. */
	recommendation: RecommendationResult | null;
	/** Echo of capture health for the UI. */
	samplingRate: number;
	overflows: number;
	sampleCount: number;
}

export interface AnalyseOptions {
	/** Lower bound of the band peaks/fitting consider (Hz). Default: 0 (no floor). */
	minFreq?: number;
	maxFreq?: number;
	dampingRatio?: number;
	scv?: number;
}

export function analyseCapture(capture: AccelCapture, options: AnalyseOptions = {}): CaptureAnalysis {
	const spectrum = welchPsd(capture.channels, capture.samplingRate);
	const normalized = normalizeToFrequencies(spectrum.freqs, spectrum.psdSum);
	const minFreq = options.minFreq ?? 0;
	const maxFreq = options.maxFreq ?? MAX_FREQ;

	// Peaks are reported on the normalised curve restricted to the useful band. Peak detection is
	// relative to the curve's maximum, so a silent capture (FFT rounding dust ~1e-29) would still
	// "find" peaks - an absolute floor far below any real accelerometer noise filters that out.
	const SILENCE_FLOOR = 1e-12;
	const bandFreqs: Array<number> = [];
	const bandPsd: Array<number> = [];
	let bandMax = 0;
	for (let i = 0; i < spectrum.freqs.length; i++) {
		if (spectrum.freqs[i] >= minFreq && spectrum.freqs[i] <= maxFreq) {
			bandFreqs.push(spectrum.freqs[i]);
			bandPsd.push(normalized[i]);
			if (normalized[i] > bandMax) {
				bandMax = normalized[i];
			}
		}
	}
	const peaks = bandMax > SILENCE_FLOOR ? findPeaks(bandFreqs, bandPsd) : [];

	// Feed the measured damping ratio of the dominant resonance into the fit when it resolved -
	// a machine-specific ratio beats the generic default for shaper frequency selection, and is
	// also added to the worst-case test set so the fit's residual-vibration figure covers the
	// machine's actual ζ, not just the generic pessimistic bracket.
	const measuredZeta = peaks[0]?.dampingRatio;
	const zetaValid = measuredZeta !== undefined && measuredZeta >= 0.02 && measuredZeta <= 0.3;
	const recommendation = peaks.length > 0
		? findBestShaper(spectrum.freqs, normalized, {
			...options,
			dampingRatio: options.dampingRatio ?? (zetaValid ? measuredZeta : undefined),
			testDampingRatios: zetaValid ? Array.from(new Set([...TEST_DAMPING_RATIOS, measuredZeta])) : undefined,
		})
		: null;

	return {
		spectrum,
		normalized,
		peaks,
		recommendation,
		samplingRate: capture.samplingRate,
		overflows: capture.overflows,
		sampleCount: capture.channels[0]?.length ?? 0,
	};
}
