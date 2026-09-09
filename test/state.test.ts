import { beforeEach, describe, expect, it } from "vitest";
import { watchEffect } from "vue";

import {
	activeTool, findOrientationEntry, lastResult, loadOrientationRegistry, motorResult,
	type MotorSessionResult, motorTuneResult, type MotorTuneResult, saveOrientationEntry,
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

/**
 * Node 22+ defines a global `localStorage` accessor of its own (gated behind `--localstorage-file`,
 * which this test run doesn't set) that SHADOWS happy-dom's - it resolves for both bare `localStorage`
 * and `window.localStorage` (verified empirically: they're `===`), but implements none of the Storage
 * interface (no getItem/setItem/clear at all). state.ts's real code already tolerates this fine (every
 * call is try/catch-wrapped, same pattern as the existing Z-height persistence), but a test that wants
 * to observe an actual round-trip needs a real backing store. The property is configurable, so replace
 * it for the duration of this suite.
 */
function makeMemoryStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		setItem: (k: string, v: string) => { store.set(k, String(v)); },
		removeItem: (k: string) => { store.delete(k); },
		clear: () => { store.clear(); },
		key: (i: number) => Array.from(store.keys())[i] ?? null,
		get length() { return store.size; },
	} as Storage;
}

describe("accelerometer orientation registry", () => {
	beforeEach(() => {
		Object.defineProperty(globalThis, "localStorage", { value: makeMemoryStorage(), configurable: true });
	});

	it("returns an empty array when nothing is recorded", () => {
		expect(loadOrientationRegistry()).toEqual([]);
	});

	it("round-trips a saved entry through localStorage", () => {
		saveOrientationEntry({ canAddress: 121, uniqueId: "abc123", orientation: 6, resolution: 10, samplingRate: 1344 });
		const registry = loadOrientationRegistry();
		expect(registry).toEqual([{ canAddress: 121, uniqueId: "abc123", orientation: 6, resolution: 10, samplingRate: 1344 }]);
	});

	it("upserts by canAddress rather than accumulating duplicates", () => {
		saveOrientationEntry({ canAddress: 121, uniqueId: "abc123", orientation: 6 });
		saveOrientationEntry({ canAddress: 121, uniqueId: "abc123", orientation: 20 });
		const registry = loadOrientationRegistry();
		expect(registry).toHaveLength(1);
		expect(registry[0].orientation).toBe(20);
	});

	it("keeps separate boards' entries independent", () => {
		saveOrientationEntry({ canAddress: 0, uniqueId: null, orientation: 20 });
		saveOrientationEntry({ canAddress: 121, uniqueId: "abc123", orientation: 6 });
		expect(loadOrientationRegistry()).toHaveLength(2);
	});

	it("finds an entry matching both canAddress and uniqueId", () => {
		const registry = [{ canAddress: 121, uniqueId: "abc123", orientation: 6 }];
		expect(findOrientationEntry(registry, 121, "abc123")).toEqual(registry[0]);
	});

	it("returns null when the board was swapped (same canAddress, different uniqueId)", () => {
		const registry = [{ canAddress: 121, uniqueId: "abc123", orientation: 6 }];
		expect(findOrientationEntry(registry, 121, "xyz789")).toBeNull();
	});

	it("matches on canAddress alone when either side has no uniqueId", () => {
		const registry = [{ canAddress: 0, uniqueId: null, orientation: 20 }];
		expect(findOrientationEntry(registry, 0, "some-id")).toEqual(registry[0]);
		expect(findOrientationEntry(registry, 0, null)).toEqual(registry[0]);
	});

	it("returns null for an unknown canAddress", () => {
		expect(findOrientationEntry([], 121, "abc123")).toBeNull();
	});

	it("survives a corrupted storage value without throwing", () => {
		localStorage.setItem("resonanceLab.accelOrientation", "{not valid json");
		expect(loadOrientationRegistry()).toEqual([]);
	});
});
