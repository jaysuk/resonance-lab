/**
 * Welch power-spectral-density estimation for accelerometer samples, matching the parameters the
 * input-shaping literature settled on for resonance tuning: ~0.5 s segments (rounded up to a power
 * of two), Kaiser(beta=6) window, 50% overlap, per-segment mean detrend, one-sided scaling.
 * Pure functions, no Vue - unit-testable in isolation and cheap enough to run on the UI thread for
 * typical captures (a Web Worker wrapper can come later for very long recordings).
 */
import { rfft } from "./fft";

export interface PsdResult {
	/** Frequency bins (Hz), 0..fs/2. */
	freqs: Float64Array;
	/** One PSD per input channel, same length as freqs. */
	psd: Array<Float64Array>;
	/** Sum across channels (the "total vibration" curve recommendations run on). */
	psdSum: Float64Array;
}

/** Modified Bessel function of the first kind, order 0 (series expansion; converges fast). */
function besselI0(x: number): number {
	let sum = 1;
	let term = 1;
	const halfX = x / 2;
	for (let k = 1; k < 50; k++) {
		term *= (halfX / k) * (halfX / k);
		sum += term;
		if (term < sum * 1e-16) {
			break;
		}
	}
	return sum;
}

/** Kaiser window of length n with shape parameter beta. */
export function kaiserWindow(n: number, beta: number): Float64Array {
	const w = new Float64Array(n);
	const denom = besselI0(beta);
	const m = n - 1;
	for (let i = 0; i < n; i++) {
		const r = (2 * i) / m - 1;
		w[i] = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom;
	}
	return w;
}

/** Segment length: the power of two covering ~windowTSec seconds of samples. */
export function welchSegmentLength(sampleRate: number, windowTSec = 0.5): number {
	const target = Math.max(2, Math.floor(sampleRate * windowTSec - 1));
	// Next power of two >= target+? : 1 << bitLength(target)
	return 1 << (32 - Math.clz32(target));
}

/**
 * Welch PSD of one or more equally-long channels sampled at sampleRate. Channels shorter than one
 * segment are zero-padded into a single segment (low-resolution but defined behaviour for very
 * short captures - callers should warn the user).
 */
export function welchPsd(channels: Array<ArrayLike<number>>, sampleRate: number, windowTSec = 0.5): PsdResult {
	if (channels.length === 0) {
		throw new Error("welchPsd needs at least one channel");
	}
	const nfft = welchSegmentLength(sampleRate, windowTSec);
	const window = kaiserWindow(nfft, 6);
	let windowSq = 0;
	for (let i = 0; i < nfft; i++) {
		windowSq += window[i] * window[i];
	}
	const scale = 1 / (windowSq * sampleRate);
	const step = nfft / 2; // 50% overlap

	const half = nfft / 2 + 1;
	const psd = channels.map(() => new Float64Array(half));

	for (let c = 0; c < channels.length; c++) {
		const data = channels[c];
		const segments = Math.max(1, Math.floor((data.length - nfft) / step) + 1);
		const seg = new Float64Array(nfft);
		for (let s = 0; s < segments; s++) {
			const off = s * step;
			// Mean detrend within the segment, then window. Missing samples (short capture) stay 0.
			let mean = 0;
			let count = 0;
			for (let i = 0; i < nfft; i++) {
				const v = off + i < data.length ? data[off + i] : 0;
				seg[i] = v;
				mean += v;
				count++;
			}
			mean /= count;
			for (let i = 0; i < nfft; i++) {
				seg[i] = (seg[i] - mean) * window[i];
			}
			const { re, im } = rfft(seg, nfft);
			const acc = psd[c];
			for (let i = 0; i < half; i++) {
				acc[i] += (re[i] * re[i] + im[i] * im[i]) * scale;
			}
		}
		// One-sided spectrum: double everything except DC and Nyquist, then average the segments.
		const acc = psd[c];
		for (let i = 1; i < half - 1; i++) {
			acc[i] *= 2;
		}
		for (let i = 0; i < half; i++) {
			acc[i] /= segments;
		}
	}

	const freqs = new Float64Array(half);
	for (let i = 0; i < half; i++) {
		freqs[i] = (i * sampleRate) / nfft;
	}
	const psdSum = new Float64Array(half);
	for (const ch of psd) {
		for (let i = 0; i < half; i++) {
			psdSum[i] += ch[i];
		}
	}
	return { freqs, psd, psdSum };
}
