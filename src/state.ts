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

import type { BeltComparison } from "./analysis/belts";
import type { VibrationProfile } from "./analysis/vibration";
import type { OrientationSolution } from "./analysis/axesMap";

export const beltResult = ref<BeltComparison | null>(null);
export const profileResult = ref<VibrationProfile | null>(null);

/** One axis of a multi-axis calibration run (kept here so the overlay survives leaving the page). */
export interface MultiAxisResult { axis: string; analysis: CaptureAnalysis; capture: AccelCapture }
export const multiResults = ref<Array<MultiAxisResult>>([]);
export const orientationResult = ref<{ solution: OrientationSolution; accelId: string; coupling: number } | null>(null);
