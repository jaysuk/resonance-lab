import { describe, expect, it } from "vitest";
import { watchEffect } from "vue";

import {
	activeTool, lastResult, motorResult, type MotorSessionResult, motorTuneResult, type MotorTuneResult,
	sessions, type SessionResult,
} from "../src/state";

function fakeResult(axis: string): SessionResult {
	return { axis, when: new Date(), source: "test", analysis: {} as SessionResult["analysis"] };
}

function fakeMotorResult(motor: string): MotorSessionResult {
	return {
		motor, label: motor, speeds: [50], overflows: 0,
		sweep: { orders: [1], frequencies: [100], amplitudes: [[0.1]], ratios: [[null]] },
		findings: [],
	};
}

function fakeMotorTuneResult(motor: string): MotorTuneResult {
	return {
		motor, label: motor, command: "M970.3", driverId: "0", chip: "TMC5160",
		results: [], codes: [], kept: false,
	};
}

describe("per-tool session state", () => {
	it("keeps each tool's result separate - measuring T1 doesn't discard T0's", () => {
		activeTool.value = 0;
		lastResult.value = fakeResult("X");
		activeTool.value = 1;
		lastResult.value = fakeResult("Y");

		activeTool.value = 0;
		expect(lastResult.value?.axis).toBe("X");
		activeTool.value = 1;
		expect(lastResult.value?.axis).toBe("Y");
	});

	it("defaults to tool -1 (no changer / no tool mounted) with its own session", () => {
		activeTool.value = -1;
		lastResult.value = fakeResult("Z");
		activeTool.value = 5;
		expect(lastResult.value).toBeNull(); // a tool with no session yet reads as empty, not T-1's data
		activeTool.value = -1;
		expect(lastResult.value?.axis).toBe("Z");
	});

	it("reassigns the sessions Map wholesale rather than mutating it in place", () => {
		// This is the property the whole design rests on: Vue 2.7 (the DWC 3.6 build) does not observe
		// native Map.set() through a ref, only a reassignment of ref.value - see state.ts's header
		// comment. A regression back to in-place mutation would compile and pass on Vue 3 alone.
		activeTool.value = 2;
		const before = sessions.value;
		lastResult.value = fakeResult("X");
		expect(sessions.value).not.toBe(before);
	});

	it("is reactive to a computed reading through it (the property Vue actually needs)", async () => {
		activeTool.value = 3;
		lastResult.value = null;
		let seenAxis: string | null | undefined;
		let runs = 0;
		const stop = watchEffect(() => {
			seenAxis = lastResult.value?.axis;
			runs++;
		});
		await Promise.resolve();
		const runsAfterInit = runs;
		lastResult.value = fakeResult("Y");
		await Promise.resolve();
		expect(runs).toBeGreaterThan(runsAfterInit);
		expect(seenAxis).toBe("Y");
		stop();
	});

	it("keeps each tool's motor result separate", () => {
		activeTool.value = 0;
		motorResult.value = fakeMotorResult("X");
		activeTool.value = 1;
		motorResult.value = fakeMotorResult("Y");

		activeTool.value = 0;
		expect(motorResult.value?.motor).toBe("X");
		activeTool.value = 1;
		expect(motorResult.value?.motor).toBe("Y");
	});

	it("keeps each tool's motor tune result separate", () => {
		activeTool.value = 0;
		motorTuneResult.value = fakeMotorTuneResult("X");
		activeTool.value = 1;
		motorTuneResult.value = fakeMotorTuneResult("Y");

		activeTool.value = 0;
		expect(motorTuneResult.value?.motor).toBe("X");
		activeTool.value = 1;
		expect(motorTuneResult.value?.motor).toBe("Y");
	});
});
