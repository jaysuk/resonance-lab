<!-- Spectrogram heatmap rendered straight to canvas (time -> x, frequency -> y, magnitude -> colour). -->
<template>
	<div class="rlab-spectrogram">
		<div class="rlab-spectrogram-row">
			<div class="rlab-spectrogram-ylabel text-caption text-medium-emphasis">Frequency (Hz)</div>
			<canvas ref="canvas" />
		</div>
		<div class="rlab-spectrogram-labels text-caption text-medium-emphasis">
			<span>0 Hz (bottom)</span>
			<span>{{ spec.freqs[spec.freqs.length - 1]?.toFixed(0) ?? 0 }} Hz (top)</span>
		</div>
		<div class="text-caption text-medium-emphasis text-center mt-1">
			Time (s): 0 → {{ spec.times[spec.times.length - 1]?.toFixed(0) ?? 0 }}
		</div>
	</div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";

import type { Spectrogram } from "../../analysis/stft";

const props = defineProps<{ spec: Spectrogram }>();
const canvas = ref<HTMLCanvasElement | null>(null);

/** Dark-friendly 3-stop colour ramp (deep blue -> orange -> white-hot). */
function color(v: number): [number, number, number] {
	if (v < 0.5) {
		const t = v * 2;
		return [Math.round(20 + 235 * t * 0.8), Math.round(30 + 120 * t), Math.round(80 - 40 * t)];
	}
	const t = (v - 0.5) * 2;
	return [Math.round(208 + 47 * t), Math.round(150 + 105 * t), Math.round(40 + 215 * t)];
}

function render(): void {
	const el = canvas.value;
	const ctx = el?.getContext?.("2d");
	if (!el || !ctx) {
		return;
	}
	const cols = props.spec.columns.length;
	const rows = props.spec.freqs.length;
	if (cols === 0 || rows === 0) {
		return;
	}
	el.width = cols;
	el.height = rows;
	const img = ctx.createImageData(cols, rows);
	for (let x = 0; x < cols; x++) {
		const col = props.spec.columns[x];
		for (let y = 0; y < rows; y++) {
			// y inverted: low frequencies at the bottom.
			const [r, g, b] = color(col[y]);
			const idx = ((rows - 1 - y) * cols + x) * 4;
			img.data[idx] = r;
			img.data[idx + 1] = g;
			img.data[idx + 2] = b;
			img.data[idx + 3] = 255;
		}
	}
	ctx.putImageData(img, 0, 0);
}

onMounted(render);
watch(() => props.spec, render);
</script>

<style scoped>
.rlab-spectrogram { position: relative; width: 100%; height: 100%; min-height: 320px; display: flex; flex-direction: column; }
.rlab-spectrogram-row { flex: 1; min-height: 0; display: flex; align-items: stretch; }
.rlab-spectrogram-ylabel {
	writing-mode: vertical-lr;
	transform: rotate(180deg);
	white-space: nowrap;
	display: flex;
	align-items: center;
	justify-content: center;
	padding-right: 4px;
	flex-shrink: 0;
}
.rlab-spectrogram canvas { flex: 1; min-width: 0; width: 100%; height: 100%; image-rendering: auto; border-radius: 4px; }
.rlab-spectrogram-labels { display: flex; justify-content: space-between; margin-top: 2px; }
</style>
