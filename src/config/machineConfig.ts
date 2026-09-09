/**
 * Read/diff/backup/write config.g and tool-change macros through a `HostAdapter`, using the pure
 * line editor in ./gcodeEdit for the actual editing. This is the layer that touches the machine;
 * everything about WHERE and HOW SAFELY to edit a line lives in gcodeEdit.ts and is tested there
 * without a printer. Nothing here writes anything without the caller explicitly calling
 * `applyEditPlan` on a plan it has shown the user - `plan*` functions are pure previews.
 */
import type { AccelerometerRef } from "../capture/orchestrator";
import type { HostAdapter } from "../core/host";
import { findAccelWiring, findOtherAccelWiring, parseCPrefix, type AccelWiring } from "./accelWiring";
import { firmwareAtLeast, MIN_ACCEL_FIRMWARE } from "./firmwareVersion";
import {
	appendDirective, detectEol, diffLines, findDirectives, parseLines, replaceDirective, replaceLine,
	serializeLines, setParam, type DiffLine, type GcodeLine,
} from "./gcodeEdit";

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

/**
 * Same threshold and same field (`boards[0].firmwareVersion`) as useResonanceLab.ts's own
 * `usesNewAccelScheme` reactive computed - re-derived here, under a deliberately different name,
 * because this module takes `host` as a plain argument rather than a live store binding, so the two
 * are never confused for the same binding.
 */
function firmwareUsesNewAccelScheme(host: HostAdapter): boolean {
	const main = (host.model() as { boards?: Array<{ firmwareVersion?: string } | null> } | null)
		?.boards?.[0]?.firmwareVersion ?? null;
	return firmwareAtLeast(main, MIN_ACCEL_FIRMWARE);
}

/**
 * Where `accel`'s C/Q wiring is currently recorded - checks that tool's own `tpost<N>.g` first (R8's
 * read-side counterpart: reading a per-tool line someone already saved costs nothing, only WRITING
 * one automatically is gated), then falls back to config.g. Shared by useResonanceLab.ts's
 * `buildActivationCode` and `planAccelSave` below, so there is exactly one definition of "where do we
 * trust this accelerometer's wiring to be" - a second copy risks a save and a capture disagreeing.
 */
export async function findExistingWiring(host: HostAdapter, accel: AccelerometerRef): Promise<AccelWiring | null> {
	const canAddress = parseInt(accel.id, 10) || 0;
	const tool = accel.toolNumber;
	if (tool !== undefined && tool >= 0) {
		const hit = findAccelWiring(await getGcodeText(tpostPath(host, tool), () => readTpostOrEmpty(host, tool)), canAddress);
		if (hit) {
			return hit;
		}
	}
	return findAccelWiring(await getGcodeText(configPath(host), () => readConfig(host)), canAddress);
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
 * accelerometer (M955 C"...") resets orientation unless resupplied in the SAME command, so the
 * persisted line is always the complete `M955 C"..." I<n>`, and where it goes (config.g machine-wide,
 * vs. one tool's own `tpost<N>.g`) is always the caller's explicit choice - see R9, never inferred
 * from whether `accel.toolNumber` happens to be set.
 *
 * `orientation` is a string (RRF's own two-digit-per-axis-pair code, e.g. "206"), not a number - it's
 * built by concatenating digits, and a leading zero (e.g. "06") is significant.
 */
export async function planAccelSave(
	host: HostAdapter, accel: AccelerometerRef, scope: ShaperScope, orientation: string,
): Promise<ShaperSaveResult> {
	const canAddress = parseInt(accel.id, 10) || 0; // "121.0" -> 121, "0" -> 0
	const notes: Array<string> = [];

	if (!firmwareUsesNewAccelScheme(host)) {
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
	const wiring = await findExistingWiring(host, accel);
	if (!wiring) {
		throw new Error("This accelerometer's wiring isn't recorded anywhere yet - run the orientation task with it active first.");
	}

	// R/S deliberately omitted: they're the CURRENT session's sampling settings, which each capture
	// sets for itself in its own activation line. Persisting them would freeze one task's rate into
	// config.g as a machine default. C + I + Q is the durable wiring+orientation; nothing else.
	const newLine = `M955 C"${wiring.cSpec}" I${orientation}${wiring.spiFrequency ? ` Q${wiring.spiFrequency}` : ""}`;
	const configText = await readConfig(host);
	const isThisBoard = accelLineForBoard(canAddress);

	if (scope === "all") {
		const configHasOther = findOtherAccelWiring(configText, canAddress);
		if (configHasOther) {
			notes.push(
				`config.g already makes board ${configHasOther.canAddress}'s accelerometer the boot-time default - `
				+ `saving here replaces it. Board ${configHasOther.canAddress}'s accelerometer will need `
				+ "reactivating (by resonance-lab, or its own tpost) before it's usable again.",
			);
		}
		const plan = buildPlan(configPath(host), configText, "M955", isThisBoard, (raw) => setParam(raw, "I", orientation), newLine);
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
	const plan = buildPlan(tpostPath(host, toolNumber), tpostText, "M955", isThisBoard, (raw) => setParam(raw, "I", orientation), newLine);
	return { plan, notes };
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
