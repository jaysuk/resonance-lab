import { describe, expect, it } from "vitest";
import { loadObjectModel, mountInDwc, sentCodes, setConnected, setModel } from "dwc-plugin-test-kit";

import { analyseCapture } from "../src/analysis/pipeline";
import { parseAccelCsv } from "../src/capture/csv";
import ResonanceLabPage from "../src/ui37/ResonanceLabPage.vue";
import SummaryPanel from "../src/ui37/SummaryPanel.vue";
import { lastResult, measurementRunning, method } from "../src/state";

/** Synthetic 3-channel (X/Y/Z) accelerometer capture, ringing at f0 on every channel. */
function accelCsv3(f0: number): string {
	const fs = 1000;
	const lines = ["Sample,X,Y,Z"];
	for (let i = 0; i < 4000; i++) {
		const t = i / fs;
		const ring = Math.exp(-8 * (t % 0.5)) * Math.sin(2 * Math.PI * f0 * t);
		lines.push(`${i},${ring.toFixed(5)},${(0.3 * ring).toFixed(5)},${(0.1 * ring).toFixed(5)}`);
	}
	lines.push(`Rate ${fs} overflows 0`);
	return lines.join("\n");
}

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

	// Regression test for a real bug: dwc-plugin-runtime's AboutDialog/HelpTip (render-function
	// components, not SFCs) called h("v-xxx", ...) with a bare string tag. Vue only resolves
	// globally-registered components by string name when the SFC template compiler inserts a
	// resolveComponent() call for you - a hand-written render function bypasses that, so the "v-xxx"
	// rendered as an inert custom HTML element (present in the DOM, completely invisible/non-
	// functional) instead of the real Vuetify component. Clicking the info button silently did
	// nothing because of this. If this test ever fails after a `npm install`, dwc-plugin-runtime's
	// pinned version has reverted to (or never received) the resolveComponent() fix.
	it("the About dialog actually renders (teleported to document.body) when opened, not an inert custom element", async () => {
		setConnected(true);
		setModel(loadObjectModel({ boards: [{ shortName: "MB6HC", accelerometer: { points: 0, runs: 0 } }] }));
		const wrapper = mountInDwc(ResonanceLabPage);
		const infoBtn = wrapper.findAll("button").find((b) => b.html().includes("mdi-information-outline"));
		expect(infoBtn).toBeTruthy();
		await infoBtn!.trigger("click");
		await wrapper.vm.$nextTick();
		await new Promise((r) => setTimeout(r, 50));
		// v-dialog teleports its content to document.body, outside the mounted component's subtree.
		expect(document.body.innerHTML).toContain("About Resonance Lab");
		wrapper.unmount();
	});

	it("HelpTip renders a real Vuetify icon, not an inert custom element", () => {
		setConnected(true);
		setModel(loadObjectModel({ boards: [{ shortName: "MB6HC", accelerometer: { points: 0, runs: 0 } }] }));
		const wrapper = mountInDwc(ResonanceLabPage);
		// The broken version rendered <v-tooltip text="..."> as an inert custom element (the text
		// attribute is present either way, so it's not a valid differentiator); the real VIcon renders
		// as a classed <i> element, which only appears once resolveComponent() actually resolves it.
		expect(wrapper.html()).toMatch(/class="[^"]*mdi-help-circle-outline[^"]*v-icon/);
		wrapper.unmount();
	});

	// RRF can't gracefully interrupt an in-progress M98 macro from a non-file channel (see CLAUDE.md) -
	// cancel only stops the plugin from waiting/queuing further steps, so the button must go into a
	// disabled "cancelling" state on click rather than disappearing (the machine may still be moving).
	it("shows a cancel button while a measurement is running, and clicking it moves to a cancelling state", async () => {
		setConnected(true);
		setModel(loadObjectModel({ boards: [{ shortName: "MB6HC", accelerometer: { points: 0, runs: 0 } }] }));
		measurementRunning.value = true;
		const wrapper = mountInDwc(ResonanceLabPage);
		try {
			const cancelBtn = wrapper.findAll("button").find((b) => b.text().includes("resonanceLab.cancel.button"));
			expect(cancelBtn).toBeTruthy();
			await cancelBtn!.trigger("click");
			expect(wrapper.text()).toContain("resonanceLab.cancel.cancelling");
		} finally {
			measurementRunning.value = false;
			wrapper.unmount();
		}
	});

	// Custom G-code (unlike every other task's fixed, reviewed move profile) runs whatever the user
	// typed verbatim, so it must be reviewed before anything is sent to the machine.
	it("asks for confirmation before running a custom G-code profile, and sends nothing until confirmed", async () => {
		setConnected(true);
		setModel(loadObjectModel({ boards: [{ shortName: "MB6HC", accelerometer: { points: 0, runs: 0 } }] }));
		method.value = "custom";
		const wrapper = mountInDwc(ResonanceLabPage);
		try {
			await wrapper.find("textarea").setValue("G1 X10 F600");
			const measureBtn = wrapper.findAll("button").find((b) => b.text().includes("resonanceLab.controls.measure"));
			await measureBtn!.trigger("click");
			await wrapper.vm.$nextTick();
			expect(document.body.innerHTML).toContain("resonanceLab.confirmGcode.title");
			expect(document.body.innerHTML).toContain("G1 X10 F600");
			expect(sentCodes()).toHaveLength(0);
		} finally {
			method.value = "sweep";
			wrapper.unmount();
		}
	});

	// The accelerometer CSV always carries every configured axis even though only one was
	// deliberately excited - the "Show X/Y/Z channels" overlay is how that data becomes visible.
	it("offers a per-channel breakdown for a single-axis result with more than one recorded channel", async () => {
		setConnected(true);
		setModel(loadObjectModel({ boards: [{ shortName: "MB6HC", accelerometer: { points: 0, runs: 0 } }] }));
		const capture = parseAccelCsv(accelCsv3(42));
		lastResult.value = { axis: "X", when: new Date(), source: "test", analysis: analyseCapture(capture), capture };
		method.value = "sweep";
		const wrapper = mountInDwc(ResonanceLabPage);
		try {
			expect(wrapper.text()).toContain("resonanceLab.results.showChannels");
			const checkbox = wrapper.find('input[type="checkbox"]');
			expect(checkbox.exists()).toBe(true);
			expect((checkbox.element as HTMLInputElement).checked).toBe(false);
			await checkbox.setValue(true);
			expect((checkbox.element as HTMLInputElement).checked).toBe(true);
		} finally {
			lastResult.value = null;
			wrapper.unmount();
		}
	});
});
