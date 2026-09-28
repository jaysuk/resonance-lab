import { describe, expect, it } from "vitest";

import {
	driverBoardFirmware, isSoftwareCommutationMode, motorTuneSupported, usesFreePhaseCorrection,
} from "../src/config/motorTuneSupport";

/** DWC's Input Shaping plugin lists these as able to carry a waveform correction (its
 *  `waveformTuningBoards`); this plugin has no such list, so each must pass on its own merits. */
const DWC_LISTED_BOARDS = ["MB6HC", "EXP3HC", "EXP1HCL", "M23CL", "TOOLINDX"];

/** A motor `X` whose first driver is `driver` on board `board`, on RRF 3.7.0-rc.2 everywhere. */
function model(opts: { shortName: string; phaseStep?: boolean; mode?: unknown; toolboard?: boolean; firmware?: string }) {
	const board = opts.toolboard ? 121 : 0;
	const firmware = opts.firmware ?? "3.7.0-rc.2";
	return {
		boards: [
			{ canAddress: 0, shortName: opts.toolboard ? "MB6HC" : opts.shortName, firmwareVersion: firmware },
			...(opts.toolboard ? [{
				canAddress: 121, shortName: opts.shortName, firmwareVersion: firmware,
				drivers: [{ config: { mode: opts.mode ?? 2 } }],
			}] : []),
		],
		move: { axes: [{ letter: "X", phaseStep: opts.phaseStep ?? false, drivers: [{ board, driver: 0 }] }] },
	};
}

describe("motorTuneSupported - no board list, so every board DWC lists passes", () => {
	it.each(DWC_LISTED_BOARDS)("offers the task for a driver on a %s toolboard", (shortName) => {
		expect(motorTuneSupported(model({ shortName, toolboard: true }), ["X"])).toBe(true);
	});

	it("offers it for the closed-loop toolboards (1HCL, M23CL) and the INDX toolboard by name", () => {
		for (const shortName of ["EXP1HCL", "M23CL", "TOOLINDX"]) {
			const m = model({ shortName, toolboard: true, mode: 4 });
			expect(motorTuneSupported(m, ["X"])).toBe(true);
			expect(driverBoardFirmware(m, "X")).toBe("3.7.0-rc.2");
		}
	});

	it("also passes a board DWC doesn't list (a future one) - firmware decides, not the name", () => {
		expect(motorTuneSupported(model({ shortName: "SOMENEWBOARD", toolboard: true }), ["X"])).toBe(true);
	});

	it("hides the task when the mainboard is too old, even if the driver's board is fine", () => {
		const m = model({ shortName: "M23CL", toolboard: true });
		m.boards[0].firmwareVersion = "3.6.1";
		expect(motorTuneSupported(m, ["X"])).toBe(false);
	});

	it("hides the task when the driver's own board is too old", () => {
		const m = model({ shortName: "M23CL", toolboard: true });
		m.boards[1].firmwareVersion = "3.6.1";
		expect(motorTuneSupported(m, ["X"])).toBe(false);
	});

	it("fails closed on missing firmware versions", () => {
		const m = model({ shortName: "M23CL", toolboard: true });
		delete (m.boards[1] as { firmwareVersion?: string }).firmwareVersion;
		expect(motorTuneSupported(m, ["X"])).toBe(false);
		expect(motorTuneSupported({}, ["X"])).toBe(false);
	});

	it("reads the STM32 port's parenthesised version suffix", () => {
		expect(motorTuneSupported(model({ shortName: "TOOLINDX", toolboard: true, firmware: "3.7.0-rc.2(CAN0)" }), ["X"])).toBe(true);
	});
});

describe("usesFreePhaseCorrection - which command carries the correction", () => {
	it("uses M970.3's free phase for an axis in phase stepping", () => {
		expect(usesFreePhaseCorrection(model({ shortName: "MB6HC", phaseStep: true }), "X")).toBe(true);
	});

	it("uses M970.3 for a closed-loop driver too, even though axis.phaseStep is false (as DWC does)", () => {
		expect(usesFreePhaseCorrection(model({ shortName: "M23CL", toolboard: true, mode: 4 }), "X")).toBe(true); // direct
		expect(usesFreePhaseCorrection(model({ shortName: "EXP1HCL", toolboard: true, mode: "assistedOpen" }), "X")).toBe(true);
	});

	it("uses the sine table (M569.2) for an ordinary step/dir driver", () => {
		expect(usesFreePhaseCorrection(model({ shortName: "EXP3HC", toolboard: true, mode: 3 }), "X")).toBe(false); // stealthChop
		expect(usesFreePhaseCorrection(model({ shortName: "MB6HC" }), "X")).toBe(false);
	});

	it("defaults to the sine table when the model doesn't say", () => {
		expect(usesFreePhaseCorrection({}, "X")).toBe(false);
		expect(usesFreePhaseCorrection(model({ shortName: "MB6HC" }), "Q")).toBe(false);
	});
});

describe("isSoftwareCommutationMode", () => {
	it("accepts the enum integers and names, rejects everything else", () => {
		expect([4, 5, "direct", "assistedOpen"].every(isSoftwareCommutationMode)).toBe(true);
		expect([0, 1, 2, 3, "stealthChop", null, undefined].some(isSoftwareCommutationMode)).toBe(false);
	});
});
