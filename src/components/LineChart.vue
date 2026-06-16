<!-- Generic Chart.js line chart for the comparison views (belts, vibration profile). -->
<template>
	<div class="rlab-chart"><canvas ref="canvas" /></div>
</template>

<script setup lang="ts">
import { Chart } from "chart.js/auto";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
	labels: Array<number | string>;
	series: Array<{ label: string; data: Array<number>; color: string; dash?: boolean }>;
	xTitle: string;
	yTitle: string;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

function render(): void {
	const ctx = canvas.value?.getContext?.("2d");
	if (!ctx) {
		return; // test environments have no 2D context
	}
	chart?.destroy();
	chart = new Chart(ctx, {
		type: "line",
		data: {
			labels: props.labels,
			datasets: props.series.map((s) => ({
				label: s.label, data: s.data, borderColor: s.color,
				backgroundColor: `${s.color}30`, fill: !s.dash, borderDash: s.dash ? [6, 4] : undefined,
				pointRadius: props.labels.length <= 24 ? 3 : 0, borderWidth: 1.5, tension: 0.15,
			})),
		},
		options: {
			responsive: true, maintainAspectRatio: false, animation: false,
			interaction: { mode: "index", intersect: false },
			plugins: { legend: { position: "top", labels: { boxWidth: 14, usePointStyle: true } } },
			scales: {
				x: { title: { display: true, text: props.xTitle }, ticks: { maxTicksLimit: 14 } },
				y: { title: { display: true, text: props.yTitle }, beginAtZero: true, ticks: { maxTicksLimit: 8 } },
			},
		},
	});
}

onMounted(render);
watch(() => [props.labels, props.series], render);
onBeforeUnmount(() => { chart?.destroy(); chart = null; });
</script>

<style scoped>
.rlab-chart { position: relative; width: 100%; height: 100%; min-height: 420px; }
</style>
