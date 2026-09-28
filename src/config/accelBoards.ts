/**
 * Accelerometer wiring for the boards whose accelerometer is connected over SPI.
 *
 * On a Duet3D-source toolboard (TOOL1LC, TOOL1RR, TOOLINDX, EXP1HCL, F3PTB, NodeTrix, SAMMYC21, SZP)
 * the accelerometer is on the I2C bus. The third-party expansion-board firmware (the Duet3Expansion
 * fork carrying the RP2040/RP2350 toolboards) wires its accelerometers to SPI instead, and for those
 * `M955`'s `C` names TWO pins - chip select then interrupt, in that order - which RRF 3.7.0-rc.2 names
 * `spi.cs.acc` and `int.acc`:
 *
 *     M955 P<slot> C"<addr>.spi.cs.acc+int.acc"
 *
 * The board prefix goes on the first pin only. These names do NOT exist on any Duet3D-source board, so
 * this must never be applied to one (`test/accelBoards.test.ts` pins that): the list below is
 * deliberately an allow-list of the boards that are known to be SPI, not "anything that isn't I2C".
 *
 * Names are the `BOARD_TYPE_NAME` each board reports as `boards[].shortName`, taken from the fork's
 * `src/Config/*.h` (`v3.7-dev`) - only boards that build with the accelerometer enabled
 * (`SUPPORT_LIS3DH 1`). Boards with an SPI accelerometer footprint but the driver switched off
 * (FLYSB2040V1_0, MKSTHR3642v1_0, PITBV1_0, PITBV2_0, STRIDEMAXV2_0, RP2350TEST) are left out until they
 * have one to configure.
 */
// The /firmware subpath - see accelScheme.ts for why not the root specifier.
import { firmwareAtLeast } from "dwc-gcode-core/firmware";
import { listAccelModelEntries } from "../capture/tools";
import { MIN_SPI_ACCEL_FIRMWARE } from "./firmwareVersion";

/** Boards whose accelerometer is SPI-connected (CS + INT pins), by reported short name. */
export const SPI_ACCEL_BOARDS: ReadonlyArray<string> = [
	"SHT36V3", "SHT36MAX3", "SHT36MAX4", // Fly SHT36
	"SB2040MAX3", "SB2040PROMAX3", // Fly SB2040 v3
	"FLY36RRF",
	"FLYM2",
	"FSSB2040V2", // Fysetc SB2040 v2
];

/** The two SPI pins, in the order `M955`'s `C` takes them: chip select, then interrupt. */
export const SPI_ACCEL_PINS = "spi.cs.acc+int.acc";

function normalise(name: string | null | undefined): string {
	return (name ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Whether a board's short name is one of the SPI-accelerometer boards. */
export function isSpiAccelBoard(shortName: string | null | undefined): boolean {
	const n = normalise(shortName);
	return n !== "" && SPI_ACCEL_BOARDS.some((b) => normalise(b) === n);
}

/** The `C` value for an SPI accelerometer board at `canAddress` (the prefix is omitted for 0), or null
 *  if the board isn't a known SPI one - never guess a wiring for a board this doesn't know. */
export function spiAccelPort(canAddress: number, shortName: string | null | undefined): string | null {
	if (!isSpiAccelBoard(shortName)) {
		return null;
	}
	return canAddress > 0 ? `${canAddress}.${SPI_ACCEL_PINS}` : SPI_ACCEL_PINS;
}

export interface AccelSetupHint {
	canAddress: number;
	/** The board's reported short name, e.g. "SHT36V3". */
	board: string;
	/** The line to add to config.g, ready to paste. */
	line: string;
}

interface HintBoard { canAddress?: number | null; shortName?: string; firmwareVersion?: string }

/**
 * SPI-accelerometer boards on the machine that have no accelerometer configured yet, each with the exact
 * `M955` line to add. Only offered when both the mainboard and that board run RRF >= 3.7.0-rc.2, the
 * release that names the pins - below it `spi.cs.acc`/`int.acc` don't exist and the line would fail.
 * Each takes the lowest slot the machine isn't using.
 */
export function accelSetupHints(model: unknown): Array<AccelSetupHint> {
	const boards = ((model as { boards?: Array<HintBoard | null> } | null)?.boards ?? []);
	if (!firmwareAtLeast(boards[0]?.firmwareVersion ?? null, MIN_SPI_ACCEL_FIRMWARE)) {
		return [];
	}
	const configured = listAccelModelEntries(model);
	const usedSlots = new Set(configured.map((e) => e.slot).filter((s): s is number => s !== undefined));
	const hints: Array<AccelSetupHint> = [];
	for (const board of boards) {
		const canAddress = board?.canAddress ?? 0;
		const port = board ? spiAccelPort(canAddress, board.shortName) : null;
		if (!board || !port || configured.some((e) => e.canAddress === canAddress)) {
			continue;
		}
		if (!firmwareAtLeast(board.firmwareVersion ?? null, MIN_SPI_ACCEL_FIRMWARE)) {
			continue;
		}
		let slot = 0;
		while (usedSlots.has(slot)) {
			slot++;
		}
		if (slot >= 10) {
			break; // RRF's MaxAccelerometers
		}
		usedSlots.add(slot);
		hints.push({ canAddress, board: board.shortName ?? "", line: `M955 P${slot} C"${port}"` });
	}
	return hints;
}
