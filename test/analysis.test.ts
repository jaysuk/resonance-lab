import { describe, expect, it } from "vitest";

import { fftInPlace, rfft } from "../src/analysis/fft";
import { findPeaks } from "../src/analysis/peaks";
import {
	estimateRemainingVibrations, estimateShaperResponse, estimateSmoothing, findBestShaper,
	findBestShaperCombined, fitShaper, normalizeToFrequencies,
} from "../src/analysis/recommend";
import { SHAPERS } from "../src/analysis/shapers";
import { kaiserWindow, welchPsd, welchSegmentLength } from "../src/analysis/spectrum";

// ─── FFT ──────────────────────────────────────────────────────────────────────

describe("fft", () => {
	it("transforms a pure tone into a single bin", () => {
		const n = 256;
		const signal = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			signal[i] = Math.sin((2 * Math.PI * 16 * i) / n); // bin 16 exactly
		}
		const { re, im } = rfft(signal, n);
		const mags = Array.from({ length: n / 2 + 1 }, (_, i) => Math.hypot(re[i], im[i]));
		const top = mags.indexOf(Math.max(...mags));
		expect(top).toBe(16);
		expect(mags[16]).toBeCloseTo(n / 2, 6); // sine amplitude 1 -> n/2 magnitude
		expect(mags[20]).toBeLessThan(1e-9);
	});

	it("rejects non-power-of-two lengths", () => {
		expect(() => fftInPlace(new Float64Array(100), new Float64Array(100))).toThrow();
	});
});

// ─── Welch PSD ────────────────────────────────────────────────────────────────

describe("welchPsd", () => {
	it("sizes segments to ~0.5 s rounded up to a power of two", () => {
		expect(welchSegmentLength(1000)).toBe(512);
		expect(welchSegmentLength(3200)).toBe(2048);
	});

	it("kaiser window is symmetric with peak 1 at the centre", () => {
		const w = kaiserWindow(101, 6);
		expect(w[50]).toBeCloseTo(1, 12);
		expect(w[10]).toBeCloseTo(w[90], 12);
		expect(w[0]).toBeLessThan(0.02);
	});

	it("locates an injected resonance and sums channels", () => {
		const fs = 1000;
		const n = 8000;
		const x = new Float64Array(n);
		const y = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			const t = i / fs;
			x[i] = 3 * Math.sin(2 * Math.PI * 45 * t) + 0.2 * Math.sin(2 * Math.PI * 200 * t);
			y[i] = 1.5 * Math.sin(2 * Math.PI * 45 * t);
		}
		const { freqs, psd, psdSum } = welchPsd([x, y], fs);
		const peakAt = (arr: Float64Array) => freqs[arr.indexOf(Math.max(...Array.from(arr)))];
		expect(peakAt(psd[0])).toBeCloseTo(45, 0);
		expect(peakAt(psd[1])).toBeCloseTo(45, 0);
		// Sum really is the per-bin sum.
		const k = 100;
		expect(psdSum[k]).toBeCloseTo(psd[0][k] + psd[1][k], 12);
	});
});

// ─── Shapers ──────────────────────────────────────────────────────────────────

describe("shapers", () => {
	it("every shaper's impulses are positive, start at t=0 and (for the EI family) sum to 1", () => {
		for (const cfg of SHAPERS) {
			const s = cfg.init(50, 0.1);
			expect(s.delays[0]).toBe(0);
			expect(s.amplitudes.length).toBe(s.delays.length);
			for (let i = 1; i < s.delays.length; i++) {
				expect(s.delays[i]).toBeGreaterThan(s.delays[i - 1]);
			}
			for (const a of s.amplitudes) {
				expect(a).toBeGreaterThan(0);
			}
		}
		const sum = (n: string) => SHAPERS.find((c) => c.name === n)!.init(50, 0.1).amplitudes.reduce((a, b) => a + b, 0);
		expect(sum("ei2")).toBeCloseTo(1, 12);
		expect(sum("ei3")).toBeCloseTo(1, 12);
	});

	it("suppresses vibration at the tuned frequency", () => {
		for (const cfg of SHAPERS) {
			const s = cfg.init(50, 0.1);
			const [atTuned] = estimateShaperResponse(s, 0.1, [50]);
			expect(atTuned).toBeLessThan(0.06); // >94% reduction at the resonance it targets
			const [farBelow] = estimateShaperResponse(s, 0.1, [8]);
			expect(farBelow).toBeGreaterThan(atTuned); // low frequencies pass through
		}
	});
});

// ─── Recommendation engine ────────────────────────────────────────────────────

/** Synthetic single-resonance PSD (Lorentzian) on a 0..200 Hz grid. */
function syntheticPsd(f0: number, zeta = 0.06): { freqs: Float64Array; psd: Float64Array } {
	const n = 400;
	const freqs = new Float64Array(n);
	const psd = new Float64Array(n);
	const gamma = zeta * f0; // half-width
	for (let i = 0; i < n; i++) {
		const f = (i * 200) / n;
		freqs[i] = f;
		psd[i] = 1 / (Math.pow(f - f0, 2) + gamma * gamma);
	}
	return { freqs, psd };
}

describe("recommendation engine", () => {
	it("smoothing grows as shaper frequency falls, and EI3 smooths more than MZV", () => {
		const mzv = SHAPERS.find((c) => c.name === "mzv")!;
		expect(estimateSmoothing(mzv.init(30, 0.1))).toBeGreaterThan(estimateSmoothing(mzv.init(60, 0.1)));
		const ei3 = SHAPERS.find((c) => c.name === "ei3")!;
		expect(estimateSmoothing(ei3.init(50, 0.1))).toBeGreaterThan(estimateSmoothing(mzv.init(50, 0.1)));
	});

	it("fitShaper homes in on the resonance frequency", () => {
		const { freqs, psd } = syntheticPsd(52);
		const norm = normalizeToFrequencies(freqs, psd);
		const fit = fitShaper(SHAPERS.find((c) => c.name === "mzv")!, freqs, norm)!;
		expect(Math.abs(fit.freq - 52)).toBeLessThan(6);
		expect(fit.vibrations).toBeLessThan(0.25);
	});

	it("findBestShaper returns a verdict that beats doing nothing, preferring simpler shapers", () => {
		const { freqs, psd } = syntheticPsd(45);
		const norm = normalizeToFrequencies(freqs, psd);
		const rec = findBestShaper(freqs, norm)!;
		expect(rec.allShapers.length).toBe(SHAPERS.length);
		expect(rec.best.vibrations).toBeLessThan(0.3);
		// With a clean single resonance, a heavy 3-hump EI must not displace simpler shapers.
		expect(rec.best.name).not.toBe("ei3");
	});

	// Locks in the exact selection for a reference spectrum so removing the user-facing
	// maxAccel/maxSmoothing fields (which never touched the score itself) can't silently
	// change which shaper/frequency the engine actually recommends.
	it("selection for a reference spectrum is stable (no maxAccel/maxSmoothing left to influence it)", () => {
		const { freqs, psd } = syntheticPsd(45);
		const norm = normalizeToFrequencies(freqs, psd);
		const rec = findBestShaper(freqs, norm)!;
		expect(rec.best.name).toBe("mzv");
		expect(rec.best.freq).toBeCloseTo(46.8, 1);
	});

	it("estimateRemainingVibrations is ~1 for a no-op shaper and small for a tuned one", () => {
		const { freqs, psd } = syntheticPsd(50);
		const noop = { amplitudes: [1], delays: [0] };
		expect(estimateRemainingVibrations(noop, 0.1, Array.from(freqs), Array.from(psd)).remaining).toBeCloseTo(1, 5);
		const tuned = SHAPERS.find((c) => c.name === "zvdd")!.init(50, 0.1);
		expect(estimateRemainingVibrations(tuned, 0.1, Array.from(freqs), Array.from(psd)).remaining).toBeLessThan(0.12);
	});

	it("normalizeToFrequencies divides by frequency and suppresses the low band", () => {
		const freqs = [1, 5, 50];
		const psd = [10, 10, 10];
		const out = normalizeToFrequencies(freqs, psd);
		expect(out[2]).toBeCloseTo(10 / 50.1, 9);
		expect(out[0]).toBeLessThan(out[2]); // hard-suppressed below 10 Hz
	});
});

// ─── Combined multi-axis recommendation ──────────────────────────────────────

describe("findBestShaperCombined", () => {
	// findBestShaperCombined's per-shaper frequency scan runs once per axis passed in, so these are
	// noticeably heavier than a single-axis findBestShaper call - under load the default 5000ms
	// vitest timeout has been flaky here (observed 5.3-7.3s), so give these an explicit margin rather
	// than relying on machine load being light every run.
	it("agrees with the single-axis best when both axes share the same resonance", () => {
		const { freqs, psd } = syntheticPsd(45);
		const norm = normalizeToFrequencies(freqs, psd);
		const single = findBestShaper(freqs, norm)!;
		const combined = findBestShaperCombined([
			{ axis: "X", freqBins: freqs, psd: norm },
			{ axis: "Y", freqBins: freqs, psd: norm },
		])!;
		expect(combined.best.name).toBe(single.best.name);
		expect(combined.best.freq).toBeCloseTo(single.best.freq, 0);
	}, 20000);

	it("leaves low residual vibration on both axes when they resonate at different frequencies", () => {
		const x = syntheticPsd(40);
		const y = syntheticPsd(55);
		const combined = findBestShaperCombined([
			{ axis: "X", freqBins: x.freqs, psd: normalizeToFrequencies(x.freqs, x.psd) },
			{ axis: "Y", freqBins: y.freqs, psd: normalizeToFrequencies(y.freqs, y.psd) },
		])!;
		expect(combined.best.perAxis.length).toBe(2);
		for (const p of combined.best.perAxis) {
			expect(p.vibrations).toBeLessThan(0.4);
		}
		// The reported combined vibration is the worst of the two axes.
		const maxPerAxis = Math.max(...combined.best.perAxis.map((p) => p.vibrations));
		expect(combined.best.vibrations).toBeCloseTo(maxPerAxis, 9);
	}, 20000);

	// Quiet (no-peak) axes are filtered out by the caller before calling this engine (see
	// ResonanceLabPage.vue's combinedSpectra) - a flat spectrum is still nonzero broadband "noise"
	// the engine has no special-case for, so passing just the surviving axis must match findBestShaper.
	it("with a single surviving axis, matches the single-axis recommendation", () => {
		const peaked = syntheticPsd(50);
		const norm = normalizeToFrequencies(peaked.freqs, peaked.psd);
		const combined = findBestShaperCombined([{ axis: "X", freqBins: peaked.freqs, psd: norm }])!;
		const single = findBestShaper(peaked.freqs, norm)!;
		expect(combined.best.name).toBe(single.best.name);
		expect(combined.best.freq).toBeCloseTo(single.best.freq, 0);
	}, 20000);

	it("handles axes with different-length frequency grids without crashing", () => {
		const a = syntheticPsd(40);
		const bFreqs = a.freqs.slice(0, 250); // shorter grid, same spacing
		const bPsd = a.psd.slice(0, 250);
		const combined = findBestShaperCombined([
			{ axis: "X", freqBins: a.freqs, psd: normalizeToFrequencies(a.freqs, a.psd) },
			{ axis: "Y", freqBins: bFreqs, psd: normalizeToFrequencies(bFreqs, bPsd) },
		]);
		expect(combined).not.toBeNull();
		expect(combined!.best.vibrations).toBeLessThan(1);
	});

	it("returns null for an empty axis list", () => {
		expect(findBestShaperCombined([])).toBeNull();
	});
});

// ─── Peaks & damping ──────────────────────────────────────────────────────────

describe("peaks", () => {
	it("finds the resonance and estimates its damping ratio from the half-power width", () => {
		const { freqs, psd } = syntheticPsd(60, 0.05);
		const peaks = findPeaks(freqs, psd);
		expect(peaks.length).toBeGreaterThan(0);
		expect(peaks[0].freq).toBeCloseTo(60, 0);
		// Lorentzian half-power full width = 2*gamma = 2*zeta*f0 -> zeta estimate ~= 0.05.
		expect(peaks[0].dampingRatio).toBeDefined();
		expect(peaks[0].dampingRatio!).toBeGreaterThan(0.02);
		expect(peaks[0].dampingRatio!).toBeLessThan(0.1);
	});

	it("separates two distinct resonances", () => {
		const a = syntheticPsd(40, 0.04);
		const b = syntheticPsd(95, 0.04);
		const psd = a.psd.map((v, i) => v + 0.6 * b.psd[i]);
		const peaks = findPeaks(a.freqs, psd, 0.05, 5);
		const freqsFound = peaks.slice(0, 2).map((p) => Math.round(p.freq)).sort((x, y) => x - y);
		expect(Math.abs(freqsFound[0] - 40)).toBeLessThanOrEqual(1);
		expect(Math.abs(freqsFound[1] - 95)).toBeLessThanOrEqual(1);
	});
});
