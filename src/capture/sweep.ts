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

/** A snapshot of RRF's move.shaping object model, read before a test disables it. */
export interface ShaperState {
	/** move.shaping.type: a real shaper name, "none", or "custom". */
	type: string;
	frequency: number;
	damping: number;
}

/**
 * G-code to restore a previously-read shaper configuration, or "" if there's nothing to do -
 * either it was already "none" (the test's own disable line already covers that), or it's
 * "custom" (a user-defined impulse train with its own M593 H/T syntax this doesn't attempt to
 * reconstruct - this plugin only ever recommends the six named shapers).
 */
export function shaperRestoreGcode(state?: ShaperState): string {
	if (!state || state.type === "none" || state.type === "custom") {
		return "";
	}
	return `M593 P"${state.type}" F${state.frequency.toFixed(1)} S${state.damping.toFixed(2)}`;
}

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
	/**
	 * Second axis moved in lockstep for diagonal (belt) excitation: scale +1 excites one belt of a
	 * CoreXY pair, -1 the other (the perpendicular diagonal).
	 */
	secondary?: { axis: string; center: number; scale: number };
	/** Keep the configured input shaper ACTIVE during the test (the verify run). Default: disable. */
	keepShaper?: boolean;
	/**
	 * The shaper configuration to restore once the test's own disabling is done with (read from the
	 * object model just before the test starts). Without this, the test leaves shaping disabled
	 * indefinitely - M593 is a persistent override, same reasoning as the M204 restore above.
	 */
	restoreShaper?: ShaperState;
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

	const lines: Array<string> = [
		"; Resonance Lab swept excitation",
		`; axis ${axis}, ${startFreq}-${endFreq} Hz at ${hzPerSec} Hz/s, ${accelPerHz} mm/s^2 per Hz`,
		"M400",
		options.keepShaper
			? "; input shaper left ACTIVE (verify run)"
			: 'M593 P"none" ; disable input shaping during the measurement',
		`M204 P${maxAccel} T${maxAccel}`,
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
		const sec = options.secondary;
		const secOut = sec ? ` ${sec.axis.toUpperCase()}${round3(sec.center + dir * d * sec.scale)}` : "";
		const secHome = sec ? ` ${sec.axis.toUpperCase()}${round3(sec.center)}` : "";
		lines.push(`G1 ${axis}${round3(target)}${secOut} F${maxFeedrate}`);
		lines.push(`G1 ${axis}${round3(options.center)}${secHome} F${maxFeedrate}`);
		dir = -dir;
		pulses++;
		durationSec += 4 * tSeg; // out + back, each a 2-segment triangular profile
		freq += 2 * tSeg * hzPerSec * 2; // frequency advances with elapsed test time
	}

	// M204 is a persistent machine-wide override, not scoped to this macro - restore the real
	// configured acceleration so moves issued after this test (including another task's) aren't
	// left running at whatever the sweep's last (test) pulse happened to set.
	lines.push(`M204 P${maxAccel} T${maxAccel}`);
	if (!options.keepShaper) {
		const restore = shaperRestoreGcode(options.restoreShaper);
		if (restore) {
			lines.push(restore);
		}
	}
	lines.push("M400");
	const endHome = options.secondary ? ` ${options.secondary.axis.toUpperCase()}${round3(options.secondary.center)}` : "";
	lines.push(`G1 ${axis}${round3(options.center)}${endHome} F${maxFeedrate}`);
	return { lines, pulses, durationSec, maxExcursion };
}

function round3(v: number): string {
	return (Math.round(v * 1000) / 1000).toString();
}

/**
 * Fixed-frequency excitation: hold one frequency for `seconds` to study a single suspicious peak
 * (locate a rattling part by touch, or watch how a resonance behaves under sustained drive).
 */
export function generateFixedExcitation(options: SweepOptions & { freq: number; seconds?: number }): SweepProgram {
	const axis = options.axis.toUpperCase();
	const freq = options.freq;
	const seconds = options.seconds ?? 10;
	const accelPerHz = options.accelPerHz ?? 60;
	const maxAccel = options.maxAccel ?? 10000;
	const maxFeedrate = options.maxFeedrate ?? 30000;
	if (!(freq > 0) || !(seconds > 0)) {
		throw new Error("Invalid excitation parameters");
	}
	const tSeg = 0.25 / freq;
	const accel = Math.min(accelPerHz * freq, maxAccel);
	const d = accel * tSeg * tSeg;
	const pulses = Math.ceil(seconds / (4 * tSeg));
	const lines: Array<string> = [
		`; Resonance Lab fixed excitation: ${freq} Hz for ${seconds}s on ${axis}`,
		"M400",
		options.keepShaper ? "; input shaper left ACTIVE" : 'M593 P"none" ; disable input shaping during the measurement',
		`M204 P${accel.toFixed(0)} T${accel.toFixed(0)}`,
	];
	let dir = 1;
	for (let i = 0; i < pulses; i++) {
		lines.push(`G1 ${axis}${round3(options.center + dir * d)} F${maxFeedrate}`);
		lines.push(`G1 ${axis}${round3(options.center)} F${maxFeedrate}`);
		dir = -dir;
	}
	// Restore the real configured acceleration - M204 is a persistent machine-wide override (see
	// generateSweep's note), not scoped to this macro.
	lines.push(`M204 P${maxAccel} T${maxAccel}`);
	if (!options.keepShaper) {
		const restore = shaperRestoreGcode(options.restoreShaper);
		if (restore) {
			lines.push(restore);
		}
	}
	lines.push("M400");
	return { lines, pulses, durationSec: pulses * 4 * tSeg, maxExcursion: d };
}
