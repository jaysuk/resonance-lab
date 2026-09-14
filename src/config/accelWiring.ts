/**
 * Extracts an M955 accelerometer's wiring (`C`/`Q`) from a G-code file's text - config.g or a tool's
 * own `tpost<N>.g` (both use the same line shape, so this module is deliberately file-agnostic; the
 * caller decides which file(s) to read and in what order - see `machineConfig.ts`'s
 * `findExistingWiring`).
 *
 * Needed because RRF's object model carries no field for M955's `C` wiring string anywhere - as of
 * 3.7.0-rc.1 it only ever exists as the text of the M955 line itself. Pure text parsing on top of
 * `gcodeEdit.ts`'s `parseLines`; no Vue/host imports.
 */
import { parseLines, type GcodeLine } from "./gcodeEdit";

export interface AccelWiring {
	/** The exact C parameter value as written, quotes stripped, e.g. "121.i2c.lis" or "^spi.cs1". */
	cSpec: string;
	/** SPI frequency if the line specified one. */
	spiFrequency?: number;
	/** CAN address this line's C prefix resolves to (0 = local/mainboard). */
	canAddress: number;
	/** The line's own P value - which of RRF's (up to 10, on multi-accelerometer firmware) logical
	 *  accelerometer slots this wiring occupies. Defaults to 0 when the line has no P token at all (a
	 *  line written before P became mandatory, or hand-edited) - the only value that was ever legal
	 *  before multiple slots existed, so it's the correct assumption for an old line either way. */
	slot: number;
}

/** Strip a param value's surrounding quotes, exactly as gcodeEdit's parseLines leaves them attached
 *  (e.g. '"121.i2c.lis"'). A no-op on an already-bare value like a Q frequency. */
function unquote(v: string): string {
	return v.replace(/^"|"$/g, "");
}

/**
 * The CAN address a C value's optional "<digits>." prefix names; 0 (local) when absent. Pass the
 * value with quotes already stripped. Mirrors RRF's `IoPort::RemoveBoardAddress` - only the
 * numeric-dot prefix is stripped for addressing; a leading inversion character (^/!/*) is irrelevant
 * to the address and is not reproduced here.
 */
export function parseCPrefix(cSpec: string): number {
	const m = /^(\d+)\./.exec(cSpec.replace(/^[\^!*]+/, ""));
	return m ? parseInt(m[1], 10) : 0;
}

/** Every enabled, safely-editable M955 line that names a C wiring. Excludes disabled (commented-out)
 *  lines, lines with no C at all, and `unsafe` lines ({...} expression syntax or flow control) - a
 *  `C{param.accelPin}` value can't be resolved statically and must not be guessed at. */
function activeM955Lines(gcodeText: string): Array<GcodeLine> {
	return parseLines(gcodeText).filter(
		(l) => l.code === "M955" && !l.disabled && !l.unsafe && l.params.C !== undefined,
	);
}

function toWiring(line: GcodeLine): AccelWiring {
	const cSpec = unquote(line.params.C);
	const canAddress = parseCPrefix(cSpec);
	const rawQ = line.params.Q;
	const spiFrequency = rawQ !== undefined ? parseInt(unquote(rawQ), 10) : NaN;
	const rawP = line.params.P;
	const parsedSlot = rawP !== undefined ? parseInt(unquote(rawP), 10) : NaN;
	const slot = Number.isNaN(parsedSlot) ? 0 : parsedSlot;
	return Number.isNaN(spiFrequency) ? { cSpec, canAddress, slot } : { cSpec, canAddress, slot, spiFrequency };
}

/**
 * The wiring for `canAddress`, or null if no active M955 C line names it. When more than one line
 * matches (the file legitimately can contain more than one attempt), the LAST one wins - mirrors RRF
 * itself processing the file top-to-bottom.
 */
export function findAccelWiring(gcodeText: string, canAddress: number): AccelWiring | null {
	const matches = activeM955Lines(gcodeText).filter((l) => parseCPrefix(unquote(l.params.C)) === canAddress);
	if (matches.length === 0) {
		return null;
	}
	return toWiring(matches[matches.length - 1]);
}

/**
 * The first active M955 C line belonging to any board OTHER than `canAddress` - used to name the
 * specific accelerometer a config.g save would displace, rather than warning generically.
 */
export function findOtherAccelWiring(gcodeText: string, canAddress: number): AccelWiring | null {
	const other = activeM955Lines(gcodeText).find((l) => parseCPrefix(unquote(l.params.C)) !== canAddress);
	return other ? toWiring(other) : null;
}

/**
 * Every active M955 C line in the file, for ANY board - unlike `findAccelWiring`, not scoped to one
 * `canAddress`. Used for machine-wide scans (e.g. finding every stray accelerometer line across every
 * tool's own tpost<N>.g during migration) where the whole point is discovering every board at once,
 * not looking one up. Returned in file order; unlike `findAccelWiring` there is no "last one wins"
 * collapsing here - a caller scanning for strays wants to see every line, including a duplicate.
 */
export function findAllAccelWiring(gcodeText: string): Array<AccelWiring> {
	return activeM955Lines(gcodeText).map(toWiring);
}
