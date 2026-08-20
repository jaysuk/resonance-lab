<!--
  The main spectrum chart: measured (normalised) vibration spectrum, the recommended shaper's
  worst-case response (against the right-hand axis), and the residual after shaping. Renders with
  Chart.js (bundled), theme-aware, and guards canvas access so test environments without a 2D
  context simply render nothing.
-->
<template>
	<div class="rlab-chart">
		<canvas ref="canvas" />
	</div>
</template>

<script setup lang="ts">
import { Chart, type ChartDataset } from "chart.js/auto";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { normalizeToFrequencies } from "../../analysis/recommend";
import type { CaptureAnalysis } from "../../analysis/pipeline";

/** Muted, distinguishable colours for the raw per-channel overlay - deliberately not reusing the
 *  measured/after-shaper/response palette above so the two concerns stay visually separable. */
const CHANNEL_COLORS = ["#ab47bc", "#26a69a", "#8d6e63", "#7e57c2", "#5c6bc0"];

const props = defineProps<{
	analysis: CaptureAnalysis;
	/** Which shaper from the recommendation to overlay (name), defaults to the best one. */
	overlayShaper?: string;
	/** Raw per-channel axis labels from the capture (e.g. ["X","Y","Z"]), same order as analysis.spectrum.psd. */
	channelLabels?: Array<string>;
	/** Overlay each raw channel's own (frequency-weighted) spectrum alongside the combined "Measured" curve. */
	showChannels?: boolean;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

/** Format a value with ~3 significant figures so tiny normalised numbers don't round to 0. */
function fmtVal(v: number): string {
	if (!isFinite(v) || v === 0) {
		return "0";
	}
	const abs = Math.abs(v);
	return abs >= 1 ? v.toFixed(2) : v.toFixed(Math.min(8, 2 - Math.floor(Math.log10(abs))));
}

function buildDatasets(): { labels: Array<number>; datasets: Array<ChartDataset<"line">> } {
	const a = props.analysis;
	const rec = a.recommendation;
	// rec.freqBins is already restricted to whatever band the fit was scored on (the sweep's own
	// Start/End Hz, when known) - mirror that bound here so "Measured" lines up index-for-index with
	// fit.vals/residual below, instead of showing spectrum content outside the tested range.
	const minFreq = rec ? rec.freqBins[0] : 0;
	const maxFreq = rec ? rec.freqBins[rec.freqBins.length - 1] : 200;

	const labels: Array<number> = [];
	const measured: Array<number> = [];
	const includedIdx: Array<number> = []; // raw spectrum.freqs index behind each label - needed below since minFreq can skip a leading run
	for (let i = 0; i < a.spectrum.freqs.length; i++) {
		const f = a.spectrum.freqs[i];
		if (f < minFreq) {
			continue;
		}
		if (f > maxFreq) {
			break;
		}
		labels.push(Math.round(f * 10) / 10);
		measured.push(a.normalized[i]);
		includedIdx.push(i);
	}

	const datasets: Array<ChartDataset<"line">> = [{
		label: "Measured",
		data: measured,
		borderColor: "#2196f3",
		backgroundColor: "rgba(33,150,243,0.18)",
		fill: true, pointRadius: 0, borderWidth: 1.5, tension: 0.15,
	}];

	if (rec) {
		const fit = rec.allShapers.find((s) => s.name === (props.overlayShaper ?? rec.best.name)) ?? rec.best;
		// Shaper response (0..1) and the spectrum that survives it.
		const response: Array<number> = [];
		const residual: Array<number> = [];
		for (let i = 0; i < labels.length; i++) {
			// freqBins of the fit align with the <=maxFreq slice of spectrum freqs.
			const v = i < fit.vals.length ? fit.vals[i] : 1;
			response.push(v);
			residual.push(measured[i] * v);
		}
		datasets.push({
			label: "After shaper",
			data: residual,
			borderColor: "#4caf50",
			backgroundColor: "rgba(76,175,80,0.25)",
			fill: true, pointRadius: 0, borderWidth: 1.5, tension: 0.15,
		});
		datasets.push({
			label: "Shaper response",
			data: response,
			borderColor: "#ff9800",
			borderDash: [6, 4],
			fill: false, pointRadius: 0, borderWidth: 1.25, tension: 0.15,
			yAxisID: "y1",
		});
	}

	// Raw per-channel breakdown (X/Y/Z as captured) - same frequency-weighting as "Measured" (which is
	// just their sum) so the curves sit on the same visual scale and add up to it.
	if (props.showChannels && props.channelLabels?.length) {
		a.spectrum.psd.forEach((psd, i) => {
			const label = props.channelLabels![i] ?? `ch${i}`;
			const weighted = normalizeToFrequencies(a.spectrum.freqs, psd);
			const data = includedIdx.map((idx) => weighted[idx] ?? 0);
			datasets.push({
				label,
				data,
				borderColor: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
				fill: false, pointRadius: 0, borderWidth: 1, borderDash: [2, 2], tension: 0.15,
			});
		});
	}
	return { labels, datasets };
}

function render(): void {
	if (!canvas.value) {
		return;
	}
	const ctx = canvas.value.getContext?.("2d");
	if (!ctx) {
		return; // no 2D context (test environment) - nothing to draw
	}
	const { labels, datasets } = buildDatasets();
	if (chart) {
		chart.destroy();
	}
	chart = new Chart(ctx, {
		type: "line",
		data: { labels, datasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			interaction: { mode: "index", intersect: false },
			plugins: {
				legend: { position: "top", labels: { boxWidth: 14, usePointStyle: true } },
				tooltip: { callbacks: { title: (items) => `${items[0].label} Hz`, label: (c) => `${c.dataset.label}: ${fmtVal(c.parsed.y as number)}` } },
			},
			scales: {
				x: { title: { display: true, text: "Frequency (Hz)" }, ticks: { maxTicksLimit: 14 } },
				y: { title: { display: true, text: "Vibration (normalised)" }, beginAtZero: true, ticks: { maxTicksLimit: 8 } },
				y1: {
					position: "right", min: 0, max: 1.05, grid: { drawOnChartArea: false },
					title: { display: true, text: "Shaper response" },
				},
			},
		},
	});
}

onMounted(render);
watch(() => [props.analysis, props.overlayShaper, props.showChannels, props.channelLabels], render);
onBeforeUnmount(() => {
	chart?.destroy();
	chart = null;
});
</script>

<style scoped>
.rlab-chart {
	position: relative;
	width: 100%;
	height: 100%;
	min-height: 420px;
}
</style>
