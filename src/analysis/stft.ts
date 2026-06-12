/**
 * Short-time Fourier transform for the spectrogram view: how the spectrum evolves over the test.
 * On a swept excitation the resonance lights up when the sweep crosses it, which separates true
 * machine resonances (horizontal lines) from excitation-following noise (the moving diagonal).
 */
import { rfft } from "./fft";
import { kaiserWindow } from "./spectrum";

export interface Spectrogram {
	/** Time of each column (s). */
	times: Array<number>;
	/** Frequency of each row (Hz), low to high, capped at maxFreq. */
	freqs: Array<number>;
	/** Column-major magnitudes normalised 0..1 (log-compressed). columns[t][f]. */
	columns: Array<Float64Array>;
}

export function computeSpectrogram(channel: ArrayLike<number>, sampleRate: number, maxFreq = 200, nfft = 256, hop = 128): Spectrogram {
	const window = kaiserWindow(nfft, 6);
	const half = nfft / 2 + 1;
	let rows = 0;
	while (rows < half && (rows * sampleRate) / nfft <= maxFreq) {
		rows++;
	}
	const freqs = Array.from({ length: rows }, (_, i) => (i * sampleRate) / nfft);
	const times: Array<number> = [];
	const columns: Array<Float64Array> = [];
	const seg = new Float64Array(nfft);
	let max = 0;
	for (let off = 0; off + nfft <= channel.length; off += hop) {
		let mean = 0;
		for (let i = 0; i < nfft; i++) {
			mean += channel[off + i];
		}
		mean /= nfft;
		for (let i = 0; i < nfft; i++) {
			seg[i] = (channel[off + i] - mean) * window[i];
		}
		const { re, im } = rfft(seg, nfft);
		const col = new Float64Array(rows);
		for (let i = 0; i < rows; i++) {
			const m = Math.log10(1 + Math.hypot(re[i], im[i]));
			col[i] = m;
			if (m > max) {
				max = m;
			}
		}
		columns.push(col);
		times.push((off + nfft / 2) / sampleRate);
	}
	if (max > 0) {
		for (const col of columns) {
			for (let i = 0; i < col.length; i++) {
				col[i] /= max;
			}
		}
	}
	return { times, freqs, columns };
}
