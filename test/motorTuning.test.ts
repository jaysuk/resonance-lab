import { describe, expect, it } from "vitest";

import {
	defaultTuningSchedule, getMovesPerHarmonic, parsePhaseCorrections, tuneHarmonic, type TuningMeasurement,
} from "../src/analysis/motorTuning";

/**
 * Build a synthetic `measure` that models a fixed error vector E per direction: applying a
 * correction (J, O) gives amplitude |E + J*e^(iO)|. Both directions share the same error unless
 * `errors` gives two.
 */
function makeMeasure(errors: [{ mag: number; phaseDeg: number }, { mag: number; phaseDeg: number }?]) {
	// Always resolve exactly two directions - the second falls back to the first when not given.
	const e = [0, 1].map((i) => {
		const err = errors[i] ?? errors[0];
		const rad = (err.phaseDeg * Math.PI) / 180;
		return { x: err.mag * Math.cos(rad), y: err.mag * Math.sin(rad) };
	});
	const calls: Array<{ magnitude: number; phase: number }> = [];
	async function measure(magnitude: number, phase: number): Promise<TuningMeasurement> {
		calls.push({ magnitude, phase });
		const rad = (phase * Math.PI) / 180;
		const cx = magnitude * Math.cos(rad), cy = magnitude * Math.sin(rad);
		const amplitudes = e.map((err) => {
			const x = err.x + cx, y = err.y + cy;
			return Math.sqrt(x * x + y * y);
		}) as [number, number];
		return { harmonic: 0, magnitude, phase, amplitude: (amplitudes[0] + amplitudes[1]) / 2, amplitudes };
	}
	return { measure, calls };
}

describe("tuneHarmonic", () => {
	it("converges on roughly the negative of the error vector", async () => {
		const { measure } = makeMeasure([{ mag: 2, phaseDeg: 40 }]);
		const result = await tuneHarmonic(4, measure, false);
		// The optimal correction cancels the error: magnitude ~2, phase ~40+180=220.
		expect(result.best.magnitude).toBeGreaterThan(1.6);
		expect(result.best.magnitude).toBeLessThan(2.4);
		const raw = (((result.best.phase - 220) % 360) + 360) % 360; // 0..360
		const angularDistance = Math.min(raw, 360 - raw); // shortest distance to 220, 0..180
		expect(angularDistance).toBeLessThan(25);
		expect(result.best.amplitude).toBeLessThan(result.baseline * 0.3);
	});

	it("uses exactly the documented move budget", async () => {
		const { measure: freeMeasure, calls: freeCalls } = makeMeasure([{ mag: 1, phaseDeg: 10 }]);
		await tuneHarmonic(4, freeMeasure, false);
		expect(freeCalls.length).toBe(10);
		expect(freeCalls.length).toBe(getMovesPerHarmonic(false));

		const { measure: constrMeasure, calls: constrCalls } = makeMeasure([{ mag: 1, phaseDeg: 0 }]);
		await tuneHarmonic(4, constrMeasure, true);
		expect(constrCalls.length).toBe(6);
		expect(constrCalls.length).toBe(getMovesPerHarmonic(true));
	});

	it("only ever requests phase 0 or 180 when constrained", async () => {
		const { measure, calls } = makeMeasure([{ mag: 1.5, phaseDeg: 180 }]);
		const result = await tuneHarmonic(4, measure, true);
		for (const call of calls) {
			expect([0, 180]).toContain(call.phase);
		}
		expect([0, 180]).toContain(result.best.phase);
	});

	it("does not adopt a correction that fails to improve on the baseline", async () => {
		async function noisyMeasure(magnitude: number, phase: number): Promise<TuningMeasurement> {
			return { harmonic: 0, magnitude, phase, amplitude: 1, amplitudes: [1, 1] };
		}
		const result = await tuneHarmonic(4, noisyMeasure, false);
		expect(result.best.magnitude).toBe(0);
		expect(result.best.amplitude).toBe(result.baseline);
	});

	it("does not throw or produce NaN on an all-zero response", async () => {
		async function zeroMeasure(magnitude: number, phase: number): Promise<TuningMeasurement> {
			return { harmonic: 0, magnitude, phase, amplitude: 0, amplitudes: [0, 0] };
		}
		const result = await tuneHarmonic(4, zeroMeasure, false);
		expect(Number.isNaN(result.best.magnitude)).toBe(false);
		expect(Number.isNaN(result.best.phase)).toBe(false);
		expect(Number.isFinite(result.best.magnitude)).toBe(true);
	});

	it("never requests a magnitude above the schedule's maxMagnitude", async () => {
		const { measure, calls } = makeMeasure([{ mag: 50, phaseDeg: 0 }]);
		await tuneHarmonic(4, measure, false, defaultTuningSchedule);
		for (const call of calls) {
			expect(call.magnitude).toBeLessThanOrEqual(defaultTuningSchedule.maxMagnitude);
		}
	});

	it("produces a finite result when the two directions have different error vectors", async () => {
		const { measure } = makeMeasure([{ mag: 1, phaseDeg: 0 }, { mag: 2, phaseDeg: 90 }]);
		const result = await tuneHarmonic(4, measure, false);
		expect(Number.isFinite(result.best.magnitude)).toBe(true);
		expect(Number.isFinite(result.best.phase)).toBe(true);
		expect(result.best.magnitude).toBeGreaterThan(0);
		expect(result.best.magnitude).toBeLessThanOrEqual(defaultTuningSchedule.maxMagnitude);
	});
});

describe("parsePhaseCorrections", () => {
	it("parses a multi-harmonic reply", () => {
		const parsed = parsePhaseCorrections("Driver 0 waveform correction: S2 J1.500 O200.0, S4 J0.300 O0.0");
		expect(parsed).toEqual([
			{ harmonic: 2, magnitude: 1.5, phase: 200 },
			{ harmonic: 4, magnitude: 0.3, phase: 0 },
		]);
	});

	it("returns an empty array for 'none'", () => {
		expect(parsePhaseCorrections("Driver 0 waveform correction: none")).toEqual([]);
	});
});
