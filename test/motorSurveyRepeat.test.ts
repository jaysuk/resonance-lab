import { describe, expect, it } from "vitest";

import type { MotorHarmonics } from "../src/analysis/motorHarmonics";
import {
	pickTopHarmonics, SURVEY_MIN_STABILITY, surveyHarmonics, surveyRepeated, TUNE_HARMONICS,
} from "../src/analysis/motorTunePlan";
import {
	buildDiagnosticsExport, harmonicReadings, MAX_LOGGED_RUNS, pushRun, recordCapture, startRun, finishRun, type DiagLabel,
} from "../src/analysis/tuneDiagnostics";

/** A synthetic analysis with the given amplitude (g) at each harmonic S (order S/4), orders 0.25..4, background 0.001. */
function analysis(amps: Record<number, number>, fundamental = 100): MotorHarmonics {
	const orders = TUNE_HARMONICS.map((h) => h / 4);
	return {
		fundamental,
		orders,
		frequencies: orders.map((o) => o * fundamental),
		amplitudes: [Float64Array.from(TUNE_HARMONICS.map((h) => amps[h] ?? 0.0005))],
		noiseFloor: Float64Array.of(0.001),
	};
}

/** One capture = two move directions with the same readings. */
const capture = (amps: Record<number, number>) => [analysis(amps), analysis(amps)];

describe("surveyRepeated", () => {
	// S4 repeats to within 2%, S2 swings from 0.02 to 0.005 between captures at about the same mean as S4's level.
	const captures = [
		capture({ 4: 0.100, 2: 0.020, 1: 0.0004 }),
		capture({ 4: 0.102, 2: 0.006, 1: 0.0004 }),
		capture({ 4: 0.099, 2: 0.019, 1: 0.0004 }),
		capture({ 4: 0.101, 2: 0.005, 1: 0.0004 }),
		capture({ 4: 0.100, 2: 0.020, 1: 0.0004 }),
	];
	const rows = surveyRepeated(captures, TUNE_HARMONICS);
	const row = (h: number) => rows.find((r) => r.harmonic === h)!;

	it("reads the mean and the capture-to-capture scatter of every harmonic", () => {
		expect(row(4).captures).toBe(5);
		expect(row(4).amplitude).toBeCloseTo(0.1004, 3);
		expect(row(4).stdev!).toBeLessThan(0.002);
		expect(row(4).stability!).toBeGreaterThan(SURVEY_MIN_STABILITY);
		expect(row(2).stability!).toBeLessThan(SURVEY_MIN_STABILITY);
	});

	it("marks a strong but scattering harmonic unstable, and does not offer it", () => {
		expect(row(2).quiet).toBe(false);
		expect(row(2).stable).toBe(false);
		expect(row(4).stable).toBe(true);
		expect(pickTopHarmonics(rows)).toEqual([4]);
	});

	it("ranks repeatable first, then scattering ones, then quiet, then unmeasurable", () => {
		const order = rows.map((r) => r.harmonic);
		expect(order[0]).toBe(4);
		expect(order[1]).toBe(2);
		expect(row(1).quiet).toBe(true);
		expect(order.indexOf(1)).toBeGreaterThan(order.indexOf(2));
	});

	it("ranks on repeatability, so a strong scattering order cannot outrank a steady one", () => {
		const steady = surveyRepeated([capture({ 3: 0.02 }), capture({ 3: 0.0201 }), capture({ 3: 0.0199 })], [3, 5]);
		const loud = surveyRepeated([capture({ 5: 0.3 }), capture({ 5: 0.1 }), capture({ 5: 0.2 })], [3, 5]);
		expect(steady[0].harmonic).toBe(3);
		expect(loud.find((r) => r.harmonic === 5)!.stable).toBe(false);
	});

	it("treats identical captures as perfectly repeatable", () => {
		const [r] = surveyRepeated([capture({ 4: 0.1 }), capture({ 4: 0.1 })], [4]);
		expect(r.stdev).toBe(0);
		expect(r.stability).toBe(Infinity);
		expect(r.stable).toBe(true);
	});

	it("keeps a single capture behaving as before: no scatter to judge, so nothing is held against it", () => {
		const single = surveyHarmonics(capture({ 4: 0.1 }), [4]);
		expect(single[0].stdev).toBeNull();
		expect(single[0].stability).toBeNull();
		expect(single[0].stable).toBe(true);
		expect(single[0].captures).toBe(1);
	});

	it("reports a harmonic that any capture could not see as not measurable", () => {
		const short = analysis({ 4: 0.1 });
		short.orders = short.orders.slice(0, 4);
		short.frequencies = short.frequencies.slice(0, 4);
		short.amplitudes = [short.amplitudes[0].slice(0, 4)];
		const [r] = surveyRepeated([capture({ 16: 0.1 }), [short, short]], [16]);
		expect(r.measurable).toBe(false);
	});
});

describe("diagnostics log", () => {
	const label: DiagLabel = { kind: "probe", harmonic: 4, magnitude: 1, phase: 90, applied: [{ harmonic: 2, magnitude: 1, phase: 270 }] };

	it("reads every harmonic's mean amplitude across the legs", () => {
		const legs = [analysis({ 4: 0.1, 2: 0.2 }), analysis({ 4: 0.3, 2: 0.2 })];
		const readings = harmonicReadings(legs);
		expect(readings.S4).toBeCloseTo(0.2);
		expect(readings.S2).toBeCloseTo(0.2);
		expect(Object.keys(readings)).toHaveLength(16);
	});

	it("omits harmonics whose order a leg did not analyse", () => {
		const short = analysis({ 4: 0.1 });
		short.orders = short.orders.slice(0, 4);
		short.frequencies = short.frequencies.slice(0, 4);
		short.amplitudes = [short.amplitudes[0].slice(0, 4)];
		expect(Object.keys(harmonicReadings([short]))).toEqual(["S1", "S2", "S3", "S4"]);
	});

	it("records a capture with what was applied, copied rather than aliased", () => {
		const run = startRun("tune", { motor: "X" });
		recordCapture(run, label, { legs: [analysis({ 4: 0.1 })], samplingRate: 1343.7, sampleCount: 9000, overflows: 0 });
		label.applied[0].magnitude = 99;
		expect(run.captures[0].applied[0].magnitude).toBe(1);
		expect(run.captures[0].seq).toBe(1);
		expect(run.captures[0].legs[0].combined).toHaveLength(16);
		expect(run.captures[0].legs[0].noiseFloor).toEqual([0.001]);
		expect(run.captures[0].samplingRate).toBeCloseTo(1343.7, 1);
	});

	it("exports plain JSON, with per-harmonic scatter for a survey run", () => {
		const run = startRun("survey", { motor: "X" });
		for (const v of [0.1, 0.12, 0.08]) {
			recordCapture(run, { kind: "survey", applied: [] }, { legs: [analysis({ 4: v })], samplingRate: 1344, sampleCount: 9000, overflows: 0 });
		}
		finishRun(run, "completed");
		const out = JSON.parse(JSON.stringify(buildDiagnosticsExport([run], { page: "test" }))) as {
			schema: number; runs: Array<{ outcome: string; scatter: Record<string, { n: number; mean: number; stdev: number }> }>;
		};
		expect(out.schema).toBe(1);
		expect(out.runs[0].outcome).toBe("completed");
		expect(out.runs[0].scatter.S4.n).toBe(3);
		expect(out.runs[0].scatter.S4.mean).toBeCloseTo(0.1);
		expect(out.runs[0].scatter.S4.stdev).toBeCloseTo(0.02);
	});

	it("keeps only the most recent runs", () => {
		const runs: Array<ReturnType<typeof startRun>> = [];
		for (let i = 0; i < MAX_LOGGED_RUNS + 5; i++) {
			pushRun(runs, startRun("verify", { i }));
		}
		expect(runs).toHaveLength(MAX_LOGGED_RUNS);
		expect(runs[0].context.i).toBe(5);
	});
});
