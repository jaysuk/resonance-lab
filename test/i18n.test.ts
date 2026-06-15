import { describe, expect, it } from "vitest";

import en from "../src/i18n/en.json";

/** Flatten the nested message object to [dotted.key, value] pairs. */
function leaves(obj: unknown, path = ""): Array<[string, string]> {
	if (typeof obj === "string") {
		return [[path, obj]];
	}
	if (obj && typeof obj === "object") {
		return Object.entries(obj).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
	}
	return [];
}

describe("i18n messages are safe for the vue-i18n compiler", () => {
	// vue-i18n reads a bare "@" as linked-message syntax (@:key / @.modifier:key). An unescaped "@"
	// anywhere else throws compile error 10 (INVALID_LINKED_FORMAT) the first time the message is
	// rendered, which blanks the whole page. A literal "@" must be written as the {'@'} literal.
	it("contains no unescaped @ (linked-message) token", () => {
		const offenders = leaves(en)
			.filter(([, v]) => v.replace(/\{'[^']*'\}/g, "").includes("@"))
			.map(([k]) => k);
		expect(offenders).toEqual([]);
	});
});
