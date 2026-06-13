<!--
  Resonance Lab - the lab page.

  Layout: a task rail on the left lists the jobs (calibrate, belt tension, vibration-vs-speed,
  orientation + a diagnostics group); the panel on the right explains the selected task, shows only
  the controls that task actually uses, then gives the rest of the space to the chart and verdict.
  Each task owns its parameters and its "what will happen" blurb, so nothing on screen is inert.
-->
<template>
	<v-container fluid class="d-flex flex-column fill-height pa-0">
		<!-- Top strip: title + global actions -->
		<div class="d-flex align-center ga-2 px-3 py-2">
			<v-icon size="large" class="me-1">mdi-sine-wave</v-icon>
			<span class="text-subtitle-1 font-weight-medium">{{ $t("plugins.resonanceLab.title") }}</span>
			<v-spacer />
			<v-menu @update:model-value="(open: boolean) => open && refreshRemoteCaptures()">
				<template #activator="{ props: m }">
					<v-btn v-bind="m" variant="text" prepend-icon="mdi-folder-open-outline" :disabled="running || !isConnected">
						{{ $t("plugins.resonanceLab.controls.captures") }}
					</v-btn>
				</template>
				<v-list density="compact" max-height="320">
					<v-list-item v-if="remoteCaptures.length === 0" :title="$t('plugins.resonanceLab.controls.noCaptures')" disabled />
					<v-list-item v-for="f in remoteCaptures" :key="f" :title="f" @click="openRemoteCapture(f)" />
				</v-list>
			</v-menu>
			<v-btn variant="text" prepend-icon="mdi-file-upload-outline" :disabled="running" @click="filePicker?.click()">
				{{ $t("plugins.resonanceLab.controls.loadCsv") }}
			</v-btn>
			<v-btn icon="mdi-bug-outline" variant="text" size="small" :title="$t('plugins.resonanceLab.controls.diagnostics')" @click="downloadDiagnostics" />
			<input ref="filePicker" type="file" accept=".csv" class="d-none" @change="loadLocalCsv">
		</div>
		<v-divider />

		<div class="d-flex flex-grow-1" style="min-height: 0">
			<!-- Task rail: pick the job by what you want to achieve -->
			<v-list nav density="compact" class="flex-shrink-0 py-2" style="width: 220px">
				<v-list-subheader>{{ $t("plugins.resonanceLab.rail.goals") }}</v-list-subheader>
				<v-list-item v-for="td in goalTasks" :key="td.id" :active="method === td.id" :disabled="running"
							 :prepend-icon="td.icon" :title="$t(`plugins.resonanceLab.tasks.${td.id}.title`)" @click="selectTask(td.id)" />
				<v-list-subheader>{{ $t("plugins.resonanceLab.rail.diagnostics") }}</v-list-subheader>
				<v-list-item v-for="td in diagTasks" :key="td.id" :active="method === td.id" :disabled="running"
							 :prepend-icon="td.icon" :title="$t(`plugins.resonanceLab.tasks.${td.id}.title`)" @click="selectTask(td.id)" />
			</v-list>
			<v-divider vertical />

			<!-- Task panel -->
			<div class="flex-grow-1 d-flex flex-column pa-3" style="min-width: 0">
				<!-- What this task does -->
				<div class="d-flex align-center ga-2">
					<v-icon size="large">{{ activeTask.icon }}</v-icon>
					<div class="text-h6">{{ $t(`plugins.resonanceLab.tasks.${method}.title`) }}</div>
				</div>
				<div class="text-body-2 text-medium-emphasis mt-1 mb-3" style="max-width: 80ch">
					{{ $t(`plugins.resonanceLab.tasks.${method}.blurb`) }}
				</div>

				<!-- Self-update offer -->
				<v-alert v-if="updatePendingReload" type="success" variant="tonal" density="compact" class="mb-3">
					{{ $t("plugins.resonanceLab.update.installed") }}
					<template #append><v-btn size="small" color="success" prepend-icon="mdi-restart" @click="reload">{{ $t("plugins.resonanceLab.update.reload") }}</v-btn></template>
				</v-alert>
				<v-alert v-else-if="updateState?.scenario === 'pluginUpdate'" type="info" variant="tonal" density="compact" class="mb-3">
					{{ $t("plugins.resonanceLab.update.available", { version: updateState.latestVersion }) }}
					<template #append><v-btn size="small" color="primary" :loading="updateApplying" prepend-icon="mdi-download" @click="applyUpdateNow">{{ $t("plugins.resonanceLab.update.apply") }}</v-btn></template>
				</v-alert>

				<!-- Readiness -->
				<v-alert v-if="!isConnected" type="info" variant="tonal" density="compact" class="mb-3">
					{{ $t("plugins.resonanceLab.notConnected") }}
				</v-alert>
				<v-alert v-else-if="accelItems.length === 0" type="warning" variant="tonal" density="compact" class="mb-3">
					{{ $t("plugins.resonanceLab.accelMissing") }}
				</v-alert>
				<v-alert v-else-if="error" type="error" variant="tonal" density="compact" class="mb-3" closable @click:close="error = ''">
					{{ error }}
				</v-alert>

				<!-- Parameters: only the controls this task actually uses -->
				<v-sheet v-if="isConnected && accelItems.length > 0" border rounded class="pa-3 mb-3">
					<div class="d-flex flex-wrap align-center ga-3">
						<v-select v-if="accelItems.length > 1" v-model="selectedAccel" :items="accelItems" item-title="label" return-object
								  density="compact" variant="outlined" hide-details style="min-width: 220px"
								  :label="$t('plugins.resonanceLab.controls.accelerometer')" :disabled="running" />
						<div v-else-if="selectedAccel" class="text-body-2">
							<span class="text-medium-emphasis">{{ $t("plugins.resonanceLab.controls.accelerometer") }}:</span> {{ selectedAccel.label }}
						</div>
						<v-select v-if="activeTask.usesAxis" v-model="selectedAxis" :items="axisItems" density="compact" variant="outlined"
								  hide-details style="max-width: 110px" :label="$t('plugins.resonanceLab.controls.axis')" :disabled="running" />
						<v-chip v-else size="small" variant="tonal" prepend-icon="mdi-axis-arrow">{{ taskAxisNote }}</v-chip>
						<v-text-field v-if="activeTask.params.includes('startFreq')" v-model.number="adv.startFreq" type="number" density="compact" variant="outlined" hide-details label="Start (Hz)" style="max-width: 120px" :disabled="running" />
						<v-text-field v-if="activeTask.params.includes('endFreq')" v-model.number="adv.endFreq" type="number" density="compact" variant="outlined" hide-details label="End (Hz)" style="max-width: 120px" :disabled="running" />
						<v-text-field v-if="activeTask.params.includes('hzPerSec')" v-model.number="adv.hzPerSec" type="number" density="compact" variant="outlined" hide-details label="Sweep (Hz/s)" style="max-width: 130px" :disabled="running" />
						<v-text-field v-if="activeTask.params.includes('beltStart')" v-model.number="adv.beltStart" type="number" density="compact" variant="outlined" hide-details label="Start (Hz)" style="max-width: 120px" :disabled="running" />
						<v-text-field v-if="activeTask.params.includes('beltEnd')" v-model.number="adv.beltEnd" type="number" density="compact" variant="outlined" hide-details label="End (Hz)" style="max-width: 120px" :disabled="running" />
						<v-text-field v-if="activeTask.params.includes('beltHz')" v-model.number="adv.beltHz" type="number" density="compact" variant="outlined" hide-details label="Sweep (Hz/s)" style="max-width: 130px" :disabled="running" />
						<v-text-field v-if="activeTask.params.includes('exciteFreq')" v-model.number="adv.exciteFreq" type="number" density="compact" variant="outlined" hide-details label="Frequency (Hz)" style="max-width: 140px" :disabled="running" />
						<v-text-field v-if="activeTask.params.includes('exciteSeconds')" v-model.number="adv.exciteSeconds" type="number" density="compact" variant="outlined" hide-details label="Duration (s)" style="max-width: 120px" :disabled="running" />
						<v-text-field v-if="activeTask.params.includes('speedMin')" v-model.number="adv.speedMin" type="number" density="compact" variant="outlined" hide-details label="Min (mm/s)" style="max-width: 120px" :disabled="running" />
						<v-text-field v-if="activeTask.params.includes('speedMax')" v-model.number="adv.speedMax" type="number" density="compact" variant="outlined" hide-details label="Max (mm/s)" style="max-width: 120px" :disabled="running" />
						<v-text-field v-if="activeTask.params.includes('speedStep')" v-model.number="adv.speedStep" type="number" density="compact" variant="outlined" hide-details label="Step (mm/s)" style="max-width: 120px" :disabled="running" />
						<v-text-field v-if="activeTask.params.includes('maxSmoothing')" v-model.number="adv.maxSmoothing" type="number" step="0.01" density="compact" variant="outlined" hide-details :label="$t('plugins.resonanceLab.controls.maxSmoothing')" style="max-width: 160px" :disabled="running" />
						<v-spacer />
						<v-btn color="primary" prepend-icon="mdi-play" :loading="running" :disabled="!canMeasure" @click="measure">
							{{ $t("plugins.resonanceLab.controls.measure") }}
						</v-btn>
					</div>
					<v-textarea v-if="activeTask.params.includes('customMoves')" v-model="adv.customMoves" class="mt-3" density="compact" variant="outlined"
								rows="4" hide-details :label="$t('plugins.resonanceLab.controls.customMoves')" :disabled="running" />
					<div class="text-caption text-medium-emphasis mt-2">
						{{ $t(`plugins.resonanceLab.tasks.${method}.run`) }} · {{ $t("plugins.resonanceLab.durationLabel", { dur: durationEstimate }) }}
					</div>
				</v-sheet>

				<!-- Progress -->
				<v-alert v-if="running" type="info" variant="tonal" density="compact" class="mb-3">
					<v-progress-circular indeterminate size="16" width="2" class="me-2" />
					{{ $t("plugins.resonanceLab.runningTask", { task: $t(`plugins.resonanceLab.tasks.${method}.title`) }) }}
				</v-alert>

				<!-- Results: verdict + chart get all remaining space -->
				<template v-if="result">
					<v-alert v-if="result.analysis.overflows > 0" type="warning" variant="tonal" density="compact" class="mb-2">
						{{ $t("plugins.resonanceLab.overflows", { count: result.analysis.overflows }) }}
					</v-alert>

					<v-card v-if="verdict" variant="tonal" :color="verdict.color" class="mb-3">
						<v-card-text class="d-flex align-center flex-wrap ga-3 py-3">
							<v-icon size="large">{{ verdict.icon }}</v-icon>
							<div class="flex-grow-1">
								<div class="text-subtitle-1 font-weight-medium">{{ verdict.headline }}</div>
								<div class="text-body-2">{{ verdict.detail }}</div>
							</div>
							<v-select v-if="rec" v-model="overlay" :items="overlayItems" item-title="title" item-value="value"
									  density="compact" variant="outlined" hide-details style="max-width: 260px"
									  :label="$t('plugins.resonanceLab.results.compare')" />
							<v-btn v-if="rec" color="primary" prepend-icon="mdi-check" :loading="applying" :disabled="!isConnected" @click="applyShaper">
								{{ $t("plugins.resonanceLab.results.apply", { shaper: displayName(overlay) }) }}
							</v-btn>
							<v-btn v-if="appliedFit" variant="tonal" prepend-icon="mdi-check-decagram-outline" :loading="running" :disabled="!isConnected" @click="verify">
								{{ $t("plugins.resonanceLab.results.verify") }}
							</v-btn>
						</v-card-text>
					</v-card>

					<v-alert v-if="verifyResult" :type="verifyResult.reduction > 0.5 ? 'success' : 'warning'" variant="tonal" density="comfortable" class="mb-2">
						{{ $t("plugins.resonanceLab.results.verified", { reduction: (verifyResult.reduction * 100).toFixed(0) }) }}
					</v-alert>
					<div v-if="!verifyResult && result.capture" class="d-flex justify-end mb-1">
						<v-btn-toggle v-model="chartMode" density="compact" variant="outlined" mandatory>
							<v-btn value="spectrum" size="small" prepend-icon="mdi-chart-bell-curve">{{ $t("plugins.resonanceLab.results.spectrum") }}</v-btn>
							<v-btn value="spectrogram" size="small" prepend-icon="mdi-blur-linear">{{ $t("plugins.resonanceLab.results.spectrogram") }}</v-btn>
						</v-btn-toggle>
					</div>
					<div class="flex-grow-1" style="min-height: 320px">
						<SpectrogramView v-if="!verifyResult && chartMode === 'spectrogram' && spectrogram" :spec="spectrogram" />
						<LineChart v-else-if="verifyResult"
								   :labels="verifyResult.before.labels"
								   :series="[
								   	{ label: $t('plugins.resonanceLab.results.before'), data: verifyResult.before.data, color: '#2196f3' },
								   	{ label: $t('plugins.resonanceLab.results.after'), data: verifyResult.after, color: '#4caf50' },
								   ]"
								   x-title="Frequency (Hz)" y-title="Vibration (normalised)" />
						<SpectrumChart v-else :analysis="result.analysis" :overlay-shaper="overlay" />
					</div>

					<div class="d-flex align-center flex-wrap ga-4 mt-2 text-caption text-medium-emphasis">
						<span>{{ $t("plugins.resonanceLab.results.source", { source: result.source }) }}</span>
						<span>{{ $t("plugins.resonanceLab.results.samples", { count: result.analysis.sampleCount, rate: result.analysis.samplingRate }) }}</span>
						<span v-for="p in result.analysis.peaks.slice(0, 3)" :key="p.freq">
							{{ $t("plugins.resonanceLab.results.peak", { freq: p.freq.toFixed(1) }) }}<template v-if="p.dampingRatio"> (ζ≈{{ p.dampingRatio.toFixed(3) }})</template>
						</span>
					</div>
				</template>

				<!-- Accelerometer orientation check result -->
				<template v-else-if="orientationResult">
					<v-card variant="tonal" :color="orientationResult.solution.iParam ? 'success' : 'warning'" class="mb-3">
						<v-card-text class="d-flex align-center flex-wrap ga-3 py-3">
							<v-icon size="large">{{ orientationResult.solution.iParam ? "mdi-axis-arrow-info" : "mdi-axis-arrow-lock" }}</v-icon>
							<div class="flex-grow-1">
								<div class="text-subtitle-1 font-weight-medium">{{ orientationResult.solution.summary.join(" · ") }}</div>
								<div v-if="orientationResult.solution.iParam" class="text-body-2">
									{{ $t("plugins.resonanceLab.orientation.suggest") }}
									<code>M955 P{{ orientationResult.accelId }} I{{ orientationResult.solution.iParam }}</code>
								</div>
								<div v-else class="text-body-2">{{ $t("plugins.resonanceLab.orientation.underdetermined") }}</div>
								<div v-if="orientationResult.solution.conflicts.length" class="text-caption text-warning">
									{{ $t("plugins.resonanceLab.orientation.conflict", { axes: orientationResult.solution.conflicts.join(", ") }) }}
								</div>
								<div v-if="orientationResult.coupling > 0.6" class="text-caption text-warning">
									{{ $t("plugins.resonanceLab.orientation.coupling", { pct: (orientationResult.coupling * 100).toFixed(0) }) }}
								</div>
							</div>
							<v-btn v-if="orientationResult.solution.iParam" color="primary" prepend-icon="mdi-check" :disabled="!isConnected"
								   @click="applyOrientation">
								{{ $t("plugins.resonanceLab.orientation.apply") }}
							</v-btn>
						</v-card-text>
					</v-card>
				</template>

				<!-- Belt comparison result -->
				<template v-else-if="beltResult && beltVerdict && beltChart">
					<v-card variant="tonal" :color="beltVerdict.color" class="mb-3">
						<v-card-text class="d-flex align-center ga-3 py-3">
							<v-icon size="large">{{ beltVerdict.icon }}</v-icon>
							<div>
								<div class="text-subtitle-1 font-weight-medium">{{ beltVerdict.headline }}</div>
								<div class="text-body-2">{{ beltVerdict.detail }}</div>
							</div>
						</v-card-text>
					</v-card>
					<div class="flex-grow-1" style="min-height: 320px">
						<LineChart :labels="beltChart.labels" :series="beltChart.series"
								   x-title="Frequency (Hz)" y-title="Vibration" />
					</div>
				</template>

				<!-- Vibration profile result -->
				<template v-else-if="profileResult && profileVerdict && profileChart">
					<v-card variant="tonal" :color="profileVerdict.color" class="mb-3">
						<v-card-text class="d-flex align-center ga-3 py-3">
							<v-icon size="large">{{ profileVerdict.icon }}</v-icon>
							<div>
								<div class="text-subtitle-1 font-weight-medium">{{ profileVerdict.headline }}</div>
								<div class="text-body-2">{{ profileVerdict.detail }}</div>
							</div>
						</v-card-text>
					</v-card>
					<div class="flex-grow-1" style="min-height: 320px">
						<LineChart :labels="profileChart.labels" :series="profileChart.series"
								   x-title="Speed (mm/s)" y-title="Vibration energy" />
					</div>
				</template>

				<!-- Empty state -->
				<div v-else-if="!running" class="flex-grow-1 d-flex flex-column align-center justify-center text-medium-emphasis">
					<v-icon size="64" class="mb-3">mdi-sine-wave</v-icon>
					<div class="text-body-1">{{ $t("plugins.resonanceLab.emptyState") }}</div>
					<div class="text-caption mt-1">{{ $t("plugins.resonanceLab.emptyHint") }}</div>
				</div>
			</div>
		</div>
	</v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";
import i18n from "@/i18n";

import { buildReport, downloadReport } from "dwc-plugin-runtime";

import { compareBelts } from "./analysis/belts";
import { analyzeAxisBurst, detectVerticalAxis, solveOrientation, type OrientationSolution } from "./analysis/axesMap";
import { analyseCapture } from "./analysis/pipeline";
import { SHAPER_DISPLAY_NAMES, type ShaperName } from "./analysis/shapers";
import { buildVibrationProfile } from "./analysis/vibration";
import { parseAccelCsv } from "./capture/csv";
import {
	downloadCapture, findAccelerometers, runBeltCapture, runFixedExcitation, runNativeCapture,
	runSpeedPointCapture, runSweepCapture, type MachineIO,
} from "./capture/orchestrator";
import { computeSpectrogram } from "./analysis/stft";
import LineChart from "./components/LineChart.vue";
import SpectrogramView from "./components/SpectrogramView.vue";
import SpectrumChart from "./components/SpectrumChart.vue";
import { beltResult, lastResult, measurementRunning, profileResult } from "./state";
import { applyUpdateNow, runUpdateCheck, updateApplying, updatePendingReload, updateState } from "./updateCheck";

onMounted(() => { void runUpdateCheck(); });
const reload = () => window.location.reload();

const machineStore = useMachineStore();
const uiStore = useUiStore();
const t = (k: string, args?: Record<string, unknown>) => i18n.global.t(`plugins.resonanceLab.${k}`, args ?? {});

const isConnected = computed(() => machineStore.isConnected);
const running = measurementRunning;
const result = lastResult;
const error = ref("");
const applying = ref(false);
const filePicker = ref<HTMLInputElement | null>(null);

// ── Controls ─────────────────────────────────────────────────────────────────
const accelItems = computed(() => findAccelerometers(machineStore.model));
const selectedAccel = ref<{ id: string; label: string } | null>(null);
// Keep a real accelerometer selected: default to the first, and never leave a stale pick.
// (Previously the picker could read empty while measurements silently used accelItems[0].)
watch(accelItems, (items) => {
	if (items.length === 0) {
		selectedAccel.value = null;
	} else if (!selectedAccel.value || !items.some((i) => i.id === selectedAccel.value!.id)) {
		selectedAccel.value = items[0];
	}
}, { immediate: true });

const axisItems = computed(() => {
	const axes = (machineStore.model as { move?: { axes?: Array<{ letter?: string; visible?: boolean }> } }).move?.axes ?? [];
	const letters = axes.filter((a) => a.visible !== false && a.letter).map((a) => a.letter!);
	return letters.length > 0 ? letters : ["X", "Y"];
});
const selectedAxis = ref("X");

type Method = "sweep" | "move" | "custom" | "belts" | "profile" | "excite" | "axescheck";
const method = ref<Method>("sweep");

const adv = ref({
	startFreq: 5, endFreq: 135, hzPerSec: 1, maxSmoothing: 0,
	beltStart: 15, beltEnd: 95, beltHz: 2,
	exciteFreq: 40, exciteSeconds: 10,
	speedMin: 30, speedMax: 180, speedStep: 30,
	customMoves: "",
});

// Each task is a self-contained job: its icon, whether it uses a single axis, and exactly which
// parameters it exposes. The panel renders only these, so no irrelevant knob is ever shown.
interface TaskDef { id: Method; group: "goal" | "diag"; icon: string; usesAxis: boolean; params: Array<string> }
const TASKS: ReadonlyArray<TaskDef> = [
	{ id: "sweep", group: "goal", icon: "mdi-tune-variant", usesAxis: true, params: ["startFreq", "endFreq", "hzPerSec", "maxSmoothing"] },
	{ id: "belts", group: "goal", icon: "mdi-scale-balance", usesAxis: false, params: ["beltStart", "beltEnd", "beltHz"] },
	{ id: "profile", group: "goal", icon: "mdi-speedometer", usesAxis: true, params: ["speedMin", "speedMax", "speedStep"] },
	{ id: "axescheck", group: "goal", icon: "mdi-axis-arrow", usesAxis: false, params: [] },
	{ id: "excite", group: "diag", icon: "mdi-pulse", usesAxis: true, params: ["exciteFreq", "exciteSeconds"] },
	{ id: "move", group: "diag", icon: "mdi-arrow-left-right", usesAxis: true, params: ["maxSmoothing"] },
	{ id: "custom", group: "diag", icon: "mdi-code-braces", usesAxis: true, params: ["maxSmoothing", "customMoves"] },
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
	error.value = "";
}

/** Rough wall-clock estimate for the active task, derived from its live parameters. */
const durationEstimate = computed(() => {
	const a = adv.value;
	let secs: number;
	switch (method.value) {
		case "sweep": secs = (a.endFreq - a.startFreq) / Math.max(0.1, a.hzPerSec) + 6; break;
		case "belts": secs = 2 * ((a.beltEnd - a.beltStart) / Math.max(0.1, a.beltHz) + 8); break;
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

const canMeasure = computed(() => isConnected.value && !running.value
	&& (selectedAccel.value !== null || accelItems.value.length > 0));

// ── Measurement ──────────────────────────────────────────────────────────────
/**
 * The firmware's completed-sampling-run counter for an accelerometer
 * (`boards[].accelerometer.runs`). Ticks the instant the CSV is closed — the authoritative
 * "recording done" signal. Accel ids are "<canAddress>.0" (CAN boards) or "0" (mainboard).
 */
function readAccelRuns(accelId: string): number {
	const boardId = parseInt(accelId, 10) || 0;
	const boards = (machineStore.model as { boards?: Array<{ canAddress?: number | null; accelerometer?: { runs?: number } | null } | null> }).boards ?? [];
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

const io: MachineIO = {
	sendCode: async (code) => String(await machineStore.sendCode(code) ?? ""),
	upload: async (path, content) => { await machineStore.upload({ filename: path, content }, false, false, true); },
	download: async (path) => String(await machineStore.download({ filename: path, type: "text" }, false, false, false)),
	accelRuns: (accelId) => readAccelRuns(accelId),
	awaitAccelRun: (accelId, from, timeoutMs) => awaitAccelRun(accelId, from, timeoutMs),
};

/** Centre of the selected axis's travel, from the object model (fallback: current position). */
function axisCenter(): number {
	const axes = (machineStore.model as { move?: { axes?: Array<{ letter?: string; min?: number; max?: number; userPosition?: number | null }> } }).move?.axes ?? [];
	const ax = axes.find((a) => a.letter === selectedAxis.value);
	if (ax && typeof ax.min === "number" && typeof ax.max === "number" && ax.max > ax.min) {
		return Math.round((ax.min + ax.max) / 2);
	}
	return ax?.userPosition ?? 0;
}

/** Centre of an arbitrary axis's travel (for the dual-axis belt test). */
function centerOf(letter: string): number {
	const axes = (machineStore.model as { move?: { axes?: Array<{ letter?: string; min?: number; max?: number }> } }).move?.axes ?? [];
	const ax = axes.find((a) => a.letter === letter);
	return ax && typeof ax.min === "number" && typeof ax.max === "number" && ax.max > ax.min
		? Math.round((ax.min + ax.max) / 2) : 0;
}

async function measure(): Promise<void> {
	const accel = selectedAccel.value ?? accelItems.value[0];
	if (!accel) {
		return;
	}
	// Guard: every visible axis must be homed before we shake the machine.
	const axesModel = (machineStore.model as { move?: { axes?: Array<{ visible?: boolean; homed?: boolean }> } }).move?.axes ?? [];
	if (axesModel.some((a) => a.visible !== false && a.homed === false)) {
		error.value = t("notHomed");
		return;
	}
	running.value = true;
	error.value = "";
	beltResult.value = null;
	profileResult.value = null;
	orientationResult.value = null;
	verifyResult.value = null;
	try {
		if (method.value === "belts" && !String((machineStore.model as { move?: { kinematics?: { name?: string } } }).move?.kinematics?.name ?? "").toLowerCase().includes("core")) {
			error.value = t("belts.notCoreXY");
			running.value = false;
			return;
		}
		if (method.value === "excite") {
			const run = await runFixedExcitation(io, {
				accelerometer: accel, axis: selectedAxis.value, center: axisCenter(),
				freq: adv.value.exciteFreq, seconds: adv.value.exciteSeconds,
			});
			finish(parse(await downloadCapture(io, run)), `${selectedAxis.value} · ${adv.value.exciteFreq} Hz`);
		} else if (method.value === "axescheck") {
			// One sharp move per horizontal axis; gravity (pre-motion DC) pins the vertical.
			const moveResults: Partial<Record<"X" | "Y", ReturnType<typeof analyzeAxisBurst>>> = {};
			let firstCapture: ReturnType<typeof parseAccelCsv> | null = null;
			for (const ax of ["X", "Y"] as const) {
				const run = await runNativeCapture(io, { accelerometer: accel, axis: ax, center: centerOf(ax), span: 20 });
				const capture = parseAccelCsv(await downloadCapture(io, run));
				firstCapture = firstCapture ?? capture;
				moveResults[ax] = analyzeAxisBurst(capture);
			}
			const gravity = detectVerticalAxis(firstCapture!, moveResults.X!.dc);
			orientationResult.value = { solution: solveOrientation(moveResults, gravity), accelId: accel.id, coupling: Math.max(moveResults.X!.coupling, moveResults.Y!.coupling) };
			lastResult.value = null;
		} else if (method.value === "belts") {
			// Tension matching only needs the band the belt resonances live in — a light 15–95 Hz
			// sweep at 2 Hz/s (~40s per belt), not the full calibration band. Defaults are belt-specific.
			const opts = {
				accelerometer: accel, centerX: centerOf("X"), centerY: centerOf("Y"),
				startFreq: adv.value.beltStart, endFreq: adv.value.beltEnd, hzPerSec: adv.value.beltHz,
			};
			const runA = await runBeltCapture(io, { ...opts, belt: "a" });
			const a = await downloadCapture(io, runA);
			const runB = await runBeltCapture(io, { ...opts, belt: "b" });
			const b = await downloadCapture(io, runB);
			lastResult.value = null;
			beltResult.value = compareBelts(parseAccelCsv(a), parseAccelCsv(b));
		} else if (method.value === "profile") {
			const entries: Array<{ speed: number; capture: ReturnType<typeof parseAccelCsv> }> = [];
			for (let speed = adv.value.speedMin; speed <= adv.value.speedMax; speed += Math.max(1, adv.value.speedStep)) {
				const run = await runSpeedPointCapture(io, { accelerometer: accel, axis: selectedAxis.value, center: axisCenter(), speed });
				entries.push({ speed, capture: parseAccelCsv(await downloadCapture(io, run)) });
			}
			lastResult.value = null;
			profileResult.value = buildVibrationProfile(entries);
		} else {
			const common = { accelerometer: accel, axis: selectedAxis.value, center: axisCenter() };
			const run = method.value === "sweep"
				? await runSweepCapture(io, { ...common, startFreq: adv.value.startFreq, endFreq: adv.value.endFreq, hzPerSec: adv.value.hzPerSec })
				: await runNativeCapture(io, {
					...common,
					customMoves: method.value === "custom" && adv.value.customMoves.trim()
						? adv.value.customMoves.split("\n").map((l) => l.trim()).filter(Boolean)
						: undefined,
				});
			const csv = await downloadCapture(io, run);
			finish(parse(csv), `${selectedAxis.value} · ${t(`methods.${method.value}`)}`);
		}
	} catch (e) {
		error.value = (e as Error).message || String(e);
	} finally {
		running.value = false;
	}
}

// ── Verify loop & orientation ────────────────────────────────────────────────
const orientationResult = ref<{ solution: OrientationSolution; accelId: string; coupling: number } | null>(null);
const verifyResult = ref<{ reduction: number; before: { labels: Array<number>; data: Array<number> }; after: Array<number> } | null>(null);
const appliedFit = ref<{ name: ShaperName; freq: number } | null>(null);

/** Re-run the same sweep with the shaper ACTIVE and compare energy before/after. */
async function verify(): Promise<void> {
	const accel = selectedAccel.value ?? accelItems.value[0];
	const before = result.value;
	if (!accel || !before) {
		return;
	}
	running.value = true;
	error.value = "";
	try {
		const run = await runSweepCapture(io, {
			accelerometer: accel, axis: before.axis, center: axisCenter(),
			startFreq: adv.value.startFreq, endFreq: adv.value.endFreq, hzPerSec: adv.value.hzPerSec,
			keepShaper: true,
		});
		const after = analyseCapture(parseAccelCsv(await downloadCapture(io, run)));
		const eBefore = before.analysis.normalized.reduce((a, b) => a + b, 0);
		const eAfter = after.normalized.reduce((a, b) => a + b, 0);
		const labels: Array<number> = [];
		const beforeData: Array<number> = [];
		const afterData: Array<number> = [];
		const maxFreq = 200;
		for (let i = 0; i < before.analysis.spectrum.freqs.length && before.analysis.spectrum.freqs[i] <= maxFreq; i++) {
			labels.push(Math.round(before.analysis.spectrum.freqs[i] * 10) / 10);
			beforeData.push(before.analysis.normalized[i]);
			afterData.push(after.normalized[i] ?? 0);
		}
		verifyResult.value = { reduction: eBefore > 0 ? 1 - eAfter / eBefore : 0, before: { labels, data: beforeData }, after: afterData };
	} catch (e) {
		error.value = (e as Error).message || String(e);
	} finally {
		running.value = false;
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

function parse(csvText: string) {
	const capture = parseAccelCsv(csvText);
	return {
		capture,
		analysis: analyseCapture(capture, { maxSmoothing: adv.value.maxSmoothing > 0 ? adv.value.maxSmoothing : undefined }),
	};
}

function finish(parsed: ReturnType<typeof parse>, source: string): void {
	result.value = { axis: selectedAxis.value, when: new Date(), source, analysis: parsed.analysis, capture: parsed.capture };
	overlay.value = parsed.analysis.recommendation?.best.name ?? "mzv";
	chartMode.value = "spectrum";
}

// ── Spectrogram view ─────────────────────────────────────────────────────────
const chartMode = ref<"spectrum" | "spectrogram">("spectrum");
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
const remoteCaptures = ref<Array<string>>([]);
async function refreshRemoteCaptures(): Promise<void> {
	try {
		const files = await (machineStore as unknown as { getFileList(dir: string): Promise<Array<{ name: string; isDirectory?: boolean }>> })
			.getFileList("0:/sys/accelerometer");
		remoteCaptures.value = files.filter((f) => !f.isDirectory && f.name.toLowerCase().endsWith(".csv")).map((f) => f.name).sort().reverse();
	} catch {
		remoteCaptures.value = [];
	}
}
async function openRemoteCapture(name: string): Promise<void> {
	try {
		finish(parse(await io.download(`0:/sys/accelerometer/${name}`)), name);
		error.value = "";
	} catch (e) {
		error.value = (e as Error).message || String(e);
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
		detail: t("results.detail", { smoothing: fit.smoothing.toFixed(3), accel: fit.maxAccel, peak: a.peaks[0]?.freq.toFixed(1) ?? "?" }),
	};
});

function downloadDiagnostics(): void {
	const r = result.value;
	downloadReport(buildReport({
		pluginId: "ResonanceLab",
		model: machineStore.model,
		state: r ? {
			axis: r.axis, source: r.source, when: r.when.toISOString(),
			samplingRate: r.analysis.samplingRate, overflows: r.analysis.overflows,
			sampleCount: r.analysis.sampleCount,
			peaks: r.analysis.peaks.slice(0, 5),
			// Strip the per-bin response array - the report only needs the verdict numbers.
			best: r.analysis.recommendation
				? (({ name, freq, vibrations, smoothing, maxAccel }) => ({ name, freq, vibrations, smoothing, maxAccel }))(r.analysis.recommendation.best)
				: null,
		} : undefined,
	}));
}

async function applyOrientation(): Promise<void> {
	const o = orientationResult.value;
	if (!o?.solution.iParam) {
		return;
	}
	await machineStore.sendCode(`M955 P${o.accelId} I${o.solution.iParam}`);
	uiStore.makeNotification(LogLevel.success, "Resonance Lab", t("orientation.applied", { i: o.solution.iParam }));
}

async function applyShaper(): Promise<void> {
	const fit = rec.value?.allShapers.find((s) => s.name === overlay.value) ?? rec.value?.best;
	if (!fit) {
		return;
	}
	applying.value = true;
	try {
		await machineStore.sendCode(`M593 P"${fit.name}" F${fit.freq.toFixed(1)}`);
		appliedFit.value = { name: fit.name, freq: fit.freq };
		uiStore.makeNotification(LogLevel.success, "Resonance Lab", t("results.applied", { shaper: SHAPER_DISPLAY_NAMES[fit.name], freq: fit.freq.toFixed(1) }));
	} catch (e) {
		uiStore.makeNotification(LogLevel.error, "Resonance Lab", (e as Error).message || String(e));
	} finally {
		applying.value = false;
	}
}
</script>
