/**
 * Read/diff/backup/write config.g and tool-change macros through a `HostAdapter`, using the pure
 * line editor in ./gcodeEdit for the actual editing. This is the layer that touches the machine;
 * everything about WHERE and HOW SAFELY to edit a line lives in gcodeEdit.ts and is tested there
 * without a printer. Nothing here writes anything without the caller explicitly calling
 * `applyEditPlan` on a plan it has shown the user - `plan*` functions are pure previews.
 */
import type { HostAdapter } from "../core/host";
import {
	appendDirective, detectEol, diffLines, findDirectives, parseLines, replaceDirective, replaceLine,
	serializeLines, setParam, type DiffLine,
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
	matchParams: Record<string, string>,
	editLine: (raw: string) => string,
	newDirectiveLine: string,
): DirectiveEditPlan {
	const before = parseLines(beforeText);
	const matches = findDirectives(before, code, matchParams);
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

/**
 * Preview setting an accelerometer's M955 orientation (I) in config.g, editing just that one
 * parameter (preserving `C`/`Q` wiring config) or appending a new M955 line if none exists yet.
 *
 * `orientation` is a string (RRF's own two-digit-per-axis-pair code, e.g. "206"), not a number -
 * it's built by concatenating digits, and a leading zero (e.g. "06") is significant.
 */
export async function planOrientationSave(host: HostAdapter, accelId: string, orientation: string): Promise<DirectiveEditPlan> {
	const path = configPath(host);
	const text = await readConfig(host);
	return buildPlan(
		path, text, "M955", { P: accelId },
		(raw) => setParam(raw, "I", orientation),
		`M955 P${accelId} I${orientation}`,
	);
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
}

/** RRF re-reads config.g only on M999 (full restart) or an explicit re-run - mirrors DWC's own
 *  ConfigUpdatedDialog. Irrelevant for a tpost<N>.g edit, which takes effect on its own next
 *  tool-change with no restart needed. */
export async function restartAfterConfigEdit(host: HostAdapter, mode: "reset" | "runConfig"): Promise<void> {
	await host.sendCode(mode === "reset" ? "M999" : "M98 P\"config.g\"");
}
