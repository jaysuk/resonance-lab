import { describe, expect, it } from "vitest";

import { analyseCapture } from "../src/analysis/pipeline";
import { findBestShaper, TEST_DAMPING_RATIOS } from "../src/analysis/recommend";
import { parseAccelCsv } from "../src/capture/csv";
import {
	findAccelerometers, runNativeCapture, runSweepCapture, type MachineIO,
} from "../src/capture/orchestrator";

/** Synthesize a realistic capture CSV: a machine ringing at f0 with noise, sampled at fs. */
function syntheticCsv(f0: number, fs: number, seconds: number): string {
	const n = Math.floor(fs * seconds);
	const lines = ["Sample,X,Y,Z"];
	let seed = 42;
	const rand = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff - 0.5;
	};
	for (let i = 0; i < n; i++) {
		const t = i / fs;
		// Repeated decaying ring bursts (as excitation pulses keep re-triggering the resonance).
		const phase = t % 0.5;
		const ring = Math.exp(-8 * phase) * Math.sin(2 * Math.PI * f0 * t);
		const x = 2 * ring + 0.15 * rand();
		const y = 0.4 * ring + 0.15 * rand();
		const z = 0.98 + 0.1 * rand();
		lines.push(`${i},${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`);
	}
	lines.push(`Rate ${fs} overflows 0`);
	return lines.join("\n");
}

describe("end-to-end: CSV text -> recommendation", () => {
	it("recovers the resonance and recommends a shaper near it", () => {
		const capture = parseAccelCsv(syntheticCsv(48, 1000, 8));
		const a = analyseCapture(capture);
		expect(a.samplingRate).toBe(1000);
		expect(a.overflows).toBe(0);
		expect(a.peaks.length).toBeGreaterThan(0);
		expect(Math.abs(a.peaks[0].freq - 48)).toBeLessThan(3);
		expect(a.recommendation).not.toBeNull();
		const best = a.recommendation!.best;
		expect(Math.abs(best.freq - 48)).toBeLessThan(10);
		expect(best.vibrations).toBeLessThan(0.35);
	});

	it("returns no recommendation for a flat/noise-only capture", () => {
		const lines = ["Sample,X,Y,Z"];
		for (let i = 0; i < 2000; i++) {
			lines.push(`${i},0,0,0.98`);
		}
		lines.push("Rate 1000 overflows 0");
		const a = analyseCapture(parseAccelCsv(lines.join("\n")));
		expect(a.recommendation).toBeNull();
	});

	it("adds the measured damping ratio to the fit's worst-case test set, not just the generic bracket", () => {
		const a = analyseCapture(parseAccelCsv(syntheticCsv(48, 1000, 8)));
		const measuredZeta = a.peaks[0].dampingRatio;
		expect(measuredZeta).toBeDefined();
		const withMeasuredRatio = findBestShaper(a.spectrum.freqs, a.normalized, {
			dampingRatio: measuredZeta,
			testDampingRatios: Array.from(new Set([...TEST_DAMPING_RATIOS, measuredZeta!])),
		})!;
		expect(a.recommendation!.best.vibrations).toBeCloseTo(withMeasuredRatio.best.vibrations, 9);
		expect(a.recommendation!.best.freq).toBeCloseTo(withMeasuredRatio.best.freq, 9);
	});
});

// ─── Orchestrator (injected I/O, no printer needed) ───────────────────────────

// makeDirectory deliberately omitted here (kept undefined): ensureDir()'s "if (!io.makeDirectory)
// return" guard means these tests' calls[] indices (upload first, then code) stay stable. The
// program-folder tests below use their own io object that does implement makeDirectory.
function fakeIo() {
	const calls: Array<{ kind: string; arg: string; content?: string }> = [];
	const io: MachineIO = {
		sendCode: async (code) => { calls.push({ kind: "code", arg: code }); return "ok"; },
		upload: async (path, content) => { calls.push({ kind: "upload", arg: path, content }); },
		download: async (path) => { calls.push({ kind: "download", arg: path }); return ""; },
	};
	return { io, calls };
}

describe("capture orchestrator", () => {
	const accel = { id: "121.0", label: "Toolboard" };

	it("finds accelerometers in the object model", () => {
		const model = {
			boards: [
				{ canAddress: 0, shortName: "MB6HC" },
				{ canAddress: 121, shortName: "TOOL1LC", accelerometer: { points: 0 } },
			],
		};
		const found = findAccelerometers(model);
		// CAN-board accelerometers must carry the .0 index (P121.0); plain P121 is "not found".
		expect(found).toEqual([{ id: "121.0", label: "TOOL1LC" }]);
		expect(findAccelerometers({ boards: [{ canAddress: 0, shortName: "MB6HC", accelerometer: {} }] }))
			.toEqual([{ id: "0", label: "MB6HC" }]);
	});

	it("sweep capture uploads the program then arms the recorder around M98", async () => {
		const { io, calls } = fakeIo();
		const run = await runSweepCapture(io, {
			accelerometer: accel, axis: "X", center: 150, startFreq: 5, endFreq: 30, expectedSampleRate: 1000,
		});
		expect(calls[0].kind).toBe("upload");
		// Per-run program file: the firmware holds the macro open while it runs, so a shared name
		// can't be overwritten for the next run. Uploaded to the dedicated program folder, not bare
		// 0:/sys (which holds the machine's own config/homing files).
		expect(calls[0].arg).toMatch(/^0:\/sys\/resonanceLab\/rlab-sweep-x-\d+\.g$/);
		expect(calls[0].content).toContain('M593 P"none"');
		const cmd = calls[1];
		expect(cmd.kind).toBe("code");
		expect(cmd.arg).toMatch(/^M400 M956 P121\.0 S\d+ A0 F"rlab-sweep-x-(\d+)\.csv" M98 P"0:\/sys\/resonanceLab\/rlab-sweep-x-\1\.g"$/);
		// Sample count covers the duration with margin.
		const s = parseInt(/S(\d+)/.exec(cmd.arg)![1], 10);
		expect(s).toBeGreaterThan(run.program.durationSec * 1000);
		expect(run.csvPath).toContain("0:/sys/accelerometer/rlab-sweep-x-");
	});

	it("sweepProgramPath defaults to DEFAULT_PROGRAM_DIR and honours a custom directory", async () => {
		const { sweepProgramPath, DEFAULT_PROGRAM_DIR } = await import("../src/capture/orchestrator");
		expect(DEFAULT_PROGRAM_DIR).toBe("0:/sys/resonanceLab");
		expect(sweepProgramPath("rlab-sweep-x-20260706120000.csv")).toBe("0:/sys/resonanceLab/rlab-sweep-x-20260706120000.g");
		expect(sweepProgramPath("rlab-sweep-x-20260706120000.csv", "0:/sys/custom")).toBe("0:/sys/custom/rlab-sweep-x-20260706120000.g");
	});

	it("sweep capture creates the program folder (best-effort) before uploading", async () => {
		const calls: Array<{ kind: string; arg: string }> = [];
		const io: MachineIO = {
			sendCode: async (code) => { calls.push({ kind: "code", arg: code }); return "ok"; },
			upload: async (path) => { calls.push({ kind: "upload", arg: path }); },
			download: async () => "",
			makeDirectory: async (path) => { calls.push({ kind: "mkdir", arg: path }); },
		};
		await runSweepCapture(io, { accelerometer: accel, axis: "X", center: 150, startFreq: 5, endFreq: 30 });
		expect(calls[0]).toEqual({ kind: "mkdir", arg: "0:/sys/resonanceLab" });
		expect(calls[1].kind).toBe("upload");
	});

	it("sweep capture uploads to a custom programDir when given, both mkdir and the file path", async () => {
		const calls: Array<{ kind: string; arg: string }> = [];
		const io: MachineIO = {
			sendCode: async (code) => { calls.push({ kind: "code", arg: code }); return "ok"; },
			upload: async (path) => { calls.push({ kind: "upload", arg: path }); },
			download: async () => "",
			makeDirectory: async (path) => { calls.push({ kind: "mkdir", arg: path }); },
		};
		await runSweepCapture(io, {
			accelerometer: accel, axis: "X", center: 150, startFreq: 5, endFreq: 30, programDir: "0:/sys/myFolder",
		});
		expect(calls[0]).toEqual({ kind: "mkdir", arg: "0:/sys/myFolder" });
		expect(calls[1].arg).toMatch(/^0:\/sys\/myFolder\/rlab-sweep-x-\d+\.g$/);
	});

	it("a failing makeDirectory doesn't stop the capture (best-effort, swallowed)", async () => {
		const io: MachineIO = {
			sendCode: async () => "ok",
			upload: async () => {},
			download: async () => "",
			makeDirectory: async () => { throw new Error("mkdir not supported"); },
		};
		// If ensureDir() didn't swallow the rejection, this await would throw and fail the test.
		const run = await runSweepCapture(io, { accelerometer: accel, axis: "X", center: 150, startFreq: 5, endFreq: 30 });
		expect(run.csvPath).toContain("0:/sys/accelerometer/rlab-sweep-x-");
	});

	it("native capture uses the generated default profile, or custom moves in advanced mode", async () => {
		const { io, calls } = fakeIo();
		await runNativeCapture(io, { accelerometer: accel, axis: "y", center: 100 });
		expect(calls[0].arg).toContain("G1 Y60");
		expect(calls[1].arg).toContain('M956 P121.0 S1000 A0 F"rlab-move-y-');
		expect(calls[1].arg).toContain("G1 Y140");

		const { io: io2, calls: calls2 } = fakeIo();
		await runNativeCapture(io2, {
			accelerometer: accel, axis: "y", center: 100,
			customMoves: ["G1 Y10 F9000", "G1 Y190 F9000"],
		});
		expect(calls2[1].arg).toContain("G1 Y10 F9000 G1 Y190 F9000");
	});
});
