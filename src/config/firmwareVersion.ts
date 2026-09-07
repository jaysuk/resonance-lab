/**
 * Firmware version parsing/comparison for gating features that need a minimum RRF version. Pure,
 * no imports.
 *
 * RRF version strings are semver-ish but not strictly semver: the STM32 port appends a parenthesised
 * suffix - `3.7.0-rc.1(CAN0)`, `3.7.0-beta.1(no 3rd order motion)` (with a SPACE before the paren,
 * despite that file's own comment claiming the version must not contain spaces). Any comparison MUST
 * strip that suffix first, or every STM32H7 board - the main phase-stepping platform - reports an
 * unparseable version and a fail-closed gate hides the feature from exactly the hardware it targets.
 */

export interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease: Array<string | number>;
}

/** Split a prerelease string into identifiers, breaking at ".", "-", and letter/digit boundaries. */
function splitPrerelease(raw: string): Array<string | number> {
	const parts = raw.split(/[.-]/).flatMap((piece) => piece.split(/(?<=[a-zA-Z])(?=[0-9])|(?<=[0-9])(?=[a-zA-Z])/));
	return parts
		.filter((p) => p.length > 0)
		.map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p));
}

/**
 * Parse an RRF-reported version string. Strips a parenthesised suffix (the STM32 port's
 * VERSION_SUFFIX) and a leading "v" first, then build metadata after "+", before matching semver.
 */
export function parseFirmwareVersion(raw: string): ParsedVersion | null {
	if (!raw) {
		return null;
	}
	let s = raw.split("(")[0].trim();
	s = s.replace(/^v/i, "");
	s = s.split("+")[0];

	const m = /^(\d+)\.(\d+)(?:\.(\d+))?(.*)$/.exec(s);
	if (!m) {
		return null;
	}
	const major = parseInt(m[1], 10);
	const minor = parseInt(m[2], 10);
	const patch = m[3] !== undefined ? parseInt(m[3], 10) : 0;
	const rest = m[4].replace(/^[.-]/, "");
	const prerelease = rest ? splitPrerelease(rest) : [];
	return { major, minor, patch, prerelease };
}

/** Compare two prerelease identifiers per semver precedence: numeric < alphanumeric; numeric compares numerically. */
function compareIdentifier(a: string | number, b: string | number): number {
	const aNum = typeof a === "number", bNum = typeof b === "number";
	if (aNum && bNum) {
		return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
	}
	if (aNum !== bNum) {
		return aNum ? -1 : 1; // numeric identifiers have lower precedence than alphanumeric
	}
	return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Compare two firmware version strings. Semver precedence: major, minor, patch; then a version with
 * NO prerelease outranks one WITH a prerelease (3.7.0 > 3.7.0-rc.1); then prerelease identifiers
 * compare pairwise, and if all shared identifiers are equal the longer list wins.
 * @returns -1 if a < b, 0 if equal, 1 if a > b. Throws if either string fails to parse - callers that
 * need a safe boolean should use firmwareAtLeast instead.
 */
export function compareFirmwareVersions(a: string, b: string): number {
	const pa = parseFirmwareVersion(a);
	const pb = parseFirmwareVersion(b);
	if (!pa || !pb) {
		throw new Error(`Cannot compare unparseable firmware version: "${a}" vs "${b}"`);
	}
	if (pa.major !== pb.major) { return pa.major < pb.major ? -1 : 1; }
	if (pa.minor !== pb.minor) { return pa.minor < pb.minor ? -1 : 1; }
	if (pa.patch !== pb.patch) { return pa.patch < pb.patch ? -1 : 1; }

	const aHasPre = pa.prerelease.length > 0, bHasPre = pb.prerelease.length > 0;
	if (aHasPre !== bHasPre) {
		return aHasPre ? -1 : 1; // no prerelease outranks any prerelease
	}
	const len = Math.min(pa.prerelease.length, pb.prerelease.length);
	for (let i = 0; i < len; i++) {
		const cmp = compareIdentifier(pa.prerelease[i], pb.prerelease[i]);
		if (cmp !== 0) {
			return cmp;
		}
	}
	if (pa.prerelease.length !== pb.prerelease.length) {
		return pa.prerelease.length < pb.prerelease.length ? -1 : 1; // longer list wins on a tie
	}
	return 0;
}

/**
 * Whether `actual` is at least `required`, failing CLOSED (false) on anything that doesn't parse -
 * missing, empty, or unparseable firmware means "unsupported", never "assume it's fine".
 */
export function firmwareAtLeast(actual: string | null | undefined, required: string): boolean {
	if (!actual) {
		return false;
	}
	const pa = parseFirmwareVersion(actual);
	const pb = parseFirmwareVersion(required);
	if (!pa || !pb) {
		return false;
	}
	return compareFirmwareVersions(actual, required) >= 0;
}
