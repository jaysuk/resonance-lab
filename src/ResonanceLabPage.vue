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
				</v-card>
			</v-menu>

			<v-spacer />
			<v-btn variant="text" prepend-icon="mdi-file-upload-outline" :disabled="running" @click="filePicker?.click()">
				{{ $t("plugins.resonanceLab.controls.loadCsv") }}
			</v-btn>
			<input ref="filePicker" type="file" accept=".csv" class="d-none" @change="loadLocalCsv">
		</div>

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
				</v-card-text>
			</v-card>

			<div class="flex-grow-1" style="min-height: 320px">
				<SpectrumChart :analysis="result.analysis" :overlay-shaper="overlay" />
			</div>

			<div class="d-flex align-center flex-wrap ga-4 mt-2 text-caption text-medium-emphasis">
				<span>{{ $t("plugins.resonanceLab.results.source", { source: result.source }) }}</span>
				<span>{{ $t("plugins.resonanceLab.results.samples", { count: result.analysis.sampleCount, rate: result.analysis.samplingRate }) }}</span>
				<span v-for="p in result.analysis.peaks.slice(0, 3)" :key="p.freq">
					{{ $t("plugins.resonanceLab.results.peak", { freq: p.freq.toFixed(1) }) }}<template v-if="p.dampingRatio"> (ζ≈{{ p.dampingRatio.toFixed(3) }})</template>
				</span>
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
import { computed, ref } from "vue";

import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";
import i18n from "@/i18n";

import { analyseCapture } from "./analysis/pipeline";
import { SHAPER_DISPLAY_NAMES, type ShaperName } from "./analysis/shapers";
import { parseAccelCsv } from "./capture/csv";
import { downloadCapture, findAccelerometers, runNativeCapture, runSweepCapture, type MachineIO } from "./capture/orchestrator";
import SpectrumChart from "./components/SpectrumChart.vue";
import { lastResult, measurementRunning } from "./state";

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
const method = ref<"sweep" | "move" | "custom">("sweep");
const methodItems = computed(() => [
	{ title: t("methods.sweep"), value: "sweep" },
	{ title: t("methods.move"), value: "move" },
	{ title: t("methods.custom"), value: "custom" },
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

async function measure(): Promise<void> {
	const accel = selectedAccel.value ?? accelItems.value[0];
	if (!accel) {
		return;
	}
	running.value = true;
	error.value = "";
	try {
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
	} catch (e) {
		error.value = (e as Error).message || String(e);
	} finally {
		running.value = false;
	}
}

function parse(csvText: string) {
	return analyseCapture(parseAccelCsv(csvText), {
		maxSmoothing: adv.value.maxSmoothing > 0 ? adv.value.maxSmoothing : undefined,
	});
}

function finish(analysis: ReturnType<typeof analyseCapture>, source: string): void {
	result.value = { axis: selectedAxis.value, when: new Date(), source, analysis };
	overlay.value = analysis.recommendation?.best.name ?? "mzv";
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

async function applyShaper(): Promise<void> {
	const fit = rec.value?.allShapers.find((s) => s.name === overlay.value) ?? rec.value?.best;
	if (!fit) {
		return;
	}
	applying.value = true;
	try {
		await machineStore.sendCode(`M593 P"${fit.name}" F${fit.freq.toFixed(1)}`);
		uiStore.makeNotification(LogLevel.success, "Resonance Lab", t("results.applied", { shaper: SHAPER_DISPLAY_NAMES[fit.name], freq: fit.freq.toFixed(1) }));
	} catch (e) {
		uiStore.makeNotification(LogLevel.error, "Resonance Lab", (e as Error).message || String(e));
	} finally {
		applying.value = false;
	}
}
</script>
