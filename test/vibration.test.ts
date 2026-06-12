import { describe, expect, it } from "vitest";

import { buildVibrationProfile } from "../src/analysis/vibration";
import { parseAccelCsv } from "../src/capture/csv";
import { runSpeedPointCapture, type MachineIO } from "../src/capture/orchestrator";

/** Capture with broadband vibration of the given amplitude. */
function noisyCapture(amp: number) {
	const lines = ["Sample,X,Y,Z"];
	let seed = 3;
	const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
	for (let i = 0; i < 3000; i++) {
		lines.push(`${i},${(amp * rand()).toFixed(5)},${(amp * rand()).toFixed(5)},0.98`);
	}
	lines.push("Rate 1000 overflows 0");
	return parseAccelCsv(lines.join("\n"));
}

describe("vibration profile", () => {
	it("flags the loud speed and suggests the quiet ones", () => {
		const profile = buildVibrationProfile([
			{ speed: 40, capture: noisyCapture(0.2) },
			{ speed: 80, capture: noisyCapture(0.2) },
			{ speed: 120, capture: noisyCapture(2.5) }, // resonant speed
			{ speed: 160, capture: noisyCapture(0.25) },
		]);
		expect(profile.points.map((p) => p.speed)).toEqual([40, 80, 120, 160]);
		expect(profile.problems.length).toBe(1);
		expect(profile.problems[0].speed).toBe(120);
		expect(profile.quietest[0].speed).not.toBe(120);
		expect(profile.median).toBeGreaterThan(0);
	});

	it("speed point capture records a constant-speed pass at the right feedrate", async () => {
		const calls: Array<string> = [];
		const io: MachineIO = {
			sendCode: async (code) => { calls.push(code); return "ok"; },
			upload: async () => {},
			download: async () => "",
		};
		const run = await runSpeedPointCapture(io, { accelerometer: { id: "0", label: "MB" }, axis: "x", center: 150, speed: 120 });
		expect(calls[0]).toContain("G1 X90 F30000");
		expect(calls[1]).toContain("F7200"); // 120 mm/s
		expect(calls[1]).toContain('F"rlab-speed120-x-');
		expect(run.program.durationSec).toBeGreaterThan(0);
	});
});
