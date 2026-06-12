/**
 * Accelerometer orientation check: when the machine shakes along one machine axis, the channel with
 * dominant energy tells us which sensor axis is aligned with it. If it isn't the expected one, the
 * M955 I (orientation) parameter is likely wrong and every per-axis analysis would mislead.
 */
import type { AccelCapture } from "../capture/csv";

export interface OrientationCheck {
	/** Sensor channel with the most motion energy (label from the CSV header). */
	dominant: string;
	/** Fraction of total energy carried by the dominant channel (0..1). */
	dominance: number;
	/** True when the dominant channel matches the machine axis that was excited. */
	ok: boolean;
}

export function checkOrientation(capture: AccelCapture, excitedAxis: string): OrientationCheck {
	const energies = capture.channels.map((ch) => {
		let mean = 0;
		for (let i = 0; i < ch.length; i++) {
			mean += ch[i];
		}
		mean /= Math.max(1, ch.length);
		let e = 0;
		for (let i = 0; i < ch.length; i++) {
			const d = ch[i] - mean;
			e += d * d;
		}
		return e;
	});
	let total = 0;
	let maxIdx = 0;
	for (let i = 0; i < energies.length; i++) {
		total += energies[i];
		if (energies[i] > energies[maxIdx]) {
			maxIdx = i;
		}
	}
	const dominant = capture.axes[maxIdx] ?? "?";
	return {
		dominant,
		dominance: total > 0 ? energies[maxIdx] / total : 0,
		ok: dominant.toUpperCase() === excitedAxis.toUpperCase(),
	};
}
