import { describe, expect, it } from "vitest";

import { accelForTool, mapAccelerometers } from "../src/capture/tools";

/** A two-tool changer: T0's extruder (index 0) drives board 121, T1's (index 1) drives board 122. */
function toolChangerModel() {
	return {
		boards: [
			{ canAddress: 0, shortName: "MB6HC" }, // mainboard, no accelerometer
			{ canAddress: 121, shortName: "SB2040MAX3", accelerometer: { points: 0 } },
			{ canAddress: 122, shortName: "SB2040MAX3", accelerometer: { points: 0 } },
		],
		move: {
			extruders: [
				{ driver: { board: 121 } },
				{ driver: { board: 122 } },
			],
		},
		tools: [
			{ number: 0, name: "Dragon", extruders: [0] },
			{ number: 1, name: "Rapido", extruders: [1] },
		],
	};
}

describe("mapAccelerometers", () => {
	it("labels each tool-changer accelerometer with its own tool", () => {
		const found = mapAccelerometers(toolChangerModel());
		expect(found).toEqual([
			{ id: "121.0", label: "T0 Dragon — SB2040MAX3", toolNumber: 0, toolName: "Dragon" },
			{ id: "122.0", label: "T1 Rapido — SB2040MAX3", toolNumber: 1, toolName: "Rapido" },
		]);
	});

	it("falls back to the board name when a board can't be tied to any tool", () => {
		// A single-mainboard machine, or a diagnostic-only board - no tools[] entry resolves to it.
		const found = mapAccelerometers({ boards: [{ canAddress: 0, shortName: "MB6HC", accelerometer: {} }] });
		expect(found).toEqual([{ id: "0", label: "MB6HC", toolNumber: undefined, toolName: undefined }]);
	});

	it("labels an unnamed tool as just its number", () => {
		const model = {
			boards: [{ canAddress: 121, shortName: "SB2040MAX3", accelerometer: {} }],
			move: { extruders: [{ driver: { board: 121 } }] },
			tools: [{ number: 3, extruders: [0] }], // no name
		};
		expect(mapAccelerometers(model)[0].label).toBe("T3 — SB2040MAX3");
	});

	it("tolerates gaps and tools with no extruders (M563 defines them out of order)", () => {
		const model = {
			boards: [{ canAddress: 121, shortName: "SB2040MAX3", accelerometer: {} }],
			move: { extruders: [{ driver: { board: 121 } }] },
			tools: [null, { number: 1, extruders: [] }, { number: 2, extruders: [0] }],
		};
		expect(mapAccelerometers(model)[0].toolNumber).toBe(2);
	});

	it("is unaffected by a model with no tools/move.extruders at all (pre-tool-changer plugin behaviour)", () => {
		expect(mapAccelerometers({ boards: [{ canAddress: 0, accelerometer: {} }] }))
			.toEqual([{ id: "0", label: "Board 0", toolNumber: undefined, toolName: undefined }]);
	});
});

describe("accelForTool", () => {
	it("finds the accelerometer belonging to a tool number", () => {
		const accels = mapAccelerometers(toolChangerModel());
		expect(accelForTool(accels, 1)?.id).toBe("122.0");
		expect(accelForTool(accels, 9)).toBeUndefined();
	});
});
