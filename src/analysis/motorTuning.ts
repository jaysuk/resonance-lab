/**
 * Motor waveform-correction search: find the magnitude/phase correction (M970.3 or M569.2) that
 * minimises vibration at one harmonic of a motor's electrical cycle.
 *
 * The model: a correction is a vector (J, O) in the complex plane. Added to the motor's own
 * (unknown) error vector E, the residual's squared amplitude is
 *   A^2 = |E + J*e^(iO)|^2 = u + v*J^2 + 2J(a*cos(O) + b*sin(O))
 * which is LINEAR in (u, v, a, b), so those four unknowns fall out of an ordinary least-squares fit
 * over a handful of probe measurements - no iteration, no gradient descent. Summing both move
 * directions' models stays quadratic in the correction vector, so the combined minimum is
 * closed-form too.
 *
 * Both directions are measured and fit separately, then combined: a rotor-fixed error component
 * shifts by the load angle, which flips sign with direction, so the two directions have different
 * optima - tuning on one alone gives a correction that's wrong in reverse.
 *
 * `measure` is injected, so this whole search is unit-testable against a synthetic error vector with
 * no printer and no G-code.
 */

export interface PhaseCorrection {
	harmonic: number;
	magnitude: number;
	phase: number;
}

/** One measurement: the correction applied, and the resulting vibration amplitude. */
export interface TuningMeasurement {
	harmonic: number;
	magnitude: number;
	phase: number;
	/** Mean amplitude of both move directions. */
	amplitude: number;
	/** Amplitude per direction [forward, return]. */
	amplitudes: [number, number];
}

export interface HarmonicTuningResult {
	harmonic: number;
	/** Amplitude with no correction applied (mean of the two baseline captures). */
	baseline: number;
	/** How far apart the two baseline captures were: a rough measure of this order's capture-to-capture scatter. */
	baselineSpread?: number;
	/** The search's winner had `best.amplitude < baseline` but not by more than the scatter, so it was not adopted. */
	withinScatter?: boolean;
	best: TuningMeasurement;
}

export interface TuningSchedule {
	/** Magnitude of the initial probe moves. */
	probeMagnitude: number;
	/** Hard cap on any magnitude this search will request. */
	maxMagnitude: number;
	/** Minimum refinement-circle radius, so a near-zero first optimum still gets meaningfully probed. */
	minRefineRadius: number;
}

export const defaultTuningSchedule: TuningSchedule = { probeMagnitude: 1, maxMagnitude: 4, minRefineRadius: 0.2 };

/** Parse a waveform-correction query reply, e.g. "Driver 0 waveform correction: S2 J1.500 O200.0, S4 J0.300 O0.0". Returns [] for "... none". */
export function parsePhaseCorrections(reply: string): Array<PhaseCorrection> {
	const out: Array<PhaseCorrection> = [];
	for (const m of reply.matchAll(/S(\d+)\s+J([\d.]+)\s+O([\d.]+)/g)) {
		out.push({ harmonic: parseInt(m[1], 10), magnitude: parseFloat(m[2]), phase: parseFloat(m[3]) });
	}
	return out;
}

/** Number of `measure` calls one tuneHarmonic run makes: 2 baselines + 4 probes + 4 refine + 1 verify (free phase), or 2 baselines + 2 + 2 + 1 (constrained). */
export function getMovesPerHarmonic(constrainPhase = false): number {
	return constrainPhase ? 7 : 11;
}

function normalizePhase(phase: number): number {
	return ((phase % 360) + 360) % 360;
}

// ---- Least squares (Gauss-Jordan with partial pivoting, small systems only) ----

function solveLinearSystem(a: Array<Array<number>>, b: Array<number>): Array<number> {
	const n = b.length;
	const m = a.map((row, i) => [...row, b[i]]);
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let row = col + 1; row < n; row++) {
			if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) {
				pivot = row;
			}
		}
		[m[col], m[pivot]] = [m[pivot], m[col]];
		const pivotVal = m[col][col];
		if (Math.abs(pivotVal) < 1e-12) {
			// Degenerate system - caller handles the fallback.
			return new Array(n).fill(0);
		}
		for (let row = 0; row < n; row++) {
			if (row === col) {
				continue;
			}
			const factor = m[row][col] / pivotVal;
			for (let k = col; k <= n; k++) {
				m[row][k] -= factor * m[col][k];
			}
		}
	}
	return m.map((row, i) => row[n] / row[i]);
}

function leastSquares(basis: Array<Array<number>>, targets: Array<number>): Array<number> {
	const n = basis[0].length;
	const ata = Array.from({ length: n }, (_, i) => Array.from({ length: n },
		(_, j) => basis.reduce((sum, row) => sum + row[i] * row[j], 0)));
	const atb = Array.from({ length: n }, (_, i) => basis.reduce((sum, row, k) => sum + row[i] * targets[k], 0));
	return solveLinearSystem(ata, atb);
}

interface DirectionFit { u: number; v: number; a: number; b: number }

/** Fit A^2 = u + v*J^2 + 2J(a*cos(O) + b*sin(O)) for one direction's measurements. */
function fitDirectionFree(measurements: Array<TuningMeasurement>, direction: 0 | 1): DirectionFit {
	const basis = measurements.map((m) => {
		const rad = (m.phase * Math.PI) / 180;
		return [1, m.magnitude * m.magnitude, 2 * m.magnitude * Math.cos(rad), 2 * m.magnitude * Math.sin(rad)];
	});
	const targets = measurements.map((m) => m.amplitudes[direction] * m.amplitudes[direction]);
	const [u, v, a, b] = leastSquares(basis, targets);
	return { u, v, a, b };
}

/** Constrained fit: phase is 0 or 180, so the model reduces to A^2 = u + v*m^2 + 2*a*m with signed magnitude m. */
function fitDirectionConstrained(measurements: Array<TuningMeasurement>, direction: 0 | 1): DirectionFit {
	const basis = measurements.map((m) => {
		const signed = m.phase === 180 ? -m.magnitude : m.magnitude;
		return [1, signed * signed, 2 * signed];
	});
	const targets = measurements.map((m) => m.amplitudes[direction] * m.amplitudes[direction]);
	const [u, v, a] = leastSquares(basis, targets);
	return { u, v, a, b: 0 };
}

interface Optimum { magnitude: number; phase: number }

/** Combine both directions' fits and find the closed-form minimum of the summed model. */
function combinedOptimum(
	measurements: Array<TuningMeasurement>, constrainPhase: boolean, schedule: TuningSchedule,
): Optimum {
	const fit0 = constrainPhase ? fitDirectionConstrained(measurements, 0) : fitDirectionFree(measurements, 0);
	const fit1 = constrainPhase ? fitDirectionConstrained(measurements, 1) : fitDirectionFree(measurements, 1);
	const v = fit0.v + fit1.v;
	const a = fit0.a + fit1.a;
	const b = fit0.b + fit1.b;

	if (!(v > 0) || !isFinite(v)) {
		return fallbackOptimum(measurements);
	}
	if (constrainPhase) {
		const signedMagnitude = -a / v;
		if (!isFinite(signedMagnitude)) {
			return fallbackOptimum(measurements);
		}
		const magnitude = Math.min(Math.abs(signedMagnitude), schedule.maxMagnitude);
		const phase = signedMagnitude >= 0 ? 0 : 180;
		return { magnitude, phase };
	}
	const magnitude = Math.sqrt(a * a + b * b) / v;
	if (!isFinite(magnitude)) {
		return fallbackOptimum(measurements);
	}
	const phase = normalizePhase((Math.atan2(-b, -a) * 180) / Math.PI);
	return { magnitude: Math.min(magnitude, schedule.maxMagnitude), phase };
}

/** Degenerate-fit guard: fall back to the lowest-amplitude measurement actually taken. */
function fallbackOptimum(measurements: Array<TuningMeasurement>): Optimum {
	const best = measurements.reduce((min, m) => (m.amplitude < min.amplitude ? m : min));
	return { magnitude: best.magnitude, phase: best.phase };
}

/**
 * Tune one harmonic: probe, fit, refine, refit, verify. `measure` applies the given correction
 * (magnitude/phase already clamped/normalised), records, analyses, and returns the amplitude.
 * Adopts the verified result only if it beats the baseline by more than the gap between the two baseline
 * captures - a fit can converge on a worse point when the signal is near the noise floor, and a weak
 * order's readings scatter by more than any small gain.
 */
export async function tuneHarmonic(
	harmonic: number,
	measure: (magnitude: number, phase: number) => Promise<TuningMeasurement>,
	constrainPhase = false,
	schedule: TuningSchedule = defaultTuningSchedule,
): Promise<HarmonicTuningResult> {
	const measurements: Array<TuningMeasurement> = [];

	async function probe(magnitude: number, phase: number): Promise<TuningMeasurement> {
		const clampedMag = Math.min(Math.max(0, magnitude), schedule.maxMagnitude);
		const m = await measure(clampedMag, normalizePhase(phase));
		measurements.push(m);
		return m;
	}

	// The uncorrected motor is captured twice: a single capture of a weak order can read several times
	// higher or lower than the next, and a "win" measured against one lucky-low baseline is no win at all.
	// The gap between the two is the scatter a correction has to beat.
	const baselineA = await probe(0, 0);
	const baselineB = await probe(0, 0);
	const baseline: TuningMeasurement = {
		harmonic, magnitude: 0, phase: 0, amplitude: (baselineA.amplitude + baselineB.amplitude) / 2,
		amplitudes: [(baselineA.amplitudes[0] + baselineB.amplitudes[0]) / 2, (baselineA.amplitudes[1] + baselineB.amplitudes[1]) / 2],
	};
	const spread = Math.abs(baselineA.amplitude - baselineB.amplitude);

	const initialPhases = constrainPhase ? [0, 180] : [0, 90, 180, 270];
	for (const phase of initialPhases) {
		await probe(schedule.probeMagnitude, phase);
	}
	let optimum = combinedOptimum(measurements, constrainPhase, schedule);

	const radius = Math.max(schedule.minRefineRadius, optimum.magnitude / 2);
	if (constrainPhase) {
		const signedCenter = optimum.phase === 180 ? -optimum.magnitude : optimum.magnitude;
		for (const delta of [-radius, radius]) {
			const signed = signedCenter + delta;
			await probe(Math.abs(signed), signed < 0 ? 180 : 0);
		}
	} else {
		const cx = optimum.magnitude * Math.cos((optimum.phase * Math.PI) / 180);
		const cy = optimum.magnitude * Math.sin((optimum.phase * Math.PI) / 180);
		for (const angleDeg of [45, 135, 225, 315]) {
			const rad = (angleDeg * Math.PI) / 180;
			const x = cx + radius * Math.cos(rad);
			const y = cy + radius * Math.sin(rad);
			const mag = Math.sqrt(x * x + y * y);
			const phase = normalizePhase((Math.atan2(y, x) * 180) / Math.PI);
			await probe(mag, phase);
		}
	}
	optimum = combinedOptimum(measurements, constrainPhase, schedule);

	const verification = await probe(optimum.magnitude, optimum.phase);
	const adopt = verification.amplitude < baseline.amplitude - spread;
	const best = adopt ? verification : {
		harmonic, magnitude: 0, phase: 0, amplitude: baseline.amplitude, amplitudes: baseline.amplitudes,
	};
	return {
		harmonic, baseline: baseline.amplitude, baselineSpread: spread, best,
		withinScatter: !adopt && verification.amplitude < baseline.amplitude,
	};
}
