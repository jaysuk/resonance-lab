/**
 * `HostAdapter` for DuetWebControl 3.6 (Vue 2.7, Vuex 3, vue-i18n 8).
 *
 * The 3.7 counterpart (`../ui37/host.ts`) talks to Pinia stores; 3.6 has a single Vuex root store
 * with a namespaced `machine` module, and notifications are a plain exported function rather than a
 * store action. Unlike the 3.7 version this needs no active component instance, since the Vuex
 * store and the i18n instance are both module singletons.
 */
import i18n from "@/i18n";
import store from "@/store";
import { makeNotification } from "@/utils/notifications";
import { LogType } from "@/utils/logging";

import type { HostAdapter, NotifyLevel } from "../core/host";

const LEVELS: Record<NotifyLevel, LogType> = {
	success: LogType.success,
	info: LogType.info,
	warning: LogType.warning,
	error: LogType.error,
};

export function createHost(): HostAdapter {
	return {
		// Read through the store every call rather than caching: Vue 2.7's `watch` tracks the same way
		// Vue 3's does, so the composable's run-counter/status watchers depend on this staying live.
		model: () => (store.state as { machine: { model: unknown } }).machine.model,
		isConnected: () => Boolean(store.getters["isConnected"]),

		sendCode: async (code) => String(await store.dispatch("machine/sendCode", code) ?? ""),
		// 3.6 takes the transfer flags as named fields of the payload where 3.7 takes them positionally;
		// the intent is the same - stay silent, this is background I/O the page reports on itself.
		upload: async (path, content) => {
			await store.dispatch("machine/upload", {
				filename: path, content, showProgress: false, showSuccess: false, showError: true,
			});
		},
		download: async (path) => String(await store.dispatch("machine/download", {
			filename: path, type: "text", showProgress: false, showSuccess: false, showError: false,
		}) ?? ""),
		delete: async (path) => { await store.dispatch("machine/delete", path); },
		makeDirectory: async (path) => { await store.dispatch("machine/makeDirectory", path); },
		getFileList: (dir) => store.dispatch("machine/getFileList", dir),
		// 3.6's action wants the parsed archive as well as the blob (it reads plugin.json out of it to
		// check the DWC version), where 3.7 parses internally. JSZip is one of DWC 3.6's own
		// dependencies, and is imported lazily so it only costs anything on an actual self-update.
		installPlugin: async (filename, blob, start) => {
			const JSZip = (await import("jszip")).default;
			const zipFile = await new JSZip().loadAsync(blob);
			await store.dispatch("machine/installPlugin", { zipFilename: filename, zipBlob: blob, zipFile, start });
		},

		// Only ever offer the DWC 3.6 package - installing the Vue 3 one here would at best be
		// rejected by DWC's own dwcVersion check, at worst leave a broken plugin installed.
		assetPattern: /-dwc36\.zip$/i,

		notify: (level, title, message) => { makeNotification(LEVELS[level], title, message); },
		// vue-i18n 8 exposes `t` directly on the instance (vue-i18n 11 nests it under `.global`).
		t: (key, args) => String(i18n.t(`plugins.resonanceLab.${key}`, args ?? {})),
	};
}
