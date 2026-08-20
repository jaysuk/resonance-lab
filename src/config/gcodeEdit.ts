/**
 * Line-preserving G-code file editor: locate a directive (e.g. `M955 P121.0 ...`) in config.g or a
 * tool-change macro, and either replace one parameter, replace the whole directive, or append a new
 * one - without disturbing anything else in the file byte-for-byte.
 *
 * Deliberately conservative. `M955` carries hardware wiring (`C` SPI pins, `Q` SPI frequency)
 * alongside the orientation this plugin cares about, so `setParam` only ever rewrites the ONE
 * parameter token it's asked for. And a line inside a conditional or using `{...}` expression syntax
 * (RRF's own meta-gcode - real config.g files use this, e.g. `M572 D0 S{global.paValue}`) is flagged
 * `unsafe` rather than silently mis-edited; the caller is expected to refuse those and tell the user
 * to edit by hand.
 *
 * Pure, no Vue/host imports - see machineConfig.ts for the read/diff/backup/write wrapper that
 * actually touches the machine.
 */

export interface GcodeLine {
	/** Original line text, exactly as read (no line-ending characters). */
	raw: string;
	/** The directive word (e.g. "M955"), upper-cased. Null for blank lines and pure comments with no
	 *  directive text at all. Set even when `disabled` is true, so a commented-out directive is still
	 *  findable - `disabled` is what says whether it's currently active. */
	code: string | null;
	/** Single-letter parameters as written, quotes included for string values (e.g. P: '"mzv"'). */
	params: Record<string, string>;
	/** The whole line is a comment (starts with `;` after only whitespace) - a directive here, if
	 *  any, is not in effect. */
	disabled: boolean;
	/** Contains `{...}` expression syntax, or looks like flow control (if/elif/else/while/echo/abort)
	 *  - editing tools in this file must refuse to touch it. */
	unsafe: boolean;
}

/** Blank out the contents of "..." spans (replacing each character with a space) so a search for
 *  unquoted syntax - a parameter letter, a comment `;`, `{` - can't match text inside a quoted
 *  string value. Same length as the input, so match positions still index into the original text. */
function maskQuoted(s: string): string {
	let out = "";
	let inQuotes = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\"") {
			inQuotes = !inQuotes;
			out += " ";
		} else {
			out += inQuotes ? " " : c;
		}
	}
	return out;
}

/** Split a line into its code+params portion and its trailing ";comment" (the first UNQUOTED
 *  semicolon onward, with no leading space - see `withComment`), so param parsing/editing can never
 *  match inside either a quoted value or a comment. */
function splitComment(raw: string): [body: string, comment: string] {
	const idx = maskQuoted(raw).indexOf(";");
	return idx === -1 ? [raw, ""] : [raw.slice(0, idx), raw.slice(idx)];
}

/** Reattach a comment split off by `splitComment`, inserting the separating space `comment` doesn't
 *  carry itself (it starts exactly at the `;`). A no-op when there's no comment at all. */
function withComment(body: string, comment: string): string {
	return comment ? `${body} ${comment}` : body;
}

const UNSAFE_LINE = /\{[^}]*\}|^\s*(if|elif|else|while|echo|abort)\b/i;

/** Parse a line's parameters after the directive word. Handles quoted string values and decimal
 *  numbers; not a general G-code parser (this module only ever edits M955/M593-shaped lines). */
function parseParams(afterCode: string): Record<string, string> {
	const params: Record<string, string> = {};
	const masked = maskQuoted(afterCode);
	const re = /[A-Za-z]/g;
	for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
		const start = m.index;
		if (start > 0 && !/\s/.test(masked[start - 1])) {
			continue; // a letter that isn't at a token boundary - part of something else, not a param
		}
		const letter = masked[start].toUpperCase();
		let end = start + 1;
		if (afterCode[end] === "\"") {
			end++;
			while (end < afterCode.length && afterCode[end] !== "\"") {
				end++;
			}
			end = Math.min(end + 1, afterCode.length);
		} else {
			while (end < afterCode.length && !/\s/.test(afterCode[end])) {
				end++;
			}
		}
		params[letter] = afterCode.slice(start + 1, end);
	}
	return params;
}

function parseLine(raw: string): GcodeLine {
	const disabled = /^[ \t]*;/.test(raw);
	const afterComment = disabled ? raw.replace(/^[ \t]*;[ \t]*/, "") : raw;
	const [body] = splitComment(afterComment);
	const trimmed = body.trimStart();
	const codeMatch = /^([A-Za-z][0-9]+(?:\.[0-9]+)?)\b/.exec(trimmed);
	const code = codeMatch ? codeMatch[1].toUpperCase() : null;
	const params = code ? parseParams(trimmed.slice(codeMatch![1].length)) : {};
	return { raw, code, params, disabled, unsafe: UNSAFE_LINE.test(raw) };
}

/** Whether a file most likely uses CRLF line endings, so a rewritten file matches. Any CRLF present
 *  is taken as CRLF - real config.g files are not a mix, and guessing conservatively wrong for a
 *  genuinely mixed file is no worse than any other heuristic here. */
export function detectEol(text: string): "\r\n" | "\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

export function parseLines(text: string): Array<GcodeLine> {
	return text.split(/\r\n|\n/).map(parseLine);
}

export function serializeLines(lines: Array<GcodeLine>, eol: "\r\n" | "\n"): string {
	return lines.map((l) => l.raw).join(eol);
}

/** Numeric-tolerant so `P121` (index 0 implied) matches a target of `"121.0"` and vice versa - this
 *  plugin's own accelerometer ids are always `<board>` or `<board>.0`, which are the same float
 *  either way. Falls back to a quote-insensitive string compare for non-numeric values (e.g. M593's
 *  `P"mzv"`), though nothing in this module currently matches directives by a string param. */
function valuesEqual(actual: string | undefined, wanted: string): boolean {
	if (actual === undefined) {
		return false;
	}
	const na = Number(actual);
	const nb = Number(wanted);
	if (!Number.isNaN(na) && !Number.isNaN(nb)) {
		return na === nb;
	}
	return actual.replace(/^"|"$/g, "") === wanted.replace(/^"|"$/g, "");
}

export interface DirectiveMatch { index: number; line: GcodeLine }

/** Every line (active or commented-out) whose directive word matches, optionally filtered by
 *  parameter values. Returns both kinds deliberately - callers distinguish via `line.disabled` so
 *  the UI can say "there's also a disabled M593 above the one I changed" rather than silently
 *  ignoring it. */
export function findDirectives(lines: Array<GcodeLine>, code: string, matchParams: Record<string, string> = {}): Array<DirectiveMatch> {
	const upper = code.toUpperCase();
	const wanted = Object.entries(matchParams);
	const found: Array<DirectiveMatch> = [];
	lines.forEach((line, index) => {
		if (line.code !== upper) {
			return;
		}
		if (wanted.every(([k, v]) => valuesEqual(line.params[k], v))) {
			found.push({ index, line });
		}
	});
	return found;
}

/**
 * Replace (or append) exactly one bare-numeric parameter token (e.g. `I` in `M955 P121.0 I20`),
 * leaving every other parameter, the directive word, spacing and trailing comment untouched. Not for
 * string parameters (M593's `P"mzv"`) - use `replaceDirective` for those.
 */
export function setParam(raw: string, letter: string, value: string): string {
	const [body, comment] = splitComment(raw);
	const masked = maskQuoted(body);
	const upper = letter.toUpperCase();
	const re = new RegExp(`(^|\\s)(${upper})(-?[0-9]*\\.?[0-9]+)`, "i");
	const m = re.exec(masked);
	if (m) {
		// body.slice(end) already carries whatever space originally sat between the old value and the
		// comment (or end of line), so the comment reattaches directly - no separator to add here.
		const start = m.index + m[1].length;
		const end = start + m[2].length + m[3].length;
		return body.slice(0, start) + upper + value + body.slice(end) + comment;
	}
	// The append path replaces body's own trailing whitespace outright, so it DOES need withComment
	// to supply a fresh separator before the comment.
	return withComment(`${body.replace(/[ \t]+$/, "")} ${upper}${value}`, comment);
}

/** Replace a line's entire directive+params with `newDirective`, keeping its original indentation
 *  and trailing comment. For M593, whose few parameters (`P F S`) are all replaced together. */
export function replaceDirective(raw: string, newDirective: string): string {
	const indent = /^[ \t]*/.exec(raw)![0];
	const [, comment] = splitComment(raw);
	return withComment(`${indent}${newDirective}`, comment);
}

/** Append a new directive at the end of the file with an audit comment, for when none exists yet. */
export function appendDirective(lines: Array<GcodeLine>, directive: string, note: string): Array<GcodeLine> {
	return [...lines, parseLine(`; ${note}`), parseLine(directive)];
}

/** Replace one line by index without disturbing any other, re-deriving `code`/`params`/etc from the
 *  new text so the result stays as accurate as a freshly-parsed line (useful if a caller inspects it
 *  further; `serializeLines` itself only reads `.raw`). */
export function replaceLine(lines: Array<GcodeLine>, index: number, raw: string): Array<GcodeLine> {
	return lines.map((l, i) => (i === index ? parseLine(raw) : l));
}

export interface DiffLine { type: "same" | "added" | "removed"; text: string }

/**
 * Line-level diff between an original file and one of this module's own edits. Deliberately not a
 * general diff algorithm - `before`/`after` only ever differ by one changed line and/or lines
 * appended at the end (everything `setParam`/`replaceDirective`/`appendDirective` produce), so a
 * straight index-by-index walk is exact and there's no realignment-on-insertion case to get wrong.
 */
export function diffLines(before: Array<GcodeLine>, after: Array<GcodeLine>): Array<DiffLine> {
	const out: Array<DiffLine> = [];
	const max = Math.max(before.length, after.length);
	for (let i = 0; i < max; i++) {
		const b = before[i];
		const a = after[i];
		if (b && a && b.raw === a.raw) {
			out.push({ type: "same", text: a.raw });
			continue;
		}
		if (b) {
			out.push({ type: "removed", text: b.raw });
		}
		if (a) {
			out.push({ type: "added", text: a.raw });
		}
	}
	return out;
}
