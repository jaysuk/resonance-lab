import { describe, expect, it } from "vitest";

import { compareBeltCsvs } from "../src/analysis/belts";
import { generateSweep } from "../src/capture/sweep";
import { runBeltCapture, type MachineIO } from "../src/capture/orchestrator";

/** Synthetic belt capture: ringing at f0 with the given amplitude. */
function beltCsv(f0: number, amp: number): string {
	const fs = 1000;
	const lines = ["Sample,X,Y,Z"];
	let seed = 7;
	const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
	for (let i = 0; i < 6000; i++) {
		const t = i / fs;
		const ring = Math.exp(-8 * (t % 0.5)) * Math.sin(2 * Math.PI * f0 * t);
		lines.push(`${i},${(amp * ring + 0.1 * rand()).toFixed(5)},${(0.3 * amp * ring + 0.1 * rand()).toFixed(5)},0.98`);
	}
	lines.push(`Rate ${fs} overflows 0`);
	return lines.join("\n");
}

/** Two near-equal resonances on a shared plateau; a0/a1 set which sub-peak dominates. */
function beltCsvTwoPeak(f0: number, a0: number, f1: number, a1: number, seed0 = 7): string {
	const fs = 1000;
	const lines = ["Sample,X,Y,Z"];
	let seed = seed0;
	const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
	for (let i = 0; i < 6000; i++) {
		const t = i / fs;
		const env = Math.exp(-8 * (t % 0.5));
		const ring = env * (a0 * Math.sin(2 * Math.PI * f0 * t) + a1 * Math.sin(2 * Math.PI * f1 * t));
		lines.push(`${i},${(ring + 0.1 * rand()).toFixed(5)},${(0.3 * ring + 0.1 * rand()).toFixed(5)},0.98`);
	}
	lines.push(`Rate ${fs} overflows 0`);
	return lines.join("\n");
}

describe("belt comparison", () => {
	it("balanced, near-identical belts stay matched even when the dominant sub-peak differs", () => {
		// Same multi-peak ridge, balanced energy — but A leans on the 60 Hz peak and B on the 72 Hz
		// peak. This must read "matched" (a brittle single-peak proximity gate used to call it tension).
		const r = compareBeltCsvs(beltCsvTwoPeak(60, 2, 72, 1.9, 7), beltCsvTwoPeak(60, 1.9, 72, 2, 19));
		expect(r.similarity).toBeGreaterThan(0.9);
		expect(Math.abs(r.energyRatio - 1)).toBeLessThan(0.3); // balanced
		expect(Math.abs(r.peakA - r.peakB)).toBeGreaterThan(5); // dominant sub-peaks disagree
		expect(r.verdict).toBe("matched");
	});

	it("identical belts are matched", () => {
		const r = compareBeltCsvs(beltCsv(52, 2), beltCsv(52, 2));
		expect(r.verdict).toBe("matched");
		expect(r.similarity).toBeGreaterThan(0.95);
		expect(Math.abs(r.energyRatio - 1)).toBeLessThan(0.1);
	});

	it("same shape but different amplitude reads as tension imbalance", () => {
		const r = compareBeltCsvs(beltCsv(52, 2), beltCsv(52, 4.5));
		expect(r.verdict).toBe("tension");
		expect(r.similarity).toBeGreaterThan(0.8); // shape still matches
		expect(r.energyRatio).toBeLessThan(0.7); // but B carries far more energy
	});

	it("different resonance frequencies read as a mismatch", () => {
		const r = compareBeltCsvs(beltCsv(40, 2), beltCsv(85, 2));
		expect(r.verdict).toBe("mismatch");
		expect(Math.abs(r.peakA - 40)).toBeLessThan(3);
		expect(Math.abs(r.peakB - 85)).toBeLessThan(3);
	});
});

describe("diagonal sweep + belt capture", () => {
	it("secondary axis moves in lockstep, inverted for belt b", () => {
		const a = generateSweep({ axis: "X", center: 100, startFreq: 5, endFreq: 10, secondary: { axis: "Y", center: 120, scale: 1 } });
		const b = generateSweep({ axis: "X", center: 100, startFreq: 5, endFreq: 10, secondary: { axis: "Y", center: 120, scale: -1 } });
		const moveA = a.lines.find((l) => l.startsWith("G1 X") && !l.includes("X100 "))!;
		const moveB = b.lines.find((l) => l.startsWith("G1 X") && !l.includes("X100 "))!;
		const [, xa, ya] = /X([\d.]+) Y([\d.]+)/.exec(moveA)!;
		const [, xb, yb] = /X([\d.]+) Y([\d.]+)/.exec(moveB)!;
		// Same X excursion; Y excursion mirrored around its centre.
		expect(parseFloat(xa)).toBeCloseTo(parseFloat(xb), 6);
		expect(parseFloat(ya) - 120).toBeCloseTo(-(parseFloat(yb) - 120), 6);
	});

	it("runBeltCapture uploads a diagonal program and arms the recorder", async () => {
		const calls: Array<{ kind: string; arg: string; content?: string }> = [];
		const io: MachineIO = {
			sendCode: async (code) => { calls.push({ kind: "code", arg: code }); return "ok"; },
			upload: async (path, content) => { calls.push({ kind: "upload", arg: path, content }); },
			download: async () => "",
		};
		const run = await runBeltCapture(io, { accelerometer: { id: "0", label: "MB" }, belt: "b", centerX: 150, centerY: 150, endFreq: 30 });
		expect(calls[0].content).toMatch(/G1 X[\d.]+ Y[\d.]+ F/);
		expect(calls[1].arg).toContain('F"rlab-beltb-xy-');
		expect(run.csvPath).toContain("rlab-beltb-xy-");
	});
});
