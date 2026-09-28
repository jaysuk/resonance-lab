import { beforeEach, describe, expect, it } from "vitest";

import type { AccelerometerRef } from "../src/capture/orchestrator";
import type { HostAdapter } from "../src/core/host";
import {
	applyEditPlan, configPath, findExistingWiring, findStrayTpostAccelLines, invalidateGcodeCache,
	planAccelMigration, planAccelSave, planShaperSave, restartAfterConfigEdit, tpostPath,
} from "../src/config/machineConfig";

// findExistingWiring/planAccelSave cache file text keyed by path (see machineConfig.ts), and every
// fakeHost() in this file resolves to the same literal paths ("0:/sys/config.g" etc.) - without
// clearing between tests, one test's config.g content would leak into the next test's lookup for the
// "same" path even though each test has its own, unrelated fakeHost.
beforeEach(() => {
	invalidateGcodeCache();
});

/** Minimal AccelerometerRef for tests that only need the id (and optionally a tool number). */
function accelRef(id: string, toolNumber?: number): AccelerometerRef {
	return toolNumber === undefined ? { id, label: id } : { id, label: id, toolNumber };
}

/**
 * A model where the mainboard AND every CAN board these tests address (20, 121) report new-scheme
 * firmware - i.e. a machine fully updated everywhere. firmwareUsesNewAccelScheme checks the SPECIFIC
 * board a given accelerometer lives on, not boards[0] alone (a remote M955 is forwarded to and parsed
 * by that board's own, independently-flashed firmware) - see the MIXED_FIRMWARE_MODEL fixture below
 * for the case where the mainboard is updated but a toolboard isn't.
 */
const NEW_SCHEME_MODEL = {
	directories: { system: "0:/sys" },
	boards: [
		{ canAddress: 0, firmwareVersion: "3.7.0-rc.1" },
		{ canAddress: 20, firmwareVersion: "3.7.0-rc.1" },
		{ canAddress: 121, firmwareVersion: "3.7.0-rc.1" },
	],
};

/**
 * Mainboard updated to 3.7.0-rc.1+, toolboard 121 still on old firmware (no firmwareVersion new
 * enough, or a pre-update board reporting e.g. "3.6.0") - the exact real-world configuration behind
 * the field report this fixture exists to cover: "Tool Board 1LC ... Error M955: missing parameter
 * 'P'", caused by an earlier version of this code gating on boards[0] alone and omitting P for a
 * board whose own firmware still required it.
 */
const MIXED_FIRMWARE_MODEL = {
	directories: { system: "0:/sys" },
	boards: [
		{ canAddress: 0, firmwareVersion: "3.7.0-rc.1" },
		{ canAddress: 121, firmwareVersion: "3.5.1" },
	],
};

/**
 * Every board on RRF's multi-accelerometer firmware ("3.7.0-rc.1+1" - up to 10 independent slots,
 * `RepRapFirmware@ee3c80b`/`Duet3Expansion@73549e0`). Distinct from NEW_SCHEME_MODEL (plain rc.1,
 * still single-slot) - the two thresholds are independent and this fixture must NOT satisfy the
 * single-slot-only tests above by accident.
 */
const MULTI_ACCEL_MODEL = {
	directories: { system: "0:/sys" },
	boards: [
		{ canAddress: 0, firmwareVersion: "3.7.0-rc.1+1" },
		{ canAddress: 20, firmwareVersion: "3.7.0-rc.1+1" },
		{ canAddress: 121, firmwareVersion: "3.7.0-rc.1+1" },
	],
};

/** A fake HostAdapter backed by an in-memory file map, so writes/backups are directly inspectable. */
function fakeHost(files: Record<string, string> = {}, model: unknown = { directories: { system: "0:/sys" } }) {
	const fs = new Map(Object.entries(files));
	const sent: Array<string> = [];
	const host: HostAdapter = {
		model: () => model,
		isConnected: () => true,
		sendCode: async (code) => { sent.push(code); return "ok"; },
		upload: async (path, content) => { fs.set(path, content); },
		download: async (path) => {
			if (!fs.has(path)) {
				throw new Error(`No such file: ${path}`);
			}
			return fs.get(path)!;
		},
		delete: async () => {},
		makeDirectory: async () => {},
		getFileList: async () => [],
		installPlugin: async () => {},
		assetPattern: /\.zip$/i,
		notify: () => {},
		t: (k) => k,
	};
	return { host, fs, sent };
}

describe("configPath / tpostPath", () => {
	it("reads directories.system from the object model rather than assuming 0:/sys", () => {
		const { host } = fakeHost({}, { directories: { system: "1:/firmware/sys" } });
		expect(configPath(host)).toBe("1:/firmware/sys/config.g");
		expect(tpostPath(host, 2)).toBe("1:/firmware/sys/tpost2.g");
	});

	it("falls back to 0:/sys when the object model hasn't reported directories yet", () => {
		const { host } = fakeHost({}, {});
		expect(configPath(host)).toBe("0:/sys/config.g");
	});
});

describe("planAccelSave - legacy firmware (scope is meaningless, always edits config.g)", () => {
	it("edits I in place when M955 already exists, preserving C/Q wiring config", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'G90\nM955 P121.0 C"^spi.cs1" Q2000000 I0 ; toolboard accelerometer\nM84 S60',
		});
		const { plan, notes } = await planAccelSave(host, accelRef("121.0"), "all", "20");
		expect(plan.appended).toBe(false);
		expect(plan.after).toContain('M955 P121.0 C"^spi.cs1" Q2000000 I20 ; toolboard accelerometer');
		expect(plan.after).toContain("G90");
		expect(plan.after).toContain("M84 S60");
		expect(notes).toHaveLength(0);
	});

	it("appends a new M955 line when the accelerometer isn't configured in config.g at all", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "G90\nM84 S60" });
		const { plan } = await planAccelSave(host, accelRef("0"), "all", "20");
		expect(plan.appended).toBe(true);
		expect(plan.after).toContain("M955 P0 I20");
		expect(plan.after).toMatch(/; Resonance Lab \d{4}-\d{2}-\d{2}/);
	});

	it("matches the right accelerometer on a multi-toolboard machine by P id, not just M955", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": "M955 P121.0 I0\nM955 P122.0 I0",
		});
		const { plan } = await planAccelSave(host, accelRef("122.0"), "all", "6");
		expect(plan.after).toBe("M955 P121.0 I0\nM955 P122.0 I6");
	});

	it("explicitly on 3.7.0-beta.3 (last pre-RC build) still uses the old P<board.driver> form, not P0/C", async () => {
		// The threshold is 3.7.0-rc.1 exactly - anything before it, including the last beta, must take
		// the legacy path. Confirms the boundary case by name rather than only via an absent boards[]
		// field (which every other "legacy" test above relies on implicitly).
		const model = { directories: { system: "0:/sys" }, boards: [{ canAddress: 0, firmwareVersion: "3.7.0-beta.3" }] };
		const { host } = fakeHost({ "0:/sys/config.g": "M955 P0 I0" }, model);
		const { plan } = await planAccelSave(host, accelRef("0"), "all", "6");
		expect(plan.after).toBe("M955 P0 I6");
		expect(plan.after).not.toContain("C\"");
	});

	it("flags a commented-out duplicate without treating it as the active one", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": "; M955 P0 I0 ; old wiring\nM955 P0 I0",
		});
		const { plan } = await planAccelSave(host, accelRef("0"), "all", "20");
		expect(plan.disabledDuplicateFound).toBe(true);
		expect(plan.after).toBe("; M955 P0 I0 ; old wiring\nM955 P0 I20");
	});

	it("refuses to edit an M955 line that uses {expression} syntax", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "M955 P0 I{global.accelOrientation}" });
		const { plan } = await planAccelSave(host, accelRef("0"), "all", "20");
		expect(plan.blocked).toBeTruthy();
		expect(plan.after).toBe(plan.before);
	});

	it("round-trips a CRLF config.g without changing its line endings", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "G90\r\nM955 P0 I0\r\nM84 S60" });
		const { plan } = await planAccelSave(host, accelRef("0"), "all", "20");
		expect(plan.after).toBe("G90\r\nM955 P0 I20\r\nM84 S60");
	});

	it("propagates a real read failure rather than treating config.g as empty", async () => {
		const { host } = fakeHost({}); // config.g not present in the fake filesystem at all
		await expect(planAccelSave(host, accelRef("0"), "all", "20")).rejects.toThrow(/config\.g/);
	});

	it("ignores scope 'tool' entirely - still edits config.g, since scope is meaningless pre-3.7.0-rc.1", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "M955 P0 I0" });
		const { plan } = await planAccelSave(host, accelRef("0", 3), "tool", "20");
		expect(plan.path).toBe("0:/sys/config.g");
		expect(plan.after).toBe("M955 P0 I20");
	});
});

describe("findExistingWiring", () => {
	it("finds config.g wiring when no tool is associated", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 C"121.i2c.lis" I6' }, NEW_SCHEME_MODEL);
		expect(await findExistingWiring(host, accelRef("121.0"))).toEqual({ cSpec: "121.i2c.lis", canAddress: 121, slot: 0 });
	});

	it("checks the tool's own tpost<N>.g before config.g", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'M955 C"121.i2c.lis" I0',
			"0:/sys/tpost3.g": 'M955 C"121.i2c.lis" I6',
		}, NEW_SCHEME_MODEL);
		const wiring = await findExistingWiring(host, accelRef("121.0", 3));
		expect(wiring).toEqual({ cSpec: "121.i2c.lis", canAddress: 121, slot: 0 });
	});

	it("falls back to config.g when the tool's tpost<N>.g has no wiring for this board", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'M955 C"121.i2c.lis" I6',
			"0:/sys/tpost3.g": "G28",
		}, NEW_SCHEME_MODEL);
		expect(await findExistingWiring(host, accelRef("121.0", 3))).toEqual({ cSpec: "121.i2c.lis", canAddress: 121, slot: 0 });
	});

	it("returns null when the accelerometer isn't wired anywhere", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "G90" }, NEW_SCHEME_MODEL);
		expect(await findExistingWiring(host, accelRef("121.0"))).toBeNull();
	});

	it("never treats a negative tool number as a real tool", async () => {
		const { host, fs } = fakeHost({ "0:/sys/config.g": 'M955 C"121.i2c.lis" I6' }, NEW_SCHEME_MODEL);
		await findExistingWiring(host, accelRef("121.0", -1));
		expect([...fs.keys()].some((k) => k.includes("tpost"))).toBe(false); // never even tried tpost-1.g
	});
});

describe("planAccelSave - new-scheme firmware (>= 3.7.0-rc.1)", () => {
	it("throws when the accelerometer's wiring isn't recorded anywhere", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "G90" }, NEW_SCHEME_MODEL);
		await expect(planAccelSave(host, accelRef("121.0"), "all", "6")).rejects.toThrow(/wiring/);
	});

	it("scope 'all': edits I in place, preserving C/Q, matched by C's CAN prefix not P", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 C"121.i2c.lis" Q2000000 I0' }, NEW_SCHEME_MODEL);
		const { plan, notes } = await planAccelSave(host, accelRef("121.0"), "all", "6");
		expect(plan.path).toBe("0:/sys/config.g");
		// P0 is appended (the pre-existing line had none) - P0 is still mandatory even under the new
		// scheme (confirmed on real hardware), so an edit self-heals a line missing it, not just I.
		expect(plan.after).toBe('M955 C"121.i2c.lis" Q2000000 I6 P0');
		expect(notes).toHaveLength(0);
	});

	it("scope 'all': names the specific other board a save would displace", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'M955 C"20.spi.cs1" I20\nM955 C"121.i2c.lis" I0',
		}, NEW_SCHEME_MODEL);
		const { notes } = await planAccelSave(host, accelRef("121.0"), "all", "6");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("board 20");
	});

	it("scope 'all': no note when this board is config.g's only accelerometer", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 C"121.i2c.lis" I0' }, NEW_SCHEME_MODEL);
		const { notes } = await planAccelSave(host, accelRef("121.0"), "all", "6");
		expect(notes).toHaveLength(0);
	});

	it("scope 'tool': writes the full line into that tool's own tpost<N>.g", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 C"121.i2c.lis" I0' }, NEW_SCHEME_MODEL);
		const { plan, notes } = await planAccelSave(host, accelRef("121.0", 3), "tool", "6");
		expect(plan.path).toBe("0:/sys/tpost3.g");
		expect(plan.appended).toBe(true);
		expect(plan.after).toContain('M955 P0 C"121.i2c.lis" I6'); // P0 mandatory even under the new scheme
		expect(notes).toHaveLength(1); // config.g also has wiring for this board - informational
		expect(notes[0]).toContain("config.g");
	});

	it("scope 'tool': edits an existing tpost<N>.g entry for this board without disturbing another board's line", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'M955 C"121.i2c.lis" I0',
			"0:/sys/tpost3.g": 'M955 C"20.spi.cs1" I20\nM955 C"121.i2c.lis" I0',
		}, NEW_SCHEME_MODEL);
		const { plan } = await planAccelSave(host, accelRef("121.0", 3), "tool", "6");
		// Only board 121's line is touched (gains P0, self-healing a line that didn't have one) - board
		// 20's own line is left completely alone.
		expect(plan.after).toBe('M955 C"20.spi.cs1" I20\nM955 C"121.i2c.lis" I6 P0');
	});

	it("scope 'tool': throws rather than writing tpost-1.g / tpostundefined.g when there's no usable tool number", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 C"121.i2c.lis" I0' }, NEW_SCHEME_MODEL);
		await expect(planAccelSave(host, accelRef("121.0"), "tool", "6")).rejects.toThrow();
		await expect(planAccelSave(host, accelRef("121.0", -1), "tool", "6")).rejects.toThrow();
	});

	it("uses the wiring found in tpost<N>.g (not config.g's possibly different copy) as the line to persist", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'M955 C"121.i2c.lis" I0',
			"0:/sys/tpost3.g": 'M955 C"121.i2c.lis" Q4000000 I0',
		}, NEW_SCHEME_MODEL);
		const { plan } = await planAccelSave(host, accelRef("121.0", 3), "tool", "6");
		expect(plan.after).toContain("Q4000000");
	});
});

describe("planAccelSave - mixed firmware: the MAINBOARD's version decides the scheme", () => {
	// M955/M956 are validated on the mainboard first (P is MustSee and range-limited there, C is parsed
	// there, the slot table lives there) - a remote board only receives the forwarded parameters. So an
	// updated mainboard rejects a legacy P<board.driver> line whatever its toolboard runs, and an old
	// mainboard can't accept C at all. (This suite used to gate per accelerometer-board instead, after a
	// field report that turned out to be caused by P being omitted entirely, not by mixed firmware.)

	it("uses the NEW C-based line for a toolboard still on old firmware when the mainboard is updated", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 C"121.i2c.lis" I0' }, MIXED_FIRMWARE_MODEL);
		const { plan } = await planAccelSave(host, accelRef("121.0"), "all", "6");
		expect(plan.after).toBe('M955 C"121.i2c.lis" I6 P0');
		expect(plan.after).not.toContain("P121.0");
	});

	it("uses the LEGACY P-based line when the mainboard is old, even if the toolboard is new", async () => {
		const model = {
			directories: { system: "0:/sys" },
			boards: [{ canAddress: 0, firmwareVersion: "3.6.1" }, { canAddress: 121, firmwareVersion: "3.7.0-rc.2" }],
		};
		const { host } = fakeHost({ "0:/sys/config.g": "M955 P121.0 I0" }, model);
		const { plan } = await planAccelSave(host, accelRef("121.0"), "all", "6");
		expect(plan.after).toBe("M955 P121.0 I6");
		expect(plan.after).not.toContain("C\"");
	});

	it("still uses the NEW C-based line (with P0) for an accelerometer on the mainboard itself (which IS updated)", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 C"^spi.cs1" I0' }, MIXED_FIRMWARE_MODEL);
		const { plan } = await planAccelSave(host, accelRef("0"), "all", "6");
		expect(plan.after).toBe('M955 C"^spi.cs1" I6 P0'); // P0 appended - the pre-existing line had none
	});

	it("findExistingWiring's lookup is unaffected by firmware - only planAccelSave's SAVE FORMAT depends on it", async () => {
		// Reading wiring text is pure G-code parsing, independent of which board runs which firmware -
		// the SAME config.g text resolves identically under either fixture. The bug this suite guards
		// against was specifically about the FORMAT planAccelSave chooses to WRITE, not about lookup.
		const configText = 'M955 C"121.i2c.lis" I0';
		const { host: newHost } = fakeHost({ "0:/sys/config.g": configText }, NEW_SCHEME_MODEL);
		const { host: mixedHost } = fakeHost({ "0:/sys/config.g": configText }, MIXED_FIRMWARE_MODEL);
		const expected = { cSpec: "121.i2c.lis", canAddress: 121, slot: 0 };
		expect(await findExistingWiring(newHost, accelRef("121.0"))).toEqual(expected);
		expect(await findExistingWiring(mixedHost, accelRef("121.0"))).toEqual(expected);
	});
});

describe("planAccelSave - multi-accelerometer firmware (>= 3.7.0-rc.1+1)", () => {
	it("always saves to config.g, ignoring scope entirely - there is nothing to displace", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 P0 C"121.i2c.lis" I0' }, MULTI_ACCEL_MODEL);
		const { plan, notes } = await planAccelSave(host, accelRef("121.0"), "tool", "6"); // scope "tool" - ignored
		expect(plan.path).toBe("0:/sys/config.g");
		expect(plan.after).toBe('M955 P0 C"121.i2c.lis" I6');
		expect(notes).toHaveLength(0);
	});

	it("two different boards can each be saved independently, and neither's line touches the other's", async () => {
		// Board 121 is discoverable via its own tool's tpost first (R3 - a board can only be saved once
		// it's discoverable somewhere; it isn't in config.g yet, which is exactly the "new board" case).
		const { host } = fakeHost({
			"0:/sys/config.g": 'M955 P0 C"20.spi.cs1" I20',
			"0:/sys/tpost3.g": 'M955 C"121.i2c.lis" I0',
		}, MULTI_ACCEL_MODEL);
		const { plan } = await planAccelSave(host, accelRef("121.0", 3), "all", "6");
		// Board 20's line is untouched; board 121 is a brand-new addition to config.g at the next free slot (1).
		expect(plan.after).toContain('M955 P0 C"20.spi.cs1" I20');
		expect(plan.after).toContain('M955 P1 C"121.i2c.lis" I6');
		expect(plan.appended).toBe(true);
	});

	it("a new board is assigned the lowest slot not already used by any other board", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'M955 P0 C"20.spi.cs1" I20\nM955 P2 C"22.spi.cs1" I20',
			"0:/sys/tpost3.g": 'M955 C"121.i2c.lis" I0',
		}, MULTI_ACCEL_MODEL);
		const { plan } = await planAccelSave(host, accelRef("121.0", 3), "all", "6");
		expect(plan.after).toContain('M955 P1 C"121.i2c.lis" I6'); // slot 1 is free even though 0 and 2 are taken
	});

	it("re-saving an already-configured board reuses its existing slot rather than reassigning it", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'M955 P0 C"20.spi.cs1" I20\nM955 P5 C"121.i2c.lis" I0',
		}, MULTI_ACCEL_MODEL);
		const { plan } = await planAccelSave(host, accelRef("121.0"), "all", "6");
		expect(plan.after).toBe('M955 P0 C"20.spi.cs1" I20\nM955 P5 C"121.i2c.lis" I6'); // still slot 5, not reassigned
	});

	it("pulls in a board's wiring from tpost<N>.g and assigns it a fresh config.g slot, independent of tpost's own P", async () => {
		// tpost's line predates this scheme and says P0 (the only value that was ever legal there) -
		// that must not leak into config.g, where slot 0 might already belong to a different board.
		const { host } = fakeHost({
			"0:/sys/config.g": 'M955 P0 C"20.spi.cs1" I20',
			"0:/sys/tpost3.g": 'M955 P0 C"121.i2c.lis" I6',
		}, MULTI_ACCEL_MODEL);
		const { plan } = await planAccelSave(host, accelRef("121.0", 3), "all", "6");
		expect(plan.path).toBe("0:/sys/config.g");
		expect(plan.after).toContain('M955 P1 C"121.i2c.lis" I6'); // slot 1, not tpost's stale P0
	});

	it("throws once all 10 slots are already in use", async () => {
		const lines = Array.from({ length: 10 }, (_, n) => `M955 P${n} C"${n}0.spi.cs1" I20`).join("\n");
		const { host } = fakeHost({
			"0:/sys/config.g": lines,
			"0:/sys/tpost3.g": 'M955 C"121.i2c.lis" I0',
		}, MULTI_ACCEL_MODEL);
		await expect(planAccelSave(host, accelRef("121.0", 3), "all", "6")).rejects.toThrow(/10/);
	});
});

describe("planShaperSave", () => {
	const GCODE = 'M593 P"zvd" F45.2 S0.10';

	it("edits config.g for scope 'all', fixing a malformed existing line", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'M593 P"mzv" F75 0.05 ; missing S before damping\nM84 S60',
		});
		const { plan, notes } = await planShaperSave(host, "all", null, GCODE, []);
		expect(plan.after).toContain('M593 P"zvd" F45.2 S0.10 ; missing S before damping');
		expect(notes).toHaveLength(0);
	});

	it("warns when a tool-specific tpost<N>.g would override the config.g-wide change", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": "G90",
			"0:/sys/tpost1.g": 'M593 P"mzv" F60 S0.10',
		});
		const { notes } = await planShaperSave(host, "all", null, GCODE, [0, 1]);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("T1");
		expect(notes[0]).toContain("tpost1.g");
	});

	it("creates tpost<N>.g from scratch for scope 'tool' when it doesn't exist yet", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "G90" });
		const { plan, notes } = await planShaperSave(host, "tool", 0, GCODE, [0]);
		expect(plan.path).toBe("0:/sys/tpost0.g");
		expect(plan.appended).toBe(true);
		expect(plan.after).toContain(GCODE);
		expect(notes).toHaveLength(0); // config.g has no M593 to warn about
	});

	it("warns when config.g also sets M593 machine-wide, for scope 'tool'", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M593 P"mzv" F60 S0.10' });
		const { notes } = await planShaperSave(host, "tool", 0, GCODE, [0]);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("config.g");
	});

	it("throws for scope 'tool' with no tool number rather than guessing a target file", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "G90" });
		await expect(planShaperSave(host, "tool", null, GCODE, [])).rejects.toThrow();
	});
});

describe("applyEditPlan", () => {
	it("backs up the original file before writing the edit", async () => {
		const { host, fs } = fakeHost({ "0:/sys/config.g": "M955 P0 I0" });
		const { plan } = await planAccelSave(host, accelRef("0"), "all", "20");
		await applyEditPlan(host, plan);
		expect(fs.get("0:/sys/config.g")).toBe("M955 P0 I20");
		const backupKey = [...fs.keys()].find((k) => k !== "0:/sys/config.g");
		expect(backupKey).toMatch(/^0:\/sys\/config\.g\.rlab-\d{14}\.bak$/);
		expect(fs.get(backupKey!)).toBe("M955 P0 I0");
	});

	it("writes nothing (no backup either) when the plan changes nothing", async () => {
		const { host, fs } = fakeHost({ "0:/sys/config.g": "M955 P0 I20" });
		const { plan } = await planAccelSave(host, accelRef("0"), "all", "20"); // already the target value
		expect(plan.after).toBe(plan.before);
		await applyEditPlan(host, plan);
		expect(fs.size).toBe(1); // still just config.g - no backup created for a no-op
	});

	it("refuses to write a blocked plan", async () => {
		const { host, fs } = fakeHost({ "0:/sys/config.g": "M955 P0 I{global.x}" });
		const { plan } = await planAccelSave(host, accelRef("0"), "all", "20");
		await expect(applyEditPlan(host, plan)).rejects.toThrow();
		expect(fs.size).toBe(1); // nothing written
	});

	it("invalidates the wiring cache for the written path, so a save is visible to the very next lookup", async () => {
		// Board 121 is wired in tpost3.g only - config.g has nothing for it yet.
		const { host } = fakeHost({ "0:/sys/config.g": "G90", "0:/sys/tpost3.g": 'M955 C"121.i2c.lis" I6' }, NEW_SCHEME_MODEL);

		// Query config.g directly (no tool number) BEFORE saving - caches config.g's pre-save text
		// ("G90", no M955) and correctly finds nothing.
		expect(await findExistingWiring(host, accelRef("121.0"))).toBeNull();

		// Now save this accelerometer to config.g too (scope "all") - appends a brand new M955 line,
		// using the wiring found via tpost3.g.
		const { plan } = await planAccelSave(host, accelRef("121.0", 3), "all", "6");
		expect(plan.appended).toBe(true);
		await applyEditPlan(host, plan);

		// Without invalidating config.g's cache entry, this would still return null (the pre-save text
		// this test cached above) instead of finding the line applyEditPlan just wrote.
		expect(await findExistingWiring(host, accelRef("121.0"))).toEqual({ cSpec: "121.i2c.lis", canAddress: 121, slot: 0 });
	});
});

describe("restartAfterConfigEdit", () => {
	it("sends M999 for a full reset", async () => {
		const { host, sent } = fakeHost();
		await restartAfterConfigEdit(host, "reset");
		expect(sent).toEqual(["M999"]);
	});

	it("re-runs config.g without a full reset", async () => {
		const { host, sent } = fakeHost();
		await restartAfterConfigEdit(host, "runConfig");
		expect(sent).toEqual(['M98 P"config.g"']);
	});
});

describe("findStrayTpostAccelLines", () => {
	it("finds a stray M955 line in a tool's own tpost<N>.g", async () => {
		const { host } = fakeHost({ "0:/sys/tpost0.g": 'M955 P0 C"121.i2c.lis" I6' }, MULTI_ACCEL_MODEL);
		const found = await findStrayTpostAccelLines(host, [0]);
		expect(found).toEqual([{ toolNumber: 0, path: "0:/sys/tpost0.g", wiring: { cSpec: "121.i2c.lis", canAddress: 121, slot: 0 } }]);
	});

	it("scans every tool number given, skipping ones with no tpost file or no M955 in it", async () => {
		const { host } = fakeHost({
			"0:/sys/tpost0.g": 'M955 P0 C"121.i2c.lis" I6',
			"0:/sys/tpost1.g": "G28 ; no accelerometer here",
			// tpost2.g doesn't exist at all
		}, MULTI_ACCEL_MODEL);
		const found = await findStrayTpostAccelLines(host, [0, 1, 2]);
		expect(found).toHaveLength(1);
		expect(found[0].toolNumber).toBe(0);
	});

	it("returns an empty array when no tool has a stray line", async () => {
		const { host } = fakeHost({}, MULTI_ACCEL_MODEL);
		expect(await findStrayTpostAccelLines(host, [0, 1, 2])).toEqual([]);
	});
});

describe("planAccelMigration", () => {
	it("two tools each with a stray P0 line migrate to distinct config.g slots", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": "G90",
			"0:/sys/tpost0.g": 'M955 P0 C"20.spi.cs1" I20',
			"0:/sys/tpost1.g": 'M955 P0 C"121.i2c.lis" I6',
		}, MULTI_ACCEL_MODEL);
		const stray = await findStrayTpostAccelLines(host, [0, 1]);
		expect(stray).toHaveLength(2);
		const { removals, additions } = await planAccelMigration(host, stray);

		expect(removals).toHaveLength(2);
		expect(removals.find((p) => p.path === "0:/sys/tpost0.g")?.after).toBe("");
		expect(removals.find((p) => p.path === "0:/sys/tpost1.g")?.after).toBe("");

		expect(additions).toHaveLength(2);
		const configLines = additions[additions.length - 1].after.split("\n").filter((l) => l.startsWith("M955"));
		expect(configLines).toHaveLength(2);
		// Distinct slots, each board's own orientation carried over (20 and 6, not reset to identity).
		expect(configLines.some((l) => l.includes('C"20.spi.cs1" I20'))).toBe(true);
		expect(configLines.some((l) => l.includes('C"121.i2c.lis" I6'))).toBe(true);
		const slots = configLines.map((l) => /P(\d+)/.exec(l)![1]);
		expect(new Set(slots).size).toBe(2); // no collision
	});

	it("a tool with no stray line is left alone - findStrayTpostAccelLines simply never reports it", async () => {
		const { host } = fakeHost({ "0:/sys/tpost0.g": 'M955 P0 C"121.i2c.lis" I6', "0:/sys/tpost1.g": "G28" }, MULTI_ACCEL_MODEL);
		const stray = await findStrayTpostAccelLines(host, [0, 1]);
		expect(stray.map((s) => s.toolNumber)).toEqual([0]);
	});

	it("a tpost file with an unrelated directive keeps everything but the M955 line", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": "G90",
			"0:/sys/tpost0.g": 'G28\nM955 P0 C"121.i2c.lis" I6\nM106 S1',
		}, MULTI_ACCEL_MODEL);
		const stray = await findStrayTpostAccelLines(host, [0]);
		const { removals } = await planAccelMigration(host, stray);
		expect(removals[0].after).toBe("G28\nM106 S1");
	});

	it("re-running the scan after migration finds nothing left", async () => {
		const { host, fs } = fakeHost({
			"0:/sys/config.g": "G90",
			"0:/sys/tpost0.g": 'M955 P0 C"121.i2c.lis" I6',
		}, MULTI_ACCEL_MODEL);
		const stray = await findStrayTpostAccelLines(host, [0]);
		const { removals, additions } = await planAccelMigration(host, stray);
		for (const plan of [...removals, ...additions]) {
			await applyEditPlan(host, plan);
		}
		expect(fs.get("0:/sys/tpost0.g")).toBe("");
		expect(await findStrayTpostAccelLines(host, [0])).toEqual([]);
	});

	it("reuses a board's existing config.g slot rather than assigning a new one, if it already has one there", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'M955 P5 C"121.i2c.lis" I0',
			"0:/sys/tpost3.g": 'M955 P0 C"121.i2c.lis" I6', // stray leftover, but config.g already claims slot 5
		}, MULTI_ACCEL_MODEL);
		const stray = await findStrayTpostAccelLines(host, [3]);
		const { additions } = await planAccelMigration(host, stray);
		expect(additions[0].after).toBe('M955 P5 C"121.i2c.lis" I6'); // still slot 5, orientation updated
	});
});
