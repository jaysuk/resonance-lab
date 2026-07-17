import { afterEach, describe, expect, it, vi } from "vitest";

import { cropCaptureToDuration, parseAccelCsv } from "../src/capture/csv";
import { generateSweep, shaperRestoreGcode } from "../src/capture/sweep";

describe("parseAccelCsv", () => {
	const sample = [
		"Sample,X,Y,Z",
		"0,0.012,-0.003,0.981",
		"1,0.015,-0.001,0.979",
		"2,-0.008,0.002,0.984",
		"3,0.001,0.000,0.980",
		"Rate 1342 overflows 0",
	].join("\n");

	it("parses axes, channels, rate and overflows", () => {
		const c = parseAccelCsv(sample);
		expect(c.axes).toEqual(["X", "Y", "Z"]);
		expect(c.samplingRate).toBe(1342);
		expect(c.overflows).toBe(0);
		expect(c.channels.length).toBe(3);
		expect(c.channels[0].length).toBe(4);
		expect(c.channels[0][1]).toBeCloseTo(0.015, 9);
		expect(c.channels[2][2]).toBeCloseTo(0.984, 9);
	});

	it("flags overflows and rejects garbage", () => {
		expect(parseAccelCsv(sample.replace("overflows 0", "overflows 3")).overflows).toBe(3);
		expect(() => parseAccelCsv("hello\nworld\n!")).toThrow();
		expect(() => parseAccelCsv(sample.split("\n").slice(0, 4).join("\n"))).toThrow(/trailer/);
	});
});

describe("cropCaptureToDuration", () => {
	it("discards trailing samples recorded after the real motion ended", () => {
		const capture = { axes: ["X", "Y"], channels: [new Float64Array(1000), new Float64Array(1000)], samplingRate: 1000, overflows: 0 };
		const cropped = cropCaptureToDuration(capture, 0.5); // 0.5s at 1000Hz = 500 samples
		expect(cropped.channels[0].length).toBe(500);
		expect(cropped.channels[1].length).toBe(500);
		// Metadata is preserved.
		expect(cropped.axes).toEqual(["X", "Y"]);
		expect(cropped.samplingRate).toBe(1000);
	});

	it("is a no-op when the capture is already shorter than the requested duration", () => {
		const capture = { axes: ["X"], channels: [new Float64Array(100)], samplingRate: 1000, overflows: 0 };
		expect(cropCaptureToDuration(capture, 5).channels[0].length).toBe(100);
	});

	it("never returns a negative-length crop", () => {
		const capture = { axes: ["X"], channels: [new Float64Array(100)], samplingRate: 1000, overflows: 0 };
		expect(cropCaptureToDuration(capture, -1).channels[0].length).toBe(0);
	});
});

describe("generateSweep", () => {
	it("produces a program that oscillates around the centre and disables shaping", () => {
		const p = generateSweep({ axis: "x", center: 150, startFreq: 5, endFreq: 20, maxAccel: 3000 });
		expect(p.lines[3]).toContain('M593 P"none"');
		expect(p.pulses).toBeGreaterThan(20);
		expect(p.durationSec).toBeGreaterThan(5);
		// Every move targets X<value>; excursions shrink as frequency rises.
		const targets = p.lines.filter((l) => l.startsWith("G1 X")).map((l) => parseFloat(l.slice(4)));
		expect(targets.length).toBeGreaterThan(0);
		const first = Math.abs(targets[0] - 150);
		const last = Math.abs(targets[targets.length - 3] - 150);
		expect(first).toBeGreaterThan(last);
		// Ends back at centre.
		expect(targets[targets.length - 1]).toBe(150);
	});

	it("clamps acceleration to the machine limit and reports max excursion", () => {
		const p = generateSweep({ axis: "Y", center: 100, startFreq: 5, endFreq: 135, accelPerHz: 60, maxAccel: 2000 });
		const accels = p.lines.filter((l) => l.startsWith("M204 P")).map((l) => parseFloat(l.slice(6)));
		expect(Math.max(...accels)).toBeLessThanOrEqual(2000);
		// Max excursion is at the start (lowest frequency): d = a*t^2, a = 60*5 = 300, t = 0.05.
		expect(p.maxExcursion).toBeCloseTo(300 * 0.05 * 0.05, 6);
	});

	it("sweep duration tracks the frequency span and rate", () => {
		const slow = generateSweep({ axis: "X", center: 0, startFreq: 10, endFreq: 30, hzPerSec: 1 });
		const fast = generateSweep({ axis: "X", center: 0, startFreq: 10, endFreq: 30, hzPerSec: 2 });
		expect(slow.durationSec).toBeGreaterThan(fast.durationSec * 1.5);
		// At 1 Hz/s a 20 Hz span should take roughly 20 seconds of motion.
		expect(slow.durationSec).toBeGreaterThan(10);
		expect(slow.durationSec).toBeLessThan(40);
	});

	it("rejects invalid ranges", () => {
		expect(() => generateSweep({ axis: "X", center: 0, startFreq: 0 })).toThrow();
		expect(() => generateSweep({ axis: "X", center: 0, startFreq: 50, endFreq: 20 })).toThrow();
	});

	it("restores the configured acceleration at the end, not just the last pulse's (lower) rate", () => {
		// Peak pulse accel here is 60*135=8100, below the 10000 machine limit - so without an explicit
		// restore, the program would leave M204 at 8100 rather than the real configured maximum, and
		// any later move (e.g. a "quick test move") would inherit that reduced cap since RRF's M204 is
		// a persistent override, not scoped to this macro.
		const p = generateSweep({ axis: "X", center: 0, startFreq: 5, endFreq: 135, accelPerHz: 60, maxAccel: 10000 });
		const m204s = p.lines.filter((l) => l.startsWith("M204 P")).map((l) => parseFloat(l.slice(6)));
		expect(m204s[m204s.length - 1]).toBe(10000);
		expect(m204s[m204s.length - 1]).toBeGreaterThan(m204s[m204s.length - 2]);
	});

	it("restores a previously-configured shaper after the test, not just disabling it", () => {
		const p = generateSweep({
			axis: "X", center: 0, startFreq: 5, endFreq: 20,
			restoreShaper: { type: "mzv", frequency: 42.5, damping: 0.1 },
		});
		expect(p.lines.some((l) => l === 'M593 P"none" ; disable input shaping during the measurement')).toBe(true);
		expect(p.lines.some((l) => l === 'M593 P"mzv" F42.5 S0.10')).toBe(true);
	});

	it("does not restore shaping when the machine had none configured, or during a keepShaper run", () => {
		const none = generateSweep({ axis: "X", center: 0, startFreq: 5, endFreq: 20, restoreShaper: { type: "none", frequency: 0, damping: 0 } });
		expect(none.lines.filter((l) => l.startsWith("M593")).length).toBe(1); // only the leading disable

		const kept = generateSweep({
			axis: "X", center: 0, startFreq: 5, endFreq: 20, keepShaper: true,
			restoreShaper: { type: "mzv", frequency: 42.5, damping: 0.1 },
		});
		expect(kept.lines.some((l) => l.startsWith("M593"))).toBe(false);
	});
});

describe("shaperRestoreGcode", () => {
	it("builds an M593 restore command for a real shaper", () => {
		expect(shaperRestoreGcode({ type: "zvd", frequency: 38.25, damping: 0.15 })).toBe('M593 P"zvd" F38.3 S0.15');
	});

	it("is a no-op for undefined, \"none\" or \"custom\" (never reconstructed)", () => {
		expect(shaperRestoreGcode(undefined)).toBe("");
		expect(shaperRestoreGcode({ type: "none", frequency: 0, damping: 0 })).toBe("");
		expect(shaperRestoreGcode({ type: "custom", frequency: 40, damping: 0.1 })).toBe("");
	});
});

describe("fixed excitation + orientation", () => {
	it("fixed excitation holds one frequency and can keep the shaper active", async () => {
		const { generateFixedExcitation } = await import("../src/capture/sweep");
		const p = generateFixedExcitation({ axis: "X", center: 100, freq: 40, seconds: 5 });
		expect(p.lines.some((l) => l.includes('M593 P"none"'))).toBe(true);
		expect(p.durationSec).toBeGreaterThan(4.9);
		const verify = generateFixedExcitation({ axis: "X", center: 100, freq: 40, seconds: 5, keepShaper: true });
		expect(verify.lines.some((l) => l.includes('M593 P"none"'))).toBe(false);
	});

	it("sweep keepShaper leaves the shaper active for the verify run", async () => {
		const { generateSweep } = await import("../src/capture/sweep");
		const p = generateSweep({ axis: "X", center: 100, startFreq: 5, endFreq: 10, keepShaper: true });
		expect(p.lines.some((l) => l.includes('M593 P"none"'))).toBe(false);
	});

	it("fixed excitation also restores the configured acceleration afterward", async () => {
		const { generateFixedExcitation } = await import("../src/capture/sweep");
		// Test accel at 40Hz*60 = 2400, well below the 10000 machine limit.
		const p = generateFixedExcitation({ axis: "X", center: 100, freq: 40, seconds: 2, accelPerHz: 60, maxAccel: 10000 });
		const m204s = p.lines.filter((l) => l.startsWith("M204 P")).map((l) => parseFloat(l.slice(6)));
		expect(m204s).toEqual([2400, 10000]);
	});

	it("orientation check finds the dominant channel", async () => {
		const { checkOrientation } = await import("../src/analysis/orientation");
		const { parseAccelCsv } = await import("../src/capture/csv");
		const lines = ["Sample,X,Y,Z"];
		for (let i = 0; i < 500; i++) {
			lines.push(`${i},${(0.02 * Math.sin(i / 3)).toFixed(4)},${(2 * Math.sin(i / 5)).toFixed(4)},0.98`);
		}
		lines.push("Rate 1000 overflows 0");
		const capture = parseAccelCsv(lines.join("\n"));
		expect(checkOrientation(capture, "Y").ok).toBe(true);
		const wrong = checkOrientation(capture, "X");
		expect(wrong.ok).toBe(false);
		expect(wrong.dominant).toBe("Y");
		expect(wrong.dominance).toBeGreaterThan(0.9);
	});
});

describe("capture robustness (live-printer findings)", () => {
	it("parses real-firmware trailer punctuation variants", async () => {
		const { parseAccelCsv, hasCaptureTrailer } = await import("../src/capture/csv");
		const base = "Sample,X,Y,Z\n0,0.1,0.2,0.98\n1,0.1,0.2,0.98\n";
		for (const trailer of ["Rate 1342 overflows 0", "Rate: 1342, overflows: 2", "Rate,1342,overflows,1", "Sample rate 1342, overflows 0,,"]) {
			const c = parseAccelCsv(base + trailer);
			expect(c.samplingRate).toBe(1342);
			expect(c.channels[0].length).toBe(2);
			expect(hasCaptureTrailer(base + trailer)).toBe(true);
		}
		expect(hasCaptureTrailer(base)).toBe(false);
	});

	it("downloadCapture polls until the firmware finishes writing the file", async () => {
		const { downloadCapture } = await import("../src/capture/orchestrator");
		const full = "Sample,X\n0,0.1\n1,0.2\nRate 1000, overflows 0";
		let attempt = 0;
		const io = {
			sendCode: async () => "ok",
			upload: async () => {},
			download: async () => {
				attempt++;
				if (attempt === 1) throw new Error("not found");
				if (attempt === 2) return "Sample,X\n0,0.1"; // still being written
				return full;
			},
		};
		const text = await downloadCapture(io, { csvPath: "x.csv", program: { lines: [], pulses: 0, durationSec: 0, maxExcursion: 0 } }, 5000, 10);
		expect(text).toBe(full);
		expect(attempt).toBe(3);
	});

	it("captures snapshot the run counter before arming", async () => {
		const { runSweepCapture } = await import("../src/capture/orchestrator");
		const io = {
			sendCode: async () => "ok",
			upload: async () => {},
			download: async () => "",
			accelRuns: () => 3,
		};
		const run = await runSweepCapture(io, {
			accelerometer: { id: "0", label: "MB" }, axis: "X", center: 100, startFreq: 5, endFreq: 10,
		});
		expect(run.accelId).toBe("0");
		expect(run.runsBefore).toBe(3);
	});

	it("downloadCapture waits on the run counter when the IO exposes it (no file polling)", async () => {
		const { downloadCapture } = await import("../src/capture/orchestrator");
		const full = "Sample,X\n0,0.1\nRate 1000, overflows 0";
		let runs = 5;
		let fileReady = false;
		const io = {
			sendCode: async () => "ok",
			upload: async () => {},
			download: async () => { if (!fileReady) throw new Error("not found"); return full; },
			accelRuns: () => runs,
			// The firmware finishing = counter ticks and the CSV becomes readable.
			awaitAccelRun: async (_id: string, from: number) => { runs = from + 1; fileReady = true; },
		};
		const run = { csvPath: "x.csv", program: { lines: [], pulses: 0, durationSec: 0, maxExcursion: 0 }, accelId: "0", runsBefore: 5 };
		expect(await downloadCapture(io, run)).toBe(full);
	});

	it("downloadCapture still hands the file to the parser if the counter never ticks", async () => {
		const { downloadCapture } = await import("../src/capture/orchestrator");
		const partial = "Sample,X\n0,0.1"; // truncated: no rate/overflows trailer
		const io = {
			sendCode: async () => "ok",
			upload: async () => {},
			download: async () => partial,
			accelRuns: () => 0,
			awaitAccelRun: async () => { throw new Error("never completed"); },
		};
		const run = { csvPath: "x.csv", program: { lines: [], pulses: 0, durationSec: 0, maxExcursion: 0 }, accelId: "0", runsBefore: 0 };
		// Returned (not thrown) so the CSV parser can surface its specific error.
		expect(await downloadCapture(io, run, 100)).toBe(partial);
	});

	it("downloadCapture best-effort deletes the per-run program file once the capture is confirmed complete", async () => {
		const { downloadCapture } = await import("../src/capture/orchestrator");
		const full = "Sample,X\n0,0.1\nRate 1000, overflows 0";
		const deleted: Array<string> = [];
		const io = {
			sendCode: async () => "ok",
			upload: async () => {},
			download: async () => full,
			accelRuns: () => 1,
			awaitAccelRun: async () => {},
			delete: async (path: string) => { deleted.push(path); },
		};
		const run = {
			csvPath: "x.csv", progPath: "0:/sys/rlab-sweep-x-123.g",
			program: { lines: [], pulses: 0, durationSec: 0, maxExcursion: 0 }, accelId: "0", runsBefore: 0,
		};
		await downloadCapture(io, run);
		expect(deleted).toEqual(["0:/sys/rlab-sweep-x-123.g"]);
	});

	it("downloadCapture does NOT delete the program file when the capture never completed", async () => {
		const { downloadCapture } = await import("../src/capture/orchestrator");
		const partial = "Sample,X\n0,0.1"; // truncated: no rate/overflows trailer
		const deleted: Array<string> = [];
		const io = {
			sendCode: async () => "ok",
			upload: async () => {},
			download: async () => partial,
			accelRuns: () => 0,
			awaitAccelRun: async () => { throw new Error("never completed"); },
			delete: async (path: string) => { deleted.push(path); },
		};
		const run = {
			csvPath: "x.csv", progPath: "0:/sys/rlab-sweep-x-123.g",
			program: { lines: [], pulses: 0, durationSec: 0, maxExcursion: 0 }, accelId: "0", runsBefore: 0,
		};
		await downloadCapture(io, run, 100);
		expect(deleted).toEqual([]);
	});

});

describe("orientation solver (3.6-prototype algorithm)", () => {
	it("solves a rotated chip and emits the M955 I parameter", async () => {
		const { solveOrientation } = await import("../src/analysis/axesMap");
		// Chip Y carried the machine-X burst (negative), gravity on chip Z pointing up.
		const sol = solveOrientation(
			{ X: { channel: "Y", sign: -1, coupling: 0.2, dc: [0, 0, 0.99] }, Y: { channel: "X", sign: 1, coupling: 0.2, dc: [0, 0, 0.99] } },
			{ channel: "Z", sign: 1 },
		);
		expect(sol.faces.Y).toEqual({ axis: "X", sign: -1 });
		expect(sol.faces.Z).toEqual({ axis: "Z", sign: 1 });
		// I = digit(chipZ=+Z -> 2) then digit(chipX=+Y -> 1)
		expect(sol.iParam).toBe("21");
		expect(sol.conflicts).toEqual([]);
	});

	it("flags conflicts when both moves hit the same channel", async () => {
		const { solveOrientation } = await import("../src/analysis/axesMap");
		const r = { channel: "X", sign: 1 as const, coupling: 0.9, dc: [0, 0, -1] };
		const sol = solveOrientation({ X: r, Y: { ...r } }, { channel: "Z", sign: -1 });
		expect(sol.conflicts).toEqual(["Y"]);
	});
});

describe("belt recording sizing", () => {
	const beltOpts = { accelerometer: { id: "0", label: "MB" }, belt: "a" as const, centerX: 100, centerY: 100, startFreq: 15, endFreq: 95, hzPerSec: 2 };

	it("runBeltCapture honours an explicit samples override (measured motion time)", async () => {
		const { runBeltCapture } = await import("../src/capture/orchestrator");
		const codes: Array<string> = [];
		const io = { sendCode: async (c: string) => { codes.push(c); return "ok"; }, upload: async () => {}, download: async () => "" };
		await runBeltCapture(io, { ...beltOpts, samples: 1234 });
		expect(codes.some((c) => c.includes("S1234 "))).toBe(true);
	});

	it("runBeltCapture oversizes to the kinematic estimate when no samples are given (self-sizing mode)", async () => {
		const { runBeltCapture } = await import("../src/capture/orchestrator");
		const codes: Array<string> = [];
		const io = { sendCode: async (c: string) => { codes.push(c); return "ok"; }, upload: async () => {}, download: async () => "" };
		const run = await runBeltCapture(io, beltOpts);
		const s = parseInt(/S(\d+)/.exec(codes[0])![1], 10);
		expect(s).toBeGreaterThan(run.program.durationSec * 1000); // expectedSampleRate defaults to 1000 Hz
		// No busy/idle signals on this IO - the real duration can't be measured, so the caller must
		// keep the full oversized capture rather than guessing from sendCode's resolution (which,
		// unlike the old unrecorded probe, now shares its line with the M956 recording and so no
		// longer approximates the real motion time at all).
		expect(run.motionSec).toBeUndefined();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("runBeltCapture self-times the real motion via busy/idle while its oversized recording runs, not a separate probe move", async () => {
		vi.useFakeTimers();
		const { runBeltCapture } = await import("../src/capture/orchestrator");
		const uploaded: Array<string> = [];
		const io = {
			sendCode: async () => "ok", // resolves instantly - must NOT be trusted for timing
			upload: async (path: string) => { uploaded.push(path); },
			download: async () => "",
			awaitBusy: () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
			awaitIdle: () => new Promise<void>((resolve) => setTimeout(resolve, 8000)),
		};
		const promise = runBeltCapture(io, beltOpts);
		await vi.runAllTimersAsync();
		const run = await promise;
		expect(run.motionSec).toBeCloseTo(8, 1);
		// Exactly one program uploaded (the belt's own recording) - no separate throwaway probe move.
		expect(uploaded.length).toBe(1);
	});

	it("runBeltCapture leaves motionSec undefined when awaitBusy never observes motion", async () => {
		vi.useFakeTimers();
		const { runBeltCapture } = await import("../src/capture/orchestrator");
		const io = {
			sendCode: async () => "ok",
			upload: async () => {},
			download: async () => "",
			// awaitBusy times out (motion never observed, e.g. a very short move or a status-polling
			// gap) - motionSec must stay undefined rather than reporting an unreliable duration.
			awaitBusy: () => new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
			awaitIdle: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
		};
		const promise = runBeltCapture(io, beltOpts);
		await vi.runAllTimersAsync();
		const run = await promise;
		expect(run.motionSec).toBeUndefined();
	});

	it("resizeForActualRate recomputes belt B's samples when the trailer rate differs from the sizing rate", async () => {
		const { resizeForActualRate } = await import("../src/capture/orchestrator");
		// Sized for 1000 Hz but the firmware actually ran at 800 Hz (>10% off) - resize using the
		// measured motion time at the real rate.
		const resized = resizeForActualRate(40000, 38.5, 1000, 800);
		expect(resized).toBe(Math.ceil((38.5 + 1.5) * 800));
	});

	it("resizeForActualRate leaves the sample count unchanged when the trailer rate roughly matches", async () => {
		const { resizeForActualRate } = await import("../src/capture/orchestrator");
		expect(resizeForActualRate(40000, 38.5, 1000, 1020)).toBe(40000);
	});
});

describe("parseAccelRateFromReport", () => {
	// RRF's exact M955 status wording (Accelerometers.cpp: ConfigureAccelerometer), both the
	// CAN-expansion form ("<boardAddr>:<localAddr> ...") and the local-mainboard form.
	it("parses the real RRF M955 report wording (CAN expansion board)", async () => {
		const { parseAccelRateFromReport } = await import("../src/capture/orchestrator");
		const report = "Accelerometer 121:0 type LIS3DH with orientation 20 samples at 1344Hz with 10-bit resolution, SPI frequency 5000000";
		expect(parseAccelRateFromReport(report)).toBe(1344);
	});

	it("parses the real RRF M955 report wording (local mainboard)", async () => {
		const { parseAccelRateFromReport } = await import("../src/capture/orchestrator");
		const report = "Accelerometer 0 type LIS3DH with orientation 20 samples at 1344Hz with 10-bit resolution, SPI frequency 5000000";
		expect(parseAccelRateFromReport(report)).toBe(1344);
	});

	it("is not confused by other numbers in the report (board address, orientation, resolution)", async () => {
		const { parseAccelRateFromReport } = await import("../src/capture/orchestrator");
		// A pathological but plausible report where the board address or orientation could look like
		// a rate if a naive parser grabbed the first bare number - "samples at" must anchor the match.
		const report = "Accelerometer 20:0 type LIS3DH with orientation 1344 samples at 800Hz with 10-bit resolution";
		expect(parseAccelRateFromReport(report)).toBe(800);
	});

	it("falls back to a bare '<n> Hz' if the wording doesn't match 'samples at'", async () => {
		const { parseAccelRateFromReport } = await import("../src/capture/orchestrator");
		expect(parseAccelRateFromReport("Running at 500 Hz")).toBe(500);
	});

	it("returns 0 when nothing parses", async () => {
		const { parseAccelRateFromReport } = await import("../src/capture/orchestrator");
		expect(parseAccelRateFromReport("Input shaping is disabled")).toBe(0);
	});
});
