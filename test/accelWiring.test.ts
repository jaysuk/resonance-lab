import { describe, expect, it } from "vitest";

import { findAccelWiring, findOtherAccelWiring, parseCPrefix } from "../src/config/accelWiring";

describe("parseCPrefix", () => {
	it("finds a CAN address prefix", () => {
		expect(parseCPrefix("121.i2c.lis")).toBe(121);
	});
	it("returns 0 for a local pin name with no prefix", () => {
		expect(parseCPrefix("spi.cs1")).toBe(0);
	});
	it("ignores a leading inversion character", () => {
		expect(parseCPrefix("^spi.cs1")).toBe(0);
		expect(parseCPrefix("!121.i2c.lis")).toBe(121);
	});
});

describe("findAccelWiring", () => {
	it("finds a local line", () => {
		const w = findAccelWiring('M955 C"^spi.cs1" Q2000000 I20', 0);
		expect(w).toEqual({ cSpec: "^spi.cs1", spiFrequency: 2000000, canAddress: 0 });
	});

	it("finds a remote line, keeping the CAN prefix in cSpec", () => {
		const w = findAccelWiring('M955 C"121.i2c.lis" I6', 121);
		expect(w).toEqual({ cSpec: "121.i2c.lis", canAddress: 121 });
	});

	it("returns null when no line matches that canAddress", () => {
		expect(findAccelWiring('M955 C"121.i2c.lis" I6', 20)).toBeNull();
	});

	it("ignores a commented-out line", () => {
		expect(findAccelWiring('; M955 C"121.i2c.lis" I6', 121)).toBeNull();
	});

	it("returns the LAST matching line when two exist for the same board", () => {
		const text = ['M955 C"121.i2c.lis" I6', 'M955 C"121.i2c.lis" I20 Q4000000'].join("\n");
		expect(findAccelWiring(text, 121)).toEqual({ cSpec: "121.i2c.lis", spiFrequency: 4000000, canAddress: 121 });
	});

	it("does not match a bare query with no C at all", () => {
		expect(findAccelWiring("M955 P0", 0)).toBeNull();
	});

	it("works identically framed as a tpost<N>.g file with no config.g-specific assumptions", () => {
		const tpostText = ["; tpost3.g", "; Runs when tool 3 is picked up", 'M955 C"121.i2c.lis" I6'].join("\n");
		expect(findAccelWiring(tpostText, 121)).toEqual({ cSpec: "121.i2c.lis", canAddress: 121 });
	});

	it("returns null for a line whose C uses expression syntax, rather than a literal cSpec", () => {
		expect(findAccelWiring("M955 C{param.accelPin} I6", 0)).toBeNull();
	});
});

describe("findOtherAccelWiring", () => {
	it("returns a different board's line", () => {
		const text = ['M955 C"20.spi.cs1" I20', 'M955 C"121.i2c.lis" I6'].join("\n");
		expect(findOtherAccelWiring(text, 121)).toEqual({ cSpec: "20.spi.cs1", canAddress: 20 });
	});

	it("returns null when the only M955 present is the queried board's own", () => {
		expect(findOtherAccelWiring('M955 C"121.i2c.lis" I6', 121)).toBeNull();
	});

	it("ignores a commented-out other-board line", () => {
		const text = ['; M955 C"20.spi.cs1" I20', 'M955 C"121.i2c.lis" I6'].join("\n");
		expect(findOtherAccelWiring(text, 121)).toBeNull();
	});
});
