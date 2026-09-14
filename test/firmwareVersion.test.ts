import { describe, expect, it } from "vitest";

import { firmwareAtLeast, MIN_MULTI_ACCEL_FIRMWARE, parseFirmwareVersion } from "../src/config/firmwareVersion";

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

describe("parseFirmwareVersion - build number", () => {
	it("captures a numeric \"+N\" suffix as build", () => {
		expect(parseFirmwareVersion("3.7.0-rc.1+1")?.build).toBe(1);
		expect(parseFirmwareVersion("3.7.0-rc.1+12")?.build).toBe(12);
	});

	it("leaves build undefined when there is no + suffix", () => {
		expect(parseFirmwareVersion("3.7.0-rc.1")?.build).toBeUndefined();
	});

	it("leaves build undefined for a non-numeric suffix (real build metadata, e.g. a git hash)", () => {
		expect(parseFirmwareVersion("3.7.0-rc.1+abc123")?.build).toBeUndefined();
	});

	it("still parses major/minor/patch/prerelease correctly alongside a build number", () => {
		const p = parseFirmwareVersion("3.7.0-rc.1+1");
		expect(p).toMatchObject({ major: 3, minor: 7, patch: 0, prerelease: ["rc", 1] });
	});

	it("strips the STM32 parenthesised suffix even after a build number", () => {
		expect(parseFirmwareVersion("3.7.0-rc.1+1(CAN0)")?.build).toBe(1);
	});
});

describe("firmwareAtLeast - \"+N\" build-number tiebreaker (RRF's multi-accelerometer threshold)", () => {
	it("a build number outranks the same version with none", () => {
		expect(firmwareAtLeast("3.7.0-rc.1+1", MIN)).toBe(true);
		expect(firmwareAtLeast("3.7.0-rc.1", MIN_MULTI_ACCEL_FIRMWARE)).toBe(false);
	});

	it("a later build number outranks an earlier one at the same prerelease", () => {
		expect(firmwareAtLeast("3.7.0-rc.1+2", "3.7.0-rc.1+1")).toBe(true);
		expect(firmwareAtLeast("3.7.0-rc.1+1", "3.7.0-rc.1+2")).toBe(false);
	});

	it("MIN_MULTI_ACCEL_FIRMWARE itself compares equal to itself", () => {
		expect(firmwareAtLeast(MIN_MULTI_ACCEL_FIRMWARE, MIN_MULTI_ACCEL_FIRMWARE)).toBe(true);
	});

	it("a genuinely later prerelease or a full release still outranks ANY build number under an earlier tag", () => {
		expect(firmwareAtLeast("3.7.0-rc.2", "3.7.0-rc.1+99")).toBe(true);
		expect(firmwareAtLeast("3.7.0", "3.7.0-rc.1+99")).toBe(true);
	});

	it("an earlier prerelease stage with a build number still loses to a plain later one", () => {
		expect(firmwareAtLeast("3.7.0-beta.3+5", "3.7.0-rc.1")).toBe(false);
	});

	it("the STM32 parenthesised suffix still strips correctly with a build number present", () => {
		expect(firmwareAtLeast("3.7.0-rc.1+1(CAN0)", MIN_MULTI_ACCEL_FIRMWARE)).toBe(true);
	});
});
