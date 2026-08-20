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

/** Everything one tool's own measurement session holds. */
interface ToolSession {
	lastResult: SessionResult | null;
	multiResults: Array<MultiAxisResult>;
	/** Shaper recommendation weighing every axis in `multiResults` at once (RRF's M593 is machine-wide). */
	combinedRec: CombinedRecommendationResult | null;
	orientationResult: { solution: OrientationSolution; accelId: string; coupling: number } | null;
	beltResult: BeltComparison | null;
	profileResult: VibrationProfile | null;
}

function emptySession(): ToolSession {
	return { lastResult: null, multiResults: [], combinedRec: null, orientationResult: null, beltResult: null, profileResult: null };
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

export const measurementRunning = ref(false);

// View selection lives here too, so returning to the plugin restores the same task + axes (and the
// matching result), not the default Calibrate tab.
export type CaptureMethod = "sweep" | "move" | "custom" | "belts" | "profile" | "excite" | "axescheck";
export const method = ref<CaptureMethod>("sweep");
export const selectedAxis = ref("X");
export const selectedAxes = ref<Array<string>>(["X", "Y"]);
