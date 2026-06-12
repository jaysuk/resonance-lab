# Resonance Lab

Input shaping & resonance analysis plugin for [DuetWebControl](https://github.com/Duet3D/DuetWebControl)
(RepRapFirmware), inspired by the methodology of [Shake&Tune](https://github.com/Frix-x/klippain-shaketune)
from the Klipper world: **measure → analyse → recommend → verify**.

> **Status: early development.** The scaffold is complete (page, embeddable panel, CI, release
> automation); the measurement/analysis pipeline is being built. No releases are published yet —
> they start once the plugin is feature-complete enough to be useful.

## What it will do

- **Measure** — run controlled excitation moves and capture accelerometer samples (`M955`/`M956`)
  per axis / belt.
- **Analyse** — compute power spectral density, find resonance peaks, compare belts, flag anomalies.
- **Recommend** — suggest the best input-shaper type and frequency (`M593`) with predicted smoothing
  and remaining vibration.
- **Verify** — re-measure with the shaper applied and confirm the ringing is gone before saving.

This is a wholly new Vue 3 implementation — not a port of the stock Input Shaping plugin — informed
by Shake&Tune's methodology and the lessons from the
[Flexible Layouts](https://github.com/jaysuk/Flexible-Layouts) plugin work.

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

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — the release changelog
is generated from them.

## Releasing

Releases are deliberate, not automatic on push: bump `plugin.json` + `package.json`, commit, then

```sh
git tag v<version> && git push origin v<version>
```

CI builds the ZIP against DWC, generates the changelog, and publishes the GitHub Release with the
machine-readable `dwc-plugin-update` metadata the in-plugin update checker uses.

## Credits

- [Shake&Tune](https://github.com/Frix-x/klippain-shaketune) by Félix Boisselier (Frix-x) for the
  measurement/analysis methodology this plugin adapts to RepRapFirmware.

## License

GPL-3.0-or-later.
