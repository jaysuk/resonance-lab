# Resonance Lab

Input shaping & resonance analysis plugin for [DuetWebControl](https://github.com/Duet3D/DuetWebControl)
(RepRapFirmware): **measure → analyse → recommend → verify**, computed entirely in the browser.

Grab the latest release from the [Releases page](https://github.com/jaysuk/resonance-lab/releases) —
download the ZIP and install it via **Settings → General → Plugins → Install Plugin** in DuetWebControl.

## What it does

- **Measure** — run controlled excitation moves and capture accelerometer samples (`M955`/`M956`)
  per axis / belt, optionally at a specific Z height. On RepRapFirmware **3.7.0-rc.1+**, the plugin
  reactivates the right accelerometer before every single measurement automatically — no manual `M955`
  needed between tools on a tool-changer. (RRF 3.7.0-rc.1 itself supports only one active accelerometer
  machine-wide; **3.7.0-rc.1+1 and above** support up to 10 at once, each on its own board.)
- **Analyse** — compute power spectral density, find resonance peaks, compare belts, flag anomalies,
  and measure motor quality (vibration at multiples of a motor's own full-step frequency, isolating
  the motor and driver from the machine's structural response).
- **Recommend** — suggest the input-shaper type and frequency (`M593`) that removes the most
  residual vibration, weighing every measured axis at once when more than one was swept; on
  RepRapFirmware **3.7.0-rc.1+**, also search for and apply a motor's own current-waveform
  correction (`M970.3`/`M569.2`) to reduce detent-torque and coil-imbalance vibration at the source.
- **Verify** — re-measure with the shaper applied and confirm the ringing is gone before saving.

Generated test G-code is uploaded to its own folder (`0:/sys/resonanceLab` by default, configurable
in Settings) rather than bare `0:/sys` — captured measurement data itself always lands in
`0:/sys/accelerometer`, which is fixed by the firmware and can't be relocated.

This is a wholly new Vue 3 implementation — not a port of the stock Input Shaping plugin.

## Integration

- Full page under the **Plugins** menu.
- The summary panel is published via `registerEmbeddableComponent` (DWC 3.7.0-alpha.7+), so it can
  be dropped straight into a [Flexible Layouts](https://github.com/jaysuk/Flexible-Layouts) grid
  from **Add widget → Plugins**.
- Built with [dwc-plugin-runtime](https://github.com/jaysuk/dwc-plugin-runtime) (diagnostics,
  self-update) and tested with [dwc-plugin-test-kit](https://github.com/jaysuk/dwc-plugin-test-kit).

## Requirements

- DuetWebControl **3.7.x** (built against `v3.7-dev`, `dwcVersion: auto-major`).
- An accelerometer configured with `M955` for measurements.

## Development

```sh
npm install
npm test                 # kit-based mount tests (no DWC checkout needed)

# Building / type-checking needs a DuetWebControl checkout:
DWC_DIR=/path/to/DuetWebControl npm run typecheck
DWC_DIR=/path/to/DuetWebControl npm run verify-build   # produces ResonanceLab-<version>.zip
```

On Windows, `build.bat` wraps the same checkout-relative build (edit `DWC_DIR`/`PLUGIN_ID` at the
top if your checkout lives elsewhere) and drops the ZIP in the repo root, ready to install via
**Settings → General → Plugins → Install plugin**.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — the release changelog
is generated from them.

## Releasing

Releases are deliberate, not automatic on push: bump `plugin.json` + `package.json`, commit, then

```sh
git tag v<version> && git push origin v<version>
```

CI builds the ZIP against DWC, generates the changelog, and publishes the GitHub Release with the
machine-readable `dwc-plugin-update` metadata the in-plugin update checker uses.

## License

GPL-3.0-or-later.
