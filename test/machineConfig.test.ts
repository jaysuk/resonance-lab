import { describe, expect, it } from "vitest";

import type { HostAdapter } from "../src/core/host";
import {
	applyEditPlan, configPath, planOrientationSave, planShaperSave, restartAfterConfigEdit, tpostPath,
} from "../src/config/machineConfig";

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

describe("planOrientationSave", () => {
	it("edits I in place when M955 already exists, preserving C/Q wiring config", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'G90\nM955 P121.0 C"^spi.cs1" Q2000000 I0 ; toolboard accelerometer\nM84 S60',
		});
		const plan = await planOrientationSave(host, "121.0", "20");
		expect(plan.appended).toBe(false);
		expect(plan.after).toContain('M955 P121.0 C"^spi.cs1" Q2000000 I20 ; toolboard accelerometer');
		expect(plan.after).toContain("G90");
		expect(plan.after).toContain("M84 S60");
	});

	it("appends a new M955 line when the accelerometer isn't configured in config.g at all", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "G90\nM84 S60" });
		const plan = await planOrientationSave(host, "0", "20");
		expect(plan.appended).toBe(true);
		expect(plan.after).toContain("M955 P0 I20");
		expect(plan.after).toMatch(/; Resonance Lab \d{4}-\d{2}-\d{2}/);
	});

	it("matches the right accelerometer on a multi-toolboard machine by P id, not just M955", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": "M955 P121.0 I0\nM955 P122.0 I0",
		});
		const plan = await planOrientationSave(host, "122.0", "6");
		expect(plan.after).toBe("M955 P121.0 I0\nM955 P122.0 I6");
	});

	it("flags a commented-out duplicate without treating it as the active one", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": "; M955 P0 I0 ; old wiring\nM955 P0 I0",
		});
		const plan = await planOrientationSave(host, "0", "20");
		expect(plan.disabledDuplicateFound).toBe(true);
		expect(plan.after).toBe("; M955 P0 I0 ; old wiring\nM955 P0 I20");
	});

	it("refuses to edit an M955 line that uses {expression} syntax", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "M955 P0 I{global.accelOrientation}" });
		const plan = await planOrientationSave(host, "0", "20");
		expect(plan.blocked).toBeTruthy();
		expect(plan.after).toBe(plan.before);
	});

	it("round-trips a CRLF config.g without changing its line endings", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "G90\r\nM955 P0 I0\r\nM84 S60" });
		const plan = await planOrientationSave(host, "0", "20");
		expect(plan.after).toBe("G90\r\nM955 P0 I20\r\nM84 S60");
	});

	it("propagates a real read failure rather than treating config.g as empty", async () => {
		const { host } = fakeHost({}); // config.g not present in the fake filesystem at all
		await expect(planOrientationSave(host, "0", "20")).rejects.toThrow(/config\.g/);
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
		const plan = await planOrientationSave(host, "0", "20");
		await applyEditPlan(host, plan);
		expect(fs.get("0:/sys/config.g")).toBe("M955 P0 I20");
		const backupKey = [...fs.keys()].find((k) => k !== "0:/sys/config.g");
		expect(backupKey).toMatch(/^0:\/sys\/config\.g\.rlab-\d{14}\.bak$/);
		expect(fs.get(backupKey!)).toBe("M955 P0 I0");
	});

	it("writes nothing (no backup either) when the plan changes nothing", async () => {
		const { host, fs } = fakeHost({ "0:/sys/config.g": "M955 P0 I20" });
		const plan = await planOrientationSave(host, "0", "20"); // already the target value
		expect(plan.after).toBe(plan.before);
		await applyEditPlan(host, plan);
		expect(fs.size).toBe(1); // still just config.g - no backup created for a no-op
	});

	it("refuses to write a blocked plan", async () => {
		const { host, fs } = fakeHost({ "0:/sys/config.g": "M955 P0 I{global.x}" });
		const plan = await planOrientationSave(host, "0", "20");
		await expect(applyEditPlan(host, plan)).rejects.toThrow();
		expect(fs.size).toBe(1); // nothing written
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
