/**
 * The seam between the measurement logic and whichever DuetWebControl it is running inside.
 *
 * DWC 3.7 is Vue 3 / Pinia / vue-i18n 11; DWC 3.6 is Vue 2.7 / Vuex 3 / vue-i18n 8. Those differ in
 * how you reach the object model, dispatch G-code and raise a notification - but in nothing else
 * this plugin cares about. `useResonanceLab` therefore takes a `HostAdapter` instead of importing
 * any store directly, so the entire measurement/verify/analysis flow is written once and each UI
 * layer supplies a ~30-line implementation (see `ui37/host.ts` and `ui36/host.ts`).
 *
 * Deliberately raw: no Vue types cross this boundary. The composable owns all reactivity, and the
 * adapter only exposes plain reads and promises - which is what lets the same file compile against
 * both Vue versions.
 */

/** Severity for `notify` - maps to DWC's own notification levels on both versions. */
export type NotifyLevel = "success" | "info" | "warning" | "error";

export interface HostAdapter {
	/**
	 * Read the machine object model.
	 *
	 * MUST touch the host's reactive state on every call rather than returning a cached snapshot:
	 * the composable drives `watch()` off getters that call this (accelerometer run counter, motion
	 * status), and those only fire if the dependency is tracked at read time.
	 */
	model(): unknown;
	/** Whether DWC currently has a live connection to the machine. Also a reactive read. */
	isConnected(): boolean;

	/** Send a G-code line, resolving with the firmware's reply once it has completed. */
	sendCode(code: string): Promise<string>;
	/** Upload text content to a full path (e.g. "0:/sys/resonanceLab/sweep.g"). */
	upload(path: string, content: string): Promise<void>;
	/** Download a text file by full path. */
	download(path: string): Promise<string>;
	/** Delete a file. */
	delete(path: string): Promise<void>;
	/** Create a directory (idempotent - callers treat failure as non-fatal). */
	makeDirectory(path: string): Promise<void>;
	/** List a directory, used by the saved-capture browser. */
	getFileList(dir: string): Promise<Array<{ name: string; isDirectory?: boolean; size?: number }>>;
	/** Install a plugin ZIP through DWC's own installer - the one-click self-update path. */
	installPlugin(filename: string, blob: Blob, start: boolean): Promise<void>;

	/**
	 * Which release asset this DWC can actually install.
	 *
	 * A release carries one ZIP per supported DWC generation (`…-1.2.3.zip` for 3.7,
	 * `…-1.2.3-dwc36.zip` for 3.6), and the update checker otherwise just takes the first `*.zip` it
	 * finds - which would offer a 3.6 user the Vue 3 package. Each host narrows it to its own.
	 */
	assetPattern: RegExp;

	/** Raise a DWC toast/notification. */
	notify(level: NotifyLevel, title: string, message: string): void;
	/**
	 * Translate a key relative to this plugin's own namespace - implementations prepend
	 * `plugins.resonanceLab.`, so callers pass e.g. `"results.verify"`.
	 */
	t(key: string, args?: Record<string, unknown>): string;
}
