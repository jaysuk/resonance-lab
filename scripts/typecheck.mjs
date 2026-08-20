#!/usr/bin/env node
/**
 * Type-check the DWC 3.7 sources against a DuetWebControl 3.7 checkout.
 *
 * `dwc-plugin-typecheck` copies the whole of `<pluginDir>/src` into the DWC tree and runs its
 * `vue-tsc`. That is exactly right for one generation at a time and impossible for both at once:
 * `src/ui36` is Vue 2.7 / Vuetify 2 / Vuex and imports `@/store`, `@/routes` and
 * `@/utils/notifications`, none of which exist in a 3.7 checkout, so it produces a wall of errors
 * that are not bugs. The 3.6 tree is type-checked by its own build instead (`build36.bat` runs
 * fork-ts-checker inside the 3.6 toolchain).
 *
 * So: stage a temp plugin dir containing only the generation being checked, and point the stock kit
 * binary at it — the kit takes a plugin directory as its first argument. Directories to leave out
 * come from `dwcTypecheckIgnore` in package.json.
 *
 *   DWC_DIR=/path/to/DuetWebControl-3.7  node scripts/typecheck.mjs
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dwcDir = process.env.DWC_DIR;

if (!dwcDir || !existsSync(dwcDir)) {
	console.error("DWC_DIR is not set or does not exist. Point it at a DuetWebControl 3.7 checkout.");
	process.exit(2);
}

/**
 * Refuse to run without a compiler rather than reporting a pass we never earned.
 *
 * The kit greps vue-tsc's output for lines naming its temp folder; when vue-tsc cannot run at all
 * (which is the case for every DWC 3.6 checkout — 3.6 ships no vue-tsc) nothing matches, and it
 * prints "Type-check passed." having compiled nothing. A silent false pass is worse than no check
 * because it is indistinguishable from a real one, so check up front.
 */
const hasVueTsc = ["vue-tsc", "vue-tsc.cmd", "vue-tsc.ps1"]
	.some((b) => existsSync(join(dwcDir, "node_modules", ".bin", b)));
if (!hasVueTsc) {
	console.error(
		`No vue-tsc in ${dwcDir}/node_modules/.bin — cannot type-check.\n`
		+ "Point DWC_DIR at a DuetWebControl 3.7 checkout with dependencies installed (npm install).\n"
		+ "DWC 3.6 ships no vue-tsc; its UI layer is type-checked by build36.bat instead.",
	);
	process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const ignore = Array.isArray(manifest.dwcTypecheckIgnore) ? manifest.dwcTypecheckIgnore : [];

const stage = join(tmpdir(), "resonance-lab-typecheck");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "src"), { recursive: true });

const ignored = ignore.map((d) => join(repo, "src", d));
cpSync(join(repo, "src"), join(stage, "src"), {
	recursive: true,
	filter: (src) => !ignored.some((i) => src === i || src.startsWith(`${i}\\`) || src.startsWith(`${i}/`)),
});
// The kit reads the plugin's package.json for its own purposes; keep it alongside the staged src.
cpSync(join(repo, "package.json"), join(stage, "package.json"));

if (ignore.length) {
	console.log(`Type-checking against ${dwcDir} (excluding: ${ignore.join(", ")})`);
}

const bin = join(repo, "node_modules", ".bin", process.platform === "win32" ? "dwc-plugin-typecheck.cmd" : "dwc-plugin-typecheck");
const res = spawnSync(bin, [stage], { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
rmSync(stage, { recursive: true, force: true });
process.exit(res.status ?? 1);
