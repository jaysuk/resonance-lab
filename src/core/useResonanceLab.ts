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
import {
	analyzeMotorHarmonics, combineAxes, gradeOrders, type MotorHarmonics, type MotorLevel, summarizeMotorSweep, toDisplacementUm,
} from "../analysis/motorHarmonics";
import {
	defaultTuningSchedule, getMovesPerHarmonic, parsePhaseCorrections, tuneHarmonic,
	type HarmonicTuningResult, type PhaseCorrection, type TuningMeasurement,
} from "../analysis/motorTuning";
import { analyseCapture, type CaptureAnalysis } from "../analysis/pipeline";
import { findBestShaperCombined, type CombinedRecommendationResult } from "../analysis/recommend";
import { SHAPER_DISPLAY_NAMES, type ShaperName } from "../analysis/shapers";
import { computeSpectrogram } from "../analysis/stft";
import { buildVibrationProfile } from "../analysis/vibration";
import { cropCaptureToDuration, parseAccelCsv } from "../capture/csv";
import {
	analysisWindow, buildMotorMove, constantSpeedWindow, deriveMotorOptions, fullStepFrequency,
	maxLength, maxSpeedForRate, type MotorOption,
} from "../capture/motorMoves";
import {
	beltEstimatedDurationSec, DEFAULT_PROGRAM_DIR, downloadCapture, findAccelerometers, parseAccelRateFromReport,
	resizeForActualRate, runBeltCapture, runFixedExcitation, runMotorPointCapture, runNativeCapture,
	runSpeedPointCapture, runSweepCapture, type AccelerometerRef, type MachineIO,
} from "../capture/orchestrator";
import { shaperRestoreGcode, type ShaperState } from "../capture/sweep";
import { accelForTool } from "../capture/tools";
import {
	applyEditPlan, configPath, findExistingWiring, findStrayTpostAccelLines, planAccelMigration, planAccelSave,
	planShaperSave, restartAfterConfigEdit, type AccelMigrationPlan, type DirectiveEditPlan, type ShaperScope,
	type StrayAccelLine,
} from "../config/machineConfig";
import { chipFromIoin, type DriverChip, IOIN_ADDRESSES, parseRegisterValue, supportsWaveformCorrection } from "../config/driverChip";
// The /firmware subpath, not the bare "dwc-gcode-core" root specifier - see machineConfig.ts's own
// import of this for why (DWC 3.6's older webpack/TS build can't resolve the root specifier).
import { firmwareAtLeast } from "dwc-gcode-core/firmware";
import { MIN_ACCEL_FIRMWARE, MIN_MULTI_ACCEL_FIRMWARE } from "../config/firmwareVersion";
import {
	activeTool, beltResult, combinedRec, findOrientationEntry, lastResult, loadOrientationRegistry,
	measurementRunning, method, motorResult, motorTuneResult, multiResults, orientationResult, profileResult,
	saveOrientationEntry, selectedAxes, selectedAxis, selectedMotor, type CaptureMethod, type MultiAxisResult,
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

	// ── Motor-quality task ──────────────────────────────────────────────────────
	const motorOptions = computed<Array<MotorOption>>(() => deriveMotorOptions(host.model()));
	const motorItems = computed(() => motorOptions.value.map((o) => ({ title: o.label, value: o.motor })));
	const activeMotor = computed<MotorOption | null>(() =>
		motorOptions.value.find((o) => o.motor === selectedMotor.value) ?? motorOptions.value[0] ?? null);

	// Speeds planned for the motor sweep, clamped so the fundamental stays below the accelerometer's
	// Nyquist frequency (maxSpeedForRate) - the binding constraint, since harmonics above Nyquist are
	// merely dropped by analyzeMotorHarmonics and must not limit speed further.
	function plannedMotorSpeeds(sampleRate: number): Array<number> {
		const motor = activeMotor.value;
		if (!motor) {
			return [];
		}
		const cap = sampleRate > 0 ? maxSpeedForRate(motor, sampleRate) : Infinity;
		const speeds: Array<number> = [];
		const step = Math.max(1, adv.value.motorSpeedStep);
		for (let v = adv.value.motorSpeedMin; v <= adv.value.motorSpeedMax; v += step) {
			if (v > 0 && v <= cap) {
				speeds.push(v);
			}
		}
		return speeds;
	}

	/** Nominal (unclamped) sample rate used for the live UI hint - the real per-accelerometer rate is
	 *  only known once measure() reads it from the machine. */
	const motorSpeeds = computed(() => plannedMotorSpeeds(1000));

	const motorFreqHint = computed(() => {
		const motor = activeMotor.value;
		if (!motor || motorSpeeds.value.length === 0) {
			return "";
		}
		const freqs = motorSpeeds.value.map((speed) => speed * motor.stepFactor * motor.fullStepsPerMm);
		return `${Math.round(Math.min(...freqs))} – ${Math.round(Math.max(...freqs))} Hz`;
	});

	watch(motorOptions, (options) => {
		if (!options.some((o) => o.motor === selectedMotor.value)) {
			selectedMotor.value = options[0]?.motor ?? "";
		}
	}, { immediate: true });

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
		motorSpeedMin: 20, motorSpeedMax: 120, motorSpeedStep: 25, motorLength: 100,
		tuneSpeed: 0, tuneLength: 0, // 0 = "not yet defaulted" - see the tuneSpeed/tuneLength watcher below
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
		{ id: "motor", group: "goal", icon: "mdi-cog-outline", usesAxis: false, params: ["motorSpeedMin", "motorSpeedMax", "motorSpeedStep", "motorLength"] },
		{ id: "motortune", group: "goal", icon: "mdi-tune-vertical", usesAxis: false, params: ["tuneSpeed", "tuneLength"] },
		{ id: "excite", group: "diag", icon: "mdi-pulse", usesAxis: true, params: ["exciteFreq", "exciteSeconds"] },
		{ id: "move", group: "diag", icon: "mdi-arrow-left-right", usesAxis: true, params: [] },
		{ id: "custom", group: "diag", icon: "mdi-code-braces", usesAxis: true, params: ["customMoves"] },
	];
	// The motortune task is gated on firmware version (R2/R3) - it must not appear at all below the
	// minimum, not merely be disabled, since the machine may genuinely lack the M970.3/M569.2 waveform
	// correction command entirely below that version.
	const goalTasks = computed(() => TASKS.filter((td) =>
		td.group === "goal" && (td.id !== "motortune" || motorTuneSupported.value)));
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
		motorResult.value = null;
		motorTuneResult.value = null;
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
			case "motor": {
				const motor = activeMotor.value;
				secs = motor
					? motorSpeeds.value.reduce((sum, speed) => sum + constantSpeedWindow(buildMotorMove(motor, host.model(), a.motorLength, speed)).moveDuration + 4, 0)
					: 6;
				break;
			}
			case "motortune": {
				const motor = activeMotor.value;
				const moveDuration = motor ? constantSpeedWindow(buildMotorMove(motor, host.model(), a.tuneLength, a.tuneSpeed)).moveDuration : 0;
				secs = numTuneMoves.value * (2 * moveDuration + 2);
				break;
			}
			default: secs = 6; break;
		}
		const rounded = Math.max(2, Math.round(secs));
		return rounded >= 90 ? `~${Math.round(rounded / 60)} min` : `~${rounded}s`;
	});

	/** Every planned motor speed produces an analysable (non-triangular) constant-speed move. */
	const motorSpeedsUsable = computed(() => {
		const motor = activeMotor.value;
		if (!motor || motorSpeeds.value.length === 0) {
			return false;
		}
		return motorSpeeds.value.every((speed) => constantSpeedWindow(buildMotorMove(motor, host.model(), adv.value.motorLength, speed)).duration > 0);
	});

	const canMeasure = computed(() => isConnected.value && !running.value && !loadingCapture.value
		&& (selectedAccel.value !== null || accelItems.value.length > 0)
		&& (method.value !== "sweep" || selectedAxes.value.length > 0)
		&& (method.value !== "motor" || (activeMotor.value !== null && motorSpeedsUsable.value))
		&& (method.value !== "motortune" || (
			motorTuneSupported.value && tuneDriverId.value !== null && !tuneChipUnsupported.value && tuneSpeedUsable.value
		)));

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
		sendCode: async (code, quiet) => await host.sendCode(code, quiet),
		upload: async (path, content) => { await host.upload(path, content); },
		download: async (path) => await host.download(path),
		accelRuns: (accelId) => readAccelRuns(accelId),
		awaitAccelRun: (accelId, from, timeoutMs) => awaitAccelRun(accelId, from, timeoutMs),
		awaitIdle: (timeoutMs) => awaitMotionIdle(timeoutMs),
		awaitBusy: (timeoutMs) => awaitMotionBusy(timeoutMs),
		delete: async (path) => { await host.delete(path); },
		makeDirectory: async (path) => { await host.makeDirectory(path); },
	};

	// ── Single-accelerometer activation (RRF >= 3.7.0-rc.1) ───────────────────────
	// M955/M956 collapsed to exactly one accelerometer active machine-wide, addressed via C rather
	// than P for board SELECTION - but P0 must still be sent explicitly, never omitted (confirmed on
	// real hardware, both boards on RC1: omitting it fails "M955: missing parameter 'P'" despite the
	// RRF changelog describing P as "zero or omitted"; the firmware still requires the token present,
	// it just ignores its value once validated <1). Reconfiguring one (M955 P0 C"...") deletes and
	// recreates the accelerometer object - which resets its orientation to identity unless resupplied
	// in the SAME command. See src/config/firmwareVersion.ts's MIN_ACCEL_FIRMWARE for the exact
	// threshold this reuses (a separate constant from motortune's own gate, even though both happen to
	// be "3.7.0-rc.1" today).
	/** Firmware of the board actually carrying `canAddress` (the mainboard when 0/absent). */
	function boardFirmware(canAddress: number): string | null {
		const boards = (host.model() as { boards?: Array<{ canAddress?: number | null; firmwareVersion?: string } | null> }).boards ?? [];
		return boards.find((b) => b && (b.canAddress ?? 0) === canAddress)?.firmwareVersion ?? null;
	}
	/**
	 * Whether THIS SPECIFIC accelerometer's own board runs firmware new enough for the single-
	 * accelerometer M955/M956 scheme - deliberately NOT a single machine-wide flag (an earlier version
	 * of this code checked only `boards[0]`, the mainboard). A remote `M955` (its `C` has a CAN-address
	 * prefix) is forwarded whole to that board and parsed by ITS OWN firmware, which is flashed and
	 * updated independently of the mainboard's - mirrors motortune's own `driverBoardFirmware`
	 * precedent for exactly this reason. Gating on the mainboard alone let a P-omitted activation line
	 * reach an outdated toolboard, which rejected it with "Error M955: missing parameter 'P'" - a real
	 * field report (mainboard already on 3.7.0-rc.1+, that toolboard not yet updated), not theoretical.
	 */
	function usesNewAccelSchemeFor(canAddress: number): boolean {
		return firmwareAtLeast(boardFirmware(canAddress), MIN_ACCEL_FIRMWARE);
	}

	/** Whether THIS SPECIFIC accelerometer's own board runs firmware new enough for the
	 *  multi-accelerometer scheme (RRF >= 3.7.0-rc.1+1, up to 10 independent slots) - same per-board
	 *  reasoning as usesNewAccelSchemeFor, not a machine-wide flag. Under this scheme every board's
	 *  own M955 line always lands in config.g regardless of scope (see machineConfig.ts's
	 *  planAccelSave), so the "this tool only / all tools" choice from the single-slot era no longer
	 *  has a real second option to offer - saveOrientationToConfig skips the dialog outright here. */
	function usesMultiAccelSchemeFor(canAddress: number): boolean {
		return firmwareAtLeast(boardFirmware(canAddress), MIN_MULTI_ACCEL_FIRMWARE);
	}

	/** Live OM lookup for a board's CURRENT orientation/resolution/rate - used to seed the orientation
	 *  registry the first time a board is seen this session (the OM is always current; config.g/tpost
	 *  text goes stale the instant an orientation is applied at runtime only). */
	function liveAccelState(canAddress: number): { orientation: number; resolution: number; samplingRate: number; uniqueId: string | null } | null {
		const boards = (host.model() as { boards?: Array<{
			canAddress?: number | null; uniqueId?: string | null;
			accelerometer?: { orientation?: number; resolution?: number; samplingRate?: number } | null;
		} | null> }).boards ?? [];
		const board = boards.find((b) => b && (b.canAddress ?? 0) === canAddress);
		if (!board?.accelerometer) {
			return null;
		}
		return {
			orientation: board.accelerometer.orientation ?? 20, resolution: board.accelerometer.resolution ?? 10,
			samplingRate: board.accelerometer.samplingRate ?? 1000, uniqueId: board.uniqueId ?? null,
		};
	}

	/** Build a full M955 P<slot> C"..." I<n> line using an EXPLICIT orientation, bypassing the
	 *  orientation registry entirely - for axescheck's identity-neutralize/restore, which measures
	 *  against a temporary probe value (never the user's real orientation) and must not overwrite the
	 *  registry with it. Returns null when this accelerometer's wiring can't be found anywhere (R3).
	 *  `slot` is `wiring.slot` verbatim (0 on single-slot firmware, since that's the only value any
	 *  line there could legally have - see AccelWiring.slot) so the caller can also arm the matching
	 *  M956 P<slot>, never a hardcoded 0 once more than one accelerometer can be configured. */
	async function buildActivationCodeWithOrientation(accel: AccelerometerRef, orientation: string): Promise<{ code: string; slot: number } | null> {
		const wiring = await findExistingWiring(host, accel);
		if (!wiring) {
			return null;
		}
		const q = wiring.spiFrequency ? ` Q${wiring.spiFrequency}` : "";
		return { code: `M955 P${wiring.slot} C"${wiring.cSpec}" I${orientation}${q}`, slot: wiring.slot };
	}

	/**
	 * Build the full M955 activation line for `accel` using its registry orientation, or null if it
	 * can't be activated under the new scheme (no wiring found anywhere - R3 - or never configured at
	 * all). Reissued before every single measurement, unconditionally (R2) - there is no "skip if
	 * already active" optimisation, since nothing tells this plugin whether some other code path
	 * repointed the active accelerometer since the last capture.
	 */
	async function buildActivationCode(accel: AccelerometerRef): Promise<{ code: string; slot: number } | null> {
		const canAddress = parseInt(accel.id, 10) || 0;
		const live = liveAccelState(canAddress);
		const registry = loadOrientationRegistry();
		let entry = findOrientationEntry(registry, canAddress, live?.uniqueId ?? null);
		if (!entry && live) {
			// First time this board is seen this session (or its uniqueId changed) - seed from the OM,
			// which is always current, rather than from config.g's possibly-stale I (R4).
			entry = {
				canAddress, uniqueId: live.uniqueId, orientation: live.orientation,
				resolution: live.resolution, samplingRate: live.samplingRate,
			};
			saveOrientationEntry(entry);
		}
		if (!entry) {
			return null; // board never configured at all - nothing to reactivate
		}
		const wiring = await findExistingWiring(host, accel);
		if (!wiring) {
			return null;
		}
		const q = wiring.spiFrequency ? ` Q${wiring.spiFrequency}` : "";
		const code = `M955 P${wiring.slot} C"${wiring.cSpec}" I${entry.orientation}${q} R${entry.resolution ?? 10} S${entry.samplingRate ?? 1000}`;
		return { code, slot: wiring.slot };
	}

	/**
	 * Resolve the `activationCode` to pass into a capture for `accel`, gated on THAT accelerometer's
	 * OWN board firmware (`usesNewAccelSchemeFor`) - never a single machine-wide flag, since a
	 * tool-changer can easily have boards on different firmware versions. Sets the `wiringMissing`
	 * error and tells the caller to abort when this accelerometer needs an activation line and none
	 * could be built, rather than falling through to a P-based call that firmware would reject.
	 */
	async function resolveActivationCode(accel: AccelerometerRef): Promise<{ ok: true; code: string | undefined; slot: number } | { ok: false }> {
		const canAddress = parseInt(accel.id, 10) || 0;
		if (!usesNewAccelSchemeFor(canAddress)) {
			return { ok: true, code: undefined, slot: 0 };
		}
		const built = await buildActivationCode(accel);
		if (!built) {
			error.value = t("orientation.wiringMissing");
			return { ok: false };
		}
		return { ok: true, code: built.code, slot: built.slot };
	}

	// Which discovered accelerometers have no recorded wiring (new-scheme firmware only) - a SEPARATE
	// ref, not folded into the accelItems/selectedAccel/currentToolNumber watcher chain above (see
	// CLAUDE.md's note on that chain needing `{ immediate: true }` and not gaining an untested fourth
	// dependency), and not a plain `computed` because the check needs async host I/O (config.g/tpost
	// text), which a computed can't do. selectedAccel/autoSelectAccel keep reading the base `accelItems`
	// unaffected - an accelerometer with missing wiring is still selectable (R3: "shown, not hidden"),
	// just visually flagged for the template.
	const wiringMissingIds = ref<Set<string>>(new Set());
	watch(accelItems, async (items) => {
		if (items.length === 0) {
			wiringMissingIds.value = new Set();
			return;
		}
		// Vue does not await/catch an async watcher callback - an unswallowed rejection here (e.g. a
		// config.g read failing while briefly disconnected) becomes an unhandled promise rejection,
		// which fails CI outright even with every test green (see CLAUDE.md). This is best-effort
		// discovery, not a user-facing action, so a failure here should leave the existing flags alone
		// rather than surface an error the user didn't ask for.
		try {
			const missing = new Set<string>();
			for (const item of items) {
				// Per-item, not a single machine-wide flag - a tool-changer can have boards on different
				// firmware versions, and wiring-lookup is only meaningful for a board on the new scheme.
				const canAddress = parseInt(item.id, 10) || 0;
				if (usesNewAccelSchemeFor(canAddress) && !(await findExistingWiring(host, item))) {
					missing.add(item.id);
				}
			}
			wiringMissingIds.value = missing;
		} catch {
			// leave wiringMissingIds as it was - a stale/absent flag is far less harmful than a crash
		}
	}, { immediate: true });

	/** accelItems augmented with `wiringMissing`, for the picker template only. */
	const accelItemsForPicker = computed<Array<AccelerometerRef>>(() => accelItems.value.map((a) => ({
		...a, wiringMissing: wiringMissingIds.value.has(a.id),
	})));
	/** For the single-accelerometer (non-select) fallback display, which reads the base `selectedAccel`
	 *  rather than `accelItemsForPicker` - avoids an inline re-lookup (and Vue-2-template optional
	 *  chaining risk) in either template. */
	const selectedAccelWiringMissing = computed(() => !!selectedAccel.value && wiringMissingIds.value.has(selectedAccel.value.id));

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
		if (method.value === "motor" || method.value === "motortune") {
			return activeMotor.value?.axes ?? [];
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

	/**
	 * Read the accelerometer's currently-configured orientation (default 20 = identity).
	 *
	 * On new-scheme firmware this reads the object model directly (`liveAccelState`) instead of
	 * querying via G-code, confirmed against RRF source (`ConfigureAccelerometer`/`StartAccelerometer`
	 * in Accelerometers.cpp - not the changelog, whose "P is zero or omitted" description turned out
	 * not to match either handler): `P` is `gb.MustSee`-mandatory and `GetLimitedUIValue`-capped to
	 * `[0, ActualMaxAccelerometers)` = `{0}` in BOTH the query and configure forms of M955, so
	 * `accelId`'s old board.driver shape (e.g. "121.0") is never a valid value to send as `P` here -
	 * and even `P0` would report on whichever board RRF's own `configs[0].boardAddress` bookkeeping
	 * currently points at (whatever was last configured with `M955 C`), not necessarily `accelId`'s
	 * own board. The object model's `boards[N].accelerometer` is populated per board independently of
	 * which one is globally active, so it answers "this board's own configured orientation" correctly
	 * regardless - the same source `buildActivationCode` already trusts for the same reason.
	 */
	async function readAccelOrientation(accelId: string): Promise<number> {
		const canAddress = parseInt(accelId, 10) || 0;
		if (usesNewAccelSchemeFor(canAddress)) {
			return liveAccelState(canAddress)?.orientation ?? 20;
		}
		try {
			const reply = await io.sendCode(`M955 P${accelId}`, true);
			const m = /orientation[:\s]+(\d+)/i.exec(reply);
			return m ? parseInt(m[1], 10) : 20;
		} catch {
			return 20;
		}
	}

	/**
	 * Read the accelerometer's real sample rate (Hz). The recorder is armed for a fixed sample COUNT,
	 * so this must match reality: assume too high and M956 keeps sampling long after the motion ends
	 * (machine idle while the recording finishes — the 20-30s belt-test stall). Default 1000 if
	 * unavailable. Same new-scheme-vs-legacy split as `readAccelOrientation`, for the same reason.
	 */
	async function readAccelRate(accelId: string): Promise<number> {
		const canAddress = parseInt(accelId, 10) || 0;
		if (usesNewAccelSchemeFor(canAddress)) {
			const rate = liveAccelState(canAddress)?.samplingRate;
			return rate !== undefined && rate >= 100 && rate <= 20000 ? rate : 1000;
		}
		try {
			const reply = await io.sendCode(`M955 P${accelId}`, true);
			const rate = parseAccelRateFromReport(reply);
			return rate >= 100 && rate <= 20000 ? rate : 1000;
		} catch {
			return 1000;
		}
	}

	// ── Motor waveform tuning (motortune task) ────────────────────────────────────
	// Never hardcode a board list here (upstream's own list has already grown once and will grow
	// again) - detection is: firmware gate (visibility) + axis.phaseStep (command choice) + IOIN chip
	// read (informative) + a runtime query-form probe (the actual capability check, in measure()).
	const MIN_TUNE_FIRMWARE = "3.7.0-rc.1";

	interface TuneModelAxis {
		letter?: string;
		phaseStep?: boolean | null;
		drivers?: Array<{ board?: number | null; driver?: number }>;
	}

	function tuneAxis(): TuneModelAxis | undefined {
		const motor = activeMotor.value;
		if (!motor) {
			return undefined;
		}
		const axes = (host.model() as { move?: { axes?: Array<TuneModelAxis> } }).move?.axes ?? [];
		return axes.find((a) => a.letter === motor.motor);
	}

	/** The board carrying a motor's first driver (mainboard when board is 0/absent). */
	function driverBoardFirmware(motor: string): string | null {
		const m = host.model() as {
			boards?: Array<{ canAddress?: number | null; firmwareVersion?: string } | null>;
			move?: { axes?: Array<TuneModelAxis> };
		};
		const axis = m.move?.axes?.find((a) => a.letter === motor);
		const boardId = axis?.drivers?.[0]?.board ?? 0;
		return m.boards?.find((b) => b && (b.canAddress ?? 0) === boardId)?.firmwareVersion ?? null;
	}

	// Gate: the mainboard AND the driver's own board (which may be a CAN expansion board) must both
	// be new enough. Fails closed (R2) - missing/unparseable firmware means unsupported, never "assume
	// it's fine". This is what keeps the task off the rail entirely below MIN_TUNE_FIRMWARE (see
	// goalTasks above), not merely disabled - the command may not exist in the firmware at all.
	const motorTuneSupported = computed(() => {
		const main = (host.model() as { boards?: Array<{ firmwareVersion?: string } | null> }).boards?.[0]?.firmwareVersion ?? null;
		if (!firmwareAtLeast(main, MIN_TUNE_FIRMWARE)) {
			return false;
		}
		return motorOptions.value.some((o) => firmwareAtLeast(driverBoardFirmware(o.motor), MIN_TUNE_FIRMWARE));
	});

	// Command choice: phase stepping (free phase, harmonics 2 & 4) vs the driver's sine table
	// (constrained to 0/180, harmonic 4 only - coil imbalance isn't representable there).
	const tunePhaseStepping = computed(() => tuneAxis()?.phaseStep === true);
	const tuneCommand = computed(() => (tunePhaseStepping.value ? "M970.3" : "M569.2"));
	const tuneHarmonicList = computed(() => (tunePhaseStepping.value ? [2, 4] : [4]));
	const tuneConstrain = computed(() => !tunePhaseStepping.value);
	const numTuneMoves = computed(() => tuneHarmonicList.value.length * getMovesPerHarmonic(tuneConstrain.value));

	/** DriverId -> the P parameter for M970.3/M569.2: "0" on the mainboard, "1.2" for board 1 driver 2. */
	const tuneDriverId = computed<string | null>(() => {
		const d = tuneAxis()?.drivers?.[0];
		if (!d || typeof d.driver !== "number") {
			return null;
		}
		return d.board ? `${d.board}.${d.driver}` : `${d.driver}`;
	});

	// Chip identification: informative only, never gating (the firmware check above already controls
	// visibility) - the object model carries no chip-type field at all, so this is read directly off
	// the driver via its IOIN register (see ../config/driverChip.ts, modelled on duet-tmc-tuner).
	const detectedChip = ref<DriverChip | null>(null);
	const detectingChip = ref(false);
	const tuneChipUnsupported = computed(() => detectedChip.value !== null && !supportsWaveformCorrection(detectedChip.value.family));

	async function readTuneReg(addr: number): Promise<number | null> {
		return parseRegisterValue(await io.sendCode(`M569.2 P${tuneDriverId.value} R${addr}`, true));
	}

	// The FIRST M569.2 register read after a page load is often stale - RRF returns a cached/empty
	// value before the driver is actually read. Retry until the VERSION byte resolves. Straight from
	// duet-tmc-tuner's detectChip(); do not remove the retry.
	async function detectChip(): Promise<DriverChip | null> {
		if (!tuneDriverId.value) {
			return null;
		}
		let match: DriverChip | null = null;
		for (let attempt = 0; attempt < 4 && !match; attempt++) {
			if (attempt > 0) {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			const uart = await readTuneReg(IOIN_ADDRESSES.uart);
			const spi = await readTuneReg(IOIN_ADDRESSES.spi);
			match = chipFromIoin({ uart, spi });
		}
		return match;
	}

	// Re-detect whenever the tuning task is opened or the selected motor changes - not on every page
	// load regardless of task, which would spam the G-code console with register reads for a task the
	// user isn't even looking at.
	watch([method, activeMotor], async ([m, motor]) => {
		if (m !== "motortune" || !motor) {
			return;
		}
		detectedChip.value = null;
		if (!motorTuneSupported.value) {
			return;
		}
		detectingChip.value = true;
		try {
			detectedChip.value = await detectChip();
		} finally {
			detectingChip.value = false;
		}
	}, { immediate: true });

	// Aim the default speed at a ~400Hz full-step frequency: strong signal, well under Nyquist on
	// common accelerometers. Applied whenever the motor changes or the values haven't been set yet
	// (0 = "not yet defaulted") - {immediate:true} is required, the same as the accelerometer
	// auto-select chain, or the initial synchronous default is never observed.
	watch(activeMotor, (motor) => {
		if (!motor) {
			return;
		}
		if (adv.value.tuneSpeed === 0) {
			adv.value.tuneSpeed = Math.min(maxSpeedForRate(motor, 1000), Math.round((400 / motor.fullStepsPerMm / motor.stepFactor) * 10) / 10);
		}
		if (adv.value.tuneLength === 0) {
			adv.value.tuneLength = Math.min(Math.round(maxLength(motor, host.model()) / 2), Math.floor(adv.value.tuneSpeed * 5));
		}
	}, { immediate: true });

	/** The tuning move never reaches its feedrate (a triangular profile) - nothing to analyse. */
	const tuneSpeedUsable = computed(() => {
		const motor = activeMotor.value;
		if (!motor || adv.value.tuneSpeed <= 0 || adv.value.tuneLength <= 0) {
			return false;
		}
		return constantSpeedWindow(buildMotorMove(motor, host.model(), adv.value.tuneLength, adv.value.tuneSpeed)).duration > 0;
	});

	/** Live "measuring harmonic N, move M/T" status text while a tuning run is in progress. */
	const tuneStatus = ref("");
	/** Snapshot of the driver's corrections before this run started (from the probe reply) - R1: what
	 *  cancel/error/Discard restore to. */
	const previousCorrections = ref<Array<PhaseCorrection>>([]);

	/**
	 * Restore a driver to whatever it held before a tuning run started. R1, so the identity of the
	 * driver being restored is passed in EXPLICITLY rather than re-read from `tuneCommand`/
	 * `tuneDriverId`/`tuneHarmonicList`: those are computeds over `selectedMotor`, and the motor
	 * picker is re-enabled the moment a run finishes while the result card (and its Discard button)
	 * is still on screen. Reading them live would let "Discard" write one driver's saved values into
	 * a different driver that was never tuned - the exact opposite of what Discard promises.
	 * Best-effort per harmonic: one failed write must not stop the rest, or mask the original error.
	 */
	async function restoreCorrections(cmd: string, drv: string, harmonics: Array<number>): Promise<void> {
		for (const harmonic of harmonics) {
			const previous = previousCorrections.value.find((c) => c.harmonic === harmonic);
			try {
				await io.sendCode(`${cmd} P${drv} S${harmonic} J${(previous?.magnitude ?? 0).toFixed(3)} O${(previous?.phase ?? 0).toFixed(1)}`);
			} catch {
				// best-effort - surfacing this would obscure whatever error caused the abort in the first place
			}
		}
	}

	/** Leave the just-tuned correction live (it already is - Keep only updates the record). */
	function keepMotorTune(): void {
		if (motorTuneResult.value) {
			motorTuneResult.value = { ...motorTuneResult.value, kept: true };
		}
	}

	/** Revert to the pre-tuning correction, targeting the driver the result itself records. */
	async function discardMotorTune(): Promise<void> {
		const r = motorTuneResult.value;
		if (!r) {
			return;
		}
		await restoreCorrections(r.command, r.driverId, r.results.map((res) => res.harmonic));
		motorTuneResult.value = { ...r, kept: false };
		host.notify("info", t("motorTune.reverted"), "");
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
		// Computed once per measure() call (R2's "reissue before every measurement" is satisfied by
		// each capture function resending this same string before its own M956 - see orchestrator.ts's
		// activateAndSnapshotRuns - not by recomputing it per axis/per speed here). Gated on THIS
		// accelerometer's own board firmware (resolveActivationCode), not a machine-wide flag. A null
		// result means this accelerometer has no wiring recorded anywhere (R3) - fail BEFORE moving
		// anything, rather than falling through to a P-based M956 the firmware will reject.
		const activation = await resolveActivationCode(accel);
		if (!activation.ok) {
			return;
		}
		const activationCode = activation.code;
		const activationSlot = activation.slot;
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
		motorResult.value = null;
		motorTuneResult.value = null;
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
					restoreShaper: currentShaperState(), activationCode, activationSlot,
				}));
				finish(parse(await raceCancellable(downloadCapture(io, run))), `${selectedAxis.value} · ${adv.value.exciteFreq} Hz`);
			} else if (method.value === "axescheck") {
				// Measure the RAW mounting. Any orientation already configured in M955 makes the chip report
				// machine-aligned axes, so without this we'd solve a correction on top of the existing one —
				// e.g. re-running after applying I06 would read "already correct" and suggest the wrong value.
				// Neutralise to identity (I20) for the test, then restore whatever was configured. On
				// new-scheme firmware a bare `M955 P<id> I20` is a silent no-op (R1: I is only read inside
				// the C-seen branch) - build a full activation line pinned to I20 instead, and pass THAT
				// (not the generic per-measurement `activationCode` above, which carries the REAL
				// orientation) into every capture below, so the neutralisation survives R2's per-capture
				// reissue instead of being undone by it.
				const prevOrientation = await readAccelOrientation(accel.id);
				const accelCanAddress = parseInt(accel.id, 10) || 0;
				let neutralCode: string | undefined;
				let neutralSlot: number | undefined;
				if (usesNewAccelSchemeFor(accelCanAddress)) {
					const built = await buildActivationCodeWithOrientation(accel, "20");
					if (!built) {
						error.value = t("orientation.wiringMissing");
						return;
					}
					neutralCode = built.code;
					neutralSlot = built.slot;
					await io.sendCode(neutralCode);
				} else {
					await io.sendCode(`M955 P${accel.id} I20`);
				}
				try {
					// One sharp move per horizontal axis; gravity (pre-motion DC) pins the vertical.
					const moveResults: Partial<Record<"X" | "Y", ReturnType<typeof analyzeAxisBurst>>> = {};
					let firstCapture: ReturnType<typeof parseAccelCsv> | null = null;
					for (const ax of ["X", "Y"] as const) {
						const run = await raceCancellable(runNativeCapture(io, {
							accelerometer: accel, axis: ax, center: centerOf(ax), span: 20,
							activationCode: neutralCode, activationSlot: neutralSlot,
						}));
						const capture = parseAccelCsv(await raceCancellable(downloadCapture(io, run)));
						firstCapture = firstCapture ?? capture;
						moveResults[ax] = analyzeAxisBurst(capture);
					}
					const gravity = detectVerticalAxis(firstCapture!, moveResults.X!.dc);
					orientationResult.value = { solution: solveOrientation(moveResults, gravity), accelId: accel.id, coupling: Math.max(moveResults.X!.coupling, moveResults.Y!.coupling) };
					lastResult.value = null;
				} finally {
					if (usesNewAccelSchemeFor(accelCanAddress)) {
						const restoreCode = await buildActivationCodeWithOrientation(accel, String(prevOrientation));
						if (restoreCode) {
							await io.sendCode(restoreCode.code);
						}
					} else {
						await io.sendCode(`M955 P${accel.id} I${prevOrientation}`);
					}
				}
			} else if (method.value === "motor") {
				const motor = activeMotor.value;
				if (!motor) {
					error.value = t("motor.noMotor");
					return;
				}
				const results: Array<MotorHarmonics> = [];
				const speeds: Array<number> = [];
				let overflows = 0;
				await withShaperDisabled(async () => {
					for (const speed of plannedMotorSpeeds(sampleRate)) {
						const m = buildMotorMove(motor, host.model(), adv.value.motorLength, speed);
						const run = await raceCancellable(runMotorPointCapture(io, {
							accelerometer: accel, move: m, expectedSampleRate: sampleRate, activationCode, activationSlot,
						}));
						const cap = parseAccelCsv(await raceCancellable(downloadCapture(io, run)));
						const w = analysisWindow(m, cap.samplingRate, cap.channels[0]?.length ?? 0);
						const slice = cap.channels.map((ch) => ch.slice(w.start, w.end));
						try {
							results.push(analyzeMotorHarmonics(slice, cap.samplingRate, fullStepFrequency(m)));
							speeds.push(speed);
						} catch {
							// Above Nyquist at this speed after all (the real per-recording rate can differ
							// slightly from the sizing estimate) - skip the point, keep the rest of the sweep.
						}
						overflows = Math.max(overflows, cap.overflows);
					}
				});
				lastResult.value = null;
				if (results.length === 0) {
					error.value = t("motor.noSpeeds");
					motorResult.value = null;
				} else {
					const sweep = summarizeMotorSweep(results);
					motorResult.value = { motor: motor.motor, label: motor.label, sweep, findings: gradeOrders(sweep), speeds, overflows };
				}
			} else if (method.value === "motortune") {
				const motor = activeMotor.value;
				const cmd = tuneCommand.value;
				const drv = tuneDriverId.value;
				if (!motor || !drv) {
					error.value = t("motorTune.unsupported");
					return;
				}

				// PROBE + SNAPSHOT (R1) - before any write. The same reply that confirms the driver actually
				// accepts this command is also the record of what to restore on cancel/error/Discard.
				const probeReply = await io.sendCode(`${cmd} P${drv}`, true);
				if (/^Error/im.test(probeReply) || !/waveform correction/i.test(probeReply)) {
					error.value = t("motorTune.unsupported");
					return;
				}
				previousCorrections.value = parsePhaseCorrections(probeReply);

				const m = buildMotorMove(motor, host.model(), adv.value.tuneLength, adv.value.tuneSpeed);

				// Fail fast, before any write. analyzeMotorHarmonics throws once the full-step frequency
				// (plus its ±5% search margin) reaches Nyquist; only the DEFAULT speed is clamped, and only
				// against a nominal rate, so a hand-typed speed can exceed the real one. Without this the
				// run would do several moves and then abort mid-search with a far less obvious error.
				const fullStepHz = fullStepFrequency(m);
				if (fullStepHz * 1.05 >= sampleRate / 2) {
					error.value = t("motorTune.speedTooHigh", {
						hz: Math.round(fullStepHz),
						speed: Math.floor(maxSpeedForRate(motor, sampleRate) * 10) / 10,
					});
					return;
				}

				// Snapshot the harmonic list alongside cmd/drv: everything the restore path needs must be
				// fixed at run start, not re-read from live computeds afterwards (see restoreCorrections).
				const harmonics = [...tuneHarmonicList.value];
				let moveCount = 0;
				const results: Array<HarmonicTuningResult> = [];

				async function setCorrection(harmonic: number, magnitude: number, phase: number): Promise<void> {
					await io.sendCode(`${cmd} P${drv} S${harmonic} J${magnitude.toFixed(3)} O${phase.toFixed(1)}`);
				}

				// Apply a candidate, record a round trip (both directions matter - a rotor-fixed error
				// component shifts by the load angle, flipping sign with direction), analyse each leg
				// separately and average. The recording is deleted immediately - a full run is 10-20 of
				// these and they must not accumulate in 0:/sys/accelerometer/.
				async function measureOnce(harmonic: number, magnitude: number, phase: number): Promise<TuningMeasurement> {
					await setCorrection(harmonic, magnitude, phase);
					tuneStatus.value = t("motorTune.status", {
						h: harmonic, mag: magnitude.toFixed(2), phase: phase.toFixed(1), n: ++moveCount, total: numTuneMoves.value,
					});

					const run = await raceCancellable(runMotorPointCapture(io, {
						accelerometer: accel, move: m, expectedSampleRate: sampleRate, roundTrip: true, activationCode, activationSlot,
					}));
					const cap = parseAccelCsv(await raceCancellable(downloadCapture(io, run)));
					if (io.delete) {
						try { await io.delete(run.csvPath); } catch { /* best-effort - must not abort the run */ }
					}

					const window = constantSpeedWindow(m);
					const sampleCount = cap.channels[0]?.length ?? 0;
					const amplitudes = [0, window.moveDuration].map((offset) => {
						const win = analysisWindow(m, cap.samplingRate, sampleCount, offset);
						const slice = cap.channels.map((ch) => ch.slice(win.start, win.end));
						const analysis = analyzeMotorHarmonics(slice, cap.samplingRate, fullStepFrequency(m), 1);
						const orderIndex = analysis.orders.indexOf(harmonic / 4);
						return orderIndex >= 0 ? combineAxes(analysis)[orderIndex] : 0;
					}) as [number, number];

					return { harmonic, magnitude, phase, amplitude: (amplitudes[0] + amplitudes[1]) / 2, amplitudes };
				}

				try {
					await withShaperDisabled(async () => {
						for (const harmonic of harmonics) {
							const result = await tuneHarmonic(harmonic, (mag, phase) => measureOnce(harmonic, mag, phase), tuneConstrain.value, defaultTuningSchedule);
							results.push(result);
							// Leave this harmonic at its winning value before starting the next one.
							const won = result.best.amplitude < result.baseline;
							await setCorrection(harmonic, won ? result.best.magnitude : 0, won ? result.best.phase : 0);
						}
					});
				} catch (e) {
					await restoreCorrections(cmd, drv, harmonics); // cancel / error / disconnect (R1)
					throw e;
				}

				lastResult.value = null;
				const codes = results
					.filter((r) => r.best.amplitude < r.baseline)
					.map((r) => `${cmd} P${drv} S${r.harmonic} J${r.best.magnitude.toFixed(2)} O${r.best.phase.toFixed(1)}`);
				motorTuneResult.value = {
					motor: motor.motor, label: motor.label, command: cmd, driverId: drv,
					chip: detectedChip.value?.chip ?? null, results, codes, kept: false,
				};
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
					restoreShaper: currentShaperState(), activationCode, activationSlot,
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
						const run = await raceCancellable(runSpeedPointCapture(io, { accelerometer: accel, axis: selectedAxis.value, center: axisCenter(), speed, expectedSampleRate: sampleRate, activationCode }));
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
						restoreShaper, activationCode, activationSlot,
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
					activationCode, activationSlot,
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
		accel: AccelerometerRef, before: { axis: string; analysis: CaptureAnalysis }, sampleRate: number,
		activationCode: string | undefined, activationSlot: number,
	): Promise<{ reduction: number; labels: Array<number>; beforeData: Array<number>; afterData: Array<number> }> {
		const minFreq = adv.value.startFreq;
		const maxFreq = adv.value.endFreq;
		const run = await raceCancellable(runSweepCapture(io, {
			accelerometer: accel, axis: before.axis, center: centerOf(before.axis),
			startFreq: adv.value.startFreq, endFreq: adv.value.endFreq, hzPerSec: adv.value.hzPerSec,
			keepShaper: true, expectedSampleRate: sampleRate, programDir: effectiveProgramDir.value,
			...axisLimits(before.axis), activationCode, activationSlot,
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
		const activation = await resolveActivationCode(accel);
		if (!activation.ok) {
			return;
		}
		const activationCode = activation.code;
		const activationSlot = activation.slot;
		cancelRequested.value = false;
		running.value = true;
		error.value = "";
		try {
			await moveToZIfSet();
			await moveToCenters([before.axis]);
			const sampleRate = await readAccelRate(accel.id);
			const { reduction, labels, beforeData, afterData } = await verifyAxis(accel, before, sampleRate, activationCode, activationSlot);
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
		const activation = await resolveActivationCode(accel);
		if (!activation.ok) {
			return;
		}
		const activationCode = activation.code;
		const activationSlot = activation.slot;
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
				const { reduction, labels, beforeData, afterData } = await verifyAxis(accel, before, sampleRate, activationCode, activationSlot);
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

	// ── Motor quality result ─────────────────────────────────────────────────────
	const MOTOR_ORDER_COLORS = ["#2196f3", "#ff9800", "#4caf50", "#9c27b0", "#00bcd4", "#e91e63", "#795548", "#607d8b"];
	const MOTOR_LEVEL_RANK: Record<MotorLevel, number> = { low: 0, moderate: 1, high: 2 };

	function motorLevelColor(level: MotorLevel): "warning" | "info" | "success" {
		return level === "high" ? "warning" : level === "moderate" ? "info" : "success";
	}
	function motorLevelIcon(level: MotorLevel): string {
		return level === "high" ? "mdi-alert" : level === "moderate" ? "mdi-information-outline" : "mdi-check-decagram";
	}
	function motorFindingText(f: { key: string; displacementUm: number; frequency: number; ratio: number | null; level: MotorLevel }, motor: string): string {
		return t(`motor.findings.${f.key}`, {
			motor, um: f.displacementUm.toFixed(2), hz: Math.round(f.frequency),
			ratio: f.ratio !== null ? Math.round(f.ratio * 100) : "-", level: t(`motor.levels.${f.level}`),
		});
	}

	const motorChart = computed(() => {
		const r = motorResult.value;
		if (!r) {
			return null;
		}
		const sweep = r.sweep;
		return {
			labels: sweep.frequencies.map((f) => Math.round(f)),
			series: sweep.orders.map((order, orderIndex) => ({
				label: `${order}x`,
				data: sweep.amplitudes[orderIndex].map((amplitude, i) => (amplitude !== null ? toDisplacementUm(amplitude, sweep.frequencies[i]) : NaN)),
				color: MOTOR_ORDER_COLORS[orderIndex % MOTOR_ORDER_COLORS.length],
			})),
		};
	});

	/** One row per finding, for the alert list below the verdict card. */
	const motorFindingRows = computed(() => {
		const r = motorResult.value;
		if (!r) {
			return [];
		}
		return r.findings.map((f) => ({ color: motorLevelColor(f.level), icon: motorLevelIcon(f.level), text: motorFindingText(f, r.motor) }));
	});

	const motorVerdict = computed(() => {
		const r = motorResult.value;
		if (!r) {
			return null;
		}
		if (r.findings.length === 0 || r.findings.every((f) => f.level === "low")) {
			return { color: "success", icon: "mdi-check-decagram", headline: t("motor.clean"), detail: t("motor.cleanDetail") };
		}
		const worst = r.findings.reduce((w, f) => (MOTOR_LEVEL_RANK[f.level] > MOTOR_LEVEL_RANK[w.level] ? f : w));
		return { color: motorLevelColor(worst.level), icon: motorLevelIcon(worst.level), headline: motorFindingText(worst, r.motor), detail: "" };
	});

	// ── Motor waveform tuning result ──────────────────────────────────────────────
	interface MotorTuneRow { harmonic: number; text: string; improved: boolean }

	const motorTuneRows = computed<Array<MotorTuneRow>>(() => {
		const r = motorTuneResult.value;
		if (!r) {
			return [];
		}
		return r.results.map((res) => {
			const improved = res.best.amplitude < res.baseline;
			if (!improved) {
				return { harmonic: res.harmonic, improved, text: t("motorTune.noImprovement", { h: res.harmonic }) };
			}
			const pct = res.baseline > 0 ? Math.round((1 - res.best.amplitude / res.baseline) * 100) : 0;
			return {
				harmonic: res.harmonic, improved,
				text: t("motorTune.improved", { h: res.harmonic, before: res.baseline.toFixed(4), after: res.best.amplitude.toFixed(4), pct }),
			};
		});
	});

	const motorTuneVerdict = computed(() => {
		const r = motorTuneResult.value;
		if (!r) {
			return null;
		}
		const improvedCount = motorTuneRows.value.filter((row) => row.improved).length;
		return improvedCount > 0
			? { color: "success" as const, icon: "mdi-check-decagram", headline: t("motorTune.summary", { improved: improvedCount, total: r.results.length }) }
			: { color: "info" as const, icon: "mdi-information-outline", headline: t("motorTune.summaryNone") };
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
		const m = /^rlab-(belta|beltb|sweep|move|fix\d+|speed\d+|motor[a-z]\d+)-([a-z]+)-(\d{14})\.csv$/i.exec(name);
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
		if (kind.startsWith("motor")) { return { label: t("captures.kinds.motor"), icon: "mdi-cog-outline" }; }
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
		const canAddress = parseInt(o.accelId, 10) || 0;
		if (usesNewAccelSchemeFor(canAddress)) {
			// A bare `M955 P<id> I<n>` is a silent no-op here (R1: I is only read inside the C-seen
			// branch) - build a full activation line with the just-solved orientation instead.
			const accel = accelItems.value.find((a) => a.id === o.accelId);
			const code = accel ? await buildActivationCodeWithOrientation(accel, o.solution.iParam) : null;
			if (!code) {
				error.value = t("orientation.wiringMissing");
				return;
			}
			await host.sendCode(code.code);
			// Persist to the registry, not just apply at runtime - config.g's own I goes stale the
			// instant this runs, so this is what makes the NEXT reactivation of this board (the very
			// next capture, per R2) pick up the orientation just solved here, rather than a stale one.
			const live = liveAccelState(canAddress);
			saveOrientationEntry({
				canAddress, uniqueId: live?.uniqueId ?? null, orientation: parseInt(o.solution.iParam, 10),
				resolution: live?.resolution, samplingRate: live?.samplingRate,
			});
		} else {
			await host.sendCode(`M955 P${o.accelId} I${o.solution.iParam}`); // unchanged legacy path
		}
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
	/** Mutually exclusive with pendingShaperFit - whichever save flow is active clears the other's
	 *  pending state up front (see saveShaperFit/saveOrientationToConfig), so chooseShaperScope always
	 *  has exactly one to resolve regardless of which flow was used last. */
	const pendingAccelSave = ref<{ accel: AccelerometerRef; orientation: string } | null>(null);
	/** For the scope dialog's copy while it's open (R9: config.g and tpost<N>.g carry materially
	 *  different consequences for M955 than for M593 - "don't reuse 'all tools' copy verbatim"). */
	const pendingSaveKind = computed<"M955" | "M593" | null>(() => (
		pendingAccelSave.value ? "M955" : pendingShaperFit.value ? "M593" : null
	));
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
	/**
	 * The scope dialog's "this tool only" option means something different per directive: for a
	 * shaper (M593) it's always the currently MOUNTED tool (a shaper save is about what's active now).
	 * For an accelerometer (M955) it's the tool THAT ACCELEROMETER belongs to, which may not be the
	 * tool currently mounted at all (you can save T1's accelerometer while T0 is on the machine) - so
	 * this can't reuse activeTool/activeToolLabel directly.
	 */
	const scopeDialogHasTool = computed(() => (
		pendingSaveKind.value === "M955" ? (pendingAccelSave.value?.accel.toolNumber ?? -1) >= 0 : activeTool.value >= 0
	));
	const scopeDialogToolLabel = computed(() => {
		if (pendingSaveKind.value !== "M955") {
			return activeToolLabel.value;
		}
		const accel = pendingAccelSave.value?.accel;
		return accel?.toolNumber !== undefined ? `T${accel.toolNumber}${accel.toolName ? ` ${accel.toolName}` : ""}` : "";
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

	/**
	 * Preview persisting the just-checked accelerometer orientation (and, on new-scheme firmware, its
	 * wiring) so it survives a reboot. Always asks where when more than one accelerometer exists on
	 * new-scheme firmware (R9) - never inferred from toolNumber or any other guess at machine type.
	 * Below that (legacy firmware, or a single-accelerometer machine where the choice is real but
	 * trivial) goes straight to config.g, same as before this feature existed.
	 */
	async function saveOrientationToConfig(): Promise<void> {
		const o = orientationResult.value;
		if (!o?.solution.iParam) {
			return;
		}
		const accel = accelItems.value.find((a) => a.id === o.accelId);
		if (!accel) {
			return; // board vanished from the OM since the orientation ran
		}
		pendingShaperFit.value = null; // mutually exclusive with a shaper save - see chooseShaperScope
		pendingAccelSave.value = { accel, orientation: o.solution.iParam };
		const canAddress = parseInt(accel.id, 10) || 0;
		// Multi-accelerometer firmware always saves to config.g regardless of scope (each board gets
		// its own independent slot there - see planAccelSave) - the "this tool only" option from the
		// single-slot era isn't a real second choice any more, so the dialog is never opened for this
		// branch at all, not merely defaulted through it.
		if (!usesNewAccelSchemeFor(canAddress) || usesMultiAccelSchemeFor(canAddress) || accelItems.value.length <= 1) {
			await chooseShaperScope("all");
			return;
		}
		shaperScopeDialogOpen.value = true;
	}

	/** Entry point for the scope-choice dialog - skipped (defaulting straight to "all") on a machine
	 *  with no tool-changer accelerometer at all, so a single-accelerometer setup sees one dialog
	 *  (the diff preview), not two. */
	async function saveShaperFit(name: ShaperName, freq: number, dampingRatio: number): Promise<void> {
		pendingAccelSave.value = null; // mutually exclusive with an accel save - see chooseShaperScope
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
		pendingAccelSave.value = null;
	}

	/** Resolve the scope choice into a preview - "all" edits config.g, "tool" edits the active tool's
	 *  own tpost<N>.g, creating it if it doesn't exist yet. Checks the accelerometer save first: the
	 *  two flows are mutually exclusive (each clears the other's pending state before opening this
	 *  dialog), so at most one of these is ever actually set. */
	async function chooseShaperScope(scope: ShaperScope): Promise<void> {
		shaperScopeDialogOpen.value = false;
		const accelSave = pendingAccelSave.value;
		if (accelSave) {
			await previewConfigSave("M955", () => planAccelSave(host, accelSave.accel, scope, accelSave.orientation));
			return;
		}
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

	// ── Consolidating stray tpost<N>.g M955 lines back into config.g (multi-accelerometer firmware) ──
	// Every pre-existing "this tool only" accelerometer save (from before multi-slot firmware existed)
	// wrote a full M955 line into that tool's own tpost<N>.g, and P could only ever be 0 back then - so
	// on a machine upgraded to RRF >= 3.7.0-rc.1+1, picking up ANY such tool resends "P0", silently
	// reassigning slot 0 away from whatever config.g just assigned there (no error, just silently wrong
	// axis data on the next capture). This offers to strike those lines out of tpost<N>.g and fold each
	// board's wiring into config.g instead, where it belongs under the new scheme.
	const strayAccelLines = ref<Array<StrayAccelLine>>([]);
	const migrationBannerDismissed = ref(false);
	const migrationBannerVisible = computed(() => strayAccelLines.value.length > 0 && !migrationBannerDismissed.value);
	function dismissMigrationBanner(): void {
		migrationBannerDismissed.value = true;
	}

	// Separate watcher, same reasoning as wiringMissingIds above: async host I/O, best-effort, and not
	// folded into the accelItems/selectedAccel/currentToolNumber chain that needs `{ immediate: true }`
	// for a different reason (see CLAUDE.md). Only worth checking on a tool-changer, and only once at
	// least one board is actually running multi-accelerometer firmware - below that, a tpost<N>.g M955
	// line is exactly how "this tool only" is SUPPOSED to work (single-slot scheme), not a hazard.
	watch(accelItems, async (items) => {
		if (items.length === 0 || allToolNumbers.value.length === 0) {
			strayAccelLines.value = [];
			return;
		}
		const anyMultiAccel = items.some((item) => usesMultiAccelSchemeFor(parseInt(item.id, 10) || 0));
		if (!anyMultiAccel) {
			strayAccelLines.value = [];
			return;
		}
		try {
			strayAccelLines.value = await findStrayTpostAccelLines(host, allToolNumbers.value);
		} catch {
			// best-effort discovery only - leave the existing list alone rather than surface an error
		}
	}, { immediate: true });

	const migrationDialogOpen = ref(false);
	const migrationDialogBusy = ref(false);
	const migrationDialogError = ref("");
	const migrationPlan = ref<AccelMigrationPlan | null>(null);
	/** True once `confirmMigration` has actually written every file - switches the dialog from "review
	 *  this diff" to "done", mirroring configSaved above. */
	const migrationSaved = ref(false);
	/** Just the filenames, for the dialog's summary line - e.g. "tpost0.g, tpost2.g -> config.g". */
	const migrationFileNames = computed(() => ({
		from: migrationPlan.value?.removals.map((p) => p.path.split("/").pop() ?? "") ?? [],
		to: configPath(host).split("/").pop() ?? "",
	}));

	async function openMigrationDialog(): Promise<void> {
		migrationDialogBusy.value = true;
		migrationDialogError.value = "";
		migrationSaved.value = false;
		try {
			migrationPlan.value = await planAccelMigration(host, strayAccelLines.value);
			migrationDialogOpen.value = true;
		} catch (e) {
			host.notify("error", "Resonance Lab", (e as Error).message || String(e));
		} finally {
			migrationDialogBusy.value = false;
		}
	}

	/** Write every removal, then every addition - removals first, so a crash partway through never
	 *  leaves a board deleted from tpost<N>.g AND missing from config.g at the same time. */
	async function confirmMigration(): Promise<void> {
		const plan = migrationPlan.value;
		if (!plan) {
			return;
		}
		migrationDialogBusy.value = true;
		migrationDialogError.value = "";
		try {
			for (const removal of plan.removals) {
				await applyEditPlan(host, removal);
			}
			for (const addition of plan.additions) {
				await applyEditPlan(host, addition);
			}
			migrationSaved.value = true;
			strayAccelLines.value = [];
			migrationBannerDismissed.value = true;
			host.notify("success", "Resonance Lab", t("migration.applied"));
		} catch (e) {
			migrationDialogError.value = (e as Error).message || String(e);
		} finally {
			migrationDialogBusy.value = false;
		}
	}

	async function restartAfterMigration(mode: "reset" | "runConfig"): Promise<void> {
		await restartAfterConfigEdit(host, mode);
		closeMigrationDialog();
	}

	function closeMigrationDialog(): void {
		migrationDialogOpen.value = false;
		migrationPlan.value = null;
		migrationSaved.value = false;
		migrationDialogError.value = "";
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
		accelItemsForPicker,
		selectedAccelWiringMissing,
		selectedAccel,
		axisItems,
		motorItems,
		motorFreqHint,
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
		motorChart,
		motorVerdict,
		motorFindingRows,
		tunePhaseStepping,
		tuneChipUnsupported,
		detectedChip,
		detectingChip,
		tuneStatus,
		motorTuneRows,
		motorTuneVerdict,
		keepMotorTune,
		discardMotorTune,
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
		pendingAccelSave,
		pendingSaveKind,
		scopeDialogHasTool,
		scopeDialogToolLabel,
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
		migrationBannerVisible,
		dismissMigrationBanner,
		strayAccelLines,
		migrationDialogOpen,
		migrationDialogBusy,
		migrationDialogError,
		migrationPlan,
		migrationSaved,
		migrationFileNames,
		openMigrationDialog,
		confirmMigration,
		restartAfterMigration,
		closeMigrationDialog,
	};
}
