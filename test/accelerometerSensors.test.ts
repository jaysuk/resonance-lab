/**
 * RRF 3.7.0-rc.2 moved accelerometers from `boards[].accelerometer` to `sensors.accelerometers[]`,
 * indexed by the M955/M956 `P` slot and carrying the M955 `C` value as `port` (Accelerometers.cpp,
 * `Accelerometer::objectModelTable`). These tests cover everything that follows from that: discovery,
 * slots, arming by slot alone, two-pin SPI wiring for STM32 toolboards, and the CSV a failed run leaves.
 */
import { describe, expect, it } from "vitest";

import { parseAccelCsv } from "../src/capture/csv";
import { runNativeCapture, runSweepCapture } from "../src/capture/orchestrator";
import { findAccelModelEntry, mapAccelerometers } from "../src/capture/tools";
import { findAccelWiring, findAllAccelWiring, parseCPrefix } from "../src/config/accelWiring";

/** A tool changer: T0's toolboard is an STM32 one (SPI, CS then INT), T1's a Duet one (I2C). */
function sensorsModel() {
	return {
		boards: [
			{ canAddress: 0, shortName: "MB6HC" },
			{ canAddress: 121, shortName: "SHT36v3" },
			{ canAddress: 122, shortName: "TOOL1LC" },
		],
		move: { extruders: [{ driver: { board: 121 } }, { driver: { board: 122 } }] },
		sensors: {
			accelerometers: [
				{ orientation: 20, points: 0, port: "121.spi.cs.acc+int.acc", resolution: 10, runs: 2, samplingRate: 1344 },
				null, // slot 1 unconfigured, slot 2 is
				{ orientation: 6, points: 0, port: "122.i2c.lis", resolution: 10, runs: 0, samplingRate: 1000 },
			],
		},
		tools: [{ number: 0, name: "Dragon", extruders: [0] }, { number: 1, name: "Rapido", extruders: [1] }],
	};
}

describe("mapAccelerometers - sensors.accelerometers[] (RRF >= 3.7.0-rc.2)", () => {
	it("lists each slot with its own slot number and port, tying it to its tool via the port's board prefix", () => {
		expect(mapAccelerometers(sensorsModel())).toEqual([
			{ id: "121.0", label: "T0 Dragon — SHT36v3 · P0", toolNumber: 0, toolName: "Dragon", canAddress: 121, slot: 0, port: "121.spi.cs.acc+int.acc" },
			{ id: "122.0", label: "T1 Rapido — TOOL1LC · P2", toolNumber: 1, toolName: "Rapido", canAddress: 122, slot: 2, port: "122.i2c.lis" },
		]);
	});

	it("reports the slot as its array index, skipping unconfigured (null) gaps without renumbering", () => {
		expect(mapAccelerometers(sensorsModel()).map((a) => a.slot)).toEqual([0, 2]);
	});

	it("puts a port with no board prefix on the mainboard", () => {
		const model = { boards: [{ canAddress: 0, shortName: "MB6HC" }], sensors: { accelerometers: [{ port: "spi.cs3+io4.in" }] } };
		expect(mapAccelerometers(model)).toEqual([
			{ id: "0", label: "MB6HC", toolNumber: undefined, toolName: undefined, canAddress: 0, slot: 0, port: "spi.cs3+io4.in" },
		]);
	});

	it("leaves the label alone when there is only one accelerometer (no slot suffix to disambiguate)", () => {
		const model = { boards: [{ canAddress: 121, shortName: "SHT36v3" }], sensors: { accelerometers: [{ port: "121.spi.cs.acc+int.acc" }] } };
		expect(mapAccelerometers(model)[0].label).toBe("SHT36v3");
	});

	it("reads an empty sensors list as no accelerometers", () => {
		expect(mapAccelerometers({ boards: [{ canAddress: 0 }], sensors: { accelerometers: [] } })).toEqual([]);
	});

	it("still finds a boards[].accelerometer when sensors.accelerometers is present but empty (older firmware behind a newer object-model library)", () => {
		const model = { boards: [{ canAddress: 121, shortName: "SB2040MAX3", accelerometer: {} }], sensors: { accelerometers: [] } };
		expect(mapAccelerometers(model)).toEqual([{ id: "121.0", label: "SB2040MAX3", toolNumber: undefined, toolName: undefined }]);
	});

	it("never lists one board twice when both shapes report it - the sensors entry wins", () => {
		const model = {
			boards: [{ canAddress: 121, shortName: "SHT36v3", accelerometer: {} }],
			sensors: { accelerometers: [{ port: "121.spi.cs.acc+int.acc" }] },
		};
		const found = mapAccelerometers(model);
		expect(found).toHaveLength(1);
		expect(found[0].slot).toBe(0);
	});
});

describe("findAccelModelEntry", () => {
	it("returns the live state for a board from sensors.accelerometers[]", () => {
		expect(findAccelModelEntry(sensorsModel(), 122)).toMatchObject({ slot: 2, orientation: 6, samplingRate: 1000, runs: 0, port: "122.i2c.lis" });
	});

	it("returns the live state from boards[].accelerometer before rc.2, with no slot", () => {
		const entry = findAccelModelEntry({ boards: [{ canAddress: 121, accelerometer: { orientation: 20, runs: 4 } }] }, 121);
		expect(entry).toMatchObject({ orientation: 20, runs: 4 });
		expect(entry?.slot).toBeUndefined();
	});

	it("returns null for a board with no accelerometer", () => {
		expect(findAccelModelEntry(sensorsModel(), 0)).toBeNull();
	});
});

describe("two-pin SPI wiring (STM32 toolboards: CS then INT)", () => {
	it("takes the CAN prefix from the first pin and keeps both pins in cSpec", () => {
		const w = findAccelWiring('M955 P0 C"121.spi.cs.acc+int.acc" I20 Q4000000', 121);
		expect(w).toEqual({ cSpec: "121.spi.cs.acc+int.acc", spiFrequency: 4000000, canAddress: 121, slot: 0 });
	});

	it("finds a board's two-pin line among several other accelerometers", () => {
		const text = ['M955 P0 C"spi.cs3+io4.in" I20', 'M955 P1 C"121.spi.cs.acc+int.acc" I6', 'M955 P2 C"122.i2c.lis" I20'].join("\n");
		expect(findAccelWiring(text, 121)).toEqual({ cSpec: "121.spi.cs.acc+int.acc", canAddress: 121, slot: 1 });
		expect(findAllAccelWiring(text).map((w) => w.canAddress)).toEqual([0, 121, 122]);
	});

	it("treats a prefix on the second pin as the same board (RRF checks each pin against its own board)", () => {
		expect(parseCPrefix("121.spi.cs.acc+121.int.acc")).toBe(121);
	});
});

describe("arming by slot alone (RRF >= 3.7.0-rc.2)", () => {
	it("arms M956 with the slot and sends no M955 at all - each slot is independent, nothing needs re-activating", async () => {
		const sent: Array<string> = [];
		const io = {
			sendCode: async (code: string) => { sent.push(code); return "ok"; },
			upload: async () => {},
			download: async () => "",
			accelRuns: () => 7,
		};
		const run = await runSweepCapture(io, {
			accelerometer: { id: "121.0", label: "T0", canAddress: 121, slot: 3, port: "121.spi.cs.acc+int.acc" },
			axis: "X", center: 100, startFreq: 5, endFreq: 10, activationSlot: 3,
		});
		expect(sent.some((c) => c.startsWith("M955"))).toBe(false);
		expect(sent.find((c) => c.includes("M956"))).toContain("M956 P3 S");
		expect(sent.find((c) => c.includes("M956"))).not.toContain("P121.0");
		expect(run.runsBefore).toBe(7); // sampled from the live slot, no recreate to wait out
	});

	it("keeps the older fallbacks: an activation line alone arms P0, neither arms the legacy id", async () => {
		const armed = async (extra: object) => {
			const sent: Array<string> = [];
			const io = { sendCode: async (code: string) => { sent.push(code); return "ok"; }, upload: async () => {}, download: async () => "", accelRuns: () => 0 };
			await runNativeCapture(io, { accelerometer: { id: "121.0", label: "T0" }, axis: "X", center: 100, span: 20, ...extra });
			return sent.find((c) => c.includes("M956"))!;
		};
		expect(await armed({ activationCode: 'M955 P0 C"121.i2c.lis" I6' })).toContain("M956 P0 S");
		expect(await armed({})).toContain("M956 P121.0 S");
	});
});

describe("parseAccelCsv - a run the firmware aborted", () => {
	it.each([
		"Failed to collect data from accelerometer",
		"Too many spurious interrupts from accelerometer",
		"Received mismatched data",
		"Board restarted before the collection was complete",
		"Failed to start accelerometer",
	])("reports the firmware's own reason instead of a vague truncation: %s", (line) => {
		expect(() => parseAccelCsv(`Sample,X,Y,Z\n0,0.1,0.2,0.3\n1,0.1,0.2,0.3\n${line}\n`)).toThrow(`The accelerometer run failed: ${line}`);
		expect(() => parseAccelCsv(`Sample,X,Y,Z\n${line}\n`)).toThrow(/run failed/);
	});
});
