/**
 * Self-update: check GitHub for a newer release (throttled, opt-out via localStorage) and apply it
 * in one click through DWC's installer, working WITH the shared cross-plugin update hub in
 * dwc-plugin-runtime: an available update is announced into a shared registry so a host (e.g. the
 * active custom-layout shell) can show ONE aggregated popup instead of every plugin popping its own;
 * while a host is active, this plugin skips its own fallback notification toast. Registering the
 * checker with the hub also means a host's "check all" can trigger a check even if this plugin's own
 * page never mounts (e.g. the user only has the embeddable summary panel on a dashboard). All heavy
 * lifting lives in dwc-plugin-runtime; this is the thin wiring. No-op until the first release exists
 * (checkForUpdate returns "unknown" on 404).
 *
 * Exposes the same surface as the rest of the plugin family (updateState / checking / applying /
 * pendingReload / updateChecksEnabled / setUpdateChecksEnabled / runUpdateCheck / applyUpdateNow) so
 * the shared dwc-plugin-runtime AboutDialog can drive it.
 */
// Deep subpath imports, not the package barrel: the barrel also re-exports AboutDialog/HelpTip/
// PluginWidgetConfigForm, which call Vue 3's `resolveComponent` — absent in Vue 2.7, so pulling the
// barrel into this shared module would break the DWC 3.6 build. These modules import no Vue at all.
import { applyUpdate, checkForUpdate, type UpdateResult } from "dwc-plugin-runtime/updates";
import {
	announceUpdate, clearAnnouncedUpdate, isUpdateHostActive, registerUpdateChecker,
} from "dwc-plugin-runtime/updateHub";
import { ref } from "vue";

import type { HostAdapter } from "./core/host";

/**
 * Set once at plugin load by whichever entry point is running (ui37/index.ts or ui36/index.ts).
 * This module is shared by both DWC versions and runs before any component mounts, so it cannot
 * reach a store directly - see ./core/host.
 */
let host: HostAdapter | null = null;
export function setUpdateHost(h: HostAdapter): void { host = h; }

const OWNER = "jaysuk";
const REPO = "resonance-lab";
const PLUGIN_MANIFEST_ID = "ResonanceLab";
const LS_LAST = "resonanceLab.updateCheck.lastCheck";
const LS_ENABLED = "resonanceLab.updateCheck.enabled";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const updateState = ref<UpdateResult | null>(null);
export const checking = ref(false);
export const applying = ref(false);
export const pendingReload = ref(false);
// Back-compat aliases for older template bindings.
export const updateApplying = applying;
export const updatePendingReload = pendingReload;

function safeGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* storage disabled */ } }

export function updateChecksEnabled(): boolean { return safeGet(LS_ENABLED) !== "false"; }
export function setUpdateChecksEnabled(on: boolean): void {
	safeSet(LS_ENABLED, on ? "true" : "false");
	if (!on) { clearAnnouncedUpdate(PLUGIN_MANIFEST_ID); }
}

function currentVersion(): string {
	const plugins = (host?.model() as { plugins?: Map<string, { version?: string }> } | undefined)?.plugins;
	return plugins?.get(PLUGIN_MANIFEST_ID)?.version ?? "0.0.0";
}

/** Announce (or clear) this plugin's update in the shared cross-plugin hub, based on the last check. */
function syncHub(): void {
	const s = updateState.value;
	if (s?.updateAvailable) {
		announceUpdate(PLUGIN_MANIFEST_ID, "Resonance Lab", s);
	} else {
		clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
	}
}

/**
 * Throttled on-load check; never throws — it runs fire-and-forget from index.ts, so any failure
 * (offline, rate-limited, CORS, no release yet, or a host without a usable localStorage) must be
 * swallowed rather than becoming an unhandled rejection.
 *
 * `notify`: when an update is found and no cross-plugin update-hub host is currently showing its own
 * aggregated popup, fall back to a one-off toast so a standalone install (no host, and the user may
 * never open the full page) still finds out about it.
 */
export async function runUpdateCheck(opts: { force?: boolean; notify?: boolean } = {}): Promise<void> {
	try {
		if (!opts.force) {
			if (!updateChecksEnabled()) { return; }
			const last = Number(safeGet(LS_LAST) || 0);
			if (Date.now() - last < CHECK_INTERVAL_MS) {
				syncHub(); // keep a newly-mounted host in sync even when the check itself is throttled
				return;
			}
		}
		// Stamp the attempt up front so a flaky network throttles the next try rather than
		// re-hitting GitHub on every page mount.
		safeSet(LS_LAST, String(Date.now()));
		checking.value = true;
		updateState.value = await checkForUpdate({
				owner: OWNER, repo: REPO, currentVersion: currentVersion(),
				// A release ships one ZIP per DWC generation; without this the checker takes whichever
				// *.zip GitHub lists first and could offer a 3.6 user the Vue 3 package.
				...(host?.assetPattern ? { assetPattern: host.assetPattern } : {}),
			});
		syncHub();
		if (opts.notify && updateState.value.updateAvailable && !isUpdateHostActive()) {
			const message = host?.t("update.available", { version: updateState.value.latestVersion }) ?? "";
			host?.notify("info", "Resonance Lab", message);
		}
	} catch {
		// Intentionally ignored — see the contract above.
	} finally {
		checking.value = false;
	}
}

// Register with the shared hub so another plugin's (or a host's) "check all" can trigger this
// plugin's check too, even before its own page has ever mounted.
registerUpdateChecker(PLUGIN_MANIFEST_ID, async () => { await runUpdateCheck({ force: true }); });

/** One-click apply; on CORS-blocked downloads, falls back to a direct browser download. */
export async function applyUpdateNow(): Promise<void> {
	const r = updateState.value;
	if (!r?.assetUrl || !r.assetName) {
		return;
	}
	applying.value = true;
	try {
		await applyUpdate({
			assetUrl: r.assetUrl,
			assetName: r.assetName,
			installPlugin: (filename, blob, start) => host!.installPlugin(filename, blob, start),
		});
		pendingReload.value = true;
		clearAnnouncedUpdate(PLUGIN_MANIFEST_ID); // just applied - nothing left to announce
	} catch {
		window.location.href = r.assetUrl;
	} finally {
		applying.value = false;
	}
}
