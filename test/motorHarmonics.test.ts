import { describe, expect, it } from "vitest";

import {
	analyzeMotorHarmonics, gradeOrders, type MotorHarmonics, summarizeMotorSweep, toDisplacementUm,
} from "../src/analysis/motorHarmonics";

const SAMPLE_RATE = 1000;
const N = 4096;

/** Synthetic constant-speed capture: sum of sinusoids at the given frequencies/amplitudes (g), one channel. */
function toneCapture(components: Array<{ freq: number; amp: number }>, n = N, rate = SAMPLE_RATE): Array<Float64Array> {
	const ch = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let v = 0;
		for (const c of components) {
			v += c.amp * Math.sin((2 * Math.PI * c.freq * i) / rate);
		}
		ch[i] = v;
	}
	return [ch];
}

describe("analyzeMotorHarmonics", () => {
	it("finds the fundamental near a pure tone", () => {
		const result = analyzeMotorHarmonics(toneCapture([{ freq: 100, amp: 0.4 }]), SAMPLE_RATE, 98);
		expect(result.fundamental).toBeGreaterThan(99.5);
		expect(result.fundamental).toBeLessThan(100.5);
	});

	it("recovers the amplitude at the fundamental", () => {
		const result = analyzeMotorHarmonics(toneCapture([{ freq: 100, amp: 0.4 }]), SAMPLE_RATE, 100);
		const orderIndex = result.orders.indexOf(1);
		expect(orderIndex).toBeGreaterThanOrEqual(0);
		expect(result.amplitudes[0][orderIndex]).toBeGreaterThan(0.38);
		expect(result.amplitudes[0][orderIndex]).toBeLessThan(0.42);
	});

	it("resolves a quarter-order component", () => {
		const result = analyzeMotorHarmonics(
			toneCapture([{ freq: 100, amp: 0.4 }, { freq: 25, amp: 0.1 }]), SAMPLE_RATE, 100,
		);
		const q = result.orders.indexOf(0.25);
		const half = result.orders.indexOf(0.5);
		const threeQ = result.orders.indexOf(0.75);
		expect(q).toBeGreaterThanOrEqual(0);
		expect(result.amplitudes[0][q]).toBeGreaterThan(0.08);
		expect(result.amplitudes[0][q]).toBeLessThan(0.12);
		expect(result.amplitudes[0][half]).toBeLessThan(0.03);
		expect(result.amplitudes[0][threeQ]).toBeLessThan(0.03);
	});

	it("drops harmonics above the Nyquist frequency", () => {
		const result = analyzeMotorHarmonics(toneCapture([{ freq: 200, amp: 0.3 }]), SAMPLE_RATE, 200);
		const maxFreq = Math.max(...result.frequencies);
		expect(maxFreq).toBeLessThan(500);
	});

	it("throws when the nominal frequency exceeds Nyquist", () => {
		expect(() => analyzeMotorHarmonics(toneCapture([{ freq: 100, amp: 0.1 }]), SAMPLE_RATE, 490))
			.toThrow(/Nyquist/);
	});

	it("throws on a too-short capture", () => {
		expect(() => analyzeMotorHarmonics([new Float64Array(8)], SAMPLE_RATE, 100))
			.toThrow(/Too few samples/);
	});
});

describe("toDisplacementUm", () => {
	it("converts 1g at 100Hz to about 24.84 um", () => {
		expect(toDisplacementUm(1, 100)).toBeCloseTo(24.84, 2);
	});
});

describe("summarizeMotorSweep", () => {
	function harmonics(fundamental: number, order1Amp: number, order05Amp: number): MotorHarmonics {
		return {
			fundamental,
			orders: [0.5, 1],
			frequencies: [0.5 * fundamental, fundamental],
			amplitudes: [new Float64Array([order05Amp, order1Amp])],
		};
	}

	it("clusters harmonics from different speeds that land on the same absolute frequency", () => {
		// 200Hz fundamental -> order-1 at 200Hz, order-0.5 at 100Hz.
		// 100Hz fundamental -> order-1 at 100Hz. These should cluster on the 100Hz column.
		const sweep = summarizeMotorSweep([harmonics(200, 0.4, 0.05), harmonics(100, 0.2, 0.02)]);
		const col100 = sweep.frequencies.findIndex((f) => Math.abs(f - 100) < 5);
		expect(col100).toBeGreaterThanOrEqual(0);
		const order1Idx = sweep.orders.indexOf(1);
		const order05Idx = sweep.orders.indexOf(0.5);
		expect(sweep.amplitudes[order1Idx][col100]).not.toBeNull();
		expect(sweep.amplitudes[order05Idx][col100]).not.toBeNull();
		expect(sweep.ratios[order05Idx][col100]).toBeCloseTo(0.05 / 0.2, 5);
	});
});

describe("gradeOrders", () => {
	it("grades a large order-1 displacement as high", () => {
		// amplitude (g) at freq (Hz) such that toDisplacementUm > 2
		const freq = 50;
		const amp = 3 / toDisplacementUm(1, freq); // scales toDisplacementUm(amp, freq) to 3um
		const sweep = { orders: [1], frequencies: [freq], amplitudes: [[amp]], ratios: [[null]] };
		const findings = gradeOrders(sweep);
		const fullStep = findings.find((f) => f.key === "fullStep");
		expect(fullStep?.level).toBe("high");
	});

	it("grades a tiny order-1 displacement as low", () => {
		const freq = 50;
		const amp = 0.1 / toDisplacementUm(1, freq); // scales to 0.1um
		const sweep = { orders: [1], frequencies: [freq], amplitudes: [[amp]], ratios: [[null]] };
		const findings = gradeOrders(sweep);
		const fullStep = findings.find((f) => f.key === "fullStep");
		expect(fullStep?.level).toBe("low");
	});

	it("omits a finding whose orders never appear in the sweep", () => {
		const sweep = { orders: [1], frequencies: [50], amplitudes: [[0.01]], ratios: [[null]] };
		const findings = gradeOrders(sweep);
		expect(findings.find((f) => f.key === "phase")).toBeUndefined();
		expect(findings.find((f) => f.key === "waveform")).toBeUndefined();
	});

	it("skips a column with no ratio when a ratio is required", () => {
		const sweep = {
			orders: [0.5, 1],
			frequencies: [25, 50],
			amplitudes: [[0.02, null], [0.05, 0.1]],
			ratios: [[null, null], [null, 0.5]],
		};
		const findings = gradeOrders(sweep);
		expect(findings.find((f) => f.key === "phase")).toBeUndefined();
	});
});
