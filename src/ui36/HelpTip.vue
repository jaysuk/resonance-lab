<!--
  Vuetify 2 stand-in for dwc-plugin-runtime's HelpTip.

  That package is pinned to Vue 3 (its components call `resolveComponent`, which Vue 2.7 does not
  export), so the DWC 3.6 build needs its own. Same contract as the 3.7 one - a small help icon with
  a hover tooltip - so the page template can use it identically apart from the slot name the parent
  text-field uses to place it (`#append` here, `#append-inner` on Vuetify 4).
-->
<template>
	<v-tooltip bottom max-width="320">
		<template #activator="{ on, attrs }">
			<v-icon small class="rlab-helptip" v-bind="attrs" v-on="on">mdi-help-circle-outline</v-icon>
		</template>
		<span>{{ text }}</span>
	</v-tooltip>
</template>

<script setup lang="ts">
defineProps<{ text: string }>();
</script>

<style scoped>
.rlab-helptip {
	cursor: help;
	opacity: 0.7;
}
.rlab-helptip:hover {
	opacity: 1;
}
</style>
