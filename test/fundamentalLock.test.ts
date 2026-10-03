import { describe, expect, it } from "vitest";

import {
	analyzeTuneLeg, LOCK_NOMINAL_WARN_REL, LOCK_OUTLIER_REL, LockTracker, READ_TOLERANCE,
} from "../src/analysis/fundamentalLock";
import { analyzeMotorHarmonics, combineAxes } from "../src/analysis/motorHarmonics";
import { harmonicOrder } from "../src/analysis/motorTunePlan";
import { readingStats, recordCapture, startRun } from "../src/analysis/tuneDiagnostics";

// The field capture this guards against: 400.4 Hz full-step frequency sampled at 1380 Hz over a 4.5 s
// constant-speed window. Order 1 is a weak line (a few mg), order 0.5 a strong narrow one (0.39 g at 200.15 Hz),
// and a stationary line at 401.2 Hz outweighs order 1 - so the fundamental locks ~1 Hz high.
const RATE = 1380;
const N = Math.round(4.5 * RATE);
const NOMINAL = 400.4;

function noise(n: number, rms: number, seed: number): Float64Array {
	const out = new Float64Array(n);
	let x = seed;
	for (let i = 0; i < n; i++) {
		x = (x * 1664525 + 1013904223) % 4294967296;
		out[i] = ((x / 4294967296) - 0.5) * Math.sqrt(12) * rms;
	}
	return out;
}

function capture(lines: Array<[number, number]>, seed = 1): Array<Float64Array> {
	const ch = noise(N, 0.004, seed);
	for (const [freq, amp] of lines) {
		for (let i = 0; i < N; i++) {
			ch[i] += amp * Math.sin((2 * Math.PI * freq * i) / RATE + freq);
		}
	}
	return [ch];
}

const MISLOCKED: Array<[number, number]> = [[200.15, 0.39], [400.2, 0.005], [401.2, 0.009]];

describe("analyzeTuneLeg", () => {
	it("reads a narrow order at full strength although the lock is a hertz off", () => {
		const signal = capture(MISLOCKED);
		const point = analyzeMotorHarmonics(signal, RATE, NOMINAL, 1, 0.05, 4, 1);
		expect(point.fundamental).toBeGreaterThan(400.9); // locked onto the 401.2 Hz line, not the motor's
		const pointS2 = combineAxes(point)[point.orders.indexOf(0.5)];
		expect(pointS2).toBeLessThan(0.15); // the old point read misses the 200.15 Hz line

		const tuned = analyzeTuneLeg(signal, RATE, NOMINAL, 1);
		const s2 = combineAxes(tuned)[tuned.orders.indexOf(0.5)];
		expect(s2).toBeGreaterThan(0.35);
		expect(s2).toBeLessThan(0.42);
		expect(tuned.frequencies[tuned.orders.indexOf(0.5)]).toBeCloseTo(200.15, 0); // reports where it found the line
	});

	it("reads the same S2 line whichever way the lock lands", () => {
		const good = analyzeTuneLeg(capture([[200.15, 0.39], [400.2, 0.02]], 2), RATE, NOMINAL, 1);
		const bad = analyzeTuneLeg(capture(MISLOCKED, 3), RATE, NOMINAL, 1);
		const at = (h: typeof good): number => combineAxes(h)[h.orders.indexOf(0.5)];
		expect(Math.abs(at(good) - at(bad)) / at(good)).toBeLessThan(0.1);
	});

	it("keeps the background estimator comparable: a quiet order does not read above the band's own floor by much", () => {
		const tuned = analyzeTuneLeg(capture([[200.15, 0.39]], 4), RATE, NOMINAL, 1);
		const s5 = combineAxes(tuned)[tuned.orders.indexOf(1.25)] ?? 0;
		const floor = tuned.noiseFloor![0];
		expect(s5).toBeLessThan(floor * 3);
	});

	it("falls back to the wide window when the lock ends on the edge of the narrow one", () => {
		const signal = capture([[410, 0.3]], 5);
		const narrow = analyzeMotorHarmonics(signal, RATE, NOMINAL, 1, 0.005, 4, 1, READ_TOLERANCE);
		expect(narrow.lockedAtEdge).toBe(true);
		const tuned = analyzeTuneLeg(signal, RATE, NOMINAL, 1);
		expect(tuned.fundamental).toBeGreaterThan(409);
		expect(tuned.fundamental).toBeLessThan(411);
	});

	it("does not flag an edge lock when the line is where it should be", () => {
		const tuned = analyzeTuneLeg(capture([[400.4, 0.3]], 6), RATE, NOMINAL, 1);
		expect(tuned.lockedAtEdge).toBe(false);
		expect(tuned.fundamental).toBeGreaterThan(400.2);
		expect(tuned.fundamental).toBeLessThan(400.6);
	});

	it("reads exactly at order x fundamental when no tolerance is asked for (other tasks unchanged)", () => {
		const result = analyzeMotorHarmonics(capture(MISLOCKED, 7), RATE, NOMINAL, 1, 0.05, 4, 1);
		result.orders.forEach((order, i) => expect(result.frequencies[i]).toBeCloseTo(order * result.fundamental, 9));
		expect(result.lockedAtEdge).toBeDefined();
	});
});

describe("LockTracker", () => {
	it("has nothing to compare the first capture with", () => {
		const tracker = new LockTracker(NOMINAL);
		expect(tracker.check([400.2, 401.18])).toEqual({ outlier: false, deviation: 0 });
	});

	it("compares each move direction with its own history (they lock a few tenths of a percent apart)", () => {
		const tracker = new LockTracker(NOMINAL);
		tracker.record([400.2, 401.18]);
		tracker.record([400.15, 401.12]);
		expect(tracker.check([400.23, 401.2]).outlier).toBe(false);
	});

	it("flags the capture the field run mislocked by about a hertz, in either leg", () => {
		const tracker = new LockTracker(NOMINAL);
		for (const f of [400.2, 400.23, 400.15]) {
			tracker.record([f, 401.18]);
		}
		const low = tracker.check([399.29, 401.16]);
		expect(low.outlier).toBe(true);
		expect(low.deviation).toBeGreaterThan(LOCK_OUTLIER_REL);
		expect(tracker.check([400.2, 399.9]).outlier).toBe(true);
		expect(tracker.check([393.5, 399.96]).outlier).toBe(true);
	});

	it("is not anchored by a bad first capture once later ones outvote it", () => {
		const tracker = new LockTracker(NOMINAL);
		tracker.record([399.29, 401.16]); // the odd one out
		tracker.record([400.2, 401.18]);
		tracker.record([400.18, 401.2]);
		expect(tracker.check([400.22, 401.17]).outlier).toBe(false);
	});

	it("is quiet for the healthy pattern seen in the field", () => {
		const tracker = new LockTracker(NOMINAL);
		for (const [a, b] of [[400.19, 401.18], [400.23, 401.12], [400.17, 400.91], [400.17, 401.14], [400.15, 401.08]]) {
			tracker.record([a, b]);
		}
		const summary = tracker.summary();
		expect(summary.warnings).toEqual([]);
		expect(summary.legs[1].deviation).toBeLessThan(LOCK_NOMINAL_WARN_REL);
	});

	it("warns when the lock is far from the commanded frequency", () => {
		const tracker = new LockTracker(NOMINAL);
		tracker.record([405.5, 405.6]);
		tracker.record([405.4, 405.7]);
		const warning = tracker.summary().warnings[0];
		expect(warning.kind).toBe("offNominal");
		if (warning.kind === "offNominal") {
			expect(warning.percent).toBeGreaterThan(1);
			expect(warning.expected).toBe(NOMINAL);
		}
	});

	it("warns when captures had to be accepted despite a disagreeing lock, and counts retakes", () => {
		const tracker = new LockTracker(NOMINAL);
		tracker.record([400.2, 401.18]);
		tracker.noteRetake();
		tracker.record([399.3, 401.18], { stillOutlier: true });
		const summary = tracker.summary();
		expect(summary.retakes).toBe(1);
		expect(summary.unsteady).toBe(1);
		expect(summary.warnings.some((w) => w.kind === "unsteady")).toBe(true);
	});
});

describe("diagnostics and rejected takes", () => {
	it("leaves a rejected take out of the scatter but keeps it in the file", () => {
		const leg = analyzeTuneLeg(capture([[200.15, 0.39]], 8), RATE, NOMINAL, 1);
		const run = startRun("survey", {});
		const take = (rejected: boolean, attempt: number): void => recordCapture(
			run, { kind: "survey", applied: [] }, { legs: [leg, leg], samplingRate: RATE, sampleCount: N, overflows: 0, attempt, rejected, lockDeviation: rejected ? 0.003 : 0 },
		);
		take(true, 1);
		take(false, 2);
		expect(run.captures).toHaveLength(2);
		expect(run.captures[0]).toMatchObject({ rejected: true, attempt: 1, lockDeviation: 0.003 });
		expect(readingStats(run, 2)?.n).toBe(1);
		expect(harmonicOrder(2)).toBe(0.5);
	});
});

// Second field capture: 620.5 Hz full-step. Tuning S4 (order 1) took that line from 0.0135 g to ~0.0045 g, and with
// it gone one move direction's lock jumped to 632.5 / 604.8 Hz - 2-3% out, outside every window above - halving
// every reading in the capture, S2 included.
describe("a hinted lock", () => {
	const NOMINAL_HI = 620.49;
	const REFERENCE = 620.4;
	function correctedOrderOne(seed: number): Array<Float64Array> {
		const ch = noise(N, 0.004, seed);
		for (const [freq, amp] of [[310.2, 0.09], [REFERENCE, 0.0003], [623.55, 0.012], [632.5, 0.02]] as Array<[number, number]>) {
			for (let i = 0; i < N; i++) {
				ch[i] += amp * Math.sin((2 * Math.PI * freq * i) / RATE + freq);
			}
		}
		return [ch];
	}
	const s2 = (h: ReturnType<typeof analyzeTuneLeg>): number => combineAxes(h)[h.orders.indexOf(0.5)];

	it("loses the line without a hint once order 1 has been corrected away", () => {
		const free = analyzeTuneLeg(correctedOrderOne(11), RATE, NOMINAL_HI, 1);
		expect(Math.abs(free.fundamental - REFERENCE) / REFERENCE).toBeGreaterThan(0.01);
		expect(s2(free)).toBeLessThan(0.05);
	});

	it("stays on the established lock and still reads S2 in full", () => {
		const hinted = analyzeTuneLeg(correctedOrderOne(11), RATE, NOMINAL_HI, 1, REFERENCE);
		expect(Math.abs(hinted.fundamental - REFERENCE) / REFERENCE).toBeLessThan(0.0025);
		expect(s2(hinted)).toBeGreaterThan(0.08);
		expect(s2(hinted)).toBeLessThan(0.1);
	});

	it("is offered by the tracker only once enough captures agree, per leg", () => {
		const tracker = new LockTracker(NOMINAL_HI);
		expect(tracker.reference(0)).toBeUndefined();
		tracker.record([620.4, 620.3]);
		tracker.record([620.42, 620.34]);
		expect(tracker.reference(0)).toBeUndefined();
		tracker.record([620.38, 620.3]);
		expect(tracker.reference(0)).toBeCloseTo(620.4, 2);
		expect(tracker.reference(1)).toBeCloseTo(620.3, 2);
	});

	it("starts established from a seed (the survey's locks)", () => {
		const tracker = new LockTracker(NOMINAL_HI, [620.4, 620.3]);
		expect(tracker.reference(0)).toBe(620.4);
		expect(tracker.reference(1)).toBe(620.3);
		expect(tracker.check([620.45, 620.35]).outlier).toBe(false);
		expect(tracker.check([632.5, 620.3]).outlier).toBe(true);
	});
});
