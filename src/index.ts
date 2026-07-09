/**
 * Resonance Lab - entry point.
 *
 * Input shaping & resonance analysis for RepRapFirmware (measure -> analyse -> recommend -> verify).
 * This file only wires the plugin into DWC; all real behaviour lives in the components and (future)
 * model modules.
 *
 * Surfaces:
 *  - a full PAGE under the Plugins menu (the lab: measurement runs, PSD graphs, recommendations),
 *  - a compact PANEL published via registerEmbeddableComponent (DWC 3.7.0-alpha.7+) so it can be
 *    dropped straight into a Flexible Layouts grid from the widget palette.
 *
 * External plugins may only import DWC's externalised API (`@/plugins`, `@/stores/*`, vue, ...).
 */
import { registerEmbeddableComponent, registerPluginMessages, registerRoute, unregisterEmbeddableComponent } from "@/plugins";
import Events from "@/utils/events";

import { clearAnnouncedUpdate, installErrorCapture } from "dwc-plugin-runtime";

import en from "./i18n/en.json";
import ResonanceLabPage from "./ResonanceLabPage.vue";
import SummaryPanel from "./SummaryPanel.vue";
import { runUpdateCheck } from "./updateCheck";

/** Manifest id (plugin.json `id`) - what DWC uses for plugin load/unload events. */
export const PLUGIN_ID = "ResonanceLab";

// i18n namespace: registerPluginMessages nests the bundle under `plugins.<this>.*`, so the bundle
// itself must NOT be pre-namespaced and $t keys are `plugins.resonanceLab.*`.
const I18N_ID = "resonanceLab";
registerPluginMessages(I18N_ID, { en });

// Keep plugin paths under /Plugins/<id>/... so the owning plugin is correctly attributed when a
// Flexible Layouts layout that embeds the page is exported (dependency-aware import).
registerRoute(ResonanceLabPage, {
	Plugins: {
		ResonanceLab: {
			icon: "mdi-sine-wave",
			caption: "plugins.resonanceLab.menuCaption",
			path: "/Plugins/ResonanceLab",
		},
	},
});

// Publish the summary panel straight into layout widget palettes (Flexible Layouts' "Add widget ->
// Plugins"). A saved layout stores the id, so it must stay stable across versions.
const EMBEDDABLE_ID = `${PLUGIN_ID}.Summary`;
registerEmbeddableComponent({
	id: EMBEDDABLE_ID,
	pluginId: PLUGIN_ID,
	caption: "plugins.resonanceLab.embeddable.caption",
	icon: "mdi-sine-wave",
	description: "Latest resonance measurement & shaper recommendation at a glance.",
	author: "James Skitt",
	component: SummaryPanel,
	defaultSize: { w: 4, h: 5 },
	machineMode: "fff",
});

// Diagnostics: capture window errors while the plugin is loaded so a bug report can carry them
// (see the "Download diagnostics report" button in the page and the About dialog).
const uninstallErrorCapture = installErrorCapture();

// Throttled on-load update check (see ./updateCheck) - runs once per plugin load regardless of
// whether the user ever opens the full page, so an embeddable-summary-panel-only install still
// finds out about updates. Delayed so it doesn't compete with initial page load.
setTimeout(() => { void runUpdateCheck({ notify: true }); }, 4000);

Events.on("dwcPluginUnloaded", (id: string) => {
	if (id === PLUGIN_ID) {
		unregisterEmbeddableComponent(EMBEDDABLE_ID);
		uninstallErrorCapture();
		clearAnnouncedUpdate(PLUGIN_ID);
	}
});
