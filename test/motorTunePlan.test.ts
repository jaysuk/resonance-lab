import { describe, expect, it } from "vitest";

import { analyzeMotorHarmonics } from "../src/analysis/motorHarmonics";
import {
	classifyTuneCheck, estimateTuneMoves, harmonicFeasible, harmonicOrder, MAX_CORRECTION_SLOTS, orderAmplitude, planHarmonics,
	pickTopHarmonics, surveyHarmonics, SURVEY_MIN_SNR, TUNE_HARMONICS, verifyRegressed,
} from "../src/analysis/motorTunePlan";
import { getMovesPerHarmonic, type PhaseCorrection } from "../src/analysis/motorTuning";

const RATE = 3200;
const N = 8192;

/** One-channel capture: sum of sinusoids at the given frequencies/amplitudes (g). */
function tones(components: Array<{ freq: number; amp: number }>, rate = RATE, n = N): Array<Float64Array> {
	const ch = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		for (const c of components) {
			ch[i] += c.amp * Math.sin((2 * Math.PI * c.freq * i) / rate);
		}
	}
	return [ch];
}

/** Deterministic broadband noise (uniform, +/-sigma*sqrt(3)) so a capture has a realistic background level. */
function withNoise(channels: Array<Float64Array>, sigma: number, _rate = RATE): Array<Float64Array> {
	let seed = 12345;
	const rand = () => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return seed / 4294967296;
	};
	return channels.map((ch) => ch.map((v) => v + (rand() * 2 - 1) * sigma * Math.sqrt(3)));
}

const entry = (harmonic: number): PhaseCorrection => ({ harmonic, magnitude: 1, phase: 0 });

describe("harmonic catalogue", () => {
	it("maps S to full-step order S/4", () => {
		expect(TUNE_HARMONICS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
		expect(harmonicOrder(16)).toBe(4);
		expect(harmonicOrder(5)).toBe(1.25);
	});

	it("bounds orders below 1 by the fundamental, and higher orders by themselves", () => {
		// 400 Hz full-step, 1344 Hz sampling (672 Hz Nyquist): orders up to 1.5 (600 Hz) fit, order 2 (800 Hz) does not.
		expect(harmonicFeasible(1, 400, 1344)).toBe(true);
		expect(harmonicFeasible(4, 400, 1344)).toBe(true);
		expect(harmonicFeasible(6, 400, 1344)).toBe(true);
		expect(harmonicFeasible(6, 400, 1100)).toBe(false);
		expect(harmonicFeasible(8, 400, 1344)).toBe(false);
		// A fundamental over Nyquist rules out even the sub-orders - it is always located first.
		expect(harmonicFeasible(1, 700, 1344)).toBe(false);
	});
});

describe("planHarmonics", () => {
	const base = { sampleRate: 3200, fullStepHz: 400 };

	it("runs everything selected when the driver is empty and every order is measurable", () => {
		const plan = planHarmonics({ ...base, selected: [2, 4, 6], existing: [] });
		expect(plan.run).toEqual([2, 4, 6]);
		expect(plan.skipped).toEqual([]);
	});

	it("reuses the slot of a selected harmonic that already has an entry, even with four entries", () => {
		const plan = planHarmonics({ ...base, selected: [4], existing: [entry(1), entry(2), entry(3), entry(4)] });
		expect(plan.run).toEqual([4]);
		expect(plan.skipped).toEqual([]);
	});

	it("skips a new harmonic when four entries are held by harmonics not being tuned", () => {
		const plan = planHarmonics({ ...base, selected: [6], existing: [entry(1), entry(2), entry(3), entry(4)] });
		expect(plan.run).toEqual([]);
		expect(plan.skipped).toEqual([{ harmonic: 6, reason: "slots" }]);
	});

	it("admits as many new harmonics as free slots allow (three held, two new selected -> one skipped)", () => {
		const plan = planHarmonics({ ...base, selected: [6, 8], existing: [entry(1), entry(2), entry(3)] });
		expect(plan.run).toEqual([6]);
		expect(plan.skipped).toEqual([{ harmonic: 8, reason: "slots" }]);
	});

	it("never lets a free reuser lose out to a new harmonic when slots run short", () => {
		// Held: 1, 2, 3 (not selected) and 4 (selected). 6 is new and there is no slot left for it.
		const plan = planHarmonics({ ...base, selected: [6, 4], existing: [entry(1), entry(2), entry(3), entry(4)] });
		expect(plan.run).toEqual([4]);
		expect(plan.skipped).toEqual([{ harmonic: 6, reason: "slots" }]);
	});

	it("skips orders above Nyquist, and they take no slot", () => {
		const plan = planHarmonics({
			selected: [8, 6, 4], existing: [entry(1), entry(2), entry(3)], sampleRate: 1100, fullStepHz: 400,
		});
		expect(plan.skipped).toEqual([{ harmonic: 8, reason: "nyquist" }, { harmonic: 6, reason: "nyquist" }]);
		expect(plan.run).toEqual([4]);
	});

	it("flags a harmonic outside the catalogue as unmeasurable", () => {
		const plan = planHarmonics({ ...base, selected: [17], existing: [] });
		expect(plan.skipped).toEqual([{ harmonic: 17, reason: "unmeasurable" }]);
	});

	it("has the firmware's four slots by default", () => {
		expect(MAX_CORRECTION_SLOTS).toBe(4);
	});
});

describe("orderAmplitude", () => {
	it("reads the amplitude at harmonic S's order", () => {
		const analysis = analyzeMotorHarmonics(tones([{ freq: 400, amp: 0.4 }, { freq: 800, amp: 0.2 }]), RATE, 400, 1, 0.05, 4, 2);
		expect(orderAmplitude(analysis, 4)).toBeGreaterThan(0.38);
		expect(orderAmplitude(analysis, 8)).toBeGreaterThan(0.18);
		expect(orderAmplitude(analysis, 8)).toBeLessThan(0.22);
	});

	it("throws, instead of returning zero, for an order that was never requested", () => {
		// numHarmonics = 1 only analyses up to order 1, so harmonic 6 (order 1.5) is simply absent.
		const analysis = analyzeMotorHarmonics(tones([{ freq: 400, amp: 0.4 }]), RATE, 400, 1);
		expect(() => orderAmplitude(analysis, 6)).toThrow(/harmonic 6/);
	});

	it("throws for an order the analysis dropped above Nyquist", () => {
		// 1344 Hz sampling -> 672 Hz Nyquist; order 2 (800 Hz) is requested but silently dropped.
		const analysis = analyzeMotorHarmonics(tones([{ freq: 400, amp: 0.4 }], 1344, 4096), 1344, 400, 1, 0.05, 4, 2);
		expect(analysis.orders).not.toContain(2);
		expect(() => orderAmplitude(analysis, 8)).toThrow(/Nyquist/);
	});
});

describe("analyzeMotorHarmonics evaluateHarmonics", () => {
	it("leaves the fundamental and the shared orders exactly as they were", () => {
		const capture = tones([{ freq: 402, amp: 0.4 }, { freq: 201, amp: 0.15 }, { freq: 603, amp: 0.1 }, { freq: 804, amp: 0.2 }]);
		const before = analyzeMotorHarmonics(capture, RATE, 400, 1);
		const after = analyzeMotorHarmonics(capture, RATE, 400, 1, 0.05, 4, 2);
		expect(after.fundamental).toBe(before.fundamental);
		expect(after.orders.slice(0, before.orders.length)).toEqual(before.orders);
		for (let i = 0; i < before.orders.length; i++) {
			expect(after.amplitudes[0][i]).toBe(before.amplitudes[0][i]);
		}
		expect(after.orders.length).toBeGreaterThan(before.orders.length);
	});

	it("is a no-op when omitted", () => {
		const capture = tones([{ freq: 400, amp: 0.4 }]);
		const explicit = analyzeMotorHarmonics(capture, RATE, 400, 3, 0.05, 4, 3);
		const implicit = analyzeMotorHarmonics(capture, RATE, 400, 3);
		expect(explicit).toEqual(implicit);
	});
});

describe("surveyHarmonics", () => {
	const noisy = (components: Array<{ freq: number; amp: number }>) =>
		analyzeMotorHarmonics(withNoise(tones(components), 0.05), RATE, 400, 1, 0.05, 4, 2);

	it("ranks the strongest signal over background first and flags harmonics that don't clear it", () => {
		const analysis = noisy([{ freq: 400, amp: 0.4 }, { freq: 200, amp: 0.3 }, { freq: 600, amp: 0.2 }, { freq: 300, amp: 0.0005 }]);
		const rows = surveyHarmonics(analysis, [6, 2, 3]);
		expect(rows.map((r) => r.harmonic)).toEqual([2, 6, 3]);
		expect(rows[0].quiet).toBe(false);
		expect(rows[2].harmonic).toBe(3);
		expect(rows[2].quiet).toBe(true);
		expect(rows[2].snr!).toBeLessThan(SURVEY_MIN_SNR);
	});

	it("judges a high harmonic on signal over noise, not on its (tiny) displacement", () => {
		// 0.3 g at order 2 (800 Hz) is only ~0.1 um of displacement, below the old fixed cut-off, but it
		// is ten times the background and perfectly tunable.
		const analysis = analyzeMotorHarmonics(withNoise(tones([{ freq: 400, amp: 0.4 }, { freq: 800, amp: 0.3 }]), 0.01), RATE, 400, 1, 0.05, 4, 2);
		const [row] = surveyHarmonics(analysis, [8]);
		expect(row.displacementUm).toBeLessThan(0.5);
		expect(row.quiet).toBe(false);
	});

	it("falls back to the displacement threshold when the analysis carries no noise estimate", () => {
		const analysis = analyzeMotorHarmonics(tones([{ freq: 400, amp: 0.4 }, { freq: 300, amp: 0.0005 }]), RATE, 400, 1, 0.05, 4, 2);
		delete analysis.noiseFloor;
		const [row] = surveyHarmonics(analysis, [3]);
		expect(row.snr).toBeNull();
		expect(row.quiet).toBe(true);
	});

	it("averages the two move directions", () => {
		const loud = analyzeMotorHarmonics(tones([{ freq: 400, amp: 0.4 }, { freq: 200, amp: 0.4 }]), RATE, 400);
		const silent = analyzeMotorHarmonics(tones([{ freq: 400, amp: 0.4 }]), RATE, 400);
		const [alone] = surveyHarmonics(loud, [2]);
		const [both] = surveyHarmonics([loud, silent], [2]);
		expect(both.amplitude).toBeCloseTo(alone.amplitude / 2, 2);
	});
});

describe("surveying all sixteen harmonics", () => {
	// 1344 Hz sampling (672 Hz Nyquist) at a 100 Hz full-step frequency: orders up to 5 (500 Hz) fit, so all
	// sixteen S values (orders 0.25-4, up to 400 Hz) are measurable. At 400 Hz full-step only orders up to ~1.6 are.
	const survey = (fullStep: number, extra: Array<{ freq: number; amp: number }>) => surveyHarmonics(
		analyzeMotorHarmonics(withNoise(tones([{ freq: fullStep, amp: 0.4 }, ...extra], 1344, 8192), 0.01, 1344), 1344, fullStep, 1, 0.05, 4, 4),
		TUNE_HARMONICS,
	);

	it("reports an order above Nyquist as not measurable instead of throwing, and lists it last", () => {
		const rows = survey(400, [{ freq: 200, amp: 0.3 }]);
		expect(rows).toHaveLength(16);
		const s16 = rows.find((r) => r.harmonic === 16)!;
		expect(s16.measurable).toBe(false);
		expect(s16.quiet).toBe(false);
		expect(rows.slice(-1)[0].measurable).toBe(false);
		expect(rows.find((r) => r.harmonic === 2)!.measurable).toBe(true);
	});

	it("measures every harmonic when the full-step frequency leaves room", () => {
		const rows = survey(100, [{ freq: 150, amp: 0.3 }, { freq: 350, amp: 0.2 }]);
		expect(rows.every((r) => r.measurable)).toBe(true);
	});

	it("picks at most four, strongest first, skipping quiet and unmeasurable ones", () => {
		const rows = survey(100, [
			{ freq: 100, amp: 0.4 }, { freq: 50, amp: 0.35 }, { freq: 75, amp: 0.3 }, { freq: 125, amp: 0.25 },
			{ freq: 150, amp: 0.2 }, { freq: 175, amp: 0.15 },
		]);
		const top = pickTopHarmonics(rows);
		expect(top).toHaveLength(4);
		expect(top).toEqual(rows.filter((r) => !r.quiet).slice(0, 4).map((r) => r.harmonic));
		// Strongest first: S4 (order 1) carries the largest amplitude here
		expect(top[0]).toBe(4);
		expect(pickTopHarmonics(rows, 2)).toHaveLength(2);
	});

	it("offers nothing when no harmonic clears the background", () => {
		const rows = surveyHarmonics(analyzeMotorHarmonics(withNoise(tones([], 1344, 8192), 0.05, 1344), 1344, 100, 1, 0.05, 4, 4), TUNE_HARMONICS);
		expect(pickTopHarmonics(rows)).toEqual([]);
	});
});

describe("analyzeMotorHarmonics noiseFloor", () => {
	it("tracks the broadband level and ignores the tones", () => {
		const quietAnalysis = analyzeMotorHarmonics(withNoise(tones([{ freq: 400, amp: 0.4 }]), 0.01), RATE, 400, 1, 0.05, 4, 2);
		const loudAnalysis = analyzeMotorHarmonics(withNoise(tones([{ freq: 400, amp: 0.4 }]), 0.1), RATE, 400, 1, 0.05, 4, 2);
		expect(loudAnalysis.noiseFloor![0] / quietAnalysis.noiseFloor![0]).toBeGreaterThan(5);
		expect(quietAnalysis.noiseFloor![0]).toBeLessThan(0.01);
	});
});

describe("verifyRegressed", () => {
	it("flags a clear rise over what the search measured", () => {
		expect(verifyRegressed(0.5, 0.2, 1, 1.25)).toBe(true);
	});

	it("ignores a rise within the ratio", () => {
		expect(verifyRegressed(0.24, 0.2, 1, 1.25)).toBe(false);
	});

	it("ignores a big relative rise that is a tiny share of the untuned baseline (scatter near the floor)", () => {
		// 0.01 -> 0.02 is +100%, but only 1% of a baseline of 1.
		expect(verifyRegressed(0.02, 0.01, 1, 1.25)).toBe(false);
	});
});

describe("estimateTuneMoves", () => {
	it("counts every harmonic's search, the optional survey and the final verification", () => {
		expect(estimateTuneMoves(2, false, false)).toBe(2 * getMovesPerHarmonic(false) + 1);
		expect(estimateTuneMoves(4, false, true)).toBe(4 * getMovesPerHarmonic(false) + 2);
		expect(estimateTuneMoves(1, true, false)).toBe(getMovesPerHarmonic(true) + 1);
	});

	it("is zero when nothing is selected", () => {
		expect(estimateTuneMoves(0, false, true)).toBe(0);
	});
});

describe("classifyTuneCheck", () => {
	it("calls a drop beyond the scatter threshold better and a rise worse", () => {
		expect(classifyTuneCheck(2, 0.01, 0.004).outcome).toBe("better");
		expect(classifyTuneCheck(2, 0.01, 0.004).change).toBeCloseTo(-0.6, 9);
		expect(classifyTuneCheck(4, 0.01, 0.015).outcome).toBe("worse");
	});

	it("treats a move within 20% as unchanged, whichever way it goes", () => {
		expect(classifyTuneCheck(2, 0.01, 0.0085).outcome).toBe("unchanged");
		expect(classifyTuneCheck(2, 0.01, 0.0115).outcome).toBe("unchanged");
	});

	it("does not divide by a zero baseline", () => {
		expect(classifyTuneCheck(2, 0, 0.01)).toMatchObject({ change: 0, outcome: "unchanged" });
	});
});
