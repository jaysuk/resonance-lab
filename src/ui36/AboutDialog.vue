<!--
  Vuetify 2 stand-in for dwc-plugin-runtime's AboutDialog (that package is Vue 3 only - see
  ./HelpTip.vue). Same props/events as the 3.7 component so the page template is unchanged, and the
  same job: identify the plugin, show the installed vs available version, and drive the self-update.
-->
<template>
	<v-dialog :value="value" max-width="520" @input="$emit('input', $event)">
		<v-card>
			<v-card-title class="d-flex align-center">
				<v-icon class="mr-2">mdi-information-outline</v-icon>{{ title }}
			</v-card-title>
			<v-card-text>
				<p class="body-2">{{ description }}</p>

				<div class="d-flex align-center py-1">
					<span class="text--secondary mr-2">Installed version:</span>
					<strong>{{ installedVersion }}</strong>
				</div>
				<div v-if="updateAvailable" class="d-flex align-center py-1">
					<span class="text--secondary mr-2">Latest version:</span>
					<strong class="success--text">{{ latestVersion }}</strong>
				</div>

				<v-alert v-if="pendingReload" type="success" text dense class="mt-3 mb-0">
					Update installed — reload DuetWebControl to start using it.
				</v-alert>
				<v-alert v-else-if="updateAvailable" type="info" text dense class="mt-3 mb-0">
					Version {{ latestVersion }} is available.
				</v-alert>

				<v-checkbox :input-value="autoCheck" dense hide-details class="mt-3"
							label="Check for updates automatically"
							@change="$emit('toggle-auto-check', $event)" />

				<div class="mt-3">
					<a :href="repo" target="_blank" rel="noopener">{{ repo }}</a>
				</div>
			</v-card-text>
			<v-card-actions>
				<v-btn text :loading="checking" @click="$emit('check-update')">
					<v-icon left>mdi-refresh</v-icon>Check for updates
				</v-btn>
				<v-btn v-if="updateAvailable && !pendingReload" text color="primary" :loading="applying"
					   @click="$emit('apply-update')">
					<v-icon left>mdi-download</v-icon>Update
				</v-btn>
				<v-spacer />
				<v-btn text @click="$emit('input', false)">Close</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";

// `value`/`input` rather than Vue 3's `modelValue`: `v-model` on a Vue 2 component still means
// exactly that, so the page's `v-model="aboutOpen"` binds to this without any change.
const props = defineProps<{
	value: boolean;
	pluginId: string;
	title: string;
	description: string;
	model: unknown;
	repo: string;
	updateAvailable: boolean;
	latestVersion?: string;
	checking: boolean;
	applying: boolean;
	pendingReload: boolean;
	autoCheck: boolean;
}>();

defineEmits<{
	(e: "input", value: boolean): void;
	(e: "check-update"): void;
	(e: "apply-update"): void;
	(e: "toggle-auto-check", value: boolean): void;
}>();

/** The running version, read from the object model's plugin registry (same source DWC's own
 *  plugin list uses) rather than the build-time manifest, so it reflects what is actually loaded. */
const installedVersion = computed(() => {
	const plugins = (props.model as { plugins?: Map<string, { version?: string }> } | null)?.plugins;
	return plugins?.get(props.pluginId)?.version ?? "unknown";
});
</script>
