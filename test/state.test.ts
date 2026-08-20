import { describe, expect, it } from "vitest";
import { watchEffect } from "vue";

import { activeTool, lastResult, sessions, type SessionResult } from "../src/state";

function fakeResult(axis: string): SessionResult {
	return { axis, when: new Date(), source: "test", analysis: {} as SessionResult["analysis"] };
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
});
