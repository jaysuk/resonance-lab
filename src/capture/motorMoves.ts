/**
 * Motor-isolating moves: derive a Cartesian direction that drives exactly one motor at a constant
 * step rate, and the trapezoidal-move math needed to find that move's constant-speed window. Shared
 * by the motor-quality task's capture and analysis.
 *
 * On core kinematics (CoreXY etc.) the column of the kinematics forward matrix belonging to a motor
 * IS the Cartesian direction that drives only that motor, because inverseMatrix * forwardMatrix is
 * the identity. On non-core kinematics only Z runs the motors at a constant step rate.
 */

interface ModelAxis {
	letter?: string;
	min?: number;
	max?: number;
	visible?: boolean;
	acceleration?: number;
	speed?: number;
	stepsPerMm?: number;
	microstepping?: { value?: number } | null;
}
interface ModelKinematics {
	forwardMatrix?: Array<Array<number>>;
	inverseMatrix?: Array<Array<number>>;
}
interface ResonanceLabMotorModel {
	move?: {
		axes?: Array<ModelAxis>;
		kinematics?: ModelKinematics;
		travelAcceleration?: number;
	};
}

/** A Cartesian direction through the machine that drives exactly one motor at a constant step rate. */
export interface MotorOption {
	/** Axis letter of the driving motor, e.g. "X". */
	motor: string;
	/** Display label, e.g. "X+Y". */
	label: string;
	/** Involved axis letters. */
	axes: Array<string>;
	/** Unit direction vector over `axes`. */
	direction: Array<number>;
	/** Motor travel per mm of path (1 for a single axis, sqrt(2) for a CoreXY diagonal). */
	stepFactor: number;
	/** Full steps per mm of motor travel (steps per mm divided by microstepping). */
	fullStepsPerMm: number;
}

/** A motor-isolating move plus the coordinates needed to execute it. */
export interface MotorMove {
	motor: string;
	axes: Array<string>;
	start: Array<number>;
	end: Array<number>;
	/** Path length (mm). */
	distance: number;
	/** Feedrate along the path (mm/min). */
	feedrate: number;
	/** Acceleration along the path (mm/s^2). */
	acceleration: number;
	fullStepsPerMm: number;
	stepFactor: number;
}

function model(m: unknown): ResonanceLabMotorModel {
	return (m ?? {}) as ResonanceLabMotorModel;
}

/**
 * Every motor that can be driven alone at a constant step rate: on core kinematics, one option per
 * column of the forward matrix (skipped when it touches a non-visible axis, or when the axis's
 * microstepping isn't reported - a wrong assumed microstepping would produce a confident analysis at
 * the wrong frequency, which is worse than offering no analysis); on non-core kinematics, Z alone.
 */
export function deriveMotorOptions(m: unknown): Array<MotorOption> {
	const mv = model(m).move;
	const axes = mv?.axes ?? [];
	const kinematics = mv?.kinematics;
	const forwardMatrix = kinematics?.forwardMatrix ?? [];
	const inverseMatrix = kinematics?.inverseMatrix ?? [];
	const options: Array<MotorOption> = [];

	function fullStepsPerMm(axis: ModelAxis): number | null {
		const microstepping = axis.microstepping?.value;
		if (typeof axis.stepsPerMm !== "number" || !axis.stepsPerMm || typeof microstepping !== "number" || !microstepping) {
			return null;
		}
		return Math.round((axis.stepsPerMm / microstepping) * 1000) / 1000;
	}

	if (Array.isArray(forwardMatrix) && forwardMatrix.length > 0) {
		for (let motorIndex = 0; motorIndex < axes.length && motorIndex < forwardMatrix.length; motorIndex++) {
			const column = axes.map((_, axisIndex) => forwardMatrix[axisIndex]?.[motorIndex] ?? 0);
			const involvedIndices = axes.map((_, i) => i).filter((i) => column[i] !== 0);
			if (involvedIndices.length === 0 || involvedIndices.some((i) => axes[i].visible === false)) {
				continue;
			}
			const motorAxis = axes[motorIndex];
			const steps = fullStepsPerMm(motorAxis);
			if (steps === null) {
				continue;
			}
			const length = Math.sqrt(involvedIndices.reduce((sum, i) => sum + column[i] * column[i], 0));
			let direction = involvedIndices.map((i) => column[i] / length);
			if (direction[0] < 0) {
				direction = direction.map((v) => -v);
			}
			const inverseRow = inverseMatrix[motorIndex] ?? [];
			const stepFactor = Math.abs(involvedIndices.reduce((sum, i, idx) => sum + (inverseRow[i] ?? 0) * direction[idx], 0));
			const involvedLetters = involvedIndices.map((i) => axes[i].letter ?? "");
			const label = involvedLetters.map((letter, idx) => `${idx > 0 ? (direction[idx] < 0 ? "-" : "+") : ""}${letter}`).join("");
			options.push({
				motor: motorAxis.letter ?? "",
				label,
				axes: involvedLetters,
				direction,
				stepFactor,
				fullStepsPerMm: steps,
			});
		}
	} else {
		const zAxis = axes.find((a) => a.letter === "Z" && a.visible !== false);
		if (zAxis) {
			const steps = fullStepsPerMm(zAxis);
			if (steps !== null) {
				options.push({ motor: "Z", label: "Z", axes: ["Z"], direction: [1], stepFactor: 1, fullStepsPerMm: steps });
			}
		}
	}
	return options;
}

/** Axis object for a letter, or undefined if it's not in the model. */
function findAxis(m: unknown, letter: string): ModelAxis | undefined {
	return model(m).move?.axes?.find((a) => a.letter === letter);
}

/** Centre of an axis's travel range, or 0 if the model doesn't have valid limits for it. */
function axisCenter(axis: ModelAxis | undefined): number {
	if (axis && typeof axis.min === "number" && typeof axis.max === "number" && axis.max > axis.min) {
		return (axis.min + axis.max) / 2;
	}
	return 0;
}

/** Longest line through the centre (along `option`'s direction) that keeps every involved axis within its limits. */
export function maxLength(o: MotorOption, m: unknown): number {
	const limits = o.axes.map((letter, i) => {
		const axis = findAxis(m, letter);
		if (!axis || typeof axis.min !== "number" || typeof axis.max !== "number") {
			return Infinity;
		}
		return (axis.max - axis.min) / Math.abs(o.direction[i]);
	});
	return Math.floor(Math.min(...limits));
}

/**
 * Highest test speed (mm/s) before the motor's full-step frequency itself passes the accelerometer's
 * Nyquist frequency - the binding constraint on test speed. Harmonics above Nyquist are merely
 * dropped by analyzeMotorHarmonics and must not limit speed further; only the fundamental's own
 * ±5% search margin (matching analyzeMotorHarmonics' default searchRange) does.
 */
export function maxSpeedForRate(o: MotorOption, sampleRate: number): number {
	return sampleRate / (2 * 1.05 * o.fullStepsPerMm * o.stepFactor);
}

/**
 * Fraction of the configured sampling rate a waveform tune plans against. The rate a recording really
 * achieves can differ a little from the configured one (the motor sweep already tolerates that), so
 * a harmonic sitting right at Nyquist on paper must not be admitted and then dropped mid-run.
 */
export const TUNE_RATE_MARGIN = 0.97;

/**
 * Highest test speed (mm/s) at which every harmonic in `harmonics` (S values, order S/4) can still be
 * measured: the highest selected order, or the fundamental if that is higher, must stay clear of
 * Nyquist with the same ±5% margin. Generalises maxSpeedForRate, which only covers order 1 - the
 * fundamental is always located first, so no order below 1 can relax that bound.
 */
export function maxTuneSpeed(harmonics: Array<number>, o: MotorOption, sampleRate: number): number {
	const highestOrder = Math.max(1, ...harmonics.map((h) => h / 4));
	return maxSpeedForRate(o, sampleRate) / highestOrder;
}

/** Build a motor-isolating move of `lengthMm` centred on the machine, at `speedMmS`. */
export function buildMotorMove(o: MotorOption, m: unknown, lengthMm: number, speedMmS: number): MotorMove {
	const centers = o.axes.map((letter) => axisCenter(findAxis(m, letter)));
	const start = centers.map((c, i) => Math.round((c - (o.direction[i] * lengthMm) / 2) * 100) / 100);
	const end = centers.map((c, i) => Math.round((c + (o.direction[i] * lengthMm) / 2) * 100) / 100);
	const travelAcceleration = model(m).move?.travelAcceleration ?? 10000;
	const axisAccelLimits = o.axes.map((letter, i) => {
		const axis = findAxis(m, letter);
		const accel = axis?.acceleration;
		return typeof accel === "number" && accel > 0 ? accel / Math.abs(o.direction[i]) : Infinity;
	});
	return {
		motor: o.motor,
		axes: o.axes,
		start,
		end,
		distance: lengthMm,
		feedrate: Math.round(speedMmS * 60),
		acceleration: Math.floor(Math.min(travelAcceleration, ...axisAccelLimits)),
		fullStepsPerMm: o.fullStepsPerMm,
		stepFactor: o.stepFactor,
	};
}

/** Constant-speed portion of a trapezoidal move: when it starts, how long it lasts, and the total move duration. */
export interface ConstantSpeedWindow {
	/** Time from the start of the move until the constant-speed segment starts (s). */
	start: number;
	/** Duration of the constant-speed segment (s), zero if the move never reaches its feedrate. */
	duration: number;
	/** Total move duration (s). */
	moveDuration: number;
}

export function constantSpeedWindow(m: MotorMove): ConstantSpeedWindow {
	const speed = m.feedrate / 60;
	const rampTime = speed / m.acceleration;
	const rampDistance = (speed * rampTime) / 2;
	if (2 * rampDistance >= m.distance) {
		// Triangular profile: the move never reaches its feedrate.
		return { start: 0, duration: 0, moveDuration: 2 * Math.sqrt(m.distance / m.acceleration) };
	}
	const duration = (m.distance - 2 * rampDistance) / speed;
	return { start: rampTime, duration, moveDuration: 2 * rampTime + duration };
}

/** The motor's full-step frequency (Hz) for this move. */
export function fullStepFrequency(m: MotorMove): number {
	return ((m.feedrate / 60) * m.stepFactor * m.fullStepsPerMm);
}

/**
 * Sample range covering the middle 80% of the constant-speed window, clear of the acceleration
 * ramps. `offsetSec` shifts the window later in the recording - used to select the RETURN leg of a
 * round-trip capture (pass the outbound move's `moveDuration` as the offset), where the same
 * constant-speed geometry repeats a second time after the outbound pass and its own ramps.
 */
export function analysisWindow(m: MotorMove, sampleRate: number, sampleCount: number, offsetSec = 0): { start: number; end: number } {
	const w = constantSpeedWindow(m);
	const start = Math.min(sampleCount - 1, Math.round((offsetSec + w.start + 0.1 * w.duration) * sampleRate));
	const end = Math.min(sampleCount, Math.round((offsetSec + w.start + 0.9 * w.duration) * sampleRate));
	return { start, end };
}

/** G-code axis words for a coordinate set, e.g. "X90 Y110". */
export function axisWords(m: MotorMove, coords: Array<number>): string {
	return coords.map((c, i) => `${m.axes[i]}${c}`).join(" ");
}
