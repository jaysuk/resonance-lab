<!--
  Resonance Lab - the lab page.

  Layout philosophy: one compact control bar of dropdowns up top, then ALL remaining space goes to
  the chart and the verdict. No wizards, no tab maze: pick accelerometer + axis + method, press
  Measure, read the sentence, press Apply. Advanced knobs live behind a single menu.
-->
<template>
	<v-container fluid class="d-flex flex-column fill-height pa-3">
		<!-- Control bar -->
		<div class="d-flex align-center flex-wrap ga-2 mb-3">
			<v-icon size="large" class="me-1">mdi-sine-wave</v-icon>
			<v-select v-model="selectedAccel" :items="accelItems" item-title="label" return-object density="compact"
					  variant="outlined" hide-details style="max-width: 200px"
					  :label="$t('plugins.resonanceLab.controls.accelerometer')" :disabled="running" />
			<v-select v-model="selectedAxis" :items="axisItems" density="compact" variant="outlined" hide-details
					  style="max-width: 110px" :label="$t('plugins.resonanceLab.controls.axis')" :disabled="running" />
			<v-select v-model="method" :items="methodItems" item-title="title" item-value="value" density="compact"
					  variant="outlined" hide-details style="max-width: 230px"
					  :label="$t('plugins.resonanceLab.controls.method')" :disabled="running" />
			<v-btn color="primary" prepend-icon="mdi-play" :loading="running"
				   :disabled="!canMeasure" @click="measure">
				{{ $t("plugins.resonanceLab.controls.measure") }}
			</v-btn>

			<!-- Advanced options: one menu, not a settings wall -->
			<v-menu :close-on-content-click="false">
				<template #activator="{ props: m }">
					<v-btn v-bind="m" icon="mdi-tune" variant="text" :title="$t('plugins.resonanceLab.controls.advanced')" />
				</template>
				<v-card min-width="340" class="pa-3">
					<div class="text-subtitle-2 mb-2">{{ $t("plugins.resonanceLab.controls.advanced") }}</div>
					<v-row dense>
						<v-col cols="6"><v-text-field v-model.number="adv.startFreq" type="number" density="compact" variant="outlined" hide-details label="Start (Hz)" /></v-col>
						<v-col cols="6"><v-text-field v-model.number="adv.endFreq" type="number" density="compact" variant="outlined" hide-details label="End (Hz)" /></v-col>
						<v-col cols="6"><v-text-field v-model.number="adv.hzPerSec" type="number" density="compact" variant="outlined" hide-details label="Sweep (Hz/s)" /></v-col>
						<v-col cols="6"><v-text-field v-model.number="adv.maxSmoothing" type="number" step="0.01" density="compact" variant="outlined" hide-details :label="$t('plugins.resonanceLab.controls.maxSmoothing')" /></v-col>
					</v-row>
					<v-textarea v-if="method === 'custom'" v-model="adv.customMoves" class="mt-2" density="compact" variant="outlined"
								rows="4" hide-details :label="$t('plugins.resonanceLab.controls.customMoves')" />
					<div class="text-caption text-medium-emphasis mt-2">{{ $t("plugins.resonanceLab.controls.advancedHint") }}</div>
					<v-divider class="my-2" />
					<v-btn size="small" variant="tonal" block prepend-icon="mdi-bug-outline" @click="downloadDiagnostics">
						{{ $t("plugins.resonanceLab.controls.diagnostics") }}
					</v-btn>
				</v-card>
			</v-menu>

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
			<input ref="filePicker" type="file" accept=".csv" class="d-none" @change="loadLocalCsv">
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

		<!-- Readiness / progress -->
		<v-alert v-if="!isConnected" type="info" variant="tonal" density="compact" class="mb-3">
			{{ $t("plugins.resonanceLab.notConnected") }}
		</v-alert>
		<v-alert v-else-if="accelItems.length === 0" type="warning" variant="tonal" density="compact" class="mb-3">
			{{ $t("plugins.resonanceLab.accelMissing") }}
		</v-alert>
		<v-alert v-else-if="running" type="info" variant="tonal" density="compact" class="mb-3">
			<v-progress-circular indeterminate size="16" width="2" class="me-2" />
			{{ $t("plugins.resonanceLab.measuring", { axis: selectedAxis }) }}
		</v-alert>
		<v-alert v-else-if="error" type="error" variant="tonal" density="compact" class="mb-3" closable @click:close="error = ''">
			{{ error }}
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
		<v-card v-else-if="orientationResult" variant="tonal" :color="orientationResult.ok ? 'success' : 'error'" class="mb-3">
			<v-card-text class="d-flex align-center ga-3 py-3">
				<v-icon size="large">{{ orientationResult.ok ? "mdi-axis-arrow-info" : "mdi-axis-arrow-lock" }}</v-icon>
				<div>
					<div class="text-subtitle-1 font-weight-medium">
						{{ orientationResult.ok
							? $t("plugins.resonanceLab.orientation.ok", { axis: selectedAxis, dominance: (orientationResult.dominance * 100).toFixed(0) })
							: $t("plugins.resonanceLab.orientation.wrong", { axis: selectedAxis, dominant: orientationResult.dominant }) }}
					</div>
					<div class="text-body-2">{{ $t("plugins.resonanceLab.orientation.detail") }}</div>
				</div>
			</v-card-text>
		</v-card>

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
		<div v-else class="flex-grow-1 d-flex flex-column align-center justify-center text-medium-emphasis">
			<v-icon size="64" class="mb-3">mdi-sine-wave</v-icon>
			<div class="text-body-1">{{ $t("plugins.resonanceLab.emptyState") }}</div>
			<div class="text-caption mt-1">{{ $t("plugins.resonanceLab.emptyHint") }}</div>
		</div>
	</v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";
import i18n from "@/i18n";

import { buildReport, downloadReport } from "dwc-plugin-runtime";

import { compareBelts } from "./analysis/belts";
import { checkOrientation, type OrientationCheck } from "./analysis/orientation";
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
const axisItems = computed(() => {
	const axes = (machineStore.model as { move?: { axes?: Array<{ letter?: string; visible?: boolean }> } }).move?.axes ?? [];
	const letters = axes.filter((a) => a.visible !== false && a.letter).map((a) => a.letter!);
	return letters.length > 0 ? letters : ["X", "Y"];
});
const selectedAxis = ref("X");
const method = ref<"sweep" | "move" | "custom" | "belts" | "profile" | "excite" | "axescheck">("sweep");
const methodItems = computed(() => [
	{ title: t("methods.sweep"), value: "sweep" },
	{ title: t("methods.move"), value: "move" },
	{ title: t("methods.custom"), value: "custom" },
	{ title: t("methods.belts"), value: "belts" },
	{ title: t("methods.profile"), value: "profile" },
	{ title: t("methods.excite"), value: "excite" },
	{ title: t("methods.axescheck"), value: "axescheck" },
]);
const adv = ref({ startFreq: 5, endFreq: 135, hzPerSec: 1, maxSmoothing: 0, customMoves: "" });

const canMeasure = computed(() => isConnected.value && !running.value
	&& (selectedAccel.value !== null || accelItems.value.length > 0));

// ── Measurement ──────────────────────────────────────────────────────────────
const io: MachineIO = {
	sendCode: async (code) => String(await machineStore.sendCode(code) ?? ""),
	upload: async (path, content) => { await machineStore.upload({ filename: path, content }, false, false, true); },
	download: async (path) => String(await machineStore.download({ filename: path, type: "text" }, false, false, false)),
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
				freq: adv.value.startFreq, seconds: 10,
			});
			finish(parse(await downloadCapture(io, run)), `${selectedAxis.value} · ${adv.value.startFreq} Hz`);
		} else if (method.value === "axescheck") {
			const run = await runNativeCapture(io, { accelerometer: accel, axis: selectedAxis.value, center: axisCenter() });
			orientationResult.value = checkOrientation(parseAccelCsv(await downloadCapture(io, run)), selectedAxis.value);
			lastResult.value = null;
		} else if (method.value === "belts") {
			const opts = { accelerometer: accel, centerX: centerOf("X"), centerY: centerOf("Y"), startFreq: adv.value.startFreq, endFreq: adv.value.endFreq, hzPerSec: adv.value.hzPerSec };
			const a = await downloadCapture(io, await runBeltCapture(io, { ...opts, belt: "a" }));
			const b = await downloadCapture(io, await runBeltCapture(io, { ...opts, belt: "b" }));
			lastResult.value = null;
			beltResult.value = compareBelts(parseAccelCsv(a), parseAccelCsv(b));
		} else if (method.value === "profile") {
			const entries: Array<{ speed: number; capture: ReturnType<typeof parseAccelCsv> }> = [];
			for (let speed = 30; speed <= 180; speed += 30) {
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
const orientationResult = ref<OrientationCheck | null>(null);
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
		const tighter = r.energyRatio > 1 ? t("belts.beltB") : t("belts.beltA");
		return { color: "warning", icon: "mdi-scale-unbalanced", headline: t("belts.tension", { sim }), detail: t("belts.tensionDetail", { tighter, ratio: (r.energyRatio > 1 ? r.energyRatio : 1 / r.energyRatio).toFixed(2) }) };
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
