/**
 * Tiny shared reactive state so the page and the embeddable summary panel show the same session:
 * the last analysis result and whether a measurement is currently running.
 *
 * Results are kept PER TOOL (keyed by tool number, `-1` = no tool changer / no tool mounted) so a
 * tool-changer with an accelerometer per tool doesn't lose T0's result the moment T1 is measured.
 * `useResonanceLab.ts` drives `activeTool` from the live machine tool (or the user's manual
 * accelerometer pick); everything else here just reads/writes whichever tool is currently active.
 *
 * Vue 2.7's reactivity (the DWC 3.6 build) does not observe native `Map`/`Set` mutations the way
 * Vue 3's Proxy-based system does - confirmed empirically, not from docs: calling `.set()` on a
 * `ref(new Map())` never re-runs a Vue-2.7 watcher, while reassigning `ref.value` to a fresh Map
 * does, on both versions. So `sessions` is never mutated in place below - every write replaces it
 * wholesale with a new Map. This file is shared byte-for-byte between both UIs, so this is the only
 * pattern that is safe here; don't "simplify" it back to `sessions.value.set(...)`.
 */
import { computed, ref } from "vue";

import type { OrientationSolution } from "./analysis/axesMap";
import type { BeltComparison } from "./analysis/belts";
import type { MotorFinding, MotorSweep } from "./analysis/motorHarmonics";
import type { HarmonicTuningResult } from "./analysis/motorTuning";
import type { CaptureAnalysis } from "./analysis/pipeline";
import type { CombinedRecommendationResult } from "./analysis/recommend";
import type { VibrationProfile } from "./analysis/vibration";
import type { AccelCapture } from "./capture/csv";

export interface SessionResult {
	axis: string;
	when: Date;
	source: string;
	analysis: CaptureAnalysis;
	/** Raw capture retained for views that need the time series (spectrogram). */
	capture?: AccelCapture;
}

/** One axis of a multi-axis calibration run (kept here so the overlay survives leaving the page). */
export interface MultiAxisResult { axis: string; analysis: CaptureAnalysis; capture: AccelCapture }

/** Result of the motor-quality task: a speed sweep summarized by absolute frequency, plus its findings. */
export interface MotorSessionResult {
	/** Motor letter, for labelling - a motor is per-driver, not per-tool, so this disambiguates a
	 *  shared motor (e.g. X on a tool changer) seen under two different tool sessions. */
	motor: string;
	/** Display label, e.g. "X+Y". */
	label: string;
	sweep: MotorSweep;
	findings: Array<MotorFinding>;
	/** Speeds (mm/s) actually recorded. */
	speeds: Array<number>;
	/** Worst overflow count across the recordings that made up this result. */
	overflows: number;
}

/** Result of the motor-quality-tuning task: the search outcome per harmonic, plus the G-code to persist it. */
export interface MotorTuneResult {
	motor: string;
	/** Display label, e.g. "X+Y". */
	label: string;
	/** "M970.3" (phase stepping) or "M569.2" (sine table). */
	command: string;
	/** The `P` value used, e.g. "0" or "1.2". */
	driverId: string;
	/** Detected chip name (e.g. "TMC5160"), or null when detection didn't resolve. */
	chip: string | null;
	results: Array<HarmonicTuningResult>;
	/** Every harmonic this run may have written to the driver - what Discard restores. Absent on a
	 *  result from before multi-harmonic tuning, where it is just the harmonics in `results`. */
	written?: Array<number>;
	/** Highest accelerometer sample-overflow count seen across the run's recordings; any is worth a warning. */
	overflows?: number;
	/** Harmonics nothing improved that were put back to the value the driver held before the run. */
	keptPrevious?: Array<number>;
	/** Final capture with every tuned correction in place: amplitude per tuned harmonic, and whether
	 *  it got noticeably worse than the search measured (tuned harmonics disturbing each other). */
	verification?: Array<{ harmonic: number; amplitude: number; regressed: boolean }>;
	/** Speed (mm/s) and move length (mm) the run measured at, so a later check repeats the same pass. */
	speed?: number;
	length?: number;
	/** The config.g lines a user would add to persist this correction. */
	codes: Array<string>;
	/** False until the Keep button is pressed - Discard (or an abort) restores the prior values instead. */
	kept: boolean;
}

/** Everything one tool's own measurement session holds. */
interface ToolSession {
	lastResult: SessionResult | null;
	multiResults: Array<MultiAxisResult>;
	/** Shaper recommendation weighing every axis in `multiResults` at once (RRF's M593 is machine-wide). */
	combinedRec: CombinedRecommendationResult | null;
	orientationResult: { solution: OrientationSolution; accelId: string; coupling: number } | null;
	beltResult: BeltComparison | null;
	profileResult: VibrationProfile | null;
	motorResult: MotorSessionResult | null;
	motorTuneResult: MotorTuneResult | null;
}

function emptySession(): ToolSession {
	return {
		lastResult: null, multiResults: [], combinedRec: null, orientationResult: null,
		beltResult: null, profileResult: null, motorResult: null, motorTuneResult: null,
	};
}

/**
 * Per-tool sessions, keyed by tool number. Exported for tests and any future per-tool comparison
 * view; ordinary code should go through the per-field computeds below rather than indexing this
 * directly, so it doesn't have to know about the Map-reassignment requirement above.
 */
export const sessions = ref<Map<number, ToolSession>>(new Map());
/**
 * Which tool's session the fields below read/write. `-1` (the default) is "no tool changer, or no
 * tool mounted yet" - existing single-accelerometer setups get exactly one session and see no
 * behavioural change. `useResonanceLab.ts` keeps this following the live machine tool (with a
 * manual-override escape hatch); the embeddable summary panel doesn't run that composable, so it
 * just displays whatever this currently points at.
 */
export const activeTool = ref<number>(-1);

function currentSession(): ToolSession {
	return sessions.value.get(activeTool.value) ?? emptySession();
}

/** Replace one field of `tool`'s session, replacing the whole `sessions` Map (see file header). */
function updateSession<K extends keyof ToolSession>(tool: number, key: K, value: ToolSession[K]): void {
	const next = new Map(sessions.value);
	next.set(tool, { ...(next.get(tool) ?? emptySession()), [key]: value });
	sessions.value = next;
}

function sessionField<K extends keyof ToolSession>(key: K) {
	return computed<ToolSession[K]>({
		get: () => currentSession()[key],
		set: (v) => updateSession(activeTool.value, key, v),
	});
}

export const lastResult = sessionField("lastResult");
export const multiResults = sessionField("multiResults");
export const combinedRec = sessionField("combinedRec");
export const orientationResult = sessionField("orientationResult");
export const beltResult = sessionField("beltResult");
export const profileResult = sessionField("profileResult");
export const motorResult = sessionField("motorResult");
export const motorTuneResult = sessionField("motorTuneResult");

// ── Accelerometer orientation registry (RRF >= 3.7.0-rc.1) ─────────────────────────────────────
// New-scheme M955 only ever has one board's wiring active machine-wide, and reconfiguring an
// accelerometer (M955 C"...") resets its orientation to identity unless resupplied in the SAME
// command. config.g's own I value goes stale the instant `applyOrientation` runs at runtime only (the
// existing, pre-3.7.0-rc.1 behaviour), so it can't be trusted as the source of truth for reactivating
// an accelerometer later. This registry is resonance-lab's own record instead: localStorage (survives
// a reload; a per-tab session was rejected as "forgotten on reload"), keyed by CAN address AND board
// uniqueId so a physically swapped board can't inherit a stale orientation just because its CAN
// address was reused.
export interface AccelOrientationEntry {
	canAddress: number;
	/** boards[N].uniqueId at the time this was recorded - a board swap invalidates the entry even if
	 *  canAddress is reused. Null when the firmware doesn't report one; falls back to canAddress alone. */
	uniqueId: string | null;
	orientation: number;
	resolution?: number;
	samplingRate?: number;
}

const LS_ACCEL_ORIENTATION = "resonanceLab.accelOrientation";

/** All recorded entries. Never throws - an empty array on disabled/corrupted storage is the correct
 *  "nothing recorded yet" state, not a distinguishable error. */
export function loadOrientationRegistry(): Array<AccelOrientationEntry> {
	try {
		const raw = localStorage.getItem(LS_ACCEL_ORIENTATION);
		if (!raw) {
			return [];
		}
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as Array<AccelOrientationEntry>) : [];
	} catch {
		return [];
	}
}

/** Upsert by canAddress - a board only ever has one recorded entry, matching the firmware's own
 *  single-active-accelerometer constraint. Silently no-ops if storage is unavailable; the caller
 *  already has the value in memory for the rest of this session either way. */
export function saveOrientationEntry(entry: AccelOrientationEntry): void {
	try {
		const registry = loadOrientationRegistry().filter((e) => e.canAddress !== entry.canAddress);
		registry.push(entry);
		localStorage.setItem(LS_ACCEL_ORIENTATION, JSON.stringify(registry));
	} catch {
		// storage disabled - nothing more to do
	}
}

/** Matches on canAddress AND (when both sides have one) uniqueId - a uniqueId mismatch (the board was
 *  swapped) returns null rather than a stale value, even though canAddress alone still matches. */
export function findOrientationEntry(
	registry: Array<AccelOrientationEntry>, canAddress: number, uniqueId: string | null,
): AccelOrientationEntry | null {
	const entry = registry.find((e) => e.canAddress === canAddress);
	if (!entry) {
		return null;
	}
	if (entry.uniqueId && uniqueId && entry.uniqueId !== uniqueId) {
		return null;
	}
	return entry;
}

export const measurementRunning = ref(false);

// View selection lives here too, so returning to the plugin restores the same task + axes (and the
// matching result), not the default Calibrate tab.
export type CaptureMethod = "sweep" | "move" | "custom" | "belts" | "profile" | "excite" | "axescheck" | "motor" | "motortune";
export const method = ref<CaptureMethod>("sweep");
export const selectedAxis = ref("X");
export const selectedAxes = ref<Array<string>>(["X", "Y"]);
/** Motor letter picked for the motor-quality task, kept here so the pick survives leaving the page. */
export const selectedMotor = ref("");
