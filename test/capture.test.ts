import { describe, expect, it } from "vitest";

import { parseAccelCsv } from "../src/capture/csv";
import { generateSweep } from "../src/capture/sweep";

describe("parseAccelCsv", () => {
	const sample = [
		"Sample,X,Y,Z",
		"0,0.012,-0.003,0.981",
		"1,0.015,-0.001,0.979",
		"2,-0.008,0.002,0.984",
		"3,0.001,0.000,0.980",
		"Rate 1342 overflows 0",
	].join("\n");

	it("parses axes, channels, rate and overflows", () => {
		const c = parseAccelCsv(sample);
		expect(c.axes).toEqual(["X", "Y", "Z"]);
		expect(c.samplingRate).toBe(1342);
		expect(c.overflows).toBe(0);
		expect(c.channels.length).toBe(3);
		expect(c.channels[0].length).toBe(4);
		expect(c.channels[0][1]).toBeCloseTo(0.015, 9);
		expect(c.channels[2][2]).toBeCloseTo(0.984, 9);
	});

	it("flags overflows and rejects garbage", () => {
		expect(parseAccelCsv(sample.replace("overflows 0", "overflows 3")).overflows).toBe(3);
		expect(() => parseAccelCsv("hello\nworld\n!")).toThrow();
		expect(() => parseAccelCsv(sample.split("\n").slice(0, 4).join("\n"))).toThrow(/trailer/);
	});
});

describe("generateSweep", () => {
	it("produces a program that oscillates around the centre and disables shaping", () => {
		const p = generateSweep({ axis: "x", center: 150, startFreq: 5, endFreq: 20, maxAccel: 3000 });
		expect(p.lines[3]).toContain('M593 P"none"');
		expect(p.pulses).toBeGreaterThan(20);
		expect(p.durationSec).toBeGreaterThan(5);
		// Every move targets X<value>; excursions shrink as frequency rises.
		const targets = p.lines.filter((l) => l.startsWith("G1 X")).map((l) => parseFloat(l.slice(4)));
		expect(targets.length).toBeGreaterThan(0);
		const first = Math.abs(targets[0] - 150);
		const last = Math.abs(targets[targets.length - 3] - 150);
		expect(first).toBeGreaterThan(last);
		// Ends back at centre.
		expect(targets[targets.length - 1]).toBe(150);
	});

	it("clamps acceleration to the machine limit and reports max excursion", () => {
		const p = generateSweep({ axis: "Y", center: 100, startFreq: 5, endFreq: 135, accelPerHz: 60, maxAccel: 2000 });
		const accels = p.lines.filter((l) => l.startsWith("M204 P")).map((l) => parseFloat(l.slice(6)));
		expect(Math.max(...accels)).toBeLessThanOrEqual(2000);
		// Max excursion is at the start (lowest frequency): d = a*t^2, a = 60*5 = 300, t = 0.05.
		expect(p.maxExcursion).toBeCloseTo(300 * 0.05 * 0.05, 6);
	});

	it("sweep duration tracks the frequency span and rate", () => {
		const slow = generateSweep({ axis: "X", center: 0, startFreq: 10, endFreq: 30, hzPerSec: 1 });
		const fast = generateSweep({ axis: "X", center: 0, startFreq: 10, endFreq: 30, hzPerSec: 2 });
		expect(slow.durationSec).toBeGreaterThan(fast.durationSec * 1.5);
		// At 1 Hz/s a 20 Hz span should take roughly 20 seconds of motion.
		expect(slow.durationSec).toBeGreaterThan(10);
		expect(slow.durationSec).toBeLessThan(40);
	});

	it("rejects invalid ranges", () => {
		expect(() => generateSweep({ axis: "X", center: 0, startFreq: 0 })).toThrow();
		expect(() => generateSweep({ axis: "X", center: 0, startFreq: 50, endFreq: 20 })).toThrow();
	});
});

describe("fixed excitation + orientation", () => {
	it("fixed excitation holds one frequency and can keep the shaper active", async () => {
		const { generateFixedExcitation } = await import("../src/capture/sweep");
		const p = generateFixedExcitation({ axis: "X", center: 100, freq: 40, seconds: 5 });
		expect(p.lines.some((l) => l.includes('M593 P"none"'))).toBe(true);
		expect(p.durationSec).toBeGreaterThan(4.9);
		const verify = generateFixedExcitation({ axis: "X", center: 100, freq: 40, seconds: 5, keepShaper: true });
		expect(verify.lines.some((l) => l.includes('M593 P"none"'))).toBe(false);
	});

	it("sweep keepShaper leaves the shaper active for the verify run", async () => {
		const { generateSweep } = await import("../src/capture/sweep");
		const p = generateSweep({ axis: "X", center: 100, startFreq: 5, endFreq: 10, keepShaper: true });
		expect(p.lines.some((l) => l.includes('M593 P"none"'))).toBe(false);
	});

	it("orientation check finds the dominant channel", async () => {
		const { checkOrientation } = await import("../src/analysis/orientation");
		const { parseAccelCsv } = await import("../src/capture/csv");
		const lines = ["Sample,X,Y,Z"];
		for (let i = 0; i < 500; i++) {
			lines.push(`${i},${(0.02 * Math.sin(i / 3)).toFixed(4)},${(2 * Math.sin(i / 5)).toFixed(4)},0.98`);
		}
		lines.push("Rate 1000 overflows 0");
		const capture = parseAccelCsv(lines.join("\n"));
		expect(checkOrientation(capture, "Y").ok).toBe(true);
		const wrong = checkOrientation(capture, "X");
		expect(wrong.ok).toBe(false);
		expect(wrong.dominant).toBe("Y");
		expect(wrong.dominance).toBeGreaterThan(0.9);
	});
});
