/**
 * Accelerometer discovery from the object model, plus tool <-> accelerometer mapping for
 * tool-changer machines (one toolboard, one accelerometer, per tool).
 *
 * Two object-model shapes exist and both are read here:
 *  - RRF >= 3.7.0-rc.2: `sensors.accelerometers[]`, indexed by the M955/M956 `P` slot number, each
 *    entry carrying `port` (the M955 `C` value as given, board prefix included - e.g.
 *    `"121.i2c.lis"`, or `"121.spi.cs.acc+int.acc"` for an SPI-connected STM32 toolboard). The
 *    board is therefore identified by the `port` prefix, not by which `boards[]` entry holds it.
 *  - Earlier 3.7 builds: one `boards[N].accelerometer` per board, with no slot number and no port.
 * Entries from `sensors.accelerometers[]` win; a `boards[].accelerometer` is only added for a board
 * the sensors list doesn't already cover, so a firmware/DWC combination that reports both can never
 * list one accelerometer twice.
 *
 * RRF's `Tool` object model entry carries no accelerometer field, so the tool association has to be
 * derived: `tools[N].extruders[0]` names an extruder index, `move.extruders[i].driver.board` is the
 * CAN address of the board driving it, and that address is matched against the accelerometer's
 * board to find the toolboard - whose accelerometer (if any) is this tool's. Verified against
 * `@duet3d/objectmodel`'s type declarations, not guessed.
 *
 * Machines that aren't tool-changers (a single mainboard or one fixed toolboard) simply have no tool
 * whose first extruder resolves to that board, so every accelerometer falls back to today's
 * board-name label - existing single-accelerometer users see no behavioural change.
 */
import { parseCPrefix } from "../config/accelWiring";
import type { AccelerometerRef } from "./orchestrator";

interface ModelAccelerometer {
	orientation?: number;
	resolution?: number;
	samplingRate?: number;
	runs?: number;
	port?: string | null;
}
interface ModelBoard {
	accelerometer?: ModelAccelerometer | null;
	canAddress?: number | null;
	shortName?: string;
	name?: string;
	uniqueId?: string | null;
}
interface ModelDriverId { board?: number | null }
interface ModelExtruder { driver?: ModelDriverId | null }
interface ModelTool { number?: number; name?: string; extruders?: Array<number> }
interface ResonanceLabModel {
	boards?: Array<ModelBoard | null>;
	move?: { extruders?: Array<ModelExtruder | null> };
	sensors?: { accelerometers?: Array<ModelAccelerometer | null> | null };
	tools?: Array<ModelTool | null>;
}

/** M955/M956 id: "<canAddress>.0" for CAN boards, plain "0" for the mainboard. An internal board
 *  key, unique per accelerometer because a board can only ever hold one - on firmware before
 *  multi-accelerometer support it was also the literal M956 `P` value. Never send it as `P` on
 *  firmware that reports `slot`. */
function accelId(canAddress: number): string {
	return canAddress > 0 ? `${canAddress}.0` : "0";
}

/** One accelerometer as the object model reports it, whichever shape it came from. */
export interface AccelModelEntry {
	/** CAN address of the board it is connected to (0 = the mainboard). */
	canAddress: number;
	/** The M955/M956 `P` slot. Only known from `sensors.accelerometers[]` (RRF >= 3.7.0-rc.2). */
	slot?: number;
	/** The M955 `C` value as configured. Only known from `sensors.accelerometers[]`. */
	port?: string;
	orientation?: number;
	resolution?: number;
	samplingRate?: number;
	runs?: number;
	/** The `boards[]` entry for `canAddress`, for its name and unique id. */
	board?: ModelBoard;
}

/** Every configured accelerometer in the model. */
export function listAccelModelEntries(model: unknown): Array<AccelModelEntry> {
	const m = (model ?? {}) as ResonanceLabModel;
	const boards = m.boards ?? [];
	const mainboardAddress = boards[0]?.canAddress ?? 0;
	const boardAt = (canAddress: number) => boards.find((b) => b && (b.canAddress ?? 0) === canAddress) ?? undefined;
	const entries: Array<AccelModelEntry> = [];

	const sensors = m.sensors?.accelerometers;
	if (Array.isArray(sensors)) {
		sensors.forEach((a, slot) => {
			if (!a) {
				return; // a gap: RRF reports null for an unconfigured slot below a configured one
			}
			// No board prefix means the port is on the board RRF itself runs on
			const canAddress = a.port ? (/^[!^*]*\d+\./.test(a.port) ? parseCPrefix(a.port) : mainboardAddress) : mainboardAddress;
			entries.push({
				canAddress, slot, port: a.port ?? undefined, orientation: a.orientation, resolution: a.resolution,
				samplingRate: a.samplingRate, runs: a.runs, board: boardAt(canAddress),
			});
		});
	}
	for (const board of boards) {
		if (!board?.accelerometer) {
			continue;
		}
		const canAddress = board.canAddress ?? 0;
		if (entries.some((e) => e.canAddress === canAddress)) {
			continue;
		}
		const a = board.accelerometer;
		entries.push({
			canAddress, orientation: a.orientation, resolution: a.resolution, samplingRate: a.samplingRate, runs: a.runs, board,
		});
	}
	return entries;
}

/** The accelerometer connected to one board, or null if that board has none. */
export function findAccelModelEntry(model: unknown, canAddress: number): AccelModelEntry | null {
	return listAccelModelEntries(model).find((e) => e.canAddress === canAddress) ?? null;
}

/**
 * Every accelerometer configured on the machine, labelled by tool where that's derivable.
 * `AccelerometerRef.toolNumber`/`toolName` are set only when a tool's first extruder resolves to
 * that accelerometer's board; callers must treat them as optional, not assume a tool-changer.
 */
export function mapAccelerometers(model: unknown): Array<AccelerometerRef> {
	const m = (model ?? {}) as ResonanceLabModel;
	const extruders = m.move?.extruders ?? [];
	const tools = m.tools ?? [];

	// Board CAN address -> the tool whose first extruder drives it. First match wins; a board should
	// only ever be one tool's toolboard, but a pathological config (two tools sharing an extruder
	// index into the same board) shouldn't produce two conflicting labels for one accelerometer.
	const boardToTool = new Map<number, ModelTool>();
	for (const tool of tools) {
		const extIndex = tool?.extruders?.[0];
		if (tool === null || tool === undefined || extIndex === undefined) {
			continue;
		}
		const board = extruders[extIndex]?.driver?.board;
		if (board === null || board === undefined || boardToTool.has(board)) {
			continue;
		}
		boardToTool.set(board, tool);
	}

	const entries = listAccelModelEntries(model);
	const withSlots = entries.filter((e) => e.slot !== undefined).length;
	return entries.map((entry) => {
		const can = entry.canAddress;
		const boardLabel = entry.board?.shortName || entry.board?.name || `Board ${can}`;
		const tool = boardToTool.get(can);
		let label = tool !== undefined
			? `T${tool.number}${tool.name ? ` ${tool.name}` : ""} — ${boardLabel}`
			: boardLabel;
		if (withSlots > 1) {
			label += ` · P${entry.slot}`; // two boards can share a name, the slot number is what tells them apart
		}
		const ref: AccelerometerRef = { id: accelId(can), label, toolNumber: tool?.number, toolName: tool?.name };
		if (entry.slot !== undefined) {
			ref.canAddress = can;
			ref.slot = entry.slot;
			ref.port = entry.port;
		}
		return ref;
	});
}

/** The accelerometer belonging to a given tool number, if any (used to auto-select on tool change). */
export function accelForTool(accelerometers: Array<AccelerometerRef>, toolNumber: number): AccelerometerRef | undefined {
	return accelerometers.find((a) => a.toolNumber === toolNumber);
}
