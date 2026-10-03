import { describe, expect, it } from "vitest";

import {
	analysisWindow, buildMotorMove, constantSpeedWindow, deriveMotorOptions, maxSpeedForRate, maxTuneSpeed,
} from "../src/capture/motorMoves";
import type { MachineIO } from "../src/capture/orchestrator";
import { runMotorPointCapture } from "../src/capture/orchestrator";

const coreXY = {
	move: {
		travelAcceleration: 5000,
		kinematics: {
			forwardMatrix: [[0.5, 0.5], [0.5, -0.5]],
			inverseMatrix: [[1, 1], [1, -1]],
		},
		axes: [
			{
				letter: "X", min: 0, max: 300, visible: true, acceleration: 4000, speed: 500,
				stepsPerMm: 80, microstepping: { value: 16 },
			},
			{
				letter: "Y", min: 0, max: 300, visible: true, acceleration: 4000, speed: 500,
				stepsPerMm: 80, microstepping: { value: 16 },
			},
		],
	},
};

const cartesianWithZ = {
	move: {
		travelAcceleration: 1000,
		kinematics: {},
		axes: [
			{
				letter: "X", min: 0, max: 300, visible: true, acceleration: 3000, speed: 300,
				stepsPerMm: 80, microstepping: { value: 16 },
			},
			{
				letter: "Z", min: 0, max: 400, visible: true, acceleration: 500, speed: 40,
				stepsPerMm: 400, microstepping: { value: 16 },
			},
		],
	},
};

describe("deriveMotorOptions", () => {
	it("derives two diagonal motors on CoreXY", () => {
		const options = deriveMotorOptions(coreXY);
		expect(options.length).toBe(2);
		const labels = options.map((o) => o.label).sort();
		expect(labels).toEqual(["X+Y", "X-Y"]);
		for (const o of options) {
			expect(o.axes).toEqual(["X", "Y"]);
			expect(o.fullStepsPerMm).toBe(5);
		}
	});

	it("every direction is a unit vector with a positive first component", () => {
		for (const o of deriveMotorOptions(coreXY)) {
			const length = Math.sqrt(o.direction.reduce((sum, v) => sum + v * v, 0));
			expect(length).toBeCloseTo(1, 6);
			expect(o.direction[0]).toBeGreaterThan(0);
		}
	});

	it("omits a motor with no reported microstepping", () => {
		const noMicrostepping = {
			move: {
				kinematics: coreXY.move.kinematics,
				axes: coreXY.move.axes.map((a) => ({ ...a, microstepping: null })),
			},
		};
		expect(deriveMotorOptions(noMicrostepping)).toEqual([]);
	});

	it("offers Z only on non-core kinematics", () => {
		const options = deriveMotorOptions(cartesianWithZ);
		expect(options.length).toBe(1);
		expect(options[0].motor).toBe("Z");
		expect(options[0].stepFactor).toBe(1);
	});
});

describe("buildMotorMove", () => {
	it("centres the move and sets the feedrate", () => {
		const option = deriveMotorOptions(coreXY).find((o) => o.label === "X+Y")!;
		const m = buildMotorMove(option, coreXY, 100, 50);
		expect(m.feedrate).toBe(3000);
		// Centre of X/Y travel is 150,150; the diagonal move should straddle it.
		const midStart = (m.start[0] + m.end[0]) / 2;
		const midEnd = (m.start[1] + m.end[1]) / 2;
		expect(midStart).toBeCloseTo(150, 1);
		expect(midEnd).toBeCloseTo(150, 1);
	});
});

describe("constantSpeedWindow", () => {
	it("returns a positive duration for a long, slow move", () => {
		const w = constantSpeedWindow({
			motor: "X", axes: ["X"], start: [0], end: [100], distance: 100,
			feedrate: 600, acceleration: 1000, fullStepsPerMm: 5, stepFactor: 1,
		});
		expect(w.duration).toBeGreaterThan(0);
	});

	it("returns zero duration for a triangular (too-short) move", () => {
		const w = constantSpeedWindow({
			motor: "X", axes: ["X"], start: [0], end: [2], distance: 2,
			feedrate: 12000, acceleration: 1000, fullStepsPerMm: 5, stepFactor: 1,
		});
		expect(w.duration).toBe(0);
		expect(w.moveDuration).toBeGreaterThan(0);
	});
});

describe("maxSpeedForRate", () => {
	it("keeps the full-step frequency below Nyquist with search margin", () => {
		const option = deriveMotorOptions(coreXY).find((o) => o.label === "X+Y")!;
		const speed = maxSpeedForRate(option, 1344);
		const fullStepHz = speed * option.stepFactor * option.fullStepsPerMm;
		expect(fullStepHz).toBeLessThan(1344 / 2);
	});
});

describe("maxTuneSpeed", () => {
	const option = deriveMotorOptions(coreXY).find((o) => o.label === "X+Y")!;

	it("equals maxSpeedForRate for any selection no higher than order 1", () => {
		expect(maxTuneSpeed([1, 2, 4], option, 1344)).toBe(maxSpeedForRate(option, 1344));
	});

	it("follows the highest selected harmonic", () => {
		expect(maxTuneSpeed([2, 4, 6], option, 3200)).toBeCloseTo(maxSpeedForRate(option, 3200) / 1.5, 9);
		expect(maxTuneSpeed([2, 4, 8], option, 3200)).toBeCloseTo(maxSpeedForRate(option, 3200) / 2, 9);
	});

	it("keeps the highest selected order below Nyquist", () => {
		const speed = maxTuneSpeed([8], option, 1344);
		expect(2 * speed * option.stepFactor * option.fullStepsPerMm).toBeLessThan(1344 / 2);
	});
});

describe("analysisWindow", () => {
	it("covers the middle 80% of the constant-speed segment", () => {
		const m = {
			motor: "X", axes: ["X"], start: [0], end: [100], distance: 100,
			feedrate: 600, acceleration: 1000, fullStepsPerMm: 5, stepFactor: 1,
		};
		const w = constantSpeedWindow(m);
		const rate = 1000;
		const win = analysisWindow(m, rate, Math.ceil((w.moveDuration + 1) * rate));
		expect(win.start).toBeGreaterThan(0);
		expect(win.end).toBeGreaterThan(win.start);
	});

	it("an offset selects a later window, for the return leg of a round trip", () => {
		const m = {
			motor: "X", axes: ["X"], start: [0], end: [100], distance: 100,
			feedrate: 600, acceleration: 1000, fullStepsPerMm: 5, stepFactor: 1,
		};
		const w = constantSpeedWindow(m);
		const rate = 1000;
		const sampleCount = Math.ceil((2 * w.moveDuration + 1) * rate);
		const outbound = analysisWindow(m, rate, sampleCount, 0);
		const returnLeg = analysisWindow(m, rate, sampleCount, w.moveDuration);
		expect(returnLeg.start).toBeGreaterThan(outbound.start);
		expect(returnLeg.end).toBeGreaterThan(outbound.end);
	});
});

describe("runMotorPointCapture", () => {
	it("positions, then arms and executes the pass in one line", async () => {
		const calls: Array<string> = [];
		const io: MachineIO = {
			sendCode: async (code) => { calls.push(code); return "ok"; },
			upload: async () => {},
			download: async () => "",
		};
		const option = deriveMotorOptions(coreXY).find((o) => o.label === "X+Y")!;
		const move = buildMotorMove(option, coreXY, 100, 50);
		await runMotorPointCapture(io, { accelerometer: { id: "0", label: "MB" }, move, expectedSampleRate: 1344 });
		expect(calls[0]).toContain("G1 X");
		expect(calls[0]).toContain("M400");
		expect(calls[1]).toContain("M956 P0");
		expect(calls[1]).toContain('F"rlab-motorx');
		expect(calls[1]).toContain(`F${move.feedrate}`);
	});

	it("a round trip emits two G1s at the same feedrate and sizes a larger recording", async () => {
		const singleCalls: Array<string> = [];
		const roundTripCalls: Array<string> = [];
		const singleIo: MachineIO = { sendCode: async (code) => { singleCalls.push(code); return "ok"; }, upload: async () => {}, download: async () => "" };
		const roundTripIo: MachineIO = { sendCode: async (code) => { roundTripCalls.push(code); return "ok"; }, upload: async () => {}, download: async () => "" };

		const option = deriveMotorOptions(coreXY).find((o) => o.label === "X+Y")!;
		const move = buildMotorMove(option, coreXY, 100, 50);

		await runMotorPointCapture(singleIo, { accelerometer: { id: "0", label: "MB" }, move, expectedSampleRate: 1344 });
		await runMotorPointCapture(roundTripIo, { accelerometer: { id: "0", label: "MB" }, move, expectedSampleRate: 1344, roundTrip: true });

		const armLine = roundTripCalls[1];
		// Two G1s at the move feedrate (once going out, once coming back), not the single pass's one.
		const g1Count = (armLine.match(/G1 /g) ?? []).length;
		expect(g1Count).toBe(2);
		expect((armLine.match(new RegExp(`F${move.feedrate}(?!\\d)`, "g")) ?? []).length).toBe(2);

		// Larger S count than the single-pass recording, since it must cover both legs.
		const singleSamples = Number(/S(\d+)/.exec(singleCalls[1])![1]);
		const roundTripSamples = Number(/S(\d+)/.exec(armLine)![1]);
		expect(roundTripSamples).toBeGreaterThan(singleSamples);
	});

	it("sends the activation line, THEN samples the run counter, THEN arms with P0 (not the old board.driver id)", async () => {
		// M955 P0 C"..." (RRF >= 3.7.0-rc.1) deletes and recreates the accelerometer object, resetting
		// its run counter - sampling runsBefore before activating would snapshot the wrong object's
		// count. P0 is mandatory (gb.MustSee) in both M955 and M956 under this scheme - never omitted,
		// never the old board.driver-shaped id (GetLimitedUIValue caps it to exactly 0).
		const order: Array<string> = [];
		const io: MachineIO = {
			sendCode: async (code) => { order.push(`send:${code}`); return "ok"; },
			upload: async () => {},
			download: async () => "",
			accelRuns: () => { order.push("accelRuns"); return 0; },
		};
		const option = deriveMotorOptions(coreXY).find((o) => o.label === "X+Y")!;
		const move = buildMotorMove(option, coreXY, 100, 50);
		await runMotorPointCapture(io, {
			accelerometer: { id: "121.0", label: "T0" }, move, expectedSampleRate: 1344,
			activationCode: 'M955 P0 C"121.i2c.lis" I6',
		});
		expect(order[0]).toContain("G1 X"); // positioning move first
		expect(order[1]).toBe('send:M955 P0 C"121.i2c.lis" I6');
		expect(order[2]).toBe("accelRuns");
		expect(order[3]).toContain("M956 P0 S");
		expect(order[3]).not.toContain("P121.0");
	});

	it("arms with activationSlot's own slot number under the multi-accelerometer scheme (RRF >= 3.7.0-rc.1+1)", async () => {
		const order: Array<string> = [];
		const io: MachineIO = {
			sendCode: async (code) => { order.push(`send:${code}`); return "ok"; },
			upload: async () => {},
			download: async () => "",
			accelRuns: () => 0,
		};
		const option = deriveMotorOptions(coreXY).find((o) => o.label === "X+Y")!;
		const move = buildMotorMove(option, coreXY, 100, 50);
		await runMotorPointCapture(io, {
			accelerometer: { id: "121.0", label: "T0" }, move, expectedSampleRate: 1344,
			activationCode: 'M955 P3 C"121.i2c.lis" I6', activationSlot: 3,
		});
		const armLine = order.find((o) => o.includes("M956"))!;
		expect(armLine).toContain("M956 P3 S");
	});
});
