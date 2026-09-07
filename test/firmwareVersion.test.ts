import { describe, expect, it } from "vitest";

import { firmwareAtLeast } from "../src/config/firmwareVersion";

const MIN = "3.7.0-rc.1";

describe("firmwareAtLeast", () => {
	it("accepts an equal version", () => {
		expect(firmwareAtLeast("3.7.0-rc.1", MIN)).toBe(true);
	});

	it("accepts a later prerelease", () => {
		expect(firmwareAtLeast("3.7.0-rc.2", MIN)).toBe(true);
	});

	it("a release outranks a prerelease of the same version", () => {
		expect(firmwareAtLeast("3.7.0", MIN)).toBe(true);
	});

	it("accepts a later minor version", () => {
		expect(firmwareAtLeast("3.8.0", MIN)).toBe(true);
	});

	it("accepts a later major version", () => {
		expect(firmwareAtLeast("4.0.0", MIN)).toBe(true);
	});

	it("rejects an earlier prerelease stage (beta < rc)", () => {
		expect(firmwareAtLeast("3.7.0-beta.3", MIN)).toBe(false);
	});

	it("rejects earlier versions", () => {
		expect(firmwareAtLeast("3.6.1", MIN)).toBe(false);
		expect(firmwareAtLeast("3.5.4", MIN)).toBe(false);
	});

	it("parses alternate prerelease punctuation the same way", () => {
		expect(firmwareAtLeast("3.7.0rc1", MIN)).toBe(true);
	});

	it("strips the STM32 port's parenthesised suffix before parsing", () => {
		expect(firmwareAtLeast("3.7.0-rc.1(CAN0)", MIN)).toBe(true);
		expect(firmwareAtLeast("3.7.0(CAN0)", MIN)).toBe(true);
	});

	it("still compares correctly with a spaced, multi-word suffix", () => {
		expect(firmwareAtLeast("3.7.0-beta.1(no 3rd order motion)", MIN)).toBe(false);
	});

	it("fails closed on missing or unparseable input", () => {
		expect(firmwareAtLeast(null, MIN)).toBe(false);
		expect(firmwareAtLeast(undefined, MIN)).toBe(false);
		expect(firmwareAtLeast("", MIN)).toBe(false);
		expect(firmwareAtLeast("garbage", MIN)).toBe(false);
	});
});
