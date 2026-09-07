import { describe, expect, it } from "vitest";

import { chipFromIoin, parseRegisterValue, supportsWaveformCorrection } from "../src/config/driverChip";

describe("chipFromIoin", () => {
	it("identifies each known VERSION byte", () => {
		expect(chipFromIoin({ uart: 0x20 << 24 })).toEqual({ chip: "TMC2208", family: "tmc22xx" });
		expect(chipFromIoin({ uart: 0x21 << 24 })).toEqual({ chip: "TMC2209", family: "tmc22xx" });
		expect(chipFromIoin({ spi: 0x30 << 24 })).toEqual({ chip: "TMC5160", family: "tmc5160" });
		expect(chipFromIoin({ spi: 0x40 << 24 })).toEqual({ chip: "TMC2240", family: "tmc2240" });
	});

	it("returns null for an unrecognised or missing version byte", () => {
		expect(chipFromIoin({ uart: 0xFF << 24, spi: 0xFF << 24 })).toBeNull();
		expect(chipFromIoin({})).toBeNull();
		expect(chipFromIoin({ uart: null, spi: null })).toBeNull();
	});

	it("preserves lower bits correctly when extracting the version byte", () => {
		// A full 32-bit word with real IOIN flag bits set below the VERSION byte.
		expect(chipFromIoin({ spi: (0x30 << 24) | 0x00001234 })).toEqual({ chip: "TMC5160", family: "tmc5160" });
	});
});

describe("supportsWaveformCorrection", () => {
	it("is true only for tmc5160/tmc2240", () => {
		expect(supportsWaveformCorrection("tmc5160")).toBe(true);
		expect(supportsWaveformCorrection("tmc2240")).toBe(true);
		expect(supportsWaveformCorrection("tmc22xx")).toBe(false);
		expect(supportsWaveformCorrection(null)).toBe(false);
	});
});

describe("parseRegisterValue", () => {
	it("parses a hex value after 'value'", () => {
		expect(parseRegisterValue("Driver 0 register 4 value 0x30000000")).toBe(0x30000000);
	});

	it("parses a decimal value after '='", () => {
		expect(parseRegisterValue("Driver 0 register 4 = 805306368")).toBe(805306368);
	});

	it("parses a bare hex token with no label", () => {
		expect(parseRegisterValue("0x40000000")).toBe(0x40000000);
	});

	it("prefers the tagged value over a trailing unrelated number", () => {
		// A naive "last number in the string" fallback would pick up the "3" from "mode 3" instead.
		expect(parseRegisterValue("Driver 0.4 register 4 value 0x30001234, mode 3")).toBe(0x30001234);
	});

	it("returns null for empty or missing input", () => {
		expect(parseRegisterValue(null)).toBeNull();
		expect(parseRegisterValue(undefined)).toBeNull();
		expect(parseRegisterValue("")).toBeNull();
		expect(parseRegisterValue("no numbers here")).toBeNull();
	});
});
