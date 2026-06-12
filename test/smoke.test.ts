import { describe, expect, it } from "vitest";
import { loadObjectModel, mountInDwc, setConnected, setModel } from "dwc-plugin-test-kit";

import ResonanceLabPage from "../src/ResonanceLabPage.vue";
import SummaryPanel from "../src/SummaryPanel.vue";

// The kit's i18n stub renders raw keys (registerPluginMessages runs in index.ts, which tests don't
// load), so assertions target the message keys the components pick - which is exactly the logic
// under test: connected/accelerometer state driving which branch renders.
describe("Resonance Lab smoke", () => {
	it("mounts the page disconnected (prompts to connect)", () => {
		setConnected(false);
		const wrapper = mountInDwc(ResonanceLabPage);
		expect(wrapper.exists()).toBe(true);
		expect(wrapper.text()).toContain("resonanceLab.notConnected");
		wrapper.unmount();
	});

	it("shows the ready empty state when an accelerometer is configured", () => {
		setConnected(true);
		setModel(loadObjectModel({ boards: [{ shortName: "MB6HC", accelerometer: { points: 0, runs: 0 } }] }));
		const wrapper = mountInDwc(ResonanceLabPage);
		expect(wrapper.text()).not.toContain("resonanceLab.accelMissing");
		expect(wrapper.text()).toContain("resonanceLab.emptyState");
		wrapper.unmount();
	});

	it("mounts the summary panel (the embeddable component) in both readiness states", () => {
		setConnected(false);
		let wrapper = mountInDwc(SummaryPanel);
		expect(wrapper.text()).toContain("resonanceLab.panel.notReady");
		wrapper.unmount();

		setConnected(true);
		setModel(loadObjectModel({ boards: [{ accelerometer: { points: 0, runs: 0 } }] }));
		wrapper = mountInDwc(SummaryPanel);
		expect(wrapper.text()).toContain("resonanceLab.panel.ready");
		wrapper.unmount();
	});
});
