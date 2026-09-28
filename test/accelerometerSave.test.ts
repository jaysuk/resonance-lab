/**
 * planAccelSave / planAccelMigration / resolveAccelWiring against RRF 3.7.0-rc.2's
 * `sensors.accelerometers[]`, where the object model itself supplies each accelerometer's slot and its
 * M955 `C` value (`port`) - so nothing has to be recovered from config.g's text, and a board's own
 * firmware version string no longer decides which scheme applies.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { AccelerometerRef } from "../src/capture/orchestrator";
import type { HostAdapter } from "../src/core/host";
import {
	configPath, findStrayTpostAccelLines, invalidateGcodeCache, planAccelMigration, planAccelSave, resolveAccelWiring,
} from "../src/config/machineConfig";

beforeEach(() => {
	invalidateGcodeCache();
});

// Deliberately NOT a firmware version that satisfies the multi-slot gate on the toolboard: an
// accelerometer the object model gives a slot for is on multi-accelerometer firmware by definition.
const MODEL = {
	directories: { system: "0:/sys" },
	boards: [
		{ canAddress: 0, firmwareVersion: "3.7.0-rc.2" },
		{ canAddress: 121, firmwareVersion: "3.7.0-rc.1" },
		{ canAddress: 122, firmwareVersion: "3.7.0-rc.2" },
	],
};

/** T0's STM32 toolboard, wired over SPI - CS then INT - occupying slot 2. */
const SPI_ACCEL: AccelerometerRef = {
	id: "121.0", label: "T0 — SHT36v3", toolNumber: 0, canAddress: 121, slot: 2, port: "121.spi.cs.acc+int.acc",
};
const I2C_ACCEL: AccelerometerRef = {
	id: "122.0", label: "T1 — TOOL1LC", toolNumber: 1, canAddress: 122, slot: 0, port: "122.i2c.lis",
};

function fakeHost(files: Record<string, string> = {}) {
	const fs = new Map(Object.entries(files));
	const host: HostAdapter = {
		model: () => MODEL,
		isConnected: () => true,
		sendCode: async () => "ok",
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
	return { host, fs };
}

describe("resolveAccelWiring - the object model's port is the wiring", () => {
	it("returns the port and slot as reported, both pins intact, without any file having to mention this board", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "G90\n" });
		expect(await resolveAccelWiring(host, SPI_ACCEL)).toEqual({ cSpec: "121.spi.cs.acc+int.acc", canAddress: 121, slot: 2 });
	});

	it("takes Q (the one thing the object model doesn't carry) from the file when it's there", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 P2 C"121.spi.cs.acc+int.acc" I20 Q4000000\n' });
		expect(await resolveAccelWiring(host, SPI_ACCEL)).toEqual({ cSpec: "121.spi.cs.acc+int.acc", canAddress: 121, slot: 2, spiFrequency: 4000000 });
	});

	it("prefers the object model's port over a stale line in config.g", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 P2 C"121.spi.cs.acc" I20\n' }); // CS only - would be rejected by the firmware
		expect((await resolveAccelWiring(host, SPI_ACCEL))?.cSpec).toBe("121.spi.cs.acc+int.acc");
	});

	it("does not need config.g to be readable at all", async () => {
		const { host } = fakeHost({}); // no config.g to download
		expect(await resolveAccelWiring(host, I2C_ACCEL)).toEqual({ cSpec: "122.i2c.lis", canAddress: 122, slot: 0 });
	});

	it("falls back to the files for an accelerometer the object model gives no port for (before rc.2)", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 P0 C"121.i2c.lis" I6\n' });
		expect(await resolveAccelWiring(host, { id: "121.0", label: "T0" })).toEqual({ cSpec: "121.i2c.lis", canAddress: 121, slot: 0 });
	});
});

describe("planAccelSave - sensors.accelerometers[] (RRF >= 3.7.0-rc.2)", () => {
	it("appends a full line with the accelerometer's own slot and BOTH SPI pins, no wiring lookup needed", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "G90\n" });
		const { plan, notes } = await planAccelSave(host, SPI_ACCEL, "all", "206");
		expect(plan.path).toBe(configPath(host));
		expect(plan.appended).toBe(true);
		expect(plan.after).toContain('M955 P2 C"121.spi.cs.acc+int.acc" I206');
		expect(notes).toEqual([]);
	});

	it("saves to config.g whatever scope is asked for - every slot is independent, there is nothing to displace", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": "G90\n" });
		const all = await planAccelSave(host, SPI_ACCEL, "all", "206");
		const tool = await planAccelSave(host, SPI_ACCEL, "tool", "206");
		expect(tool.plan.path).toBe(all.plan.path);
		expect(tool.plan.after).toBe(all.plan.after);
	});

	it("edits I in place on the board's existing line, keeping its slot, pins and Q", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'G90\nM955 P5 C"121.spi.cs.acc+int.acc" I20 Q4000000\nM84 S60\n' });
		const { plan } = await planAccelSave(host, SPI_ACCEL, "all", "206");
		expect(plan.appended).toBe(false);
		expect(plan.after).toBe('G90\nM955 P5 C"121.spi.cs.acc+int.acc" I206 Q4000000\nM84 S60\n');
	});

	it("keeps the slot RRF is running the board in when config.g has no line for it yet", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 P0 C"122.i2c.lis" I20\n' });
		const { plan } = await planAccelSave(host, SPI_ACCEL, "all", "20");
		expect(plan.after).toContain('M955 P2 C"121.spi.cs.acc+int.acc" I20');
		expect(plan.after).toContain('M955 P0 C"122.i2c.lis" I20'); // the other board's line untouched
	});

	it("does not reuse that slot when config.g already gives the number to a different board", async () => {
		const { host } = fakeHost({ "0:/sys/config.g": 'M955 P2 C"122.i2c.lis" I20\n' });
		const { plan } = await planAccelSave(host, SPI_ACCEL, "all", "20");
		expect(plan.after).toContain('M955 P0 C"121.spi.cs.acc+int.acc" I20'); // lowest free instead
		expect(plan.after).toContain('M955 P2 C"122.i2c.lis" I20');
	});

	it("carries Q into a new line when a file records it", async () => {
		const { host } = fakeHost({ "0:/sys/tpost0.g": 'M955 P0 C"121.spi.cs.acc+int.acc" I20 Q4000000\n', "0:/sys/config.g": "G90\n" });
		const { plan } = await planAccelSave(host, SPI_ACCEL, "all", "206");
		expect(plan.after).toContain('M955 P2 C"121.spi.cs.acc+int.acc" I206 Q4000000');
	});
});

describe("planAccelMigration - keeps the slots RRF already runs", () => {
	it("gives a migrated board the slot the object model has it in, when config.g doesn't hand that number out", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": "G90\n",
			"0:/sys/tpost0.g": 'M955 P0 C"121.spi.cs.acc+int.acc" I6\nM568 P0 A2\n',
		});
		const stray = await findStrayTpostAccelLines(host, [0]);
		const { additions } = await planAccelMigration(host, stray, new Map([[121, 2]]));
		expect(additions[0].after).toContain('M955 P2 C"121.spi.cs.acc+int.acc" I6');
	});

	it("falls back to the lowest free slot for a board the object model doesn't place, or whose number is taken", async () => {
		const { host } = fakeHost({
			"0:/sys/config.g": 'M955 P2 C"122.i2c.lis" I20\n',
			"0:/sys/tpost0.g": 'M955 P0 C"121.spi.cs.acc+int.acc" I6\n',
		});
		const stray = await findStrayTpostAccelLines(host, [0]);
		const taken = await planAccelMigration(host, stray, new Map([[121, 2]]));
		expect(taken.additions[0].after).toContain('M955 P0 C"121.spi.cs.acc+int.acc" I6');
		const unknown = await planAccelMigration(host, stray);
		expect(unknown.additions[0].after).toContain('M955 P0 C"121.spi.cs.acc+int.acc" I6');
	});
});
