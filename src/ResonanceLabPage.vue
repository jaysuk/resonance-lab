<!--
  Resonance Lab - the full page (the "lab").

  Skeleton for the Shake&Tune-style workflow: Measure -> Analyse -> Recommend -> Verify. Each stage
  is stubbed with its planned scope so the page is honest about its state while the implementation
  lands incrementally. The accelerometer probe is real: it reads the object model so users
  immediately see whether their hardware is ready.
-->
<template>
	<v-container fluid>
		<div class="d-flex align-center mb-4">
			<v-icon size="large" class="me-3">mdi-sine-wave</v-icon>
			<div>
				<div class="text-h6">{{ $t("plugins.resonanceLab.title") }}</div>
				<div class="text-body-2 text-medium-emphasis">{{ $t("plugins.resonanceLab.subtitle") }}</div>
			</div>
		</div>

		<!-- Hardware readiness: accelerometer(s) from the live object model. -->
		<v-alert :type="accelerometers.length > 0 ? 'success' : 'info'" variant="tonal" density="comfortable" class="mb-4">
			<template v-if="!isConnected">{{ $t("plugins.resonanceLab.notConnected") }}</template>
			<template v-else-if="accelerometers.length > 0">
				{{ $t("plugins.resonanceLab.accelFound", { count: accelerometers.length, boards: accelerometers.join(", ") }) }}
			</template>
			<template v-else>{{ $t("plugins.resonanceLab.accelMissing") }}</template>
		</v-alert>

		<v-row>
			<v-col v-for="stage in stages" :key="stage.key" cols="12" sm="6" lg="3">
				<v-card variant="tonal" class="fill-height">
					<v-card-title class="d-flex align-center text-subtitle-1">
						<v-icon size="small" class="me-2">{{ stage.icon }}</v-icon>
						{{ $t(`plugins.resonanceLab.stages.${stage.key}.title`) }}
					</v-card-title>
					<v-card-text class="text-body-2">
						{{ $t(`plugins.resonanceLab.stages.${stage.key}.description`) }}
					</v-card-text>
					<v-card-actions>
						<v-chip size="small" variant="flat" color="surface-variant">{{ $t("plugins.resonanceLab.comingSoon") }}</v-chip>
					</v-card-actions>
				</v-card>
			</v-col>
		</v-row>
	</v-container>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { useMachineStore } from "@/stores/machine";

const machineStore = useMachineStore();

const isConnected = computed(() => machineStore.isConnected);

// Boards expose `accelerometer` in the object model when one is configured (M955).
const accelerometers = computed(() => {
	const boards = (machineStore.model as { boards?: Array<{ accelerometer?: unknown; name?: string; shortName?: string } | null> }).boards ?? [];
	return boards
		.map((b, i) => (b && b.accelerometer ? (b.shortName || b.name || `board ${i}`) : null))
		.filter((n): n is string => n !== null);
});

const stages = [
	{ key: "measure", icon: "mdi-waveform" },
	{ key: "analyse", icon: "mdi-chart-bell-curve" },
	{ key: "recommend", icon: "mdi-lightbulb-on-outline" },
	{ key: "verify", icon: "mdi-check-decagram-outline" },
] as const;
</script>
