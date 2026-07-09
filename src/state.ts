/**
 * Tiny shared reactive state so the page and the embeddable summary panel show the same session:
 * the last analysis result and whether a measurement is currently running.
 */
import { ref } from "vue";

import type { CaptureAnalysis } from "./analysis/pipeline";
import type { AccelCapture } from "./capture/csv";

export interface SessionResult {
	axis: string;
	when: Date;
	source: string;
	analysis: CaptureAnalysis;
	/** Raw capture retained for views that need the time series (spectrogram). */
	capture?: AccelCapture;
}

export const lastResult = ref<SessionResult | null>(null);
export const measurementRunning = ref(false);

// View selection lives here too, so returning to the plugin restores the same task + axes (and the
// matching result), not the default Calibrate tab.
export type CaptureMethod = "sweep" | "move" | "custom" | "belts" | "profile" | "excite" | "axescheck";
export const method = ref<CaptureMethod>("sweep");
export const selectedAxis = ref("X");
export const selectedAxes = ref<Array<string>>(["X", "Y"]);

import type { BeltComparison } from "./analysis/belts";
import type { VibrationProfile } from "./analysis/vibration";
import type { OrientationSolution } from "./analysis/axesMap";
import type { CombinedRecommendationResult } from "./analysis/recommend";

export const beltResult = ref<BeltComparison | null>(null);
export const profileResult = ref<VibrationProfile | null>(null);

/** One axis of a multi-axis calibration run (kept here so the overlay survives leaving the page). */
export interface MultiAxisResult { axis: string; analysis: CaptureAnalysis; capture: AccelCapture }
export const multiResults = ref<Array<MultiAxisResult>>([]);
/** Shaper recommendation weighing every axis in `multiResults` at once (RRF's M593 is machine-wide). */
export const combinedRec = ref<CombinedRecommendationResult | null>(null);
export const orientationResult = ref<{ solution: OrientationSolution; accelId: string; coupling: number } | null>(null);
