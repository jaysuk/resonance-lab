/**
 * Full accelerometer orientation solver (ported from our earlier 3.6 prototype's approach):
 *  - per machine-axis test move, find the chip channel that carries the INITIAL burst (onset via
 *    noise-relative threshold, then a ~5-sample window before cross-axis resonance contaminates),
 *    plus its sign and cross-coupling;
 *  - gravity (pre-motion DC) pins the chip's vertical axis and polarity - more reliable than a Z
 *    motion test;
 *  - the right-hand rule fills any missing face;
 *  - the result is the exact M955 I parameter: digit1 = where chip Z faces, digit2 = where chip X
 *    faces (0=+X 1=+Y 2=+Z 4=-X 5=-Y 6=-Z).
 */
import type { AccelCapture } from "../capture/csv";

export interface BurstResult {
	/** Chip channel that carried the initial acceleration burst (label from the CSV). */
	channel: string;
	sign: 1 | -1;
	/** 2nd-strongest / strongest burst RMS - high values mean ambiguous mounting or coupling. */
	coupling: number;
	/** Pre-motion DC per channel (gravity vector, in g). */
	dc: Array<number>;
}

/** Analyse one test-move capture: dominant chip channel, sign of the first burst, gravity DC. */
export function analyzeAxisBurst(capture: AccelCapture): BurstResult {
	const chans = capture.channels;
	const n = chans[0]?.length ?? 0;
	const preN = Math.min(50, Math.max(5, Math.floor(n * 0.05)));
	const dc = chans.map((arr) => {
		let s = 0;
		for (let i = 0; i < preN; i++) {
			s += arr[i];
		}
		return s / preN;
	});
	const dcMean = chans.map((arr) => {
		let s = 0;
		for (let i = 0; i < n; i++) {
			s += arr[i];
		}
		return s / Math.max(1, n);
	});
	const noiseRms = chans.map((arr, c) => {
		let s = 0;
		for (let i = 0; i < preN; i++) {
			s += (arr[i] - dcMean[c]) ** 2;
		}
		return Math.sqrt(s / preN) || 0.01;
	});

	// Onset: first sample where any channel leaves its noise floor decisively.
	let onset = -1;
	for (let i = preN; i < n && onset < 0; i++) {
		if (chans.some((arr, c) => Math.abs(arr[i] - dcMean[c]) > 5 * noiseRms[c])) {
			onset = i;
		}
	}

	const windowRms = (from: number, count: number) => chans.map((arr, c) => {
		let s = 0;
		for (let i = from; i < Math.min(n, from + count); i++) {
			s += (arr[i] - dcMean[c]) ** 2;
		}
		return Math.sqrt(s / Math.max(1, count));
	});

	const rms = onset >= 0 ? windowRms(onset, Math.min(5, n - onset)) : windowRms(0, n);
	let domIdx = 0;
	for (let i = 1; i < rms.length; i++) {
		if (rms[i] > rms[domIdx]) {
			domIdx = i;
		}
	}
	let sign: 1 | -1 = 1;
	if (onset >= 0) {
		let mean = 0;
		const count = Math.min(5, n - onset);
		for (let i = onset; i < onset + count; i++) {
			mean += chans[domIdx][i] - dcMean[domIdx];
		}
		sign = mean >= 0 ? 1 : -1;
	}
	const sorted = [...rms].sort((a, b) => b - a);
	return {
		channel: capture.axes[domIdx] ?? "?",
		sign,
		coupling: sorted[0] > 0 ? sorted[1] / sorted[0] : 0,
		dc,
	};
}

export interface Face { axis: "X" | "Y" | "Z"; sign: 1 | -1 }

/** Gravity: the chip channel reading ~±1g while stationary is the vertical one. */
export function detectVerticalAxis(capture: AccelCapture, dc: Array<number>): { channel: string; sign: 1 | -1 } | null {
	for (let i = 0; i < dc.length; i++) {
		if (Math.abs(dc[i]) > 0.7) {
			return { channel: capture.axes[i] ?? "?", sign: dc[i] > 0 ? 1 : -1 };
		}
	}
	return null;
}

export interface OrientationSolution {
	/** chip channel -> machine face, e.g. { X: {axis:"Y",sign:-1}, ... } */
	faces: Partial<Record<string, Face>>;
	/** The M955 I parameter (two digits) or null when underdetermined. */
	iParam: string | null;
	/** Machine axes whose moves excited an already-claimed chip channel (e.g. a bedslinger frame). */
	conflicts: Array<string>;
	/** Human summary lines: "Chip X -> machine -Y" etc. */
	summary: Array<string>;
}

const VEC: Record<"X" | "Y" | "Z", Array<number>> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

export function solveOrientation(
	moveResults: Partial<Record<"X" | "Y", BurstResult>>,
	gravity: { channel: string; sign: 1 | -1 } | null,
): OrientationSolution {
	const faces: Partial<Record<string, Face>> = {};
	const conflicts: Array<string> = [];
	for (const [machineAxis, r] of Object.entries(moveResults) as Array<["X" | "Y", BurstResult]>) {
		if (!r) {
			continue;
		}
		if (faces[r.channel]) {
			conflicts.push(machineAxis); // same chip channel claimed twice -> frame coupling
		} else {
			faces[r.channel] = { axis: machineAxis, sign: r.sign };
		}
	}
	if (gravity) {
		faces[gravity.channel] = { axis: "Z", sign: gravity.sign };
	}

	// Right-hand-rule completion: Z = X x Y etc.
	const axisVec = (f?: Face) => (f ? VEC[f.axis].map((c) => c * f.sign) : null);
	const cross = (a: Array<number>, b: Array<number>) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	const vecToFace = (v: Array<number>): Face | null => {
		for (const axis of ["X", "Y", "Z"] as const) {
			const dot = v[0] * VEC[axis][0] + v[1] * VEC[axis][1] + v[2] * VEC[axis][2];
			if (dot > 0.5) {
				return { axis, sign: 1 };
			}
			if (dot < -0.5) {
				return { axis, sign: -1 };
			}
		}
		return null;
	};
	const chips = ["X", "Y", "Z"];
	const fill = (target: string, a: string, b: string) => {
		if (!faces[target] && faces[a] && faces[b]) {
			const f = vecToFace(cross(axisVec(faces[a])!, axisVec(faces[b])!));
			if (f) {
				faces[target] = f;
			}
		}
	};
	fill("Z", "X", "Y");
	fill("X", "Y", "Z");
	fill("Y", "Z", "X");

	const digit = (f: Face) => (f.axis === "X" ? (f.sign > 0 ? 0 : 4) : f.axis === "Y" ? (f.sign > 0 ? 1 : 5) : f.sign > 0 ? 2 : 6);
	const iParam = faces.Z && faces.X ? `${digit(faces.Z)}${digit(faces.X)}` : null;
	const summary = chips.map((ch) => {
		const f = faces[ch];
		return `Chip ${ch} → ${f ? `machine ${f.sign > 0 ? "+" : "−"}${f.axis}` : "?"}`;
	});
	return { faces, iParam, conflicts, summary };
}
