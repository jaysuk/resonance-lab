/**
 * Tool <-> accelerometer mapping for tool-changer machines (one toolboard, one accelerometer, per
 * tool).
 *
 * RRF's `Tool` object model entry carries no accelerometer field, so the association has to be
 * derived: `tools[N].extruders[0]` names an extruder index, `move.extruders[i].driver.board` is the
 * CAN address of the board driving it, and that address is matched against `boards[].canAddress` to
 * find the toolboard - whose own `accelerometer` (if any) is this tool's. Verified against
 * `@duet3d/objectmodel`'s type declarations, not guessed.
 *
 * Machines that aren't tool-changers (a single mainboard or one fixed toolboard) simply have no tool
 * whose first extruder resolves to that board, so every accelerometer falls back to today's
 * board-name label - existing single-accelerometer users see no behavioural change.
 */
import type { AccelerometerRef } from "./orchestrator";

interface ModelBoard {
	accelerometer?: unknown;
	canAddress?: number | null;
	shortName?: string;
	name?: string;
}
interface ModelDriverId { board?: number | null }
interface ModelExtruder { driver?: ModelDriverId | null }
interface ModelTool { number?: number; name?: string; extruders?: Array<number> }
interface ResonanceLabModel {
	boards?: Array<ModelBoard | null>;
	move?: { extruders?: Array<ModelExtruder | null> };
	tools?: Array<ModelTool | null>;
}

/** M955/M956 id: "<canAddress>.0" for CAN boards, plain "0" for the mainboard. */
function accelId(board: ModelBoard): string {
	const can = board.canAddress ?? 0;
	return can > 0 ? `${can}.0` : "0";
}

/**
 * Every accelerometer configured on the machine, labelled by tool where that's derivable.
 * `AccelerometerRef.toolNumber`/`toolName` are set only when a tool's first extruder resolves to
 * that accelerometer's board; callers must treat them as optional, not assume a tool-changer.
 */
export function mapAccelerometers(model: unknown): Array<AccelerometerRef> {
	const m = (model ?? {}) as ResonanceLabModel;
	const boards = m.boards ?? [];
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

	const found: Array<AccelerometerRef> = [];
	for (const board of boards) {
		if (!board || !board.accelerometer) {
			continue;
		}
		const can = board.canAddress ?? 0;
		const boardLabel = board.shortName || board.name || `Board ${can}`;
		const tool = boardToTool.get(can);
		const label = tool !== undefined
			? `T${tool.number}${tool.name ? ` ${tool.name}` : ""} — ${boardLabel}`
			: boardLabel;
		found.push({ id: accelId(board), label, toolNumber: tool?.number, toolName: tool?.name });
	}
	return found;
}

/** The accelerometer belonging to a given tool number, if any (used to auto-select on tool change). */
export function accelForTool(accelerometers: Array<AccelerometerRef>, toolNumber: number): AccelerometerRef | undefined {
	return accelerometers.find((a) => a.toolNumber === toolNumber);
}
