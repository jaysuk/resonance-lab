<!--
  Resonance Lab - compact summary panel (embeddable component).

  Built to sit in a small grid cell (Flexible Layouts / any layout palette): fills its container,
  no page margins. Shows hardware readiness now; will show the latest measurement + active shaper
  once the measurement pipeline lands.
-->
<template>
	<v-card class="fill-height d-flex flex-column" variant="flat">
		<v-card-title class="d-flex align-center py-2">
			<v-icon size="small" class="me-2">mdi-sine-wave</v-icon>
			<span class="text-subtitle-2">{{ $t("plugins.resonanceLab.title") }}</span>
		</v-card-title>

		<v-card-text class="flex-grow-1 d-flex flex-column justify-center py-2">
			<div class="d-flex align-center">
				<v-icon size="small" class="me-2" :color="ready ? 'success' : 'warning'">
					{{ ready ? "mdi-check-circle-outline" : "mdi-alert-circle-outline" }}
				</v-icon>
				<span class="text-body-2">
					{{ ready ? $t("plugins.resonanceLab.panel.ready") : $t("plugins.resonanceLab.panel.notReady") }}
				</span>
			</div>
			<div class="text-caption text-medium-emphasis mt-2">{{ $t("plugins.resonanceLab.panel.noData") }}</div>
		</v-card-text>

		<v-card-actions class="pt-0">
			<v-btn size="small" variant="tonal" color="primary" block prepend-icon="mdi-open-in-app" to="/Plugins/ResonanceLab">
				{{ $t("plugins.resonanceLab.panel.open") }}
			</v-btn>
		</v-card-actions>
	</v-card>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { useMachineStore } from "@/stores/machine";

const machineStore = useMachineStore();

// Ready = connected with at least one accelerometer configured (M955) in the object model.
const ready = computed(() => {
	if (!machineStore.isConnected) {
		return false;
	}
	const boards = (machineStore.model as { boards?: Array<{ accelerometer?: unknown } | null> }).boards ?? [];
	return boards.some((b) => b && b.accelerometer);
});
</script>
