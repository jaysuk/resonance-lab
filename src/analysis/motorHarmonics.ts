/**
 * Motor harmonic analysis: how much a stepper vibrates at multiples of its own full-step frequency,
 * measured from a constant-speed capture. A current-waveform error repeats once per electrical cycle
 * (four full steps), so orders are evaluated in quarters rather than integers - see gradeOrders for
 * what each order physically means. This is orthogonal to every other analysis module here: sweep/
 * belts/profile measure the machine's STRUCTURAL response, this measures the motor and driver
 * themselves (detent torque, coil current imbalance, current-waveform distortion).
 */
import { rfft } from "./fft";

export interface MotorHarmonics {
	/** Refined full-step frequency (Hz), found by searching around the nominal value. */
	fundamental: number;
	/** Harmonic orders analyzed, as multiples of the fundamental (e.g. 0.25, 0.5, 0.75, 1, ...). */
	orders: Array<number>;
	/** Harmonic frequencies (Hz), i.e. orders[i] * fundamental. */
	frequencies: Array<number>;
	/** Amplitude per channel (outer) and order (inner), in g. */
	amplitudes: Array<Float64Array>;
	/**
	 * Per-channel background level (g): the median amplitude at frequencies midway between adjacent
	 * orders, where no motor harmonic lives. What a harmonic's amplitude has to clear to count as a real
	 * signal rather than the accelerometer's own noise and broadband machine vibration.
	 */
	noiseFloor?: Float64Array;
	/**
	 * True when the fundamental search ended on the edge of its window - the real frequency may lie outside
	 * it (a narrow `searchRange` assumes the nominal frequency is nearly right), so the caller can widen it.
	 */
	lockedAtEdge?: boolean;
}

export interface MotorSweep {
	/** Harmonic orders (rows). */
	orders: Array<number>;
	/** Absolute frequencies (columns, Hz) - clustered across every recorded speed. */
	frequencies: Array<number>;
	/** Combined amplitude per order and absolute frequency (g), null where no capture covers it. */
	amplitudes: Array<Array<number | null>>;
	/** Amplitude relative to the order-1 amplitude at the same absolute frequency; null if either is missing. */
	ratios: Array<Array<number | null>>;
}

export type MotorFindingKey = "fullStep" | "phase" | "waveform";
export type MotorLevel = "low" | "moderate" | "high";

export interface MotorFinding {
	key: MotorFindingKey;
	/** Worst displacement (um) across every column this key's orders cover. */
	displacementUm: number;
	/** Absolute frequency (Hz) where the worst value occurred. */
	frequency: number;
	/** Ratio to the order-1 amplitude at that same frequency, when required and available. */
	ratio: number | null;
	level: MotorLevel;
}

/** Which harmonic orders each finding groups, and whether a ratio to the full-step amplitude is required. */
const FINDING_ORDERS: Record<MotorFindingKey, { orders: Array<number>; requireRatio: boolean }> = {
	fullStep: { orders: [1], requireRatio: false },
	phase: { orders: [0.5], requireRatio: true },
	waveform: { orders: [0.25, 0.75], requireRatio: true },
};

/** Squared DFT magnitude of `samples` at one normalized frequency (cycles per sample), by phasor rotation. */
function dftEnergy(samples: ArrayLike<number>, normalizedFrequency: number): number {
	const cosStep = Math.cos(2 * Math.PI * normalizedFrequency);
	const sinStep = Math.sin(2 * Math.PI * normalizedFrequency);
	let real = 0;
	let imag = 0;
	let phasorRe = 1;
	let phasorIm = 0;
	for (let i = 0; i < samples.length; i++) {
		real += samples[i] * phasorRe;
		imag -= samples[i] * phasorIm;
		const nextRe = phasorRe * cosStep - phasorIm * sinStep;
		phasorIm = phasorRe * sinStep + phasorIm * cosStep;
		phasorRe = nextRe;
	}
	return real * real + imag * imag;
}

/** Largest power of two that is <= n. */
function largestPowerOfTwoAtMost(n: number): number {
	let p = 1;
	while (p * 2 <= n) {
		p *= 2;
	}
	return p;
}

/**
 * Analyze constant-speed accelerometer samples for vibration at multiples of the motor's full-step
 * frequency. Refines the true fundamental within `searchRange` of `nominalHz` (feedrates rarely land
 * exactly on the nominal value), then evaluates amplitudes at exact harmonic frequencies down to
 * `1/subdivisions` of a full step - a current-waveform error repeats once per electrical cycle (four
 * full steps), so subdivisions=4 resolves that structure; subdivisions=1 would only see integer
 * full-step harmonics and miss it entirely.
 * @param channels Accelerometer samples per channel, ideally covering only the constant-speed window
 * @param sampleRate Sampling rate (Hz)
 * @param nominalHz Nominal full-step frequency (Hz), from feedrate/steps-per-mm/microstepping
 * @param numHarmonics Number of full-step harmonics to evaluate, including the fundamental
 * @param searchRange Relative range around nominalHz in which the true fundamental is searched
 * @param subdivisions Harmonic orders per full step (4 = electrical-cycle resolution, 1 = full-step only)
 * @param evaluateHarmonics Full-step multiples to EVALUATE (orders up to this many), independent of
 *   `numHarmonics`, which alone drives the fundamental search. Defaults to `numHarmonics`. Raising
 *   `numHarmonics` instead would change where the fundamental is located, and with it every
 *   amplitude - so reaching orders above 1 must go through this parameter.
 * @param readTolerance Relative half-width (fraction of each frequency) of the band an order's amplitude is
 *   read over. 0 reads exactly at `order * fundamental`. A motor harmonic is a spectral line a fraction of
 *   a hertz wide, and the fundamental it is measured from is only as good as the lock on a weak order-1
 *   line (field data: it wandered by ~1 Hz between back-to-back captures, which put order 0.5 half a hertz
 *   off its line and read a 0.39 g peak as 0.09 g). With a tolerance, each order - and each background
 *   gap, the same estimator - takes the strongest line in its band, and `frequencies` reports where.
 */
export function analyzeMotorHarmonics(
	channels: Array<ArrayLike<number>>, sampleRate: number, nominalHz: number,
	numHarmonics = 8, searchRange = 0.05, subdivisions = 4, evaluateHarmonics = numHarmonics,
	readTolerance = 0,
): MotorHarmonics {
	if (channels.length < 1 || channels[0].length < 16) {
		throw new Error("Too few samples for harmonic analysis");
	}
	if (nominalHz <= 0 || nominalHz * (1 + searchRange) >= sampleRate / 2) {
		throw new Error("Full-step frequency exceeds the Nyquist frequency");
	}
	subdivisions = Math.max(1, Math.round(subdivisions));

	const N = channels[0].length;
	const nyquistOrders = Math.floor((sampleRate / 2 / (nominalHz * (1 + searchRange))) * subdivisions);
	const searchOrders = Math.min(numHarmonics * subdivisions, nyquistOrders);
	const numOrders = Math.min(Math.max(numHarmonics, evaluateHarmonics) * subdivisions, nyquistOrders);
	numHarmonics = Math.max(1, Math.floor(searchOrders / subdivisions));

	// Mean-correct and Hann-window each channel, at full length.
	const windowed = channels.map((ch) => {
		let mean = 0;
		for (let i = 0; i < N; i++) {
			mean += ch[i];
		}
		mean /= N;
		const out = new Float64Array(N);
		for (let i = 0; i < N; i++) {
			const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
			out[i] = (ch[i] - mean) * w;
		}
		return out;
	});
	const windowSum = N / 2;

	// Coarse search: FFT-bin harmonic energy over a power-of-two truncation.
	const nfft = largestPowerOfTwoAtMost(N);
	const binWidth = sampleRate / nfft;
	const spectra = windowed.map((ch) => {
		const { re, im } = rfft(ch, nfft);
		const power = new Float64Array(re.length);
		for (let i = 0; i < re.length; i++) {
			power[i] = re[i] * re[i] + im[i] * im[i];
		}
		return power;
	});
	const minBin = Math.max(1, Math.floor((nominalHz * (1 - searchRange)) / binWidth));
	const maxBin = Math.ceil((nominalHz * (1 + searchRange)) / binWidth);
	let bestBin = minBin;
	let bestEnergy = -1;
	for (let bin = minBin; bin <= maxBin; bin++) {
		let energy = 0;
		for (let k = 1; k <= numHarmonics && bin * k < nfft / 2; k++) {
			for (const spectrum of spectra) {
				energy += spectrum[bin * k];
			}
		}
		if (energy > bestEnergy) {
			bestBin = bin;
			bestEnergy = energy;
		}
	}

	// Fine search: direct DFT scan at 1/16 bin, over the full-length windowed signal.
	const fineStep = binWidth / 16;
	let fundamental = bestBin * binWidth;
	bestEnergy = -1;
	for (let f = (bestBin - 1) * binWidth; f <= (bestBin + 1) * binWidth + 1e-9; f += fineStep) {
		let energy = 0;
		for (let k = 1; k <= numHarmonics; k++) {
			for (const ch of windowed) {
				energy += dftEnergy(ch, (k * f) / sampleRate);
			}
		}
		if (energy > bestEnergy) {
			fundamental = f;
			bestEnergy = energy;
		}
	}

	// The strongest line, summed across channels, within `readTolerance` of `centre` (Hz). The coarse FFT bins
	// find it, a direct DFT scan at 1/8 bin around the winning bin places it - the same two steps the
	// fundamental search uses. With no tolerance it is simply `centre`.
	const peakNear = (centre: number): number => {
		if (readTolerance <= 0) {
			return centre;
		}
		const lo = Math.max(binWidth, centre * (1 - readTolerance));
		const hi = Math.min(sampleRate / 2, centre * (1 + readTolerance));
		if (!(hi > lo)) {
			return centre;
		}
		const lastBin = spectra[0].length - 1;
		let peakBin = Math.min(lastBin, Math.max(1, Math.round(centre / binWidth)));
		let peakPower = -1;
		for (let bin = Math.max(1, Math.floor(lo / binWidth)); bin <= Math.min(lastBin, Math.ceil(hi / binWidth)); bin++) {
			let power = 0;
			for (const spectrum of spectra) {
				power += spectrum[bin];
			}
			if (power > peakPower) {
				peakPower = power;
				peakBin = bin;
			}
		}
		let best = Math.min(hi, Math.max(lo, peakBin * binWidth));
		let bestEnergy = -1;
		for (let f = Math.max(lo, (peakBin - 1) * binWidth); f <= Math.min(hi, (peakBin + 1) * binWidth) + 1e-9; f += binWidth / 8) {
			let energy = 0;
			for (const ch of windowed) {
				energy += dftEnergy(ch, f / sampleRate);
			}
			if (energy > bestEnergy) {
				best = f;
				bestEnergy = energy;
			}
		}
		return best;
	};
	const amplitudeAt = (ch: ArrayLike<number>, f: number): number => (2 * Math.sqrt(dftEnergy(ch, f / sampleRate))) / windowSum;

	const orders = Array.from({ length: numOrders }, (_, k) => (k + 1) / subdivisions);
	const frequencies = orders.map((order) => peakNear(order * fundamental));
	const amplitudes = windowed.map((ch) => {
		const out = new Float64Array(frequencies.length);
		for (let i = 0; i < frequencies.length; i++) {
			out[i] = amplitudeAt(ch, frequencies[i]);
		}
		return out;
	});

	// Background level from the gaps between orders - same estimator as the amplitudes above, so the two
	// are directly comparable. Gaps past Nyquist are skipped.
	const noiseFloor = new Float64Array(windowed.length);
	const gaps = orders.map((order) => (order - 0.5 / subdivisions) * fundamental).filter((f) => f > 0 && f < sampleRate / 2).map(peakNear);
	if (gaps.length > 0) {
		windowed.forEach((ch, c) => {
			const levels = gaps.map((f) => amplitudeAt(ch, f)).sort((a, b) => a - b);
			noiseFloor[c] = levels[Math.floor(levels.length / 2)];
		});
	}

	return { fundamental, orders, frequencies, amplitudes, noiseFloor, lockedAtEdge: bestBin <= minBin || bestBin >= maxBin };
}

/** Combine per-channel amplitudes into one magnitude per order (root sum of squares across channels). */
export function combineAxes(h: MotorHarmonics): Float64Array {
	const out = new Float64Array(h.frequencies.length);
	for (let i = 0; i < out.length; i++) {
		let sum = 0;
		for (const ch of h.amplitudes) {
			sum += ch[i] * ch[i];
		}
		out[i] = Math.sqrt(sum);
	}
	return out;
}

/** Displacement (um) below which a harmonic counts as low. */
export const LOW_DISPLACEMENT_UM = 0.5;

// Standard gravity (mm/s^2), for converting an acceleration amplitude into a displacement amplitude.
const GRAVITY_MM_S2 = 9806.65;

/**
 * Convert a sinusoidal vibration's acceleration amplitude to its displacement amplitude, in um.
 * Displacement (unlike acceleration) is speed-independent, so it's what carries a fixed threshold -
 * an acceleration figure alone means different things at different frequencies.
 */
export function toDisplacementUm(amplitudeG: number, frequencyHz: number): number {
	const accelMmS2 = amplitudeG * GRAVITY_MM_S2;
	return (accelMmS2 / (2 * Math.PI * frequencyHz) ** 2) * 1000;
}

/**
 * Compare harmonic analyses recorded at different speeds by absolute frequency rather than by order:
 * the machine's mechanical response depends only on absolute frequency, so clustering harmonics from
 * different speeds that land on the same absolute frequency (within `tolerance`) cancels the machine
 * out of the comparison and leaves the motor's own behaviour.
 */
export function summarizeMotorSweep(results: Array<MotorHarmonics>, tolerance = 0.05): MotorSweep {
	const orders = Array.from(new Set(results.flatMap((r) => r.orders))).sort((a, b) => a - b);

	const points = results.flatMap((r) => {
		const combined = combineAxes(r);
		return r.orders.map((order, i) => ({ order, frequency: r.frequencies[i], amplitude: combined[i] }));
	}).sort((a, b) => a.frequency - b.frequency);

	interface Cluster { frequency: number; points: Array<{ order: number; frequency: number; amplitude: number }> }
	const clusters: Array<Cluster> = [];
	for (const point of points) {
		const last = clusters[clusters.length - 1];
		if (last && Math.abs(point.frequency - last.frequency) <= tolerance * last.frequency) {
			last.points.push(point);
			last.frequency = last.points.reduce((sum, p) => sum + p.frequency, 0) / last.points.length;
		} else {
			clusters.push({ frequency: point.frequency, points: [point] });
		}
	}

	const amplitudes = orders.map((order) => clusters.map((cluster) => {
		const matching = cluster.points.filter((p) => p.order === order);
		return matching.length > 0 ? matching.reduce((sum, p) => sum + p.amplitude, 0) / matching.length : null;
	}));
	const fullStepRow = amplitudes[orders.indexOf(1)];
	const ratios = amplitudes.map((row) => row.map((amplitude, i) => (
		amplitude !== null && fullStepRow && fullStepRow[i] ? amplitude / fullStepRow[i] : null
	)));

	return { orders, frequencies: clusters.map((c) => c.frequency), amplitudes, ratios };
}

/**
 * Plain-language findings per order group: 1x = detent torque and step ripple (inherent to the
 * motor, nothing corrects it), 0.5x = coil current imbalance (needs phase stepping), 0.25x/0.75x =
 * distorted current waveform (needs a sine table or phase stepping). Sub-orders are only scored where
 * a ratio to the full-step amplitude exists, which also skips the lowest absolute frequencies whose
 * tiny accelerations would otherwise turn noise into huge displacement figures.
 */
export function gradeOrders(sweep: MotorSweep): Array<MotorFinding> {
	const findings: Array<MotorFinding> = [];
	for (const key of Object.keys(FINDING_ORDERS) as Array<MotorFindingKey>) {
		const { orders, requireRatio } = FINDING_ORDERS[key];
		let worst: MotorFinding | null = null;
		for (const order of orders) {
			const orderIndex = sweep.orders.indexOf(order);
			if (orderIndex < 0) {
				continue;
			}
			sweep.amplitudes[orderIndex].forEach((amplitude, i) => {
				const ratio = sweep.ratios[orderIndex][i];
				if (amplitude === null || (requireRatio && ratio === null)) {
					return;
				}
				const displacementUm = toDisplacementUm(amplitude, sweep.frequencies[i]);
				if (!worst || displacementUm > worst.displacementUm) {
					const level: MotorLevel = displacementUm < LOW_DISPLACEMENT_UM ? "low" : displacementUm < 2 ? "moderate" : "high";
					worst = { key, displacementUm, frequency: sweep.frequencies[i], ratio, level };
				}
			});
		}
		if (worst) {
			findings.push(worst);
		}
	}
	return findings;
}
