/**
 * Self-update: check GitHub for a newer release (throttled, opt-out via localStorage) and apply it
 * in one click through DWC's installer. All heavy lifting lives in dwc-plugin-runtime; this is the
 * thin wiring. No-op until the first release exists (checkForUpdate returns "unknown" on 404).
 */
import { ref } from "vue";

import { applyUpdate, checkForUpdate, type UpdateResult } from "dwc-plugin-runtime";

import { useMachineStore } from "@/stores/machine";

const OWNER = "jaysuk";
const REPO = "resonance-lab";
const LS_LAST = "resonanceLab.updateCheck.lastCheck";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const updateState = ref<UpdateResult | null>(null);
export const updateApplying = ref(false);
export const updatePendingReload = ref(false);

function currentVersion(): string {
	const plugins = (useMachineStore().model as { plugins?: Map<string, { version?: string }> }).plugins;
	return plugins?.get("ResonanceLab")?.version ?? "0.0.0";
}

/** Throttled on-load check; never throws. */
export async function runUpdateCheck(force = false): Promise<void> {
	if (!force) {
		const last = Number(localStorage.getItem(LS_LAST) || 0);
		if (Date.now() - last < CHECK_INTERVAL_MS) {
			return;
		}
	}
	updateState.value = await checkForUpdate({ owner: OWNER, repo: REPO, currentVersion: currentVersion() });
	localStorage.setItem(LS_LAST, String(Date.now()));
}

/** One-click apply; on CORS-blocked downloads, falls back to a direct browser download. */
export async function applyUpdateNow(): Promise<void> {
	const r = updateState.value;
	if (!r?.assetUrl || !r.assetName) {
		return;
	}
	const machine = useMachineStore();
	updateApplying.value = true;
	try {
		await applyUpdate({
			assetUrl: r.assetUrl,
			assetName: r.assetName,
			installPlugin: (filename, blob, start) => machine.installPlugin(filename, blob, start),
		});
		updatePendingReload.value = true;
	} catch {
		window.location.href = r.assetUrl;
	} finally {
		updateApplying.value = false;
	}
}
