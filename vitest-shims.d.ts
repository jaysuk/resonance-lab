// dwc-plugin-test-kit's "/vitest" subpath export ships a plain .mjs with no accompanying .d.ts, so
// any type-check that reaches vitest.config.ts's import of it (DWC's own build-time plugin
// type-check sweeps the whole plugin directory, not just src/) can fail with "implicitly has an
// 'any' type" depending on the exact TS strictness of whatever DuetWebControl checkout it runs
// against - this file is only ever loaded by Node/Vitest directly, never bundled into the shipped
// plugin, but the import still needs a declaration to satisfy that sweep.
declare module "dwc-plugin-test-kit/vitest" {
	export function dwcVitestConfig(overrides?: Record<string, unknown>): Record<string, unknown>;
}
