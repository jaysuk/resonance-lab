/**
 * RepRapFirmware's native input-shaper definitions (M593 P"..."), as implemented in RRF's
 * AxisShaper.cpp: MZV, ZVD, ZVDD, ZVDDD, EI2 (2-hump EI) and EI3 (3-hump EI). Each shaper is a
 * short train of impulses (amplitudes + delays) derived from the target frequency and damping
 * ratio - the standard input-shaping formulation from the vibration-control literature
 * (Singer/Singhose et al.).
 */

export interface ShaperImpulses {
	/** Impulse amplitudes (not necessarily normalised; consumers divide by the sum). */
	amplitudes: Array<number>;
	/** Impulse times in seconds, first always 0. */
	delays: Array<number>;
}

export type ShaperName = "mzv" | "zvd" | "zvdd" | "zvddd" | "ei2" | "ei3";

export interface ShaperDefinition {
	name: ShaperName;
	/** RRF M593 P parameter value. */
	rrfName: string;
	/** Below this target frequency the shaper's impulse train gets too long to be useful. */
	minFreq: number;
	init: (freq: number, dampingRatio: number) => ShaperImpulses;
}

function mzv(freq: number, zeta: number): ShaperImpulses {
	const df = Math.sqrt(1 - zeta * zeta);
	const K = Math.exp((-0.75 * zeta * Math.PI) / df);
	const td = 1 / (freq * df);
	const a1 = 1 - 1 / Math.sqrt(2);
	const a2 = (Math.sqrt(2) - 1) * K;
	const a3 = a1 * K * K;
	return { amplitudes: [a1, a2, a3], delays: [0, 0.375 * td, 0.75 * td] };
}

function zvd(freq: number, zeta: number): ShaperImpulses {
	const df = Math.sqrt(1 - zeta * zeta);
	const K = Math.exp((-zeta * Math.PI) / df);
	const td = 1 / (freq * df);
	return { amplitudes: [1, 2 * K, K * K], delays: [0, 0.5 * td, td] };
}

function zvdd(freq: number, zeta: number): ShaperImpulses {
	const df = Math.sqrt(1 - zeta * zeta);
	const K = Math.exp((-zeta * Math.PI) / df);
	const td = 1 / (freq * df);
	return { amplitudes: [1, 3 * K, 3 * K * K, K * K * K], delays: [0, 0.5 * td, td, 1.5 * td] };
}

function zvddd(freq: number, zeta: number): ShaperImpulses {
	const df = Math.sqrt(1 - zeta * zeta);
	const K = Math.exp((-zeta * Math.PI) / df);
	const td = 1 / (freq * df);
	return {
		amplitudes: [1, 4 * K, 6 * K * K, 4 * K * K * K, K * K * K * K],
		delays: [0, 0.5 * td, td, 1.5 * td, 2 * td],
	};
}

// EI2/EI3 polynomial expansions as used by RRF (AxisShaper.cpp).
function ei2(freq: number, zeta: number): ShaperImpulses {
	const df = Math.sqrt(1 - zeta * zeta);
	const td = 1 / (freq * df);
	const z = zeta;
	const z2 = z * z;
	const z3 = z2 * z;
	const a1 = 0.16054 + 0.76699 * z + 2.2656 * z2 - 1.2275 * z3;
	const a2 = 0.33911 + 0.45081 * z - 2.5808 * z2 + 1.7365 * z3;
	const a3 = 0.34089 - 0.61533 * z - 0.68765 * z2 + 0.42261 * z3;
	const a4 = 1 - a1 - a2 - a3;
	const d1 = (0.4989 + 0.1627 * z - 0.54262 * z2 + 6.1618 * z3) * td;
	const d2 = (0.99748 + 0.18382 * z - 1.5827 * z2 + 8.1712 * z3) * td;
	const d3 = (1.4992 - 0.09297 * z - 0.28338 * z2 + 1.8571 * z3) * td;
	return { amplitudes: [a1, a2, a3, a4], delays: [0, d1, d2, d3] };
}

function ei3(freq: number, zeta: number): ShaperImpulses {
	const df = Math.sqrt(1 - zeta * zeta);
	const td = 1 / (freq * df);
	const z = zeta;
	const z2 = z * z;
	const z3 = z2 * z;
	const a1 = 0.11275 + 0.76632 * z + 3.2916 * z2 - 1.4438 * z3;
	const a2 = 0.23698 + 0.61164 * z - 2.5785 * z2 + 4.8522 * z3;
	const a3 = 0.30008 - 0.19062 * z - 2.1456 * z2 + 0.13744 * z3;
	const a4 = 0.23775 - 0.73297 * z + 0.46885 * z2 - 2.0865 * z3;
	const a5 = 1 - a1 - a2 - a3 - a4;
	const d1 = (0.49974 + 0.23834 * z + 0.44559 * z2 + 12.472 * z3) * td;
	const d2 = (0.99849 + 0.29808 * z - 2.3646 * z2 + 23.399 * z3) * td;
	const d3 = (1.4987 + 0.10306 * z - 2.0139 * z2 + 17.032 * z3) * td;
	const d4 = (1.9996 - 0.28231 * z + 0.61536 * z2 + 5.4045 * z3) * td;
	return { amplitudes: [a1, a2, a3, a4, a5], delays: [0, d1, d2, d3, d4] };
}

/** RRF's shaper set, ordered simplest-first (the recommendation engine prefers simpler shapers). */
export const SHAPERS: Array<ShaperDefinition> = [
	{ name: "mzv", rrfName: "mzv", minFreq: 23, init: mzv },
	{ name: "zvd", rrfName: "zvd", minFreq: 29, init: zvd },
	{ name: "zvdd", rrfName: "zvdd", minFreq: 35, init: zvdd },
	{ name: "zvddd", rrfName: "zvddd", minFreq: 40, init: zvddd },
	{ name: "ei2", rrfName: "ei2", minFreq: 39, init: ei2 },
	{ name: "ei3", rrfName: "ei3", minFreq: 48, init: ei3 },
];

export const SHAPER_DISPLAY_NAMES: Record<ShaperName, string> = {
	mzv: "MZV",
	zvd: "ZVD",
	zvdd: "ZVDD",
	zvddd: "ZVDDD",
	ei2: "EI (2-hump)",
	ei3: "EI (3-hump)",
};
