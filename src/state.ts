/**
 * Tiny shared reactive state so the page and the embeddable summary panel show the same session:
 * the last analysis result and whether a measurement is currently running.
 */
import { ref } from "vue";

import type { CaptureAnalysis } from "./analysis/pipeline";

export interface SessionResult {
	axis: string;
	when: Date;
	source: string;
	analysis: CaptureAnalysis;
}

export const lastResult = ref<SessionResult | null>(null);
export const measurementRunning = ref(false);

import type { BeltComparison } from "./analysis/belts";
import type { VibrationProfile } from "./analysis/vibration";

export const beltResult = ref<BeltComparison | null>(null);
export const profileResult = ref<VibrationProfile | null>(null);
