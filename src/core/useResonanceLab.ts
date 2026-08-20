/**
 * Every bit of Resonance Lab's behaviour that does not depend on which DuetWebControl (and which
 * Vue) it is running inside: task definitions, the measurement/verify orchestration, capture
 * loading, and all the chart/verdict presentation.
 *
 * This is the single source of truth shared by the DWC 3.7 (Vue 3 / Vuetify 4) and DWC 3.6
 * (Vue 2.7 / Vuetify 2) UI layers - each of those is only a template plus a ~40-line
 * `HostAdapter`. Vue 2.7 backported the Composition API, so `ref`/`computed`/`watch` behave
 * identically on both and this file compiles unchanged against either.
 *
 * Everything reached by a template is returned at the bottom; the UI destructures it in
 * `<script setup>` so template expressions keep referring to plain names.
 */
import { computed, ref, watch } from "vue";

// Subpath, not the barrel: the barrel also re-exports AboutDialog/HelpTip, which call Vue 3's
// `resolveComponent` and would break the Vue 2.7 build of this shared module.
import { buildReport, downloadReport } from "dwc-plugin-runtime/diagnostics";

import { analyzeAxisBurst, detectVerticalAxis, solveOrientation } from "../analysis/axesMap";
import { compareBelts } from "../analysis/belts";
import { analyseCapture, type CaptureAnalysis } from "../analysis/pipeline";
import { findBestShaperCombined, type CombinedRecommendationResult } from "../analysis/recommend";
import { SHAPER_DISPLAY_NAMES, type ShaperName } from "../analysis/shapers";
import { computeSpectrogram } from "../analysis/stft";
import { buildVibrationProfile } from "../analysis/vibration";
import { cropCaptureToDuration, parseAccelCsv } from "../capture/csv";
import {
	beltEstimatedDurationSec, DEFAULT_PROGRAM_DIR, downloadCapture, findAccelerometers, parseAccelRateFromReport,
	resizeForActualRate, runBeltCapture, runFixedExcitation, runNativeCapture, runSpeedPointCapture, runSweepCapture,
	type AccelerometerRef, type MachineIO,
} from "../capture/orchestrator";
import { shaperRestoreGcode, type ShaperState } from "../capture/sweep";
import { accelForTool } from "../capture/tools";
import {
	applyEditPlan, configPath, planOrientationSave, planShaperSave, restartAfterConfigEdit,
	type DirectiveEditPlan, type ShaperScope,
} from "../config/machineConfig";
import {
	activeTool, beltResult, combinedRec, lastResult, measurementRunning, method, multiResults, orientationResult,
	profileResult, selectedAxes, selectedAxis, type CaptureMethod, type MultiAxisResult,
} from "../state";
// Only the pieces the logic itself drives. The rest of the update surface (updateState,
// pendingReload, the apply/check actions) is module-level reactive state the templates import
// straight from ../updateCheck, so it never needs to pass through here.
import { runUpdateCheck, setUpdateChecksEnabled, updateChecksEnabled } from "../updateCheck";
import type { HostAdapter } from "./host";

/** A shaper choice complete enough to reproduce with M593 - the id (name/freq) plus the damping
 *  ratio the fit was actually built with (see ShaperFit.dampingRatio for why that has to travel
 *  with it, not just score against it). */
export interface AppliedShaper { name: ShaperName; freq: number; dampingRatio: number }

export function useResonanceLab(host: HostAdapter) {

	// The on-load update check runs once from index.ts at plugin-load time (not here), so it still
	// happens for an embeddable-summary-panel-only install that never opens this page.
	const reload = () => window.location.reload();


	const aboutOpen = ref(false);
	const autoCheck = ref(updateChecksEnabled());
	const aboutDescription = "Measures and tunes printer resonance / input shaping from accelerometer captures.";
	function onCheckUpdate(): void { void runUpdateCheck({ force: true, notify: true }); }
	function onToggleAutoCheck(v: boolean): void { autoCheck.value = v; setUpdateChecksEnabled(v); }

	// ── Plugin-wide settings (program-file folder) ──────────────────────────────
	const settingsOpen = ref(false);
	const LS_PROGRAM_DIR = "resonanceLab.programDir";
	function loadProgramDir(): string {
		try {
			return localStorage.getItem(LS_PROGRAM_DIR) || DEFAULT_PROGRAM_DIR;
		} catch {
			return DEFAULT_PROGRAM_DIR;
		}
	}
	const programDir = ref(loadProgramDir());
	/** The folder actually used for uploads - falls back to the default if the field is blank/whitespace. */
	const effectiveProgramDir = computed(() => programDir.value.trim() || DEFAULT_PROGRAM_DIR);
	watch(programDir, (v) => {
		try {
			localStorage.setItem(LS_PROGRAM_DIR, v);
		} catch {
			// storage disabled - not fatal, just won't persist across sessions
		}
	});
	const t = (k: string, args?: Record<string, unknown>) => host.t(k, args);

	const isConnected = computed(() => host.isConnected());
	const running = measurementRunning;
	const result = lastResult;
	const error = ref("");
	const applying = ref(false);
	const filePicker = ref<HTMLInputElement | null>(null);
	const helpDialog = ref(false);
	const helpSections = ["spectrum", "spectrogram", "belts", "profile"] as const;
	/** Which belt is currently recording, so the progress alert can name it. */
	const beltPhase = ref<"A" | "B" | null>(null);
	/** True while belt A's own recording is also establishing the real motion timing (first run at these parameters - see the belts branch of measure()). */
	const beltEstablishingTiming = ref(false);

	// ── Controls ─────────────────────────────────────────────────────────────────
	const accelItems = computed(() => findAccelerometers(host.model()));
	const selectedAccel = ref<AccelerometerRef | null>(null);
	/**
	 * True once the user has manually picked an accelerometer this session - stops the tool-follow
	 * auto-select below from overriding a deliberate choice (e.g. reviewing a different tool's data
	 * without wanting to re-measure it). Cleared when the previously-selected accelerometer vanishes
	 * from the list (disconnect/reconfigure), since re-following the mounted tool is the right
	 * default again at that point, not sticking with a pick that no longer exists.
	 */
	const userPickedAccel = ref(false);
	/** The id `autoSelectAccel` itself last set, so the watcher below can tell "I did this" from
	 *  "the user changed the picker" without the template needing to call a different setter. */
	let lastAutoAccelId: string | null = null;

	function currentToolNumber(): number {
		return (host.model() as { state?: { currentTool?: number } }).state?.currentTool ?? -1;
	}

	/** Select the mounted tool's own accelerometer when one resolves; otherwise fall back to the
	 *  first configured accelerometer (matches this plugin's pre-tool-changer behaviour exactly on a
	 *  machine where no accelerometer is tied to any tool at all). */
	function autoSelectAccel(): void {
		const next = accelForTool(accelItems.value, currentToolNumber()) ?? accelItems.value[0] ?? null;
		lastAutoAccelId = next?.id ?? null;
		selectedAccel.value = next;
	}

	// Keep a real accelerometer selected, following the machine's active tool on a tool-changer -
	// unless the user has manually overridden it this session (see userPickedAccel above).
	watch(accelItems, (items) => {
		if (items.length === 0) {
			selectedAccel.value = null;
			lastAutoAccelId = null;
			return;
		}
		if (selectedAccel.value && !items.some((i) => i.id === selectedAccel.value!.id)) {
			userPickedAccel.value = false; // the picked one vanished - re-follow the mounted tool
		}
		if (!selectedAccel.value || !userPickedAccel.value) {
			autoSelectAccel();
		}
	}, { immediate: true });

	// A tool change on the physical machine should follow through to the picker too, same as the
	// list-shape watcher above - both call the same selector so they can't disagree.
	watch(currentToolNumber, () => {
		if (!userPickedAccel.value) {
			autoSelectAccel();
		}
	});

	// Distinguish a template-driven pick (the v-select's v-model) from our own autoSelectAccel calls
	// by comparing against what autoSelectAccel itself last set - and keep the per-tool session store
	// (../state.ts) following whichever accelerometer/tool is actually selected, since that's what
	// the embeddable summary panel and every result view read from.
	watch(selectedAccel, (v) => {
		if (v && v.id !== lastAutoAccelId) {
			userPickedAccel.value = true;
		}
		activeTool.value = v?.toolNumber ?? -1;
	}, { immediate: true });

	const axisItems = computed(() => {
		const axes = (host.model() as { move?: { axes?: Array<{ letter?: string; visible?: boolean }> } }).move?.axes ?? [];
		const letters = axes.filter((a) => a.visible !== false && a.letter).map((a) => a.letter!);
		return letters.length > 0 ? letters : ["X", "Y"];
	});
	// selectedAxis / selectedAxes / method live in ./state so the chosen task + axes (and the matching
	// result) persist across leaving the page. Calibration can sweep several axes and overlay them.
	type Method = CaptureMethod;

	const LS_Z_HEIGHT = "resonanceLab.zHeight";
	function loadZHeight(): number | null {
		try {
			const raw = localStorage.getItem(LS_Z_HEIGHT);
			if (raw === null) {
				return null;
			}
			const v = Number(raw);
			return Number.isNaN(v) ? null : v;
		} catch {
			return null;
		}
	}

	const adv = ref({
		startFreq: 5, endFreq: 135, hzPerSec: 1,
		beltStart: 15, beltEnd: 95, beltHz: 2,
		exciteFreq: 40, exciteSeconds: 10,
		speedMin: 30, speedMax: 180, speedStep: 30,
		customMoves: "",
		/** Move to this Z (mm) before measuring; null = leave Z at whatever it currently is. */
		zHeight: loadZHeight() as number | null,
	});

	watch(() => adv.value.zHeight, (v) => {
		try {
			if (typeof v === "number" && !Number.isNaN(v)) {
				localStorage.setItem(LS_Z_HEIGHT, String(v));
			} else {
				localStorage.removeItem(LS_Z_HEIGHT);
			}
		} catch {
			// storage disabled - not fatal, just won't persist across sessions
		}
	});

	// Each task is a self-contained job: its icon, whether it uses a single axis, and exactly which
	// parameters it exposes. The panel renders only these, so no irrelevant knob is ever shown.
	interface TaskDef { id: Method; group: "goal" | "diag"; icon: string; usesAxis: boolean; params: Array<string> }
	const TASKS: ReadonlyArray<TaskDef> = [
		{ id: "sweep", group: "goal", icon: "mdi-tune-variant", usesAxis: true, params: ["startFreq", "endFreq", "hzPerSec"] },
		{ id: "belts", group: "goal", icon: "mdi-scale-balance", usesAxis: false, params: ["beltStart", "beltEnd", "beltHz"] },
		{ id: "profile", group: "goal", icon: "mdi-speedometer", usesAxis: true, params: ["speedMin", "speedMax", "speedStep"] },
		{ id: "axescheck", group: "goal", icon: "mdi-axis-arrow", usesAxis: false, params: [] },
		{ id: "excite", group: "diag", icon: "mdi-pulse", usesAxis: true, params: ["exciteFreq", "exciteSeconds"] },
		{ id: "move", group: "diag", icon: "mdi-arrow-left-right", usesAxis: true, params: [] },
		{ id: "custom", group: "diag", icon: "mdi-code-braces", usesAxis: true, params: ["customMoves"] },
	];
	const goalTasks = computed(() => TASKS.filter((td) => td.group === "goal"));
	const diagTasks = computed(() => TASKS.filter((td) => td.group === "diag"));
	const activeTask = computed(() => TASKS.find((td) => td.id === method.value) ?? TASKS[0]);
	const taskAxisNote = computed(() => (activeTask.value.usesAxis ? "" : t(`tasks.${method.value}.axisNote`)));

	function selectTask(id: Method): void {
		if (running.value) {
			return;
		}
		method.value = id;
		// A fresh task starts clean — drop the previous run's verdict and chart.
		lastResult.value = null;
		beltResult.value = null;
		profileResult.value = null;
		orientationResult.value = null;
		verifyResult.value = null;
		multiResults.value = [];
		combinedRec.value = null;
		error.value = "";
	}

	/** Rough wall-clock estimate for the active task, derived from its live parameters. */
	const durationEstimate = computed(() => {
		const a = adv.value;
		let secs: number;
		switch (method.value) {
			case "sweep": secs = ((a.endFreq - a.startFreq) / Math.max(0.1, a.hzPerSec) + 6) * Math.max(1, selectedAxes.value.length); break;
			case "belts": {
				// Always exactly 2 physical sweeps now (belt A self-times its own recording instead of a
				// separate probe move - see the belts branch of measure()). On a cold cache, belt A may
				// run a little longer than this estimate while it establishes the real motion time.
				const perBelt = (a.beltEnd - a.beltStart) / Math.max(0.1, a.beltHz) + 8;
				secs = 2 * perBelt;
				break;
			}
			case "profile": {
				let s = 0;
				for (let v = a.speedMin; v <= a.speedMax; v += Math.max(1, a.speedStep)) {
					s += 240 / Math.max(1, v) + 4;
				}
				secs = s;
				break;
			}
			case "excite": secs = a.exciteSeconds + 4; break;
			case "axescheck": secs = 10; break;
			default: secs = 6; break;
		}
		const rounded = Math.max(2, Math.round(secs));
		return rounded >= 90 ? `~${Math.round(rounded / 60)} min` : `~${rounded}s`;
	});

	const canMeasure = computed(() => isConnected.value && !running.value && !loadingCapture.value
		&& (selectedAccel.value !== null || accelItems.value.length > 0)
		&& (method.value !== "sweep" || selectedAxes.value.length > 0));

	// ── Measurement ──────────────────────────────────────────────────────────────
	/**
	 * The firmware's completed-sampling-run counter for an accelerometer
	 * (`boards[].accelerometer.runs`). Ticks the instant the CSV is closed — the authoritative
	 * "recording done" signal. Accel ids are "<canAddress>.0" (CAN boards) or "0" (mainboard).
	 */
	function readAccelRuns(accelId: string): number {
		const boardId = parseInt(accelId, 10) || 0;
		const boards = (host.model() as { boards?: Array<{ canAddress?: number | null; accelerometer?: { runs?: number } | null } | null> }).boards ?? [];
		const board = boards.find((b) => b && b.accelerometer && (b.canAddress ?? 0) === boardId);
		return board?.accelerometer?.runs ?? 0;
	}

	/** Resolve when the run counter rises above `from` (watched on the object model); reject on timeout. */
	function awaitAccelRun(accelId: string, from: number, timeoutMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			// May have already ticked between arming and now — don't miss the edge.
			if (readAccelRuns(accelId) > from) {
				resolve();
				return;
			}
			const stop = watch(() => readAccelRuns(accelId), (now) => {
				if (now > from) {
					cleanup();
					resolve();
				}
			});
			const timer = setTimeout(() => { cleanup(); reject(new Error(t("captureTimeout"))); }, timeoutMs);
			function cleanup(): void { stop(); clearTimeout(timer); }
		});
	}

	/** Machine motion status from the object model (e.g. "idle", "busy", "processing", "paused"). */
	function machineStatus(): string {
		return String((host.model() as { state?: { status?: string } }).state?.status ?? "");
	}

	/** Resolve once motion has stopped (status idle/paused/halted). Resolves on timeout — never blocks the run. */
	function awaitMotionIdle(timeoutMs: number): Promise<void> {
		const stopped = () => ["idle", "off", "halted", "paused", "pausing", "cancelling"].includes(machineStatus());
		return new Promise((resolve) => {
			if (stopped()) {
				resolve();
				return;
			}
			const stop = watch(machineStatus, () => { if (stopped()) { cleanup(); resolve(); } });
			const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
			function cleanup(): void { stop(); clearTimeout(timer); }
		});
	}

	/** Resolve once motion has actually started (status left the idle set); reject after `timeoutMs`. */
	function awaitMotionBusy(timeoutMs: number): Promise<void> {
		const busy = () => !["idle", "off", "halted", "paused", "pausing", "cancelling"].includes(machineStatus());
		return new Promise((resolve, reject) => {
			if (busy()) {
				resolve();
				return;
			}
			const stop = watch(machineStatus, () => { if (busy()) { cleanup(); resolve(); } });
			const timer = setTimeout(() => { cleanup(); reject(new Error("motion never started")); }, timeoutMs);
			function cleanup(): void { stop(); clearTimeout(timer); }
		});
	}

	const io: MachineIO = {
		sendCode: async (code) => await host.sendCode(code),
		upload: async (path, content) => { await host.upload(path, content); },
		download: async (path) => await host.download(path),
		accelRuns: (accelId) => readAccelRuns(accelId),
		awaitAccelRun: (accelId, from, timeoutMs) => awaitAccelRun(accelId, from, timeoutMs),
		awaitIdle: (timeoutMs) => awaitMotionIdle(timeoutMs),
		awaitBusy: (timeoutMs) => awaitMotionBusy(timeoutMs),
		delete: async (path) => { await host.delete(path); },
		makeDirectory: async (path) => { await host.makeDirectory(path); },
	};

	/** Centre of the selected axis's travel, from the object model (fallback: current position). */
	function axisCenter(): number {
		const axes = (host.model() as { move?: { axes?: Array<{ letter?: string; min?: number; max?: number; userPosition?: number | null }> } }).move?.axes ?? [];
		const ax = axes.find((a) => a.letter === selectedAxis.value);
		if (ax && typeof ax.min === "number" && typeof ax.max === "number" && ax.max > ax.min) {
			return Math.round((ax.min + ax.max) / 2);
		}
		return ax?.userPosition ?? 0;
	}

	/** Centre of an arbitrary axis's travel (for the dual-axis belt test). */
	function centerOf(letter: string): number {
		const axes = (host.model() as { move?: { axes?: Array<{ letter?: string; min?: number; max?: number }> } }).move?.axes ?? [];
		const ax = axes.find((a) => a.letter === letter);
		return ax && typeof ax.min === "number" && typeof ax.max === "number" && ax.max > ax.min
			? Math.round((ax.min + ax.max) / 2) : 0;
	}

	/**
	 * The axis's own configured motion limits (M201 acceleration, M203 speed), so test excitation
	 * scales with what the machine can actually do instead of a fixed, conservative default - and so
	 * the "quick test move" and every other native move runs at the printer's real cruising speed.
	 * Falls back to the previous hardcoded defaults if the object model doesn't have the axis yet.
	 */
	function axisLimits(letter: string): { maxAccel: number; maxFeedrate: number } {
		const axes = (host.model() as { move?: { axes?: Array<{ letter?: string; acceleration?: number; speed?: number }> } }).move?.axes ?? [];
		const ax = axes.find((a) => a.letter === letter);
		return {
			maxAccel: ax?.acceleration && ax.acceleration > 0 ? ax.acceleration : 10000,
			maxFeedrate: ax?.speed && ax.speed > 0 ? ax.speed * 60 : 30000, // object model speed is mm/s; G-code F is mm/min
		};
	}

	/** The machine's currently-configured shaper (M593), read straight off the object model - RRF
	 * exposes move.shaping.{type,frequency,damping} directly, no G-code reply parsing needed. */
	function currentShaperState(): ShaperState {
		const s = (host.model() as { move?: { shaping?: { type?: string; frequency?: number; damping?: number } } }).move?.shaping;
		return { type: s?.type ?? "none", frequency: s?.frequency ?? 0, damping: s?.damping ?? 0 };
	}

	/**
	 * Run `fn` with input shaping disabled, restoring whatever was actually configured beforehand once
	 * it's done (even on failure/cancellation) - M593 is a persistent override, so leaving it disabled
	 * after a "quick test move" or vibration profile would silently leave the machine printing
	 * unshaped until the user noticed and reapplied one themselves.
	 */
	async function withShaperDisabled<T>(fn: () => Promise<T>): Promise<T> {
		const prev = currentShaperState();
		await io.sendCode('M593 P"none"');
		try {
			return await fn();
		} finally {
			const restore = shaperRestoreGcode(prev);
			if (restore) {
				await io.sendCode(restore);
			}
		}
	}

	/**
	 * Move to the user-set Z height (if any) before measuring. RRF's own M208 soft limits still apply to
	 * a normal G1 move (only G1/G0 H2 bypasses them), so an out-of-range value surfaces as a normal
	 * G-code error from sendCode rather than needing to be pre-validated here.
	 */
	async function moveToZIfSet(): Promise<void> {
		if (typeof adv.value.zHeight === "number" && !Number.isNaN(adv.value.zHeight)) {
			await io.sendCode(`G1 Z${adv.value.zHeight} F600 M400`);
		}
	}

	/**
	 * Axis letters this task's own test motion exercises. A single-axis test's generated program only
	 * ever moves that one axis - so if the OTHER axis started off-centre it would just stay there - and
	 * even the tested axis is only walked toward centre gradually as a side effect of the excitation
	 * oscillation (its first pulse), not moved there directly. "custom" is excluded: the user's own
	 * G-code owns its motion.
	 */
	function axesForMethod(): Array<string> {
		if (method.value === "custom") {
			return [];
		}
		if (method.value === "sweep") {
			return selectedAxes.value.length ? selectedAxes.value : [selectedAxis.value];
		}
		if (method.value === "belts" || method.value === "axescheck") {
			return ["X", "Y"];
		}
		return [selectedAxis.value]; // excite, move, profile
	}

	/** Send every axis this measurement will exercise directly to the centre of its travel before the
	 * test's own motion starts, in one combined move (rather than relying on the test's own excitation
	 * to walk it there, which never happens at all for an axis the test doesn't touch). */
	async function moveToCenters(axes: Array<string>): Promise<void> {
		if (axes.length === 0) {
			return;
		}
		const feed = Math.min(...axes.map((a) => axisLimits(a).maxFeedrate));
		const parts = axes.map((a) => `${a}${centerOf(a)}`).join(" ");
		await io.sendCode(`G1 ${parts} F${feed} M400`);
	}

	// ── Cancel a running measurement ─────────────────────────────────────────────
	// RRF has no way to interrupt an in-progress M98 macro from the same G-code channel other than a
	// full M112 emergency stop (which also disables heaters/drives - checked against the firmware
	// source, see CLAUDE.md), so this can't stop the machine's CURRENT motion. What it CAN do: give up
	// waiting immediately and stop the measurement from starting any FURTHER step (the next axis, the
	// next belt, ...), since the abandoned promise is simply never awaited again once this rejects.
	class MeasurementCancelledError extends Error {
		constructor() { super("Measurement cancelled"); this.name = "MeasurementCancelledError"; }
	}
	const cancelRequested = ref(false);

	function raceCancellable<T>(promise: Promise<T>): Promise<T> {
		if (cancelRequested.value) {
			return Promise.reject(new MeasurementCancelledError());
		}
		return new Promise<T>((resolve, reject) => {
			const stop = watch(cancelRequested, (v) => {
				if (v) {
					stop();
					reject(new MeasurementCancelledError());
				}
			});
			promise.then(
				(v) => { stop(); resolve(v); },
				(e) => { stop(); reject(e); },
			);
		});
	}

	/**
	 * The real belt motion time only depends on the sweep parameters and travel centres, so a repeat
	 * belt test with the same settings can reuse a previous measurement instead of re-probing (RRF has
	 * no way to stop an in-progress M956 recording early - see PLAN.md's B4 finding - so avoiding the
	 * probe run entirely isn't possible; caching it for repeat runs is the next best thing).
	 */
	function beltMotionCacheKey(startFreq: number, endFreq: number, hzPerSec: number, centerX: number, centerY: number): string {
		return `resonanceLab.beltMotionSec.${startFreq}-${endFreq}-${hzPerSec}-${centerX}-${centerY}`;
	}
	function readCachedBeltMotionSec(key: string): number | undefined {
		try {
			const n = parseFloat(window.localStorage.getItem(key) ?? "");
			return n > 0 ? n : undefined;
		} catch {
			return undefined; // storage disabled - just means this run re-probes
		}
	}
	function writeCachedBeltMotionSec(key: string, sec: number): void {
		try {
			window.localStorage.setItem(key, sec.toFixed(2));
		} catch {
			// storage disabled - not fatal, next run just re-probes too
		}
	}

	/** Read the accelerometer's currently-configured M955 orientation from its report (default 20 = identity). */
	async function readAccelOrientation(accelId: string): Promise<number> {
		try {
			const reply = await io.sendCode(`M955 P${accelId}`);
			const m = /orientation[:\s]+(\d+)/i.exec(reply);
			return m ? parseInt(m[1], 10) : 20;
		} catch {
			return 20;
		}
	}

	/**
	 * Read the accelerometer's real sample rate (Hz) from its M955 report. The recorder is armed for a
	 * fixed sample COUNT, so this must match reality: assume too high and M956 keeps sampling long after
	 * the motion ends (machine idle while the recording finishes — the 20-30s belt-test stall). Default
	 * 1000 if the report can't be parsed.
	 */
	async function readAccelRate(accelId: string): Promise<number> {
		try {
			const reply = await io.sendCode(`M955 P${accelId}`);
			const rate = parseAccelRateFromReport(reply);
			return rate >= 100 && rate <= 20000 ? rate : 1000;
		} catch {
			return 1000;
		}
	}

	// Custom G-code (the "custom" method) runs whatever the user typed verbatim, unlike every other
	// task's fixed, reviewed move profile - so it gets a review step first. Skippable per-session (not
	// persisted) once the user has seen it, so a repeated re-run of the same profile isn't nagged.
	const confirmGcodeOpen = ref(false);
	const skipGcodeConfirm = ref(false);

	function onMeasureClick(): void {
		if (method.value === "custom" && adv.value.customMoves.trim() && !skipGcodeConfirm.value) {
			confirmGcodeOpen.value = true;
			return;
		}
		void measure();
	}

	async function measure(): Promise<void> {
		const accel = selectedAccel.value ?? accelItems.value[0];
		if (!accel) {
			return;
		}
		// Guard: every visible axis must be homed before we shake the machine.
		const axesModel = (host.model() as { move?: { axes?: Array<{ visible?: boolean; homed?: boolean }> } }).move?.axes ?? [];
		if (axesModel.some((a) => a.visible !== false && a.homed === false)) {
			error.value = t("notHomed");
			return;
		}
		cancelRequested.value = false;
		running.value = true;
		error.value = "";
		beltResult.value = null;
		profileResult.value = null;
		orientationResult.value = null;
		verifyResult.value = null;
		multiVerifyResult.value = null;
		multiResults.value = [];
		combinedRec.value = null;
		try {
			if (method.value === "belts" && !String((host.model() as { move?: { kinematics?: { name?: string } } }).move?.kinematics?.name ?? "").toLowerCase().includes("core")) {
				error.value = t("belts.notCoreXY");
				running.value = false;
				return;
			}
			if (method.value !== "axescheck") {
				await moveToZIfSet();
			}
			await moveToCenters(axesForMethod());
			// Size every recording to the accelerometer's real rate (not an assumed 1000 Hz), so M956
			// stops near the end of the motion instead of over-sampling into idle time.
			const sampleRate = await readAccelRate(accel.id);
			if (method.value === "excite") {
				const run = await raceCancellable(runFixedExcitation(io, {
					accelerometer: accel, axis: selectedAxis.value, center: axisCenter(),
					freq: adv.value.exciteFreq, seconds: adv.value.exciteSeconds, expectedSampleRate: sampleRate,
					programDir: effectiveProgramDir.value, ...axisLimits(selectedAxis.value),
					restoreShaper: currentShaperState(),
				}));
				finish(parse(await raceCancellable(downloadCapture(io, run))), `${selectedAxis.value} · ${adv.value.exciteFreq} Hz`);
			} else if (method.value === "axescheck") {
				// Measure the RAW mounting. Any orientation already configured in M955 makes the chip report
				// machine-aligned axes, so without this we'd solve a correction on top of the existing one —
				// e.g. re-running after applying I06 would read "already correct" and suggest the wrong value.
				// Neutralise to identity (I20) for the test, then restore whatever was configured.
				const prevOrientation = await readAccelOrientation(accel.id);
				await io.sendCode(`M955 P${accel.id} I20`);
				try {
					// One sharp move per horizontal axis; gravity (pre-motion DC) pins the vertical.
					const moveResults: Partial<Record<"X" | "Y", ReturnType<typeof analyzeAxisBurst>>> = {};
					let firstCapture: ReturnType<typeof parseAccelCsv> | null = null;
					for (const ax of ["X", "Y"] as const) {
						const run = await raceCancellable(runNativeCapture(io, { accelerometer: accel, axis: ax, center: centerOf(ax), span: 20 }));
						const capture = parseAccelCsv(await raceCancellable(downloadCapture(io, run)));
						firstCapture = firstCapture ?? capture;
						moveResults[ax] = analyzeAxisBurst(capture);
					}
					const gravity = detectVerticalAxis(firstCapture!, moveResults.X!.dc);
					orientationResult.value = { solution: solveOrientation(moveResults, gravity), accelId: accel.id, coupling: Math.max(moveResults.X!.coupling, moveResults.Y!.coupling) };
					lastResult.value = null;
				} finally {
					await io.sendCode(`M955 P${accel.id} I${prevOrientation}`);
				}
			} else if (method.value === "belts") {
				// Tension matching only needs the band the belt resonances live in — a light 15–95 Hz
				// sweep at 2 Hz/s (~40s per belt), not the full calibration band. Defaults are belt-specific.
				const centerX = centerOf("X");
				const centerY = centerOf("Y");
				const limX = axisLimits("X");
				const limY = axisLimits("Y");
				const opts = {
					accelerometer: accel, centerX, centerY,
					startFreq: adv.value.beltStart, endFreq: adv.value.beltEnd, hzPerSec: adv.value.beltHz,
					expectedSampleRate: sampleRate, programDir: effectiveProgramDir.value,
					// Both axes move at once on a diagonal - use whichever is more restrictive.
					maxAccel: Math.min(limX.maxAccel, limY.maxAccel), maxFeedrate: Math.min(limX.maxFeedrate, limY.maxFeedrate),
					restoreShaper: currentShaperState(),
				};
				// The CoreXY diagonal sweep finishes well before its kinematic estimate, so a count-based
				// recording over-samples into idle time if it doesn't know the real duration in advance.
				// RRF has no way to stop an in-progress M956 recording early (see the audit notes on
				// this), so rather than a separate throwaway probe move (which used to run belt A's exact
				// profile twice in a row), belt A's own recording self-times the real motion — see
				// runBeltCapture's self-sizing mode. A cached measurement from a previous run at these
				// exact parameters skips that entirely and sizes both belts precisely up front.
				const cacheKey = beltMotionCacheKey(opts.startFreq, opts.endFreq, opts.hzPerSec, centerX, centerY);
				const cachedMotionSec = readCachedBeltMotionSec(cacheKey);
				let motionSec = cachedMotionSec ?? 0;

				beltPhase.value = "A";
				let a: ReturnType<typeof parseAccelCsv>;
				if (cachedMotionSec !== undefined) {
					const samplesA = Math.min(200000, Math.ceil((cachedMotionSec + 1.5) * sampleRate));
					const runA = await raceCancellable(runBeltCapture(io, { ...opts, belt: "a", samples: samplesA }));
					a = parseAccelCsv(await raceCancellable(downloadCapture(io, runA)));
				} else {
					beltEstablishingTiming.value = true;
					const runA = await raceCancellable(runBeltCapture(io, { ...opts, belt: "a" }));
					const rawA = parseAccelCsv(await raceCancellable(downloadCapture(io, runA)));
					beltEstablishingTiming.value = false;
					if (runA.motionSec && runA.motionSec > 0) {
						motionSec = runA.motionSec;
						writeCachedBeltMotionSec(cacheKey, motionSec);
						a = cropCaptureToDuration(rawA, motionSec + 1.5);
					} else {
						// Timing signals weren't available - keep the full (oversized) capture uncropped
						// and don't cache anything, so the next run tries again.
						a = rawA;
					}
				}
				console.info("[ResonanceLab] belt A capture", {
					kinematicDurationSec: beltEstimatedDurationSec({ ...opts, belt: "a" }), motionSec,
					samplingRate: a.samplingRate, sampleCount: a.channels[0]?.length ?? 0,
				});

				// Size belt B precisely from the known motion time (falling back to self-sizing too if it
				// isn't known at all). If the firmware's real rate differs from the M955-parsed sizing
				// rate, resize using belt A's ACTUAL trailer rate instead of repeating the same over/under-record.
				const samplesB = motionSec > 0
					? resizeForActualRate(Math.min(200000, Math.ceil((motionSec + 1.5) * sampleRate)), motionSec, sampleRate, a.samplingRate)
					: undefined;

				beltPhase.value = "B";
				const runB = await raceCancellable(runBeltCapture(io, { ...opts, belt: "b", samples: samplesB }));
				const b = parseAccelCsv(await raceCancellable(downloadCapture(io, runB)));
				console.info("[ResonanceLab] belt B capture", { samplingRate: b.samplingRate, sampleCount: b.channels[0]?.length ?? 0 });

				beltPhase.value = null;
				lastResult.value = null;
				// Analyse (and chart) only the swept band, with a little margin either side.
				beltResult.value = compareBelts(a, b, adv.value.beltEnd + 10, Math.max(0, adv.value.beltStart - 5));
			} else if (method.value === "profile") {
				const entries: Array<{ speed: number; capture: ReturnType<typeof parseAccelCsv> }> = [];
				await withShaperDisabled(async () => {
					for (let speed = adv.value.speedMin; speed <= adv.value.speedMax; speed += Math.max(1, adv.value.speedStep)) {
						const run = await raceCancellable(runSpeedPointCapture(io, { accelerometer: accel, axis: selectedAxis.value, center: axisCenter(), speed, expectedSampleRate: sampleRate }));
						entries.push({ speed, capture: parseAccelCsv(await raceCancellable(downloadCapture(io, run))) });
					}
				});
				lastResult.value = null;
				profileResult.value = buildVibrationProfile(entries);
			} else if (method.value === "sweep") {
				// Sweep each selected axis in turn. One axis → the rich single-axis verdict; several →
				// overlay them and list a per-axis suggestion (RRF applies one shaper machine-wide).
				const axes = selectedAxes.value.length ? selectedAxes.value : [selectedAxis.value];
				const restoreShaper = currentShaperState();
				const collected: Array<{ axis: string } & ReturnType<typeof parse>> = [];
				for (const ax of axes) {
					const run = await raceCancellable(runSweepCapture(io, {
						accelerometer: accel, axis: ax, center: centerOf(ax),
						startFreq: adv.value.startFreq, endFreq: adv.value.endFreq, hzPerSec: adv.value.hzPerSec,
						expectedSampleRate: sampleRate, programDir: effectiveProgramDir.value, ...axisLimits(ax),
						restoreShaper,
					}));
					collected.push({ axis: ax, ...parse(await raceCancellable(downloadCapture(io, run)), { minFreq: adv.value.startFreq, maxFreq: adv.value.endFreq }) });
				}
				if (collected.length === 1) {
					selectedAxis.value = collected[0].axis;
					finish(collected[0], `${collected[0].axis} · ${t("methods.sweep")}`);
				} else {
					lastResult.value = null;
					multiResults.value = collected.map((c) => ({ axis: c.axis, analysis: c.analysis, capture: c.capture }));
					combinedRec.value = computeCombinedRec(multiResults.value);
				}
			} else {
				const doCapture = () => raceCancellable(runNativeCapture(io, {
					accelerometer: accel, axis: selectedAxis.value, center: axisCenter(),
					feedrate: axisLimits(selectedAxis.value).maxFeedrate,
					customMoves: method.value === "custom" && adv.value.customMoves.trim()
						? adv.value.customMoves.split("\n").map((l) => l.trim()).filter(Boolean)
						: undefined,
				}));
				// "custom" runs the user's own G-code verbatim - it owns shaper state, same as axescheck
				// (which isn't measuring resonance at all). Only "move" gets the automatic disable/restore.
				const run = method.value === "custom" ? await doCapture() : await withShaperDisabled(doCapture);
				const csv = await raceCancellable(downloadCapture(io, run));
				finish(parse(csv), `${selectedAxis.value} · ${t(`methods.${method.value}`)}`);
			}
		} catch (e) {
			if (e instanceof MeasurementCancelledError) {
				host.notify("warning", t("cancel.title"), t("cancel.notification"));
			} else {
				error.value = (e as Error).message || String(e);
			}
		} finally {
			running.value = false;
			cancelRequested.value = false;
			beltPhase.value = null;
			beltEstablishingTiming.value = false;
		}
	}

	// ── Verify loop & orientation ────────────────────────────────────────────────
	// orientationResult + multiResults live in ./state so results persist across leaving the page.
	const verifyResult = ref<{
		reduction: number;
		before: { labels: Array<number>; data: Array<number> };
		after: Array<number>;
		/** Which shaper/frequency the "after" recording actually ran with - snapshotted at capture time
		 * so it stays correct even if the user applies a different shaper afterward. */
		shaper: AppliedShaper;
	} | null>(null);
	const appliedFit = ref<AppliedShaper | null>(null);
	const multiVerifyResult = ref<{
		shaper: AppliedShaper;
		perAxis: Array<{ axis: string; reduction: number; labels: Array<number>; beforeData: Array<number>; afterData: Array<number> }>;
	} | null>(null);

	/**
	 * Re-sweep one axis with the shaper ACTIVE (`keepShaper`) and compare energy against `before`'s
	 * already-measured (no-shaper) spectrum, restricted to the same band the original recommendation
	 * was scored on. Shared by the single-axis Verify and the multi-axis "verify all" below.
	 */
	async function verifyAxis(
		accel: { id: string; label: string }, before: { axis: string; analysis: CaptureAnalysis }, sampleRate: number,
	): Promise<{ reduction: number; labels: Array<number>; beforeData: Array<number>; afterData: Array<number> }> {
		const minFreq = adv.value.startFreq;
		const maxFreq = adv.value.endFreq;
		const run = await raceCancellable(runSweepCapture(io, {
			accelerometer: accel, axis: before.axis, center: centerOf(before.axis),
			startFreq: adv.value.startFreq, endFreq: adv.value.endFreq, hzPerSec: adv.value.hzPerSec,
			keepShaper: true, expectedSampleRate: sampleRate, programDir: effectiveProgramDir.value,
			...axisLimits(before.axis),
		}));
		const after = analyseCapture(parseAccelCsv(await raceCancellable(downloadCapture(io, run))), { minFreq, maxFreq });
		const labels: Array<number> = [];
		const beforeData: Array<number> = [];
		const afterData: Array<number> = [];
		let eBefore = 0;
		let eAfter = 0;
		for (let i = 0; i < before.analysis.spectrum.freqs.length; i++) {
			const f = before.analysis.spectrum.freqs[i];
			if (f < minFreq) {
				continue;
			}
			if (f > maxFreq) {
				break;
			}
			eBefore += before.analysis.normalized[i];
			eAfter += after.normalized[i] ?? 0;
			labels.push(Math.round(f * 10) / 10);
			beforeData.push(before.analysis.normalized[i]);
			afterData.push(after.normalized[i] ?? 0);
		}
		return { reduction: eBefore > 0 ? 1 - eAfter / eBefore : 0, labels, beforeData, afterData };
	}

	/** Re-run the same sweep with the shaper ACTIVE and compare energy before/after. */
	async function verify(): Promise<void> {
		const accel = selectedAccel.value ?? accelItems.value[0];
		const before = result.value;
		const shaper = appliedFit.value;
		if (!accel || !before || !shaper) {
			return;
		}
		cancelRequested.value = false;
		running.value = true;
		error.value = "";
		try {
			await moveToZIfSet();
			await moveToCenters([before.axis]);
			const sampleRate = await readAccelRate(accel.id);
			const { reduction, labels, beforeData, afterData } = await verifyAxis(accel, before, sampleRate);
			verifyResult.value = { reduction, before: { labels, data: beforeData }, after: afterData, shaper };
		} catch (e) {
			if (e instanceof MeasurementCancelledError) {
				host.notify("warning", t("cancel.title"), t("cancel.notification"));
			} else {
				error.value = (e as Error).message || String(e);
			}
		} finally {
			running.value = false;
			cancelRequested.value = false;
		}
	}

	/**
	 * Re-sweep every axis from the original multi-axis run with the shaper ACTIVE and report each
	 * axis's own reduction - the single-axis Verify only ever covers whichever axis you're inspecting,
	 * this covers the whole set that was originally selected in one go.
	 */
	async function verifyMulti(): Promise<void> {
		const accel = selectedAccel.value ?? accelItems.value[0];
		const shaper = appliedFit.value;
		if (!accel || !shaper || multiResults.value.length === 0) {
			return;
		}
		cancelRequested.value = false;
		running.value = true;
		error.value = "";
		try {
			await moveToZIfSet();
			const axes = multiResults.value.map((r) => r.axis);
			await moveToCenters(axes);
			const sampleRate = await readAccelRate(accel.id);
			const perAxis: Array<{ axis: string; reduction: number; labels: Array<number>; beforeData: Array<number>; afterData: Array<number> }> = [];
			for (const before of multiResults.value) {
				const { reduction, labels, beforeData, afterData } = await verifyAxis(accel, before, sampleRate);
				perAxis.push({ axis: before.axis, reduction, labels, beforeData, afterData });
			}
			multiVerifyResult.value = { shaper, perAxis };
		} catch (e) {
			if (e instanceof MeasurementCancelledError) {
				host.notify("warning", t("cancel.title"), t("cancel.notification"));
			} else {
				error.value = (e as Error).message || String(e);
			}
		} finally {
			running.value = false;
			cancelRequested.value = false;
		}
	}
	// ── Belt / profile presentation ──────────────────────────────────────────────
	const beltChart = computed(() => {
		const r = beltResult.value;
		if (!r) {
			return null;
		}
		return {
			labels: Array.from(r.freqs).map((f) => Math.round(f * 10) / 10),
			series: [
				{ label: t("belts.beltA"), data: Array.from(r.psdA), color: "#2196f3" },
				{ label: t("belts.beltB"), data: Array.from(r.psdB), color: "#ff9800" },
			],
		};
	});
	const beltVerdict = computed(() => {
		const r = beltResult.value;
		if (!r) {
			return null;
		}
		const sim = (r.similarity * 100).toFixed(0);
		if (r.verdict === "matched") {
			return { color: "success", icon: "mdi-check-decagram", headline: t("belts.matched", { sim }), detail: t("belts.matchedDetail", { peakA: r.peakA.toFixed(1), peakB: r.peakB.toFixed(1) }) };
		}
		if (r.verdict === "tension") {
			const louder = r.energyRatio > 1 ? t("belts.beltA") : t("belts.beltB");
			const ratio = (r.energyRatio > 1 ? r.energyRatio : 1 / r.energyRatio).toFixed(2);
			return { color: "warning", icon: "mdi-scale-unbalanced", headline: t("belts.tension", { sim }), detail: t("belts.tensionDetail", { louder, ratio }) };
		}
		return { color: "error", icon: "mdi-alert-octagon-outline", headline: t("belts.mismatch", { sim }), detail: t("belts.mismatchDetail", { peakA: r.peakA.toFixed(1), peakB: r.peakB.toFixed(1) }) };
	});

	const profileChart = computed(() => {
		const p = profileResult.value;
		if (!p) {
			return null;
		}
		return {
			labels: p.points.map((pt) => pt.speed),
			series: [{ label: t("profile.energy"), data: p.points.map((pt) => pt.energy), color: "#2196f3" }],
		};
	});
	const profileVerdict = computed(() => {
		const p = profileResult.value;
		if (!p) {
			return null;
		}
		if (p.problems.length === 0) {
			return { color: "success", icon: "mdi-check-decagram", headline: t("profile.clean"), detail: t("profile.cleanDetail") };
		}
		return {
			color: "warning",
			icon: "mdi-speedometer",
			headline: t("profile.problems", { speeds: p.problems.map((x) => `${x.speed} mm/s`).join(", ") }),
			detail: t("profile.problemsDetail", { quiet: p.quietest.slice(0, 3).map((x) => `${x.speed} mm/s`).join(", ") }),
		};
	});

	// ── Multi-axis calibration overlay ───────────────────────────────────────────
	const AXIS_COLORS: Record<string, string> = { X: "#2196f3", Y: "#ff9800", Z: "#4caf50", U: "#9c27b0", V: "#00bcd4", W: "#e91e63" };
	const multiChart = computed(() => {
		const rs = multiResults.value;
		if (rs.length === 0) {
			return null;
		}
		const minFreq = adv.value.startFreq;
		const maxFreq = adv.value.endFreq;
		// Common x-axis: the longest in-band freq grid across the runs (same rate ⇒ identical bins).
		let labels: Array<number> = [];
		let startIdx = 0;
		for (const r of rs) {
			const freqs = r.analysis.spectrum.freqs;
			const lbl: Array<number> = [];
			let idx0 = -1;
			for (let i = 0; i < freqs.length && freqs[i] <= maxFreq; i++) {
				if (freqs[i] < minFreq) {
					continue;
				}
				if (idx0 === -1) {
					idx0 = i;
				}
				lbl.push(Math.round(freqs[i] * 10) / 10);
			}
			if (lbl.length > labels.length) {
				labels = lbl;
				startIdx = idx0 === -1 ? 0 : idx0;
			}
		}
		return {
			labels,
			series: rs.map((r) => ({
				label: `${r.axis} axis`,
				data: Array.from(r.analysis.normalized).slice(startIdx, startIdx + labels.length),
				color: AXIS_COLORS[r.axis.toUpperCase()] ?? "#888888",
			})),
		};
	});
	/** Before/after overlay for every verified axis - replaces multiChart once verifyMulti has run
	 * (same "measured view swaps for a before/after view" convention as the single-axis Verify). Each
	 * axis keeps its own colour; solid = before, dashed = after, so axes stay distinguishable while
	 * before/after stays a single consistent line style across the whole chart. */
	const multiVerifyChart = computed(() => {
		const mv = multiVerifyResult.value;
		if (!mv) {
			return null;
		}
		let labels: Array<number> = [];
		for (const p of mv.perAxis) {
			if (p.labels.length > labels.length) {
				labels = p.labels;
			}
		}
		const pad = (data: Array<number>) => Array.from({ length: labels.length }, (_, i) => data[i] ?? 0);
		const series: Array<{ label: string; data: Array<number>; color: string; dash?: boolean }> = [];
		for (const p of mv.perAxis) {
			const color = AXIS_COLORS[p.axis.toUpperCase()] ?? "#888888";
			series.push({ label: `${p.axis} before`, data: pad(p.beforeData), color });
			series.push({ label: `${p.axis} after`, data: pad(p.afterData), color, dash: true });
		}
		return { labels, series };
	});
	const multiRows = computed(() => multiResults.value.map((r) => {
		const best = r.analysis.recommendation?.best;
		return {
			axis: r.axis,
			color: AXIS_COLORS[r.axis.toUpperCase()] ?? "#888888",
			peak: r.analysis.peaks[0]?.freq.toFixed(1) ?? "—",
			fit: best ? { name: best.name, display: SHAPER_DISPLAY_NAMES[best.name], freq: best.freq, dampingRatio: best.dampingRatio, reduction: (100 - best.vibrations * 100).toFixed(0) } : null,
		};
	}));

	/**
	 * Combined shaper recommendation across every axis that found a resonance - RRF's M593 shaper
	 * applies machine-wide, so with 2+ axes this is the actual decision, not each axis's own best.
	 * Needs at least two axes with a recommendation; otherwise there's nothing to combine.
	 */
	function computeCombinedRec(entries: Array<MultiAxisResult>): CombinedRecommendationResult | null {
		const withPeaks = entries.filter((e) => e.analysis.recommendation);
		if (withPeaks.length < 2) {
			return null;
		}
		// Feed the strongest measured peak's damping ratio across all axes into the fit - the same guard
		// the single-axis pipeline uses (pipeline.ts).
		let strongest: { power: number; dampingRatio?: number } | undefined;
		for (const e of withPeaks) {
			const p = e.analysis.peaks[0];
			if (p && (!strongest || p.power > strongest.power)) {
				strongest = p;
			}
		}
		const zeta = strongest?.dampingRatio;
		return findBestShaperCombined(
			withPeaks.map((e) => ({ axis: e.axis, freqBins: e.analysis.spectrum.freqs, psd: e.analysis.normalized })),
			{
				dampingRatio: zeta && zeta >= 0.02 && zeta <= 0.3 ? zeta : undefined,
				minFreq: adv.value.startFreq, maxFreq: adv.value.endFreq,
			},
		);
	}

	/** Presentation for the "recommended for all axes" row: display name, per-axis reduction, agreement. */
	const combinedSummary = computed(() => {
		const c = combinedRec.value;
		if (!c) {
			return null;
		}
		const best = c.best;
		const perAxisText = best.perAxis.map((p) => `${p.axis} −${(100 - p.vibrations * 100).toFixed(0)}%`).join(" · ");
		// "All axes agree" when every axis's own independently-chosen best already names this shaper
		// within ~2 Hz - the combined fit is confirming, not trading one axis's resonance off another's.
		const agrees = multiResults.value.every((r) => {
			const ownBest = r.analysis.recommendation?.best;
			return ownBest !== undefined && ownBest.name === best.name && Math.abs(ownBest.freq - best.freq) <= 2;
		});
		return { name: best.name, display: SHAPER_DISPLAY_NAMES[best.name], freq: best.freq, dampingRatio: best.dampingRatio, perAxisText, agrees };
	});

	/** Open one axis of a multi-axis run in the full single-axis view (shaper compare, response, verify). */
	function inspectAxis(axis: string): void {
		const r = multiResults.value.find((m) => m.axis === axis);
		if (!r) {
			return;
		}
		selectedAxis.value = r.axis;
		result.value = { axis: r.axis, when: new Date(), source: t("multi.fromOverlay", { axis: r.axis }), analysis: r.analysis, capture: r.capture };
		overlay.value = r.analysis.recommendation?.best.name ?? "mzv";
		chartMode.value = "spectrum";
		// appliedFit is deliberately left alone: it tracks what's actually active on the machine (RRF's
		// M593 is machine-wide), not which axis is currently in view - clearing it here used to hide the
		// Verify button after applying the combined recommendation from the overlay and then inspecting
		// an axis to look at its graph.
		verifyResult.value = null;
	}

	/** Return from a single-axis inspection to the multi-axis overlay (keeps the overlay loaded). */
	function backToOverlay(): void {
		result.value = null;
		verifyResult.value = null;
	}

	function parse(csvText: string, freqRange?: { minFreq: number; maxFreq: number }) {
		const capture = parseAccelCsv(csvText);
		return {
			capture,
			analysis: analyseCapture(capture, freqRange),
		};
	}

	function finish(parsed: ReturnType<typeof parse>, source: string): void {
		result.value = { axis: selectedAxis.value, when: new Date(), source, analysis: parsed.analysis, capture: parsed.capture };
		overlay.value = parsed.analysis.recommendation?.best.name ?? "mzv";
		chartMode.value = "spectrum";
	}

	// ── Spectrogram view ─────────────────────────────────────────────────────────
	const chartMode = ref<"spectrum" | "spectrogram">("spectrum");
	/** Overlay each raw captured channel (X/Y/Z as recorded) on the spectrum chart, alongside the
	 *  combined curve the recommendation actually runs on - the CSV always carries all axes even though
	 *  only one was deliberately excited, and seeing the others helps spot cross-axis coupling. */
	const showChannels = ref(false);
	const spectrogram = computed(() => {
		const r = result.value;
		if (!r?.capture || chartMode.value !== "spectrogram") {
			return null;
		}
		// Prefer the channel matching the tested axis; fall back to the first.
		const idx = Math.max(0, r.capture.axes.findIndex((a) => a.toUpperCase() === r.axis.toUpperCase()));
		return computeSpectrogram(r.capture.channels[idx], r.capture.samplingRate);
	});

	// ── Remote capture browser (0:/sys/accelerometer) ───────────────────────────
	const CAPTURE_DIR = "0:/sys/accelerometer";
	const captureBrowser = ref(false);
	const selectedFiles = ref<Array<string>>([]);
	/** True while the capture list is being fetched, or a selected capture is being downloaded/parsed. */
	const loadingCapture = ref(false);

	interface RemoteCapture { name: string; kind: string; axis: string; when: Date; size: number }
	const remoteFiles = ref<Array<RemoteCapture>>([]);

	/** Our captures are named rlab-<kind>-<axis>-<YYYYMMDDHHMMSS>.csv; parse that for grouping + labels. */
	function parseCaptureName(name: string, size: number): RemoteCapture {
		const m = /^rlab-(belta|beltb|sweep|move|fix\d+|speed\d+)-([a-z]+)-(\d{14})\.csv$/i.exec(name);
		if (!m) {
			return { name, kind: "other", axis: "", when: new Date(0), size };
		}
		const s = m[3];
		const when = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
		return { name, kind: m[1].toLowerCase(), axis: m[2].toUpperCase(), when, size };
	}

	/** Display label + icon for a capture kind. */
	function captureMeta(kind: string): { label: string; icon: string } {
		if (kind === "belta") { return { label: t("captures.kinds.belta"), icon: "mdi-scale-balance" }; }
		if (kind === "beltb") { return { label: t("captures.kinds.beltb"), icon: "mdi-scale-balance" }; }
		if (kind === "sweep") { return { label: t("captures.kinds.sweep"), icon: "mdi-tune-variant" }; }
		if (kind === "move") { return { label: t("captures.kinds.move"), icon: "mdi-arrow-left-right" }; }
		if (kind.startsWith("fix")) { return { label: t("captures.kinds.excite"), icon: "mdi-pulse" }; }
		if (kind.startsWith("speed")) { return { label: t("captures.kinds.speed"), icon: "mdi-speedometer" }; }
		return { label: t("captures.kinds.other"), icon: "mdi-file-delimited-outline" };
	}

	async function refreshRemoteCaptures(): Promise<void> {
		loadingCapture.value = true;
		try {
			const files = await host.getFileList(CAPTURE_DIR);
			remoteFiles.value = files
				.filter((f) => !f.isDirectory && f.name.toLowerCase().endsWith(".csv"))
				.map((f) => parseCaptureName(f.name, f.size ?? 0))
				.sort((a, b) => b.when.getTime() - a.when.getTime() || a.name.localeCompare(b.name));
			selectedFiles.value = [];
		} catch {
			remoteFiles.value = [];
		} finally {
			loadingCapture.value = false;
		}
	}

	/** Group captures by calendar day for the browser (newest first). */
	const groupedCaptures = computed(() => {
		const groups: Array<{ day: string; items: Array<RemoteCapture> }> = [];
		for (const f of remoteFiles.value) {
			const day = f.when.getTime() === 0 ? t("captures.unknownDay") : f.when.toLocaleDateString();
			let g = groups.find((x) => x.day === day);
			if (!g) {
				g = { day, items: [] };
				groups.push(g);
			}
			g.items.push(f);
		}
		return groups;
	});

	function openCaptureBrowser(): void {
		captureBrowser.value = true;
		void refreshRemoteCaptures();
	}

	const downloadRemote = (name: string) => io.download(`${CAPTURE_DIR}/${name}`);

	function toggleFile(name: string): void {
		const i = selectedFiles.value.indexOf(name);
		if (i >= 0) {
			selectedFiles.value.splice(i, 1);
		} else {
			selectedFiles.value.push(name);
		}
	}

	function resetResults(): void {
		lastResult.value = null;
		beltResult.value = null;
		profileResult.value = null;
		orientationResult.value = null;
		verifyResult.value = null;
		multiVerifyResult.value = null;
		multiResults.value = [];
		combinedRec.value = null;
	}

	/**
	 * Load the checked captures, choosing the view from what was selected: a Belt A + Belt B pair →
	 * tension comparison; several calibration sweeps → multi-axis overlay; anything else → the rich
	 * single-capture view.
	 */
	async function loadSelectedCaptures(): Promise<void> {
		const picks = remoteFiles.value.filter((f) => selectedFiles.value.includes(f.name));
		if (picks.length === 0) {
			return;
		}
		const hasBelt = picks.some((p) => p.kind === "belta" || p.kind === "beltb");
		const beltA = picks.find((p) => p.kind === "belta");
		const beltB = picks.find((p) => p.kind === "beltb");
		if (hasBelt && (!beltA || !beltB)) {
			error.value = t("captures.needBeltPair"); // invalid selection: keep the dialog open
			return;
		}
		captureBrowser.value = false; // selection is valid — dismiss the dialog right away
		error.value = "";
		loadingCapture.value = true;
		resetResults(); // clear whatever was on screen immediately, so stale data never lingers behind the loading state
		try {
			if (beltA && beltB) {
				const [ca, cb] = await Promise.all([downloadRemote(beltA.name), downloadRemote(beltB.name)]);
				beltResult.value = compareBelts(parseAccelCsv(ca), parseAccelCsv(cb), 150, 5);
				return;
			}
			const sweeps = picks.filter((p) => p.kind === "sweep");
			if (sweeps.length > 1) {
				const collected: Array<{ axis: string } & ReturnType<typeof parse>> = [];
				for (const s of sweeps) {
					collected.push({ axis: s.axis, ...parse(await downloadRemote(s.name), { minFreq: adv.value.startFreq, maxFreq: adv.value.endFreq }) });
				}
				multiResults.value = collected.map((c) => ({ axis: c.axis, analysis: c.analysis, capture: c.capture }));
				combinedRec.value = computeCombinedRec(multiResults.value);
				return;
			}
			const one = picks[0];
			if (one.axis) {
				selectedAxis.value = one.axis;
			}
			// The CSV itself carries no record of what sweep range captured it - the current Start/End
			// (Hz) controls are the best available approximation, so only apply them for a sweep capture.
			const freqRange = one.kind === "sweep" ? { minFreq: adv.value.startFreq, maxFreq: adv.value.endFreq } : undefined;
			finish(parse(await downloadRemote(one.name), freqRange), one.name);
		} catch (e) {
			error.value = (e as Error).message || String(e);
		} finally {
			loadingCapture.value = false;
		}
	}

	async function loadLocalCsv(ev: Event): Promise<void> {
		const file = (ev.target as HTMLInputElement).files?.[0];
		if (!file) {
			return;
		}
		try {
			finish(parse(await file.text()), file.name);
			error.value = "";
		} catch (e) {
			error.value = (e as Error).message || String(e);
		} finally {
			(ev.target as HTMLInputElement).value = "";
		}
	}

	// ── Verdict ──────────────────────────────────────────────────────────────────
	const rec = computed(() => result.value?.analysis.recommendation ?? null);
	const overlay = ref<ShaperName>("mzv");
	const overlayItems = computed(() => (rec.value?.allShapers ?? []).map((s) => ({
		title: `${SHAPER_DISPLAY_NAMES[s.name]} @ ${s.freq.toFixed(1)} Hz — ${(100 - s.vibrations * 100).toFixed(0)}%`,
		value: s.name,
	})));
	const displayName = (n: ShaperName) => SHAPER_DISPLAY_NAMES[n];

	const verdict = computed(() => {
		const a = result.value?.analysis;
		if (!a) {
			return null;
		}
		if (!rec.value) {
			return { color: "success", icon: "mdi-check-decagram", headline: t("results.quiet"), detail: t("results.quietDetail") };
		}
		const fit = rec.value.allShapers.find((s) => s.name === overlay.value) ?? rec.value.best;
		const reduction = (100 - fit.vibrations * 100).toFixed(0);
		return {
			color: "info",
			icon: "mdi-lightbulb-on-outline",
			headline: t("results.headline", { shaper: SHAPER_DISPLAY_NAMES[fit.name], freq: fit.freq.toFixed(1), reduction }),
			detail: t("results.detail", { peak: a.peaks[0]?.freq.toFixed(1) ?? "?" }),
		};
	});

	function downloadDiagnostics(): void {
		const r = result.value;
		const state: Record<string, unknown> = { method: method.value };
		// Only one of these is populated at a time in normal use, but a diagnostics report should
		// reflect whatever is actually on screen rather than assuming the single-axis shape.
		if (r) {
			state.singleAxis = {
				axis: r.axis, source: r.source, when: r.when.toISOString(),
				samplingRate: r.analysis.samplingRate, overflows: r.analysis.overflows,
				sampleCount: r.analysis.sampleCount,
				peaks: r.analysis.peaks.slice(0, 5),
				// Strip the per-bin response array - the report only needs the verdict numbers.
				best: r.analysis.recommendation
					? (({ name, freq, vibrations, smoothing }) => ({ name, freq, vibrations, smoothing }))(r.analysis.recommendation.best)
					: null,
			};
		}
		if (multiResults.value.length) {
			state.multiAxis = {
				axes: multiResults.value.map((m) => ({
					axis: m.axis, samplingRate: m.analysis.samplingRate, overflows: m.analysis.overflows,
					sampleCount: m.analysis.sampleCount, peaks: m.analysis.peaks.slice(0, 5),
				})),
				combined: combinedRec.value
					? (({ name, freq, vibrations, perAxis }) => ({ name, freq, vibrations, perAxis }))(combinedRec.value.best)
					: null,
			};
		}
		if (beltResult.value) {
			const b = beltResult.value;
			state.belts = { similarity: b.similarity, energyRatio: b.energyRatio, peakA: b.peakA, peakB: b.peakB, verdict: b.verdict };
		}
		if (profileResult.value) {
			const p = profileResult.value;
			state.profile = { median: p.median, problems: p.problems, quietest: p.quietest };
		}
		if (orientationResult.value) {
			const o = orientationResult.value;
			state.orientation = { iParam: o.solution.iParam, faces: o.solution.faces, conflicts: o.solution.conflicts, coupling: o.coupling };
		}
		if (verifyResult.value) {
			state.verify = { reduction: verifyResult.value.reduction };
		}
		downloadReport(buildReport({
			pluginId: "ResonanceLab",
			model: host.model(),
			state,
		}));
	}

	async function applyOrientation(): Promise<void> {
		const o = orientationResult.value;
		if (!o?.solution.iParam) {
			return;
		}
		await host.sendCode(`M955 P${o.accelId} I${o.solution.iParam}`);
		host.notify("success", "Resonance Lab", t("orientation.applied", { i: o.solution.iParam }));
	}

	/** Apply a specific shaper as the machine-wide M593 (RRF has no per-axis shaping). Sends the
	 *  damping ratio too (S) - RRF falls back to its own firmware default without it, which is not
	 *  necessarily the ratio this fit was actually built and scored against. */
	async function applyShaperFit(name: ShaperName, freq: number, dampingRatio: number): Promise<void> {
		applying.value = true;
		try {
			await host.sendCode(`M593 P"${name}" F${freq.toFixed(1)} S${dampingRatio.toFixed(2)}`);
			appliedFit.value = { name, freq, dampingRatio };
			host.notify("success", "Resonance Lab", t("results.applied", { shaper: SHAPER_DISPLAY_NAMES[name], freq: freq.toFixed(1) }));
		} catch (e) {
			host.notify("error", "Resonance Lab", (e as Error).message || String(e));
		}
		finally {
			applying.value = false;
		}
	}

	async function applyShaper(): Promise<void> {
		const fit = rec.value?.allShapers.find((s) => s.name === overlay.value) ?? rec.value?.best;
		if (fit) {
			await applyShaperFit(fit.name, fit.freq, fit.dampingRatio);
		}
	}

	// ── Persisting to config.g ────────────────────────────────────────────────────
	// M593/M955 applied at runtime (above) are lost on the next reboot - these write the same
	// settings into config.g (or a tool's tpost<N>.g for a shaper meant for that tool only) instead,
	// via machineConfig.ts's read/diff/backup/write. Both the shaper-scope choice and the
	// diff-preview/confirm step share one dialog's worth of state, since only one can be open at a
	// time and the templates only need to bind to it, not duplicate this flow.
	const shaperScopeDialogOpen = ref(false);
	const pendingShaperFit = ref<AppliedShaper | null>(null);
	const configDialogOpen = ref(false);
	const configDialogBusy = ref(false);
	const configDialogError = ref("");
	const configPlan = ref<DirectiveEditPlan | null>(null);
	const configNotes = ref<Array<string>>([]);
	/** Which directive the current plan edits - the two callers (orientation/shaper) know this up
	 *  front, so the dialog doesn't need to re-derive it by sniffing `configPlan`. */
	const configCode = ref<"M955" | "M593">("M593");
	/** Just the filename ("config.g", "tpost0.g") for the dialog's notes, without the full path. */
	const configFileName = computed(() => configPlan.value?.path.split("/").pop() ?? "");
	/** True once `confirmConfigSave` has actually written the file - switches the dialog from
	 *  "review this diff" to "saved; restart to apply?" without needing a second dialog. */
	const configSaved = ref(false);
	/** tpost<N>.g takes effect on its own at the next tool change; only a config.g edit needs a
	 *  restart (or a re-run) before RRF picks it up. */
	const configNeedsRestart = computed(() => configPlan.value?.path === configPath(host));
	/** Every tool number this machine actually has an accelerometer tied to, for the "which tpost<N>.g
	 *  else sets M593" cross-check in planShaperSave. */
	const allToolNumbers = computed(() => [...new Set(
		accelItems.value.map((a) => a.toolNumber).filter((n): n is number => n !== undefined),
	)]);
	const isToolChanger = computed(() => allToolNumbers.value.length > 0);
	/** Label for the scope dialog's "this tool only" option, e.g. "T0 Dragon" - falls back to a bare
	 *  number if the active tool has no configured name. */
	const activeToolLabel = computed(() => {
		const accel = accelItems.value.find((a) => a.toolNumber === activeTool.value);
		return accel ? `T${accel.toolNumber}${accel.toolName ? ` ${accel.toolName}` : ""}` : `T${activeTool.value}`;
	});

	async function previewConfigSave(
		code: "M955" | "M593", build: () => Promise<{ plan: DirectiveEditPlan; notes: Array<string> }>,
	): Promise<void> {
		configDialogBusy.value = true;
		configDialogError.value = "";
		try {
			const { plan, notes } = await build();
			configCode.value = code;
			configPlan.value = plan;
			configNotes.value = notes;
			configSaved.value = false;
			configDialogOpen.value = true;
		} catch (e) {
			host.notify("error", "Resonance Lab", (e as Error).message || String(e));
		} finally {
			configDialogBusy.value = false;
		}
	}

	/** Preview writing the just-checked accelerometer orientation into config.g's M955 line. */
	async function saveOrientationToConfig(): Promise<void> {
		const o = orientationResult.value;
		if (!o?.solution.iParam) {
			return;
		}
		const iParam = o.solution.iParam;
		await previewConfigSave("M955", async () => ({ plan: await planOrientationSave(host, o.accelId, iParam), notes: [] }));
	}

	/** Entry point for the scope-choice dialog - skipped (defaulting straight to "all") on a machine
	 *  with no tool-changer accelerometer at all, so a single-accelerometer setup sees one dialog
	 *  (the diff preview), not two. */
	async function saveShaperFit(name: ShaperName, freq: number, dampingRatio: number): Promise<void> {
		pendingShaperFit.value = { name, freq, dampingRatio };
		if (!isToolChanger.value) {
			await chooseShaperScope("all");
			return;
		}
		shaperScopeDialogOpen.value = true;
	}

	async function saveShaper(): Promise<void> {
		const fit = rec.value?.allShapers.find((s) => s.name === overlay.value) ?? rec.value?.best;
		if (fit) {
			await saveShaperFit(fit.name, fit.freq, fit.dampingRatio);
		}
	}

	function cancelShaperScope(): void {
		shaperScopeDialogOpen.value = false;
		pendingShaperFit.value = null;
	}

	/** Resolve the scope choice into a preview - "all" edits config.g, "tool" edits the active tool's
	 *  own tpost<N>.g, creating it if it doesn't exist yet. */
	async function chooseShaperScope(scope: ShaperScope): Promise<void> {
		shaperScopeDialogOpen.value = false;
		const fit = pendingShaperFit.value;
		if (!fit) {
			return;
		}
		const gcodeLine = `M593 P"${fit.name}" F${fit.freq.toFixed(1)} S${fit.dampingRatio.toFixed(2)}`;
		const toolNumber = scope === "tool" ? activeTool.value : null;
		await previewConfigSave("M593", () => planShaperSave(host, scope, toolNumber, gcodeLine, allToolNumbers.value));
	}

	/** Write the previewed plan. Leaves the dialog open afterward (switched to "saved" mode via
	 *  `configSaved`) so a config.g edit can immediately offer to restart/re-run it. */
	async function confirmConfigSave(): Promise<void> {
		if (!configPlan.value) {
			return;
		}
		configDialogBusy.value = true;
		configDialogError.value = "";
		try {
			await applyEditPlan(host, configPlan.value);
			configSaved.value = true;
			host.notify("success", "Resonance Lab", t("config.saved"));
		} catch (e) {
			configDialogError.value = (e as Error).message || String(e);
		} finally {
			configDialogBusy.value = false;
		}
	}

	async function restartAfterSave(mode: "reset" | "runConfig"): Promise<void> {
		await restartAfterConfigEdit(host, mode);
		closeConfigDialog();
	}

	function closeConfigDialog(): void {
		configDialogOpen.value = false;
		configPlan.value = null;
		configNotes.value = [];
		configSaved.value = false;
		configDialogError.value = "";
	}

	/** The object model as a computed, for child components that take it as a prop (the About
	 *  dialog). Templates cannot call `host.model()` directly - they never see `host`. */
	const model = computed(() => host.model());

	return {
		model,
		reload,
		aboutOpen,
		autoCheck,
		aboutDescription,
		onCheckUpdate,
		onToggleAutoCheck,
		settingsOpen,
		programDir,
		t,
		isConnected,
		running,
		result,
		error,
		applying,
		filePicker,
		helpDialog,
		helpSections,
		beltPhase,
		beltEstablishingTiming,
		accelItems,
		selectedAccel,
		axisItems,
		adv,
		goalTasks,
		diagTasks,
		activeTask,
		taskAxisNote,
		selectTask,
		durationEstimate,
		canMeasure,
		cancelRequested,
		confirmGcodeOpen,
		skipGcodeConfirm,
		onMeasureClick,
		measure,
		verifyResult,
		appliedFit,
		multiVerifyResult,
		verify,
		verifyMulti,
		beltChart,
		beltVerdict,
		profileChart,
		profileVerdict,
		multiChart,
		multiVerifyChart,
		multiRows,
		combinedSummary,
		inspectAxis,
		backToOverlay,
		chartMode,
		showChannels,
		spectrogram,
		captureBrowser,
		selectedFiles,
		loadingCapture,
		remoteFiles,
		captureMeta,
		refreshRemoteCaptures,
		groupedCaptures,
		openCaptureBrowser,
		toggleFile,
		loadSelectedCaptures,
		loadLocalCsv,
		rec,
		overlay,
		overlayItems,
		displayName,
		verdict,
		downloadDiagnostics,
		applyOrientation,
		applyShaperFit,
		applyShaper,
		shaperScopeDialogOpen,
		pendingShaperFit,
		configDialogOpen,
		configDialogBusy,
		configDialogError,
		configPlan,
		configNotes,
		configSaved,
		configNeedsRestart,
		configCode,
		configFileName,
		activeTool,
		activeToolLabel,
		saveOrientationToConfig,
		saveShaperFit,
		saveShaper,
		cancelShaperScope,
		chooseShaperScope,
		confirmConfigSave,
		restartAfterSave,
		closeConfigDialog,
	};
}
