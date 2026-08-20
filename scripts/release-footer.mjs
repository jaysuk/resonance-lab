#!/usr/bin/env node
/**
 * Print the static footer appended to every GitHub Release body: install instructions, the
 * DuetWebControl version the ZIP was built against, and the machine-readable metadata comment the
 * in-plugin update checker (dwc-plugin-runtime checkForUpdate) parses to learn the required DWC.
 *
 * The DWC details come from the CI build environment (the release workflow sets these after it
 * checks out DuetWebControl).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "..", "plugin.json"), "utf8"));
const pkgVersion = manifest.version;

const dwcVersion = process.env.DWC_VERSION || "";
const dwcSha = process.env.DWC_SHA || "";
const dwcRef = process.env.DWC_REF || "v3.7-dev";
const dwcBuiltAgainst = dwcVersion
	? `**DuetWebControl ${dwcVersion}**${dwcSha ? ` (\`${dwcSha}\`, ref \`${dwcRef}\`)` : ` (ref \`${dwcRef}\`)`}`
	: `DuetWebControl (ref \`${dwcRef}\`)`;

// Resolve the manifest's dwcVersion the same way DWC's build does ("auto" -> full DWC version,
// "auto-major" -> major.minor), so the metadata below matches the requirement DWC enforces at
// install. This is what the update checker compares the running DWC version against.
function resolveDwcRequirement(value, reference) {
	if (value === "auto") return reference;
	if (value === "auto-major") return reference.split(".").slice(0, 2).join(".");
	if (value === "auto-minor") return reference.split(".").slice(0, 3).join(".").split("-")[0];
	return value || "";
}
const requiredDwc = resolveDwcRequirement(manifest.dwcVersion, dwcVersion);

const out = `
---

### 📦 Install
1. Download the ZIP for **your** DuetWebControl from the **Assets** below — they are different
   builds, not alternatives:
   - DWC **3.7** and newer → \`ResonanceLab-${pkgVersion}.zip\`
   - DWC **3.6** → \`ResonanceLab-${pkgVersion}-dwc36.zip\`
2. In DuetWebControl, go to **Settings → General → Plugins** and click **Install Plugin**.
3. Select the downloaded ZIP and accept the third-party-plugin prompt.
4. Reload DWC if asked. Resonance Lab appears in the **Plugins** menu. On DWC 3.7 its summary panel
   is also available in Flexible Layouts under **Add widget → Plugins**.

> 🔧 The 3.7 package is built against ${dwcBuiltAgainst}; the 3.6 package against the DWC 3.6 branch.
> DWC refuses a package whose \`dwcVersion\` doesn't match, so picking the wrong one is safe but
> won't install. An accelerometer configured with \`M955\` is required for measurements.

<!-- dwc-plugin-update ${JSON.stringify({ version: pkgVersion, dwcVersion: requiredDwc, asset: `ResonanceLab-${pkgVersion}.zip` })} -->
<!-- dwc-plugin-update ${JSON.stringify({ version: pkgVersion, dwcVersion: "3.6", asset: `ResonanceLab-${pkgVersion}-dwc36.zip` })} -->
`;

process.stdout.write(out.replace(/^\n/, ""));
