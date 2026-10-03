/**
 * Read/diff/backup/write config.g and tool-change macros through a `HostAdapter`, using the pure
 * line editor in `dwc-gcode-core/edit` for the actual editing. This is the layer that touches the
 * machine; everything about WHERE and HOW SAFELY to edit a line lives there and is tested there
 * without a printer. Nothing here writes anything without the caller explicitly calling
 * `applyEditPlan` on a plan it has shown the user - `plan*` functions are pure previews.
 */
import { accelCanAddress, type AccelerometerRef } from "../capture/orchestrator";
import type { HostAdapter } from "../core/host";
import {
	findAccelWiring, findAllAccelWiring, findOtherAccelWiring, parseCPrefix, type AccelWiring,
} from "./accelWiring";
import {
	appendDirective, detectEol, diffLines, findDirectives, parseLines, replaceDirective,
	replaceLine, serializeLines, setParam, type DiffLine, type GcodeLine,
} from "dwc-gcode-core/edit";
import { accelScheme } from "./accelScheme";

/** Same-day, sortable audit stamp for a "; Resonance Lab <date>" comment above an appended directive. */
function dateStamp(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Filesystem-safe timestamp for a backup filename (no colons - FAT/exFAT on the SD card). */
function fileTimestamp(): string {
	return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** RRF's system directory, e.g. "0:/sys" - read from the object model rather than assumed, since
 *  M505 can relocate it. Falls back to the conventional default if the model hasn't reported it yet
 *  (e.g. read right after connecting, before the full object model has synced). */
function systemDir(host: HostAdapter): string {
	const dirs = (host.model() as { directories?: { system?: string } } | null)?.directories;
	return dirs?.system || "0:/sys";
}

export function configPath(host: HostAdapter): string {
	return `${systemDir(host)}/config.g`;
}

export function tpostPath(host: HostAdapter, toolNumber: number): string {
	return `${systemDir(host)}/tpost${toolNumber}.g`;
}

function backupPath(path: string): string {
	return `${path}.rlab-${fileTimestamp()}.bak`;
}

/** config.g must be read for real - a failure here must propagate, not be papered over as "empty",
 *  or a save would write a from-scratch file over content that was never actually seen. */
async function readConfig(host: HostAdapter): Promise<string> {
	try {
		return await host.download(configPath(host));
	} catch (e) {
		throw new Error(`Could not read config.g: ${(e as Error).message || e}`);
	}
}

/** A tool-change macro legitimately may not exist yet - that's "no directive found here", not an
 *  error, so a save through this path appends into a fresh file rather than failing. */
async function readTpostOrEmpty(host: HostAdapter, toolNumber: number): Promise<string> {
	try {
		return await host.download(tpostPath(host, toolNumber));
	} catch {
		return "";
	}
}

export interface DirectiveEditPlan {
	/** Full path this plan would write to. */
	path: string;
	before: string;
	after: string;
	/** Line-level diff for a preview UI; empty when `blocked` is set. */
	diff: Array<DiffLine>;
	/** True when no active directive existed and this plan appends one, rather than editing in place. */
	appended: boolean;
	/** A commented-out copy of the same directive was also found - worth telling the user about
	 *  (it doesn't shadow the active one, but it's easy to mistake for the current setting). */
	disabledDuplicateFound: boolean;
	/** Set (with `after === before`, nothing editable) when the live directive sits on a line this
	 *  editor refuses to touch - `{...}` expression syntax or inside a conditional. The caller should
	 *  show this and refuse to offer "save", not try `applyEditPlan` anyway. */
	blocked?: string;
}

function buildPlan(
	path: string,
	beforeText: string,
	code: string,
	match: Record<string, string> | ((line: GcodeLine) => boolean),
	editLine: (raw: string) => string,
	newDirectiveLine: string,
): DirectiveEditPlan {
	const before = parseLines(beforeText);
	// A predicate can't be handed to findDirectives (it only compares exact param values), so it
	// fetches every line of this directive unfiltered and the predicate does its own filtering here -
	// gcodeEdit.ts stays untouched, its own exports/tests unaffected.
	const all = findDirectives(before, code, typeof match === "function" ? {} : match);
	const matches = typeof match === "function" ? all.filter((m) => match(m.line)) : all;
	const active = matches.find((m) => !m.line.disabled);
	const disabledDuplicateFound = matches.some((m) => m.line.disabled);

	if (active?.line.unsafe) {
		return {
			path, before: beforeText, after: beforeText, diff: [], appended: false, disabledDuplicateFound,
			blocked: `The active ${code} line uses {...} expression syntax or sits inside a conditional - `
				+ "edit config.g by hand for this one, it isn't safe to rewrite automatically.",
		};
	}

	const appended = !active;
	const after = active
		? replaceLine(before, active.index, editLine(active.line.raw))
		: appendDirective(before, newDirectiveLine, `Resonance Lab ${dateStamp()}`);

	return {
		path, before: beforeText, after: serializeLines(after, detectEol(beforeText)),
		diff: diffLines(before, after), appended, disabledDuplicateFound,
	};
}

// ── Accelerometer wiring cache (RRF >= 3.7.0-rc.1) ──────────────────────────────────────────────
// `findExistingWiring` runs before every capture (useResonanceLab.ts's buildActivationCode, per R2 -
// unconditionally, every measurement) as well as before every save below, so re-downloading config.g
// / tpost<N>.g on every call would add a file transfer per measurement. Cached per file path;
// invalidated by this module's own writes (see applyEditPlan) so a save is reflected immediately in
// the very next capture's activation line, not just after a reload.
const cachedGcodeText = new Map<string, string>();

/** Drop one cached file's text (or everything, with no argument) so the next read is fresh. */
export function invalidateGcodeCache(path?: string): void {
	if (path) {
		cachedGcodeText.delete(path);
	} else {
		cachedGcodeText.clear();
	}
}

async function getGcodeText(path: string, read: () => Promise<string>): Promise<string> {
	if (!cachedGcodeText.has(path)) {
		cachedGcodeText.set(path, await read());
	}
	return cachedGcodeText.get(path)!;
}

/** Every accelerometer slot (M955's P value) already claimed by an active M955 C line in this text -
 *  reuses `findAllAccelWiring`'s parsing rather than re-deriving it, since `AccelWiring.slot` already
 *  carries exactly this. */
function usedSlots(gcodeText: string): Set<number> {
	return new Set(findAllAccelWiring(gcodeText).map((w) => w.slot));
}

/**
 * The slot to give a board that has no config.g line yet: the slot it already occupies on the
 * running machine (`preferred`, from the object model) when neither config.g nor `alsoExclude` gives
 * that number to a different board, else the lowest free one - so a save keeps the numbering RRF is
 * already using whenever it can, instead of silently renumbering the machine at the next boot.
 */
function preferredFreeSlot(configText: string, preferred: number | undefined, alsoExclude: ReadonlySet<number> = new Set()): number {
	if (preferred !== undefined && !usedSlots(configText).has(preferred) && !alsoExclude.has(preferred)) {
		return preferred;
	}
	return lowestFreeSlot(configText, alsoExclude);
}

/**
 * The lowest slot (0-9) not already claimed in `configText`, additionally excluding anything in
 * `alsoExclude` - needed when assigning several NEW boards' slots in one batch (Step 5's migration),
 * where each board's assignment must avoid every OTHER board's assignment in the same batch, not just
 * whatever config.g already had before the batch started. Throws if all 10 are taken (RRF's own
 * `MaxAccelerometers` cap - R4).
 */
function lowestFreeSlot(configText: string, alsoExclude: ReadonlySet<number> = new Set()): number {
	const used = usedSlots(configText);
	for (let n = 0; n < 10; n++) {
		if (!used.has(n) && !alsoExclude.has(n)) {
			return n;
		}
	}
	throw new Error("All 10 accelerometer slots are already in use.");
}

/**
 * Where `accel`'s C/Q wiring is currently recorded - checks that tool's own `tpost<N>.g` first (R8's
 * read-side counterpart: reading a per-tool line someone already saved costs nothing, only WRITING
 * one automatically is gated), then falls back to config.g. Shared by useResonanceLab.ts's
 * `buildActivationCode` and `planAccelSave` below, so there is exactly one definition of "where do we
 * trust this accelerometer's wiring to be" - a second copy risks a save and a capture disagreeing.
 */
export async function findExistingWiring(host: HostAdapter, accel: AccelerometerRef): Promise<AccelWiring | null> {
	const canAddress = accelCanAddress(accel);
	const tool = accel.toolNumber;
	if (tool !== undefined && tool >= 0) {
		const hit = findAccelWiring(await getGcodeText(tpostPath(host, tool), () => readTpostOrEmpty(host, tool)), canAddress);
		if (hit) {
			return hit;
		}
	}
	return findAccelWiring(await getGcodeText(configPath(host), () => readConfig(host)), canAddress);
}

/**
 * `accel`'s wiring for building an M955 line. On RRF >= 3.7.0-rc.2 the object model reports the `C`
 * value itself (`sensors.accelerometers[].port`) and the slot it occupies, so those are authoritative -
 * they are what is actually configured right now, which config.g's text may not be (a runtime M955, a
 * macro, `C{...}` expression syntax). Two pins are the norm on an SPI-connected STM32 toolboard (CS
 * then INT, e.g. "121.spi.cs.acc+int.acc") and pass through untouched. The one thing the object model
 * still doesn't carry is `Q` (SPI clock), so that alone is looked up in the files, best-effort - a
 * missing or unreadable file must not stop an object-model-known accelerometer being saved or
 * re-oriented, it just leaves Q at the firmware default. Before rc.2 this is `findExistingWiring`.
 */
export async function resolveAccelWiring(host: HostAdapter, accel: AccelerometerRef): Promise<AccelWiring | null> {
	if (accel.slot === undefined || !accel.port) {
		return findExistingWiring(host, accel);
	}
	let spiFrequency: number | undefined;
	try {
		spiFrequency = (await findExistingWiring(host, accel))?.spiFrequency;
	} catch {
		// Q is a nicety here - see above
	}
	const wiring: AccelWiring = { cSpec: accel.port, canAddress: accelCanAddress(accel), slot: accel.slot };
	if (spiFrequency !== undefined) {
		wiring.spiFrequency = spiFrequency;
	}
	return wiring;
}

export type ShaperScope = "all" | "tool";

export interface ShaperSaveResult {
	plan: DirectiveEditPlan;
	/** Informational notes about the OTHER location(s) that also set M593 - e.g. a per-tool
	 *  tpost<N>.g overriding a machine-wide config.g edit after that tool is next mounted, or vice
	 *  versa. Never blocks saving - RRF applies whichever M593 last ran, so both are always "valid",
	 *  just possibly not what the user meant by "all tools". */
	notes: Array<string>;
}

/**
 * Preview replacing (or inserting) the machine-wide M593 - in config.g for `scope: "all"`, or in one
 * tool's own `tpost<N>.g` for `scope: "tool"` (RRF has one shaper for the whole machine; "this tool
 * only" can only mean re-asserting it every time that tool is picked up).
 */
export async function planShaperSave(
	host: HostAdapter, scope: ShaperScope, toolNumber: number | null, gcodeLine: string, allToolNumbers: Array<number>,
): Promise<ShaperSaveResult> {
	const notes: Array<string> = [];

	if (scope === "all") {
		const path = configPath(host);
		const text = await readConfig(host);
		const plan = buildPlan(path, text, "M593", {}, (raw) => replaceDirective(raw, gcodeLine), gcodeLine);
		for (const n of allToolNumbers) {
			const tpostText = await readTpostOrEmpty(host, n);
			if (findDirectives(parseLines(tpostText), "M593").some((m) => !m.line.disabled)) {
				notes.push(`T${n} has its own M593 in tpost${n}.g, which overrides this the next time it's mounted.`);
			}
		}
		return { plan, notes };
	}

	if (toolNumber === null || toolNumber < 0) {
		throw new Error("No tool selected to save a per-tool shaper for.");
	}
	const path = tpostPath(host, toolNumber);
	const text = await readTpostOrEmpty(host, toolNumber);
	const plan = buildPlan(path, text, "M593", {}, (raw) => replaceDirective(raw, gcodeLine), gcodeLine);
	const configText = await readConfig(host);
	if (findDirectives(parseLines(configText), "M593").some((m) => !m.line.disabled)) {
		notes.push("config.g also sets M593 machine-wide - that stays the default whenever a different tool (or none) is mounted.");
	}
	return { plan, notes };
}

/**
 * Whether an existing config.g line is the one a motor-tune code line should replace: the same
 * directive aimed at the same thing. `M970 X1` is identified by its axis letter (any value - `M970 X0`
 * is replaced, not duplicated); a correction line by its driver `P` and harmonic `S`, and by carrying a
 * `J` - which keeps a register write like `M569.2 P6 R1 V...` on the same driver from matching.
 */
function motorTuneLineMatches(existing: GcodeLine, wanted: GcodeLine): boolean {
	if (wanted.code === "M970") {
		const axis = Object.keys(wanted.params)[0];
		return axis !== undefined && existing.params[axis] !== undefined;
	}
	return existing.params.P === wanted.params.P && existing.params.S === wanted.params.S && existing.params.J !== undefined;
}

/**
 * Preview persisting a motor-tune result in config.g: each code line (`M970 <axis>1` if the run needed
 * phase stepping, then one `M970.3`/`M569.2 P<drv> S<n> J<mag> O<phase>` per adopted harmonic) replaces
 * the active line already aiming at the same axis / driver+harmonic, or is appended in one block with an
 * audit comment. Lines left over from an earlier tune of a harmonic this run didn't adopt are left alone.
 *
 * A line that is conditional or uses `{...}` expressions blocks the whole plan rather than being
 * rewritten blind, like every other edit here.
 */
export async function planMotorTuneSave(host: HostAdapter, codes: ReadonlyArray<string>): Promise<DirectiveEditPlan> {
	const path = configPath(host);
	const beforeText = await readConfig(host);
	const before = parseLines(beforeText);
	let lines = before;
	const toAppend: Array<string> = [];
	let disabledDuplicateFound = false;

	for (const code of codes) {
		const wanted = parseLines(code)[0];
		if (!wanted?.code) {
			continue;
		}
		const matches = findDirectives(lines, wanted.code).filter((m) => motorTuneLineMatches(m.line, wanted));
		disabledDuplicateFound ||= matches.some((m) => m.line.disabled);
		const active = matches.find((m) => !m.line.disabled);
		if (active?.line.unsafe) {
			return {
				path, before: beforeText, after: beforeText, diff: [], appended: false, disabledDuplicateFound,
				blocked: `The active ${wanted.code} line "${active.line.raw.trim()}" uses {...} expression syntax or sits inside a conditional - `
					+ "edit config.g by hand for this one, it isn't safe to rewrite automatically.",
			};
		}
		if (active) {
			lines = replaceLine(lines, active.index, replaceDirective(active.line.raw, code));
		} else {
			toAppend.push(code);
		}
	}

	const appended = toAppend.length > 0;
	if (appended) {
		lines = [...lines, ...parseLines(`; Resonance Lab ${dateStamp()}\n${toAppend.join("\n")}`)];
	}
	return {
		path, before: beforeText, after: serializeLines(lines, detectEol(beforeText)),
		diff: diffLines(before, lines), appended, disabledDuplicateFound,
	};
}

/** Matches an M955 line belonging to ONE board, by its C prefix. Used for both destinations below - a
 *  tpost<N>.g can legitimately carry another board's M955 too, so neither branch may match "any M955". */
function accelLineForBoard(canAddress: number): (line: GcodeLine) => boolean {
	return (line) => {
		const c = line.params.C;
		return c !== undefined && parseCPrefix(c.replace(/^"|"$/g, "")) === canAddress;
	};
}

/**
 * Preview persisting an accelerometer's orientation - and, on new-scheme firmware, its wiring too -
 * so it survives a reboot. There is no orientation-only save once R1 applies: reconfiguring an
 * accelerometer (M955 P0 C"...") resets orientation unless resupplied in the SAME command, so the
 * persisted line is always the complete `M955 P0 C"..." I<n>` - P0 is still mandatory even under the
 * new scheme (confirmed on real hardware; the RRF changelog's "zero or omitted" is not accurate to
 * the actual implementation, which requires the token present) - and where it goes (config.g machine-wide,
 * vs. one tool's own `tpost<N>.g`) is always the caller's explicit choice - see R9, never inferred
 * from whether `accel.toolNumber` happens to be set.
 *
 * `orientation` is a string (RRF's own two-digit-per-axis-pair code, e.g. "206"), not a number - it's
 * built by concatenating digits, and a leading zero (e.g. "06") is significant.
 */
export async function planAccelSave(
	host: HostAdapter, accel: AccelerometerRef, scope: ShaperScope, orientation: string,
): Promise<ShaperSaveResult> {
	const canAddress = accelCanAddress(accel);
	const notes: Array<string> = [];
	// An accelerometer the object model reports a slot for is by definition on multi-accelerometer
	// firmware (RRF >= 3.7.0-rc.2) - whatever its own board's version string says.
	const slotKnown = accel.slot !== undefined;

	if (!slotKnown && accelScheme(host.model()) === "legacy") {
		const path = configPath(host);
		const text = await readConfig(host);
		const plan = buildPlan(
			path, text, "M955", { P: accel.id },
			(raw) => setParam(raw, "I", orientation), `M955 P${accel.id} I${orientation}`,
		);
		return { plan, notes }; // legacy: unchanged: scope is meaningless pre-3.7.0-rc.1
	}

	// Wherever this accelerometer's wiring currently lives (tpost first, else config.g) is what we
	// need C/Q from, REGARDLESS of where the user is choosing to SAVE to now - "scope" answers "where
	// should this become the boot-time state", not "where is the wiring recorded".
	const wiring = await resolveAccelWiring(host, accel);
	if (!wiring) {
		throw new Error("This accelerometer's wiring isn't recorded anywhere yet - run the orientation task with it active first.");
	}

	if (slotKnown || accelScheme(host.model()) === "multi") {
		// Multi-slot (RRF >= 3.7.0-rc.1+1): always config.g, never a scope choice. Each board has its
		// OWN slot now, so saving one can never displace another - the entire reason the scope dialog
		// exists below (R9, single-accelerometer plan) doesn't apply here. `scope` is accepted for a
		// uniform call signature across all three eras but is otherwise ignored, same as the legacy
		// branch above ignoring it for the opposite reason (no slots to choose between at all).
		const configText = await readConfig(host);
		// Reuse this board's EXISTING config.g slot if it already has one there - never reassign a
		// board's slot on a routine orientation update. Only a board with no config.g entry yet (its
		// wiring was found via tpost, or this is its first-ever save) gets a freshly assigned slot.
		const existingConfigWiring = findAccelWiring(configText, canAddress);
		const slot = existingConfigWiring?.slot ?? preferredFreeSlot(configText, accel.slot);
		const newLine = `M955 P${slot} C"${wiring.cSpec}" I${orientation}${wiring.spiFrequency ? ` Q${wiring.spiFrequency}` : ""}`;
		const isThisBoard = accelLineForBoard(canAddress);
		const plan = buildPlan(configPath(host), configText, "M955", isThisBoard, (raw) => setParam(raw, "I", orientation), newLine);
		return { plan, notes }; // no displacement note possible - nothing is displaced (each board keeps its own slot)
	}

	// R/S deliberately omitted: they're the CURRENT session's sampling settings, which each capture
	// sets for itself in its own activation line. Persisting them would freeze one task's rate into
	// config.g as a machine default. C + I + Q is the durable wiring+orientation; nothing else.
	const newLine = `M955 P0 C"${wiring.cSpec}" I${orientation}${wiring.spiFrequency ? ` Q${wiring.spiFrequency}` : ""}`;
	const configText = await readConfig(host);
	const isThisBoard = accelLineForBoard(canAddress);
	// Editing an EXISTING line also ensures P0 is present, not just I - a line saved by a version of
	// this plugin before P0 was known to be mandatory would otherwise stay broken (RRF requires it on
	// config.g's own boot-time M955 too, independent of anything this plugin sends at runtime)
	// forever, even after upgrading. setParam appends the token if the line doesn't have it yet.
	const editLine = (raw: string) => setParam(setParam(raw, "P", "0"), "I", orientation);

	if (scope === "all") {
		const configHasOther = findOtherAccelWiring(configText, canAddress);
		if (configHasOther) {
			notes.push(
				`config.g already makes board ${configHasOther.canAddress}'s accelerometer the boot-time default - `
				+ `saving here replaces it. Board ${configHasOther.canAddress}'s accelerometer will need `
				+ "reactivating (by resonance-lab, or its own tpost) before it's usable again.",
			);
		}
		const plan = buildPlan(configPath(host), configText, "M955", isThisBoard, editLine, newLine);
		return { plan, notes };
	}

	// scope === "tool". Guard exactly as planShaperSave does above - `accel.toolNumber` is optional
	// and activeTool's own "no tool" sentinel is -1, so skipping this would risk writing
	// tpostundefined.g / tpost-1.g, the same failure the shaper dialog already shipped once.
	const toolNumber = accel.toolNumber;
	if (toolNumber === undefined || toolNumber < 0) {
		throw new Error("This accelerometer isn't associated with a tool, so it has no tpost file to save into.");
	}
	const tpostText = await readTpostOrEmpty(host, toolNumber);
	if (findAccelWiring(configText, canAddress)) {
		notes.push(
			"config.g also configures this accelerometer's wiring - that copy is now unused whenever this tool is "
			+ "picked up, but still applies if a resonance-lab measurement targets it without a tool change happening first.",
		);
	}
	// isThisBoard, NOT an unconditional match: tpost<N>.g may already carry an unrelated board's
	// M955, and matching that one would rewrite ANOTHER accelerometer's orientation.
	const plan = buildPlan(tpostPath(host, toolNumber), tpostText, "M955", isThisBoard, editLine, newLine);
	return { plan, notes };
}

// ── Migrating stray tpost<N>.g M955 lines into config.g (RRF >= 3.7.0-rc.1+1) ───────────────────
// Every "this tool only" save before this scheme existed wrote a full M955 line into that tool's own
// tpost<N>.g - and under the single-slot scheme, P could only ever be 0, so EVERY such line, for every
// tool, says P0. On a machine upgraded to multi-accelerometer firmware, picking up any of those tools
// re-sends that stale P0, silently reassigning slot 0 away from whatever config.g assigned there -
// with no error, just quietly wrong data the next time captures run on whichever tool lost the race.
// This is a real hazard on EXISTING installs, not just new ones, and must be offered proactively.

/** Every line matching `code`+predicate deleted outright from `beforeText`, in one plan - unlike
 *  `buildPlan`, never edits-in-place or appends. `diffLines` (the general index-walking differ) is
 *  NOT used here: removing a line shifts every later line's index, which `diffLines` assumes never
 *  happens (its own doc comment: before/after differ only by an edited line and/or an appended one).
 *  The diff is instead built directly against the KNOWN removed indices, which is exact by
 *  construction and needs no realignment logic at all. */
function buildRemovalPlan(path: string, beforeText: string, match: (line: GcodeLine) => boolean): DirectiveEditPlan {
	const before = parseLines(beforeText);
	const removedIndices = new Set(
		before.map((l, i) => i).filter((i) => before[i].code === "M955" && !before[i].disabled && match(before[i])),
	);
	if (removedIndices.size === 0) {
		return { path, before: beforeText, after: beforeText, diff: [], appended: false, disabledDuplicateFound: false };
	}
	const after = before.filter((_, i) => !removedIndices.has(i));
	const diff: Array<DiffLine> = before.map((l, i) => (
		removedIndices.has(i) ? { type: "removed", text: l.raw } : { type: "same", text: l.raw }
	));
	return {
		path, before: beforeText, after: serializeLines(after, detectEol(beforeText)),
		diff, appended: false, disabledDuplicateFound: false,
	};
}

/** The line's own I value (quotes stripped, if it were ever quoted) - "20" (identity) when the line
 *  has none. A one-time carry-over for migration only: reads config.g/tpost's I directly, which R4
 *  elsewhere in this codebase deliberately does NOT trust as an ongoing source of truth (the
 *  orientation registry is) - here there is no registry entry to prefer yet, since this board has
 *  never been reactivated by this plugin under the multi-slot scheme, so the file's own last-written
 *  value is the only thing worth preserving rather than silently resetting to identity. */
function orientationOf(gcodeText: string, canAddress: number): string {
	const line = parseLines(gcodeText).find((l) => (
		l.code === "M955" && !l.disabled && !l.unsafe && l.params.C !== undefined
		&& parseCPrefix(l.params.C.replace(/^"|"$/g, "")) === canAddress
	));
	const rawI = line?.params.I;
	return rawI !== undefined ? rawI.replace(/^"|"$/g, "") : "20";
}

export interface StrayAccelLine {
	toolNumber: number;
	path: string;
	wiring: AccelWiring;
}

/**
 * Every active M955 C line found in any of `toolNumbers`' own tpost<N>.g files - a migration
 * candidate list, not scoped to one board (see `findAllAccelWiring`). Read-only; never removes
 * anything itself (`planAccelMigration` does that, once the user has reviewed and confirmed it).
 */
export async function findStrayTpostAccelLines(host: HostAdapter, toolNumbers: Array<number>): Promise<Array<StrayAccelLine>> {
	const found: Array<StrayAccelLine> = [];
	for (const n of toolNumbers) {
		const text = await readTpostOrEmpty(host, n);
		for (const wiring of findAllAccelWiring(text)) {
			found.push({ toolNumber: n, path: tpostPath(host, n), wiring });
		}
	}
	return found;
}

export interface AccelMigrationPlan {
	/** One removal plan per affected tpost<N>.g file (all of that file's stray lines removed together). */
	removals: Array<DirectiveEditPlan>;
	/** One addition/edit plan per board, into config.g, each with its own slot. */
	additions: Array<DirectiveEditPlan>;
}

/**
 * Build the full migration: strike every stray line out of its own tpost<N>.g, and ensure each
 * board's wiring exists in config.g with a slot of its own - reusing an existing config.g slot for
 * that board if it already has one there, else the lowest slot free across BOTH config.g and every
 * other board in this same batch (so two boards being migrated together never claim the same slot).
 * Orientation is carried over from each stray line's own I value where present (`orientationOf`),
 * defaulting to identity otherwise - migrating shouldn't silently reset an already-solved orientation.
 * A pure preview, same as every other `plan*` function here - nothing is written until the caller
 * applies each returned plan (`applyEditPlan`) after showing them to the user. `runningSlots` maps a
 * board's CAN address to the slot RRF currently has it in (RRF >= 3.7.0-rc.2 reports this), which a
 * board without a config.g line yet keeps when it's free.
 */
export async function planAccelMigration(
	host: HostAdapter, strayLines: Array<StrayAccelLine>, runningSlots: ReadonlyMap<number, number> = new Map(),
): Promise<AccelMigrationPlan> {
	const removals: Array<DirectiveEditPlan> = [];
	const additions: Array<DirectiveEditPlan> = [];

	// One removal plan per affected FILE, even if that file has more than one stray line - not one
	// plan per stray line, so the diff shown to the user reads as "here's everything changing in this
	// file" rather than several overlapping partial diffs of the same file. Text is read once per
	// file and kept (tpostTextByTool) so the addition loop below can read each stray line's ORIGINAL
	// orientation without a second file transfer for the same path.
	const byTool = new Map<number, Array<StrayAccelLine>>();
	for (const line of strayLines) {
		const list = byTool.get(line.toolNumber) ?? [];
		list.push(line);
		byTool.set(line.toolNumber, list);
	}
	const tpostTextByTool = new Map<number, string>();
	for (const [toolNumber, linesInFile] of byTool) {
		const tpostText = await readTpostOrEmpty(host, toolNumber);
		tpostTextByTool.set(toolNumber, tpostText);
		const boards = new Set(linesInFile.map((l) => l.wiring.canAddress));
		const matchAnyStrayBoard = (line: GcodeLine): boolean => {
			const c = line.params.C;
			return c !== undefined && boards.has(parseCPrefix(c.replace(/^"|"$/g, "")));
		};
		removals.push(buildRemovalPlan(tpostPath(host, toolNumber), tpostText, matchAnyStrayBoard));
	}

	// One addition per board into config.g. `configText` and `assignedThisBatch` both accumulate
	// across the loop (not re-read/reset per board) so slot assignment sees every EARLIER board in
	// this same batch, not just what config.g looked like before the batch started.
	let configText = await readConfig(host);
	const assignedThisBatch = new Set<number>();
	for (const { toolNumber, wiring } of strayLines) {
		const existing = findAccelWiring(configText, wiring.canAddress);
		const slot = existing?.slot ?? preferredFreeSlot(configText, runningSlots.get(wiring.canAddress), assignedThisBatch);
		assignedThisBatch.add(slot);
		const orientation = orientationOf(tpostTextByTool.get(toolNumber) ?? "", wiring.canAddress);
		const newLine = `M955 P${slot} C"${wiring.cSpec}" I${orientation}${wiring.spiFrequency ? ` Q${wiring.spiFrequency}` : ""}`;
		const isThisBoard = accelLineForBoard(wiring.canAddress);
		const plan = buildPlan(configPath(host), configText, "M955", isThisBoard, (raw) => setParam(raw, "I", orientation), newLine);
		additions.push(plan);
		configText = plan.after; // next board's lowestFreeSlot/edit-vs-append must see this one's addition
	}

	return { removals, additions };
}

/** Back up the original file, then write the edited one. No-op if the plan turned out to change
 *  nothing (e.g. re-saving the same orientation twice). Throws (without writing) for a `blocked` plan
 *  - callers should already have refused to offer this, this is a defensive last check. */
export async function applyEditPlan(host: HostAdapter, plan: DirectiveEditPlan): Promise<void> {
	if (plan.blocked) {
		throw new Error(plan.blocked);
	}
	if (plan.after === plan.before) {
		return;
	}
	await host.upload(backupPath(plan.path), plan.before);
	await host.upload(plan.path, plan.after);
	// This plugin's own writes must be visible to the NEXT accelerometer-wiring lookup - without this,
	// a user who fixes an orientation and immediately re-measures gets the pre-save text reapplied.
	invalidateGcodeCache(plan.path);
}

/** RRF re-reads config.g only on M999 (full restart) or an explicit re-run - mirrors DWC's own
 *  ConfigUpdatedDialog. Irrelevant for a tpost<N>.g edit, which takes effect on its own next
 *  tool-change with no restart needed. */
export async function restartAfterConfigEdit(host: HostAdapter, mode: "reset" | "runConfig"): Promise<void> {
	await host.sendCode(mode === "reset" ? "M999" : "M98 P\"config.g\"");
}
