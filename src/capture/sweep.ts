/**
 * Swept-excitation test generator: a G-code program that oscillates one axis with short
 * acceleration pulses whose frequency rises continuously, exciting every frequency in the band in
 * a single run. Standard resonance-testing motion: at frequency f each pulse is two quarter-period
 * segments (accelerate then decelerate, t = 0.25/f) covering d = a*t^2 with a = accelPerHz * f,
 * direction alternating each pulse so the head oscillates around the start point.
 *
 * The program is meant to be uploaded as a file and run (M98/M32) rather than streamed: a full
 * 5..135 Hz sweep is tens of thousands of short moves. Pure generator - no stores, fully testable;
 * the capture orchestrator owns upload/run/record sequencing.
 */

export interface SweepOptions {
	/** Axis letter to excite (e.g. "X"). */
	axis: string;
	/** Centre position on that axis (mm) - moves oscillate around it. */
	center: number;
	startFreq?: number;
	endFreq?: number;
	/** Sweep rate (Hz of test frequency per second of test time). */
	hzPerSec?: number;
	/** Excitation strength: acceleration = accelPerHz * frequency. */
	accelPerHz?: number;
	/** Machine acceleration ceiling for the axis (clamps the pulse acceleration). */
	maxAccel?: number;
	/** Feedrate ceiling (mm/min) used for the G1 moves (kept high; accel limits the profile). */
	maxFeedrate?: number;
}

export interface SweepProgram {
	/** G-code lines, ready to join("\n") and upload. */
	lines: Array<string>;
	/** Number of oscillation pulses. */
	pulses: number;
	/** Estimated test duration in seconds. */
	durationSec: number;
	/** Largest single-move travel (mm) - for a bounds check against the machine envelope. */
	maxExcursion: number;
}

export function generateSweep(options: SweepOptions): SweepProgram {
	const axis = options.axis.toUpperCase();
	const startFreq = options.startFreq ?? 5;
	const endFreq = options.endFreq ?? 135;
	const hzPerSec = options.hzPerSec ?? 1;
	const accelPerHz = options.accelPerHz ?? 60;
	const maxAccel = options.maxAccel ?? 10000;
	const maxFeedrate = options.maxFeedrate ?? 30000;

	if (!(startFreq > 0) || !(endFreq > startFreq) || !(hzPerSec > 0)) {
		throw new Error("Invalid sweep range");
	}

	const preambleAccel = Math.min(10000, maxAccel);
	const lines: Array<string> = [
		"; Resonance Lab swept excitation",
		`; axis ${axis}, ${startFreq}-${endFreq} Hz at ${hzPerSec} Hz/s, ${accelPerHz} mm/s^2 per Hz`,
		"M400",
		'M593 P"none" ; disable input shaping during the measurement',
		`M204 P${preambleAccel} T${preambleAccel}`,
	];

	let freq = startFreq;
	let dir = 1;
	let pulses = 0;
	let durationSec = 0;
	let maxExcursion = 0;
	let lastAccel = 0;

	while (freq <= endFreq + 1e-6) {
		const tSeg = 0.25 / freq;
		const accel = Math.min(accelPerHz * freq, maxAccel);
		const d = accel * tSeg * tSeg;
		if (d > maxExcursion) {
			maxExcursion = d;
		}
		// Acceleration changes are sparse-ish at low freq; only emit M204 when it changes enough.
		if (Math.abs(accel - lastAccel) >= 1) {
			lines.push(`M204 P${accel.toFixed(0)} T${accel.toFixed(0)}`);
			lastAccel = accel;
		}
		const target = options.center + dir * d;
		lines.push(`G1 ${axis}${round3(target)} F${maxFeedrate}`);
		lines.push(`G1 ${axis}${round3(options.center)} F${maxFeedrate}`);
		dir = -dir;
		pulses++;
		durationSec += 4 * tSeg; // out + back, each a 2-segment triangular profile
		freq += 2 * tSeg * hzPerSec * 2; // frequency advances with elapsed test time
	}

	lines.push("M400");
	lines.push(`G1 ${axis}${round3(options.center)} F${maxFeedrate}`);
	return { lines, pulses, durationSec, maxExcursion };
}

function round3(v: number): string {
	return (Math.round(v * 1000) / 1000).toString();
}
