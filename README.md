# Resonance Lab

Input shaping & resonance analysis plugin for [DuetWebControl](https://github.com/Duet3D/DuetWebControl)
(RepRapFirmware): **measure → analyse → recommend → verify**, computed entirely in the browser.

Grab the latest release from the [Releases page](https://github.com/jaysuk/resonance-lab/releases) —
download the ZIP and install it via **Settings → General → Plugins → Install Plugin** in DuetWebControl.

## What it does

- **Measure** — run controlled excitation moves and capture accelerometer samples (`M955`/`M956`)
  per axis / belt, optionally at a specific Z height. On RepRapFirmware **3.7.0-rc.2+** every
  configured accelerometer is listed (up to 10, one per board — including the SPI-connected ones on
  STM32 toolboards) and measured by its own slot, with nothing to reconfigure between tools on a
  tool-changer. On **3.7.0-rc.1** the plugin instead reactivates the right accelerometer before every
  single measurement automatically (that release supports only one active accelerometer
  machine-wide; **3.7.0-rc.1+1** raised it to 10 at once).
- **Analyse** — compute power spectral density, find resonance peaks, compare belts, flag anomalies,
  and measure motor quality (vibration at multiples of a motor's own full-step frequency, isolating
  the motor and driver from the machine's structural response).
- **Recommend** — suggest the input-shaper type and frequency (`M593`) that removes the most
  residual vibration, weighing every measured axis at once when more than one was swept; on
  RepRapFirmware **3.7.0-rc.1+**, also search for and apply a motor's own current-waveform
  correction (`M970.3`/`M569.2`) to reduce detent-torque and coil-imbalance vibration at the source —
  on phase-stepping and closed-loop drivers alike, including CAN toolboards such as the 1HCL, M23CL
  and INDX. Phase-stepping drivers can tune any of harmonics 1, 2, 3, 4, 6 and 8 (up to four at once,
  with an optional survey that skips the quiet ones and a final check that they didn't disturb each other).
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

- DuetWebControl **3.7.x** (built against `v3.7-dev`, `dwcVersion: auto-major`), or **3.6** using the
  separate `-dwc36.zip` from each release (same analysis; the Flexible Layouts summary panel is 3.7-only).
- An accelerometer configured with `M955` for measurements. On RepRapFirmware 3.7.0-rc.2+ it is found in
  `sensors.accelerometers[]`; a toolboard whose accelerometer is on SPI (the third-party RP2040/RP2350
  boards such as the SHT36 and SB2040) needs both pins — `M955 P<n> C"<addr>.spi.cs.acc+int.acc"` —
  and the page shows that line when it finds such a board with nothing configured.

## Development

```sh
npm install
npm test                 # kit-based mount tests (no DWC checkout needed)

# Building / type-checking needs a DuetWebControl checkout:
DWC_DIR=/path/to/DuetWebControl npm run typecheck
DWC_DIR=/path/to/DuetWebControl npm run verify-build   # produces ResonanceLab-<version>.zip
```

The DWC checkout must be on `v3.7-dev` with this plugin's dependencies installed in it (see `CLAUDE.md`).
`build36.bat` builds the DWC 3.6 package against a separate 3.6 checkout (`DWC36_DIR` at its top).

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
