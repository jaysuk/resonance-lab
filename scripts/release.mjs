#!/usr/bin/env node
/**
 * Launcher for the shared release script (jaysuk/dwc-plugin-workflows). Identical in every plugin and never
 * needs editing: it keeps a cached checkout of the shared repo at the floating `v1` tag, refreshes it on each
 * run, and hands over to its scripts/release.mjs. So a change to the release flow reaches every plugin without
 * touching the plugin repos.
 *
 *   npm run release -- 1.3.0 [--push] [--no-notes] [--yes]
 *
 * Offline, the cached copy is used. DWC_PLUGIN_WORKFLOWS_DIR=<path> runs a local checkout instead (to try a
 * change before tagging it).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = "https://github.com/jaysuk/dwc-plugin-workflows.git";
const REF = "v1";

let dir = process.env.DWC_PLUGIN_WORKFLOWS_DIR;
if (!dir) {
	dir = join(homedir(), ".cache", "dwc-plugin-workflows");
	const git = (args) => execFileSync("git", args, { stdio: "pipe", encoding: "utf8" });
	try {
		if (existsSync(join(dir, ".git"))) {
			git(["-C", dir, "fetch", "--quiet", "--depth", "1", "--force", "origin", `+refs/tags/${REF}:refs/tags/${REF}`]);
			git(["-C", dir, "checkout", "--quiet", "--force", REF]);
		} else {
			mkdirSync(dir, { recursive: true });
			git(["clone", "--quiet", "--depth", "1", "--branch", REF, REPO, dir]);
		}
	} catch (e) {
		if (!existsSync(join(dir, "scripts", "release.mjs"))) {
			console.error(`Could not fetch ${REPO} (${REF}): ${e.message}`);
			process.exit(1);
		}
		console.warn("Could not refresh the shared release scripts (offline?) - using the cached copy.");
	}
}

const r = spawnSync(process.execPath, [join(dir, "scripts", "release.mjs"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
