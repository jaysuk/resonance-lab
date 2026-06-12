/**
 * Minimal iterative radix-2 FFT - just enough for Welch PSD estimation. Input length must be a
 * power of two (spectrum.ts guarantees that by construction of the window size).
 */

/** In-place complex FFT (decimation in time). re/im are modified. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	if (n < 2 || (n & (n - 1)) !== 0) {
		throw new Error(`FFT length must be a power of two (got ${n})`);
	}

	// Bit-reversal permutation.
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) {
			j ^= bit;
		}
		j ^= bit;
		if (i < j) {
			let t = re[i]; re[i] = re[j]; re[j] = t;
			t = im[i]; im[i] = im[j]; im[j] = t;
		}
	}

	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len;
		const wRe = Math.cos(ang);
		const wIm = Math.sin(ang);
		for (let i = 0; i < n; i += len) {
			let curRe = 1;
			let curIm = 0;
			for (let k = 0; k < len / 2; k++) {
				const aRe = re[i + k];
				const aIm = im[i + k];
				const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
				const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
				re[i + k] = aRe + bRe;
				im[i + k] = aIm + bIm;
				re[i + k + len / 2] = aRe - bRe;
				im[i + k + len / 2] = aIm - bIm;
				const nextRe = curRe * wRe - curIm * wIm;
				curIm = curRe * wIm + curIm * wRe;
				curRe = nextRe;
			}
		}
	}
}

/**
 * Real-input FFT returning the one-sided spectrum (bins 0..n/2 inclusive) as interleaved-free
 * arrays. Simple zero-imaginary transform - clarity over the last factor-2 of speed; sample sets
 * here are tens of thousands of points, well within budget for a browser.
 */
export function rfft(signal: ArrayLike<number>, n: number): { re: Float64Array; im: Float64Array } {
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	for (let i = 0; i < Math.min(signal.length, n); i++) {
		re[i] = signal[i];
	}
	fftInPlace(re, im);
	const half = n / 2 + 1;
	return { re: re.subarray(0, half) as Float64Array, im: im.subarray(0, half) as Float64Array };
}
