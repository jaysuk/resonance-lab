/**
 * Resonance Lab - default (DuetWebControl 3.7+) entry point.
 *
 * DWC's `build-plugin-pkg` always builds `<pluginDir>/src/index.ts`, so this file decides which UI
 * layer a plain `build.bat` ships: the Vue 3 / Vuetify 4 one. The DWC 3.6 build never uses this -
 * `build36.bat` stages a temp source tree whose `src/index.ts` is `ui36/index.ts` instead (the 3.6
 * toolchain cannot resolve `@/plugins`, Pinia or Vuetify 4, so the two must not be linked).
 *
 * Everything real lives in ./ui37 (and, shared with 3.6, ./core, ./analysis and ./capture).
 */
export * from "./ui37/index";
