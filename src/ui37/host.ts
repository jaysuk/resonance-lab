/**
 * `HostAdapter` for DuetWebControl 3.7+ (Vue 3, Pinia, vue-i18n 11).
 *
 * Must be called from inside a component's setup, because `useMachineStore()`/`useUiStore()` need an
 * active Pinia instance. See `../ui36/host.ts` for the Vue 2.7 / Vuex 3 counterpart.
 */
import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";
import i18n from "@/i18n";

import type { HostAdapter, NotifyLevel } from "../core/host";

const LEVELS: Record<NotifyLevel, LogLevel> = {
	success: LogLevel.success,
	info: LogLevel.info,
	warning: LogLevel.warning,
	error: LogLevel.error,
};

/** Extra store members not on the public typings. */
type MachineExtras = {
	getFileList(dir: string): Promise<Array<{ name: string; isDirectory?: boolean; size?: number }>>;
	installPlugin(filename: string, blob: Blob, start: boolean): Promise<void>;
};

/**
 * Each method resolves its store on call rather than once up front, so this can safely be built at
 * plugin-load time (from index.ts, before any component exists) as well as inside setup.
 */
export function createHost(): HostAdapter {
	const machine = () => useMachineStore();

	return {
		// Property reads (not cached destructures) so Pinia tracks them for the composable's watchers.
		model: () => machine().model,
		isConnected: () => machine().isConnected,

		sendCode: async (code) => String(await machine().sendCode(code) ?? ""),
		upload: async (path, content) => { await machine().upload({ filename: path, content }, false, false, true); },
		download: async (path) => String(await machine().download({ filename: path, type: "text" }, false, false, false)),
		delete: async (path) => { await machine().delete(path); },
		makeDirectory: async (path) => { await machine().makeDirectory(path); },
		getFileList: (dir) => (machine() as unknown as MachineExtras).getFileList(dir),
		installPlugin: (filename, blob, start) => (machine() as unknown as MachineExtras).installPlugin(filename, blob, start),

		// The 3.7 package is the plain "<name>-<version>.zip"; the negative lookahead keeps it from
		// matching the 3.6 sibling asset in the same release.
		assetPattern: /^(?!.*-dwc36\.zip$).*\.zip$/i,

		notify: (level, title, message) => { useUiStore().makeNotification(LEVELS[level], title, message); },
		t: (key, args) => i18n.global.t(`plugins.resonanceLab.${key}`, args ?? {}),
	};
}
