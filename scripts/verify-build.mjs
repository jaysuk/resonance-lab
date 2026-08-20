#!/usr/bin/env node
/**
 * Verify the DWC 3.7 production build against a DuetWebControl checkout (CI's version of build.bat).
 *
 * `dwc-plugin-verify-build` copies the whole of `<pluginDir>/src` and actually builds it via DWC's
 * own `build-plugin-pkg.js`. Same problem as `dwc-plugin-typecheck` (see scripts/typecheck.mjs):
 * `src/ui36` is Vue 2.7 / Vuetify 2 / Vuex, and building it against a 3.7 checkout fails on missing
 * `@/store`/`@/routes`/`jszip` modules and Vuetify 2-vs-4 prop type mismatches that are not bugs -
 * the 3.6 build is verified separately, by build36.bat against a real 3.6 checkout.
 *
 * So: stage a temp plugin dir containing only the generation being verified (reusing the same
 * `dwcTypecheckIgnore` exclusion list from package.json) and point the stock kit binary at it.
 *
 *   DWC_DIR=/path/to/DuetWebControl-3.7  node scripts/verify-build.mjs
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dwcDir = process.env.DWC_DIR;

if (!dwcDir || !existsSync(dwcDir)) {
	console.error("DWC_DIR is not set or does not exist. Point it at a DuetWebControl 3.7 checkout.");
	process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const ignore = Array.isArray(manifest.dwcTypecheckIgnore) ? manifest.dwcTypecheckIgnore : [];

const stage = join(tmpdir(), "resonance-lab-verify-build");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "src"), { recursive: true });

const ignored = ignore.map((d) => join(repo, "src", d));
cpSync(join(repo, "src"), join(stage, "src"), {
	recursive: true,
	filter: (src) => !ignored.some((i) => src === i || src.startsWith(`${i}\\`) || src.startsWith(`${i}/`)),
});
// build-plugin-pkg.js reads plugin.json for the manifest (id/name/version); package.json is along
// for the ride since the kit's own tooling expects one to sit next to src/ too.
cpSync(join(repo, "plugin.json"), join(stage, "plugin.json"));
cpSync(join(repo, "package.json"), join(stage, "package.json"));
// Since the stage dir isn't in-tree in DWC, DWC's build script would otherwise see a package.json
// with no node_modules next to it and try `npm install` inside the stage - which has no lockfile
// context (and no network in some CI/sandboxed environments) and fails. Point it at the repo's own
// already-installed node_modules instead: it walks up from pluginDir looking for each dependency,
// so this alone satisfies that check.
symlinkSync(join(repo, "node_modules"), join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");

if (ignore.length) {
	console.log(`Verifying build against ${dwcDir} (excluding: ${ignore.join(", ")})`);
}

const bin = join(repo, "node_modules", ".bin", process.platform === "win32" ? "dwc-plugin-verify-build.cmd" : "dwc-plugin-verify-build");
const res = spawnSync(bin, [stage], { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
rmSync(stage, { recursive: true, force: true });
process.exit(res.status ?? 1);
