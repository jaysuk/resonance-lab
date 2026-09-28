import { describe, expect, it } from "vitest";

import { accelSetupHints, isSpiAccelBoard, SPI_ACCEL_BOARDS, spiAccelPort } from "../src/config/accelBoards";
import { accelScheme } from "../src/config/accelScheme";

/** Every board in Duet3D's own Duet3Expansion source (`src/Config/*.h`, 3.7-dev): none of them has an
 *  SPI accelerometer, so the `spi.cs.acc` / `int.acc` names must never be applied to one. */
const DUET3D_BOARDS = [
	"EXP1HCL", "EXP1XD", "EXP3HC", "F3PTB", "M23CL", "NodeTrix", "RPi_Pico", "SAMMYC21", "SZP",
	"TOOL1LC", "TOOL1RR", "TOOLINDX", "MB6HC", "MB6XD", "MINI5PLUS",
];

describe("SPI accelerometer boards", () => {
	it("never includes a Duet3D-source board - those keep their I2C accelerometer", () => {
		for (const board of DUET3D_BOARDS) {
			expect(isSpiAccelBoard(board)).toBe(false);
			expect(spiAccelPort(121, board)).toBeNull();
		}
	});

	it.each(SPI_ACCEL_BOARDS)("%s gets CS then INT, prefix on the first pin only", (board) => {
		expect(spiAccelPort(121, board)).toBe("121.spi.cs.acc+int.acc");
	});

	it("names the fork's boards as they report themselves (SHT36V3, SB2040MAX3, FLY36RRF ...)", () => {
		for (const board of ["SHT36V3", "SHT36MAX3", "SHT36MAX4", "SB2040MAX3", "SB2040PROMAX3", "FLY36RRF", "FLYM2", "FSSB2040V2"]) {
			expect(isSpiAccelBoard(board)).toBe(true);
		}
	});

	it("matches case- and punctuation-insensitively, and never guesses at an unknown or missing name", () => {
		expect(isSpiAccelBoard("sht36v3")).toBe(true);
		expect(isSpiAccelBoard("Fly-36-RRF")).toBe(true);
		expect(isSpiAccelBoard("")).toBe(false);
		expect(isSpiAccelBoard(undefined)).toBe(false);
		expect(isSpiAccelBoard("SHT36")).toBe(false); // not a full name
	});
});

const RC2 = "3.7.0-rc.2";
function machine(opts: { toolFirmware?: string; mainFirmware?: string; accelerometers?: Array<unknown> } = {}) {
	return {
		boards: [
			{ canAddress: 0, shortName: "MB6HC", firmwareVersion: opts.mainFirmware ?? RC2 },
			{ canAddress: 121, shortName: "SHT36V3", firmwareVersion: opts.toolFirmware ?? RC2 },
			{ canAddress: 122, shortName: "TOOL1LC", firmwareVersion: RC2 },
		],
		sensors: { accelerometers: opts.accelerometers ?? [] },
	};
}

describe("accelSetupHints", () => {
	it("offers the exact two-pin line for an unconfigured SPI toolboard, and nothing for an I2C one", () => {
		expect(accelSetupHints(machine())).toEqual([{ canAddress: 121, board: "SHT36V3", line: 'M955 P0 C"121.spi.cs.acc+int.acc"' }]);
	});

	it("takes the lowest slot nothing else is using", () => {
		const m = machine({ accelerometers: [{ port: "122.i2c.lis" }, { port: "spi.cs3+io4.in" }] });
		expect(accelSetupHints(m)[0].line).toBe('M955 P2 C"121.spi.cs.acc+int.acc"');
	});

	it("stays quiet once the board's accelerometer is configured", () => {
		expect(accelSetupHints(machine({ accelerometers: [{ port: "121.spi.cs.acc+int.acc" }] }))).toEqual([]);
	});

	it("stays quiet below rc.2, where the pin names don't exist yet - on either the mainboard or the board", () => {
		expect(accelSetupHints(machine({ mainFirmware: "3.7.0-rc.1" }))).toEqual([]);
		expect(accelSetupHints(machine({ toolFirmware: "3.7.0-rc.1" }))).toEqual([]);
		expect(accelSetupHints({})).toEqual([]);
	});
});

describe("accelScheme - decided by the mainboard alone", () => {
	const model = (main: string, tool: string) => ({
		boards: [{ canAddress: 0, firmwareVersion: main }, { canAddress: 121, firmwareVersion: tool }],
	});

	it.each([
		["3.6.1", "3.7.0-rc.2", "legacy"],
		["3.7.0-rc.1", "3.5.1", "single"],
		["3.7.0-rc.1+1", "3.5.1", "multi"],
		["3.7.0-rc.2", "3.5.1", "multi"],
		["3.7.0-rc.2(CAN0)", "3.7.0-rc.1", "multi"],
	])("mainboard %s with a toolboard on %s is %s", (main, tool, expected) => {
		expect(accelScheme(model(main, tool))).toBe(expected);
	});

	it("is multi whenever the object model reports slots, whatever the version string says", () => {
		const m = { boards: [{ canAddress: 0, firmwareVersion: "3.7.0-rc.1" }], sensors: { accelerometers: [{ port: "spi.cs3+io4.in" }] } };
		expect(accelScheme(m)).toBe("multi");
	});

	it("fails closed to legacy when the mainboard's version is unknown", () => {
		expect(accelScheme({})).toBe("legacy");
		expect(accelScheme({ boards: [{ canAddress: 0 }] })).toBe("legacy");
	});
});
