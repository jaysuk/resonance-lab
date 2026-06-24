/**
 * Self-update: check GitHub for a newer release (throttled, opt-out via localStorage) and apply it
 * in one click through DWC's installer. All heavy lifting lives in dwc-plugin-runtime; this is the
 * thin wiring. No-op until the first release exists (checkForUpdate returns "unknown" on 404).
 *
 * Exposes the same surface as the rest of the plugin family (updateState / checking / applying /
 * pendingReload / updateChecksEnabled / setUpdateChecksEnabled / runUpdateCheck / applyUpdateNow) so
 * the shared dwc-plugin-runtime AboutDialog can drive it.
 */
import { ref } from "vue";

import { applyUpdate, checkForUpdate, type UpdateResult } from "dwc-plugin-runtime";

import { useMachineStore } from "@/stores/machine";

const OWNER = "jaysuk";
const REPO = "resonance-lab";
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
export function setUpdateChecksEnabled(on: boolean): void { safeSet(LS_ENABLED, on ? "true" : "false"); }

function currentVersion(): string {
	const plugins = (useMachineStore().model as { plugins?: Map<string, { version?: string }> }).plugins;
	return plugins?.get("ResonanceLab")?.version ?? "0.0.0";
}

/**
 * Throttled on-load check; never throws — it runs fire-and-forget from onMounted, so any failure
 * (offline, rate-limited, CORS, no release yet, or a host without a usable localStorage) must be
 * swallowed rather than becoming an unhandled rejection.
 */
export async function runUpdateCheck(opts: { force?: boolean } = {}): Promise<void> {
	try {
		if (!opts.force) {
			if (!updateChecksEnabled()) { return; }
			const last = Number(safeGet(LS_LAST) || 0);
			if (Date.now() - last < CHECK_INTERVAL_MS) { return; }
		}
		// Stamp the attempt up front so a flaky network throttles the next try rather than
		// re-hitting GitHub on every page mount.
		safeSet(LS_LAST, String(Date.now()));
		checking.value = true;
		updateState.value = await checkForUpdate({ owner: OWNER, repo: REPO, currentVersion: currentVersion() });
	} catch {
		// Intentionally ignored — see the contract above.
	} finally {
		checking.value = false;
	}
}

/** One-click apply; on CORS-blocked downloads, falls back to a direct browser download. */
export async function applyUpdateNow(): Promise<void> {
	const r = updateState.value;
	if (!r?.assetUrl || !r.assetName) {
		return;
	}
	const machine = useMachineStore();
	applying.value = true;
	try {
		await applyUpdate({
			assetUrl: r.assetUrl,
			assetName: r.assetName,
			installPlugin: (filename, blob, start) => machine.installPlugin(filename, blob, start),
		});
		pendingReload.value = true;
	} catch {
		window.location.href = r.assetUrl;
	} finally {
		applying.value = false;
	}
}
