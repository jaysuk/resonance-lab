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

/**
 * Minimum firmware for RRF's single-accelerometer M955/M956 scheme (P capped at 0, C mandatory and
 * CAN-address-prefixed, exactly one accelerometer active machine-wide). A separate constant from any
 * other feature's own minimum (e.g. motortune's) even where they coincide today - they gate unrelated
 * firmware capabilities that only happen to share a threshold on this release.
 */
export const MIN_ACCEL_FIRMWARE = "3.7.0-rc.1";

/**
 * Minimum firmware for RRF's multi-accelerometer scheme (up to 10 independent slots, `P` selects
 * which one, instead of being capped to `0`) - `RepRapFirmware@ee3c80b`/`Duet3Expansion@73549e0`,
 * both landed the day after `MIN_ACCEL_FIRMWARE` itself and both reporting `"3.7.0-rc.1+1"`. A
 * SEPARATE constant from `MIN_ACCEL_FIRMWARE`: a board can satisfy the first without the second
 * (plain rc.1, still single-slot) - they gate genuinely different capabilities that happen to be one
 * firmware release apart. Not yet in general release as of writing; expected in test builds ahead of
 * 3.7.0 stable. Relies on `compareFirmwareVersions`'s "+N" build-number tiebreaker (see
 * `ParsedVersion.build`) - without it this string would compare equal to plain "3.7.0-rc.1".
 */
export const MIN_MULTI_ACCEL_FIRMWARE = "3.7.0-rc.1+1";

export interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease: Array<string | number>;
	/**
	 * The numeric part of a "+N" suffix (e.g. "3.7.0-rc.1+1" -> 1). Real semver calls this "build
	 * metadata" and defines it as precedence-NEUTRAL, but RRF uses it as a genuine sequential counter
	 * WITHIN one prerelease tag - confirmed by reading two consecutive firmware commits' `Version.h`
	 * diffs, both bumping only this number while leaving "rc.1" itself unchanged. Compared as the
	 * last tiebreaker in `compareFirmwareVersions`, only once everything else is already equal;
	 * undefined (compared as 0) when absent, so "3.7.0-rc.1" < "3.7.0-rc.1+1" < "3.7.0-rc.1+2". A
	 * non-numeric suffix (a real build tag, e.g. a git hash) leaves this undefined and is otherwise
	 * ignored, same as before this field existed.
	 */
	build?: number;
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
 * VERSION_SUFFIX) and a leading "v" first, then captures a numeric "+N" suffix as `build` (see
 * `ParsedVersion.build`) before matching semver on what's left. A non-numeric suffix after "+" (real
 * build metadata, e.g. a git hash) is dropped entirely, same as before `build` existed.
 */
export function parseFirmwareVersion(raw: string): ParsedVersion | null {
	if (!raw) {
		return null;
	}
	let s = raw.split("(")[0].trim();
	s = s.replace(/^v/i, "");

	let build: number | undefined;
	const plusIndex = s.indexOf("+");
	if (plusIndex !== -1) {
		const buildPart = s.slice(plusIndex + 1);
		s = s.slice(0, plusIndex);
		if (/^\d+$/.test(buildPart)) {
			build = parseInt(buildPart, 10);
		}
	}

	const m = /^(\d+)\.(\d+)(?:\.(\d+))?(.*)$/.exec(s);
	if (!m) {
		return null;
	}
	const major = parseInt(m[1], 10);
	const minor = parseInt(m[2], 10);
	const patch = m[3] !== undefined ? parseInt(m[3], 10) : 0;
	const rest = m[4].replace(/^[.-]/, "");
	const prerelease = rest ? splitPrerelease(rest) : [];
	return build !== undefined ? { major, minor, patch, prerelease, build } : { major, minor, patch, prerelease };
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
 * compare pairwise, and if all shared identifiers are equal the longer list wins; then, ONLY once all
 * of that is tied, a "+N" build number breaks the tie (3.7.0-rc.1+1 > 3.7.0-rc.1; see
 * `ParsedVersion.build` for why this departs from real semver, which treats build metadata as
 * precedence-neutral - RRF does not use it that way).
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
	const ba = pa.build ?? 0, bb = pb.build ?? 0;
	if (ba !== bb) {
		return ba < bb ? -1 : 1;
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
