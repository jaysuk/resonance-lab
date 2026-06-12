/**
 * Vibration profile: how much the machine vibrates at each travel speed. Constant-speed moves are
 * recorded per speed point; the per-point vibration energy curve exposes problem speed ranges
 * (motor resonances, frame modes) that show up as surface artefacts - so users can route their
 * print speeds around them.
 */
import { type AccelCapture } from "../capture/csv";
import { welchPsd } from "./spectrum";

export interface SpeedPoint {
	/** Travel speed (mm/s). */
	speed: number;
	/** Mean vibration power in the analysis band (relative units). */
	energy: number;
}

export interface VibrationProfile {
	points: Array<SpeedPoint>;
	/** Median energy across points (the baseline "this machine's normal"). */
	median: number;
	/** Points whose energy exceeds 2x the median, worst first - the speeds to avoid. */
	problems: Array<SpeedPoint>;
	/** Points at or below the median - safe speed suggestions. */
	quietest: Array<SpeedPoint>;
}

/** Vibration energy of one capture: mean PSD over the band (5..maxFreq Hz). */
export function captureEnergy(capture: AccelCapture, maxFreq = 200): number {
	const { freqs, psdSum } = welchPsd(capture.channels, capture.samplingRate);
	let sum = 0;
	let n = 0;
	for (let i = 0; i < freqs.length; i++) {
		if (freqs[i] >= 5 && freqs[i] <= maxFreq) {
			sum += psdSum[i];
			n++;
		}
	}
	return n > 0 ? sum / n : 0;
}

export function buildVibrationProfile(entries: Array<{ speed: number; capture: AccelCapture }>, maxFreq = 200): VibrationProfile {
	const points = entries
		.map((e) => ({ speed: e.speed, energy: captureEnergy(e.capture, maxFreq) }))
		.sort((a, b) => a.speed - b.speed);
	const sorted = points.map((p) => p.energy).sort((a, b) => a - b);
	const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
	const problems = points.filter((p) => median > 0 && p.energy > 2 * median).sort((a, b) => b.energy - a.energy);
	const quietest = points.filter((p) => p.energy <= median).sort((a, b) => a.energy - b.energy);
	return { points, median, problems, quietest };
}
