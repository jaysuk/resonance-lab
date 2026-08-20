import { describe, expect, it } from "vitest";

import {
	appendDirective, detectEol, diffLines, findDirectives, parseLines, replaceDirective, replaceLine,
	serializeLines, setParam,
} from "../src/config/gcodeEdit";

describe("parseLines", () => {
	it("extracts the directive word and params, tolerating quoted strings and trailing comments", () => {
		const [line] = parseLines('M955 P121.0 C"^spi.cs1" Q2000000 I20 ; toolboard accelerometer');
		expect(line.code).toBe("M955");
		expect(line.params).toEqual({ P: "121.0", C: "\"^spi.cs1\"", Q: "2000000", I: "20" });
		expect(line.disabled).toBe(false);
		expect(line.unsafe).toBe(false);
	});

	it("flags a fully commented-out line as disabled but still finds its directive", () => {
		const [line] = parseLines('; M593 P"mzv" F64 S0.05 ; old tune');
		expect(line.code).toBe("M593");
		expect(line.disabled).toBe(true);
	});

	it("blank and plain-comment lines have no code", () => {
		const [blank, comment] = parseLines("\n; just a note");
		expect(blank.code).toBeNull();
		expect(comment.code).toBeNull();
		expect(comment.disabled).toBe(true);
	});

	it("flags {expression} lines and flow control as unsafe", () => {
		const lines = parseLines([
			"M572 D0:1 S{global.setPAValue}",
			'if sensors.gpIn[0].value = 1',
			'echo "hello"',
			"M593 P\"mzv\" F62.5 S0.10",
		].join("\n"));
		expect(lines[0].unsafe).toBe(true);
		expect(lines[1].unsafe).toBe(true);
		expect(lines[2].unsafe).toBe(true);
		expect(lines[3].unsafe).toBe(false);
	});

	it("a letter inside a quoted value is not mistaken for a parameter", () => {
		// The pin name contains "s1" - must not be parsed as an S parameter.
		const [line] = parseLines('M955 P121.0 C"^spi.cs1"');
		expect(line.params.S).toBeUndefined();
		expect(line.params.C).toBe("\"^spi.cs1\"");
	});

	it("round-trips CRLF files exactly, including the trailing newline", () => {
		const text = 'M955 P0 I20\r\nM593 P"mzv" F62.5 S0.10\r\n';
		expect(detectEol(text)).toBe("\r\n");
		expect(serializeLines(parseLines(text), detectEol(text))).toBe(text);
	});

	it("round-trips LF files exactly", () => {
		const text = 'M955 P0 I20\nM593 P"mzv" F62.5 S0.10';
		expect(detectEol(text)).toBe("\n");
		expect(serializeLines(parseLines(text), detectEol(text))).toBe(text);
	});
});

describe("findDirectives", () => {
	it("finds an active directive by code alone", () => {
		const lines = parseLines('G90\nM593 P"mzv" F62.5 S0.10\nM84 S60');
		const found = findDirectives(lines, "M593");
		expect(found).toHaveLength(1);
		expect(found[0].index).toBe(1);
	});

	it("matches M955 by P id numerically, tolerant of an omitted .0 index", () => {
		const lines = parseLines("M955 P121 I0\nM955 P122.0 I0");
		expect(findDirectives(lines, "M955", { P: "121.0" })).toHaveLength(1);
		expect(findDirectives(lines, "M955", { P: "121" })[0].index).toBe(0);
		expect(findDirectives(lines, "M955", { P: "999" })).toHaveLength(0);
	});

	it("returns disabled matches too, so a caller can flag a shadowed directive", () => {
		const lines = parseLines('; M593 P"mzv" F60 S0.05 ; old\nM593 P"mzv" F62.5 S0.10');
		const found = findDirectives(lines, "M593");
		expect(found).toHaveLength(2);
		expect(found[0].line.disabled).toBe(true);
		expect(found[1].line.disabled).toBe(false);
	});

	it("finds nothing when the directive genuinely isn't present", () => {
		expect(findDirectives(parseLines("G90\nM84 S60"), "M955")).toHaveLength(0);
	});
});

describe("setParam", () => {
	it("replaces one parameter's value and leaves every other token, spacing and comment untouched", () => {
		const raw = 'M955 P121.0 C"^spi.cs1" Q2000000 I0 ; toolboard accelerometer';
		const edited = setParam(raw, "I", "20");
		expect(edited).toBe('M955 P121.0 C"^spi.cs1" Q2000000 I20 ; toolboard accelerometer');
	});

	it("appends the parameter when it wasn't present at all", () => {
		expect(setParam("M955 P0", "I", "20")).toBe("M955 P0 I20");
	});

	it("appends before a trailing comment rather than after it", () => {
		expect(setParam("M955 P0 ; mainboard", "I", "20")).toBe("M955 P0 I20 ; mainboard");
	});

	it("does not corrupt a quoted string parameter that happens to contain digits", () => {
		// The bare-numeric regex must not match "1" inside C"^spi.cs1" - only a real I token.
		expect(setParam('M955 P121.0 C"^spi.cs1" I5', "I", "20"))
			.toBe('M955 P121.0 C"^spi.cs1" I20');
	});

	it("is case-insensitive on the letter but always writes it upper-case", () => {
		expect(setParam("m955 p0 i0", "I", "20")).toBe("m955 p0 I20");
	});
});

describe("replaceDirective", () => {
	it("replaces the whole directive, keeping indentation and trailing comment", () => {
		const raw = '  M593 P"mzv" F75 0.05 ; update 4.23.25 after testing higher belt tension';
		const edited = replaceDirective(raw, 'M593 P"zvd" F45.2 S0.10');
		expect(edited).toBe('  M593 P"zvd" F45.2 S0.10 ; update 4.23.25 after testing higher belt tension');
	});

	it("works on a line with no comment at all", () => {
		expect(replaceDirective('M593 P"mzv" F60', 'M593 P"zvd" F45.2 S0.10')).toBe('M593 P"zvd" F45.2 S0.10');
	});
});

describe("appendDirective", () => {
	it("appends an audit comment then the directive as new lines", () => {
		const lines = parseLines("G90\nM84 S60");
		const result = appendDirective(lines, 'M593 P"mzv" F62.5 S0.10', "Resonance Lab 2026-08-17");
		expect(result).toHaveLength(4);
		expect(result[2].raw).toBe("; Resonance Lab 2026-08-17");
		expect(result[3].raw).toBe('M593 P"mzv" F62.5 S0.10');
		expect(result[3].code).toBe("M593");
		// The original lines are untouched.
		expect(result[0].raw).toBe("G90");
		expect(result[1].raw).toBe("M84 S60");
	});
});

describe("replaceLine", () => {
	it("re-derives code/params from the new text and leaves other lines' identity untouched", () => {
		const lines = parseLines("G90\nM955 P0 I0\nM84 S60");
		const edited = replaceLine(lines, 1, setParam(lines[1].raw, "I", "20"));
		expect(edited[1].raw).toBe("M955 P0 I20");
		expect(edited[1].params.I).toBe("20");
		expect(edited[0]).toBe(lines[0]); // untouched lines keep their identity, not just equal content
		expect(edited[2]).toBe(lines[2]);
	});
});

describe("diffLines", () => {
	it("marks only the changed line as removed+added, everything else as same", () => {
		const before = parseLines("G90\nM955 P0 I0\nM84 S60");
		const after = replaceLine(before, 1, "M955 P0 I20");
		const diff = diffLines(before, after);
		expect(diff).toEqual([
			{ type: "same", text: "G90" },
			{ type: "removed", text: "M955 P0 I0" },
			{ type: "added", text: "M955 P0 I20" },
			{ type: "same", text: "M84 S60" },
		]);
	});

	it("marks appended lines as added with nothing removed", () => {
		const before = parseLines("G90\nM84 S60");
		const after = appendDirective(before, "M955 P0 I20", "Resonance Lab 2026-08-17");
		const diff = diffLines(before, after);
		expect(diff).toEqual([
			{ type: "same", text: "G90" },
			{ type: "same", text: "M84 S60" },
			{ type: "added", text: "; Resonance Lab 2026-08-17" },
			{ type: "added", text: "M955 P0 I20" },
		]);
	});

	it("is empty of changes for two identical files", () => {
		const lines = parseLines("G90\nM84 S60");
		expect(diffLines(lines, lines).every((d) => d.type === "same")).toBe(true);
	});
});

describe("a realistic config.g excerpt", () => {
	const CONFIG = [
		"; General preferences",
		"M575 P1 S1 B57600",
		"G90",
		"M83",
		'M572 D0:1 S{global.setPAValue}',
		';M593 P"mzv" F64 0.05 ; 74 was good for BB hoist in 3.5.1',
		'M593 P"mzv" F75 0.05 ; update 4.23.25 after testing higher belt tension',
	].join("\n");

	it("finds the live M593 and flags the disabled one and the {expression} line separately", () => {
		const lines = parseLines(CONFIG);
		const found = findDirectives(lines, "M593");
		expect(found).toHaveLength(2);
		expect(found.filter((f) => !f.line.disabled)).toHaveLength(1);
		expect(lines.find((l) => l.raw.includes("setPAValue"))?.unsafe).toBe(true);
	});

	it("fixes a real formatting bug in the live config: F75 0.05 has no S before the damping value", () => {
		// M593's damping parameter is S; a bare "0.05" after F75 is not parsed as damping at all -
		// replaceDirective must emit a well-formed line when the plugin (re)writes it.
		const lines = parseLines(CONFIG);
		const live = findDirectives(lines, "M593").find((f) => !f.line.disabled)!;
		expect(live.line.params.S).toBeUndefined(); // confirms the bug is real in the fixture
		const rewritten = replaceDirective(live.line.raw, 'M593 P"zvd" F45.2 S0.10');
		expect(rewritten).toBe('M593 P"zvd" F45.2 S0.10 ; update 4.23.25 after testing higher belt tension');
	});
});
