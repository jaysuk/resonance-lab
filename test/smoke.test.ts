import { describe, expect, it } from "vitest";
import { loadObjectModel, mountInDwc, sentCodes, setConnected, setModel } from "dwc-plugin-test-kit";

import { analyseCapture } from "../src/analysis/pipeline";
import { parseAccelCsv } from "../src/capture/csv";
import ResonanceLabPage from "../src/ui37/ResonanceLabPage.vue";
import SummaryPanel from "../src/ui37/SummaryPanel.vue";
import { lastResult, measurementRunning, method, motorTuneResult, selectedMotor } from "../src/state";

/** Non-core-kinematics model with a single tunable Z motor, for the motortune firmware gate tests. */
function tuneModel(firmwareVersion: string) {
	return loadObjectModel({
		boards: [{ shortName: "MB6HC", firmwareVersion, canAddress: 0, accelerometer: { points: 0, runs: 0 } }],
		move: {
			kinematics: {},
			axes: [{
				letter: "Z", visible: true, homed: true, min: 0, max: 200,
				stepsPerMm: 400, microstepping: { value: 16 }, phaseStep: true,
				drivers: [{ board: 0, driver: 0 }], acceleration: 500, speed: 40,
			}],
		},
	});
}

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

	// The motortune task writes to the driver in a search loop, so it must not appear at all below
	// the minimum firmware version - not merely be disabled, since the command may not exist in the
	// firmware below that version. The motor (analysis-only) task must stay visible regardless.
	it("hides the motor waveform tuning task below the minimum firmware version, but keeps motor analysis", () => {
		setConnected(true);
		setModel(tuneModel("3.6.1"));
		const wrapper = mountInDwc(ResonanceLabPage);
		try {
			expect(wrapper.text()).not.toContain("resonanceLab.tasks.motortune.title");
			expect(wrapper.text()).toContain("resonanceLab.tasks.motor.title");
		} finally {
			wrapper.unmount();
		}
	});

	it("shows the motor waveform tuning task at the minimum firmware version", () => {
		setConnected(true);
		setModel(tuneModel("3.7.0-rc.1"));
		const wrapper = mountInDwc(ResonanceLabPage);
		try {
			expect(wrapper.text()).toContain("resonanceLab.tasks.motortune.title");
		} finally {
			wrapper.unmount();
		}
	});

	// The STM32 port appends a parenthesised suffix to its version string (e.g. "(CAN0)") - the gate
	// must strip it before parsing, or every STM32H7 board (the main phase-stepping platform) would
	// fail closed and never see this task at all.
	it("shows the motor waveform tuning task on the STM32 port's parenthesised version suffix", () => {
		setConnected(true);
		setModel(tuneModel("3.7.0-rc.1(CAN0)"));
		const wrapper = mountInDwc(ResonanceLabPage);
		try {
			expect(wrapper.text()).toContain("resonanceLab.tasks.motortune.title");
		} finally {
			wrapper.unmount();
		}
	});

	// R1 regression: the motor picker is re-enabled the moment a run finishes, while the result card
	// and its Discard button are still on screen. Discard must restore the driver that was actually
	// tuned (recorded on the result), NOT whatever motor happens to be selected now - otherwise it
	// writes one driver's saved values into a different driver that was never tuned.
	it("discard restores the driver recorded on the result, not the currently-selected motor", async () => {
		setConnected(true);
		setModel(loadObjectModel({
			boards: [{ shortName: "MB6HC", firmwareVersion: "3.7.0-rc.1", canAddress: 0, accelerometer: { points: 0, runs: 0 } }],
			move: {
				kinematics: { forwardMatrix: [[0.5, 0.5], [0.5, -0.5]], inverseMatrix: [[1, 1], [1, -1]] },
				axes: [
					{ letter: "X", visible: true, homed: true, min: 0, max: 300, stepsPerMm: 80, microstepping: { value: 16 }, phaseStep: true, drivers: [{ board: 0, driver: 0 }], acceleration: 4000, speed: 500 },
					{ letter: "Y", visible: true, homed: true, min: 0, max: 300, stepsPerMm: 80, microstepping: { value: 16 }, phaseStep: true, drivers: [{ board: 0, driver: 1 }], acceleration: 4000, speed: 500 },
				],
			},
		}));
		method.value = "motortune";
		// A finished run against driver 0 ("X"), as measure() would have left it.
		motorTuneResult.value = {
			motor: "X", label: "X+Y", command: "M970.3", driverId: "0", chip: "TMC5160",
			results: [{ harmonic: 4, baseline: 0.5, best: { harmonic: 4, magnitude: 1.2, phase: 30, amplitude: 0.2, amplitudes: [0.2, 0.2] } }],
			codes: ["M970.3 P0 S4 J1.20 O30.0"], kept: false,
		};
		// The user now picks the OTHER motor before pressing Discard.
		selectedMotor.value = "Y";

		const wrapper = mountInDwc(ResonanceLabPage);
		try {
			const before = sentCodes().length;
			const discardBtn = wrapper.findAll("button").find((b) => b.text().includes("resonanceLab.motorTune.discard"));
			expect(discardBtn).toBeTruthy();
			await discardBtn!.trigger("click");
			await new Promise((r) => setTimeout(r, 20));

			// Correction WRITES only ("<cmd> P<drv> S<h> J<mag> O<phase>") - not the chip-detection
			// register reads ("M569.2 P<drv> R<addr>"), which legitimately follow the selected motor.
			const restoreCodes = sentCodes().slice(before).filter((c) => /\sS\d+\s+J/.test(c));
			expect(restoreCodes.length).toBeGreaterThan(0);
			// Every restore write must target driver 0 (the one tuned), never driver 1 (now selected).
			for (const code of restoreCodes) {
				expect(code).toContain("P0 ");
				expect(code).not.toContain("P1 ");
			}
		} finally {
			motorTuneResult.value = null;
			selectedMotor.value = "";
			method.value = "sweep";
			wrapper.unmount();
		}
	});

	// RRF 3.7.0-rc.2 moved accelerometers from boards[].accelerometer to sensors.accelerometers[] - a
	// page that only read the old place would report "no accelerometer" on every rc.2 machine.
	it("finds an accelerometer in sensors.accelerometers[] (RRF 3.7.0-rc.2), where boards[] no longer carries one", () => {
		setConnected(true);
		setModel(loadObjectModel({
			boards: [{ shortName: "MB6HC", firmwareVersion: "3.7.0-rc.2", canAddress: 0 }],
			sensors: { accelerometers: [{ orientation: 20, points: 0, port: "spi.cs3+io4.in", resolution: 10, runs: 0, samplingRate: 1000 }] },
		}));
		const wrapper = mountInDwc(ResonanceLabPage);
		try {
			expect(wrapper.text()).not.toContain("resonanceLab.accelMissing");
			expect(wrapper.text()).toContain("resonanceLab.emptyState");
		} finally {
			wrapper.unmount();
		}
	});

	it("arms a measurement on rc.2 by the accelerometer's own slot, with no M955 in front of it", async () => {
		setConnected(true);
		setModel(loadObjectModel({
			boards: [
				{ shortName: "MB6HC", firmwareVersion: "3.7.0-rc.2", canAddress: 0 },
				{ shortName: "SHT36v3", firmwareVersion: "3.7.0-rc.2", canAddress: 121 },
			],
			// The toolboard's accelerometer was configured as slot 2, with slots 0 and 1 unused
			sensors: { accelerometers: [null, null, { orientation: 20, port: "121.spi.cs.acc+int.acc", resolution: 10, runs: 0, samplingRate: 1000 }] },
		}));
		method.value = "move";
		const wrapper = mountInDwc(ResonanceLabPage);
		try {
			const before = sentCodes().length;
			const measureBtn = wrapper.findAll("button").find((b) => b.text().includes("resonanceLab.controls.measure"));
			expect(measureBtn).toBeTruthy();
			await measureBtn!.trigger("click");
			await new Promise((r) => setTimeout(r, 50));
			const sent = sentCodes().slice(before);
			expect(sent.find((c) => c.includes("M956"))).toMatch(/M956 P2 S/); // its slot, not P121.0 or P0
			expect(sent.some((c) => c.startsWith("M955"))).toBe(false);
		} finally {
			method.value = "sweep";
			measurementRunning.value = false;
			wrapper.unmount();
		}
	});

	// Each task renders only its own params (TaskDef.params) - the motor task needs its own motor
	// picker (not the plain axis picker every other axis-using task gets) plus its four params.
	it("selecting the motor task renders its own picker and params, not the plain axis picker", () => {
		setConnected(true);
		setModel(loadObjectModel({ boards: [{ shortName: "MB6HC", accelerometer: { points: 0, runs: 0 } }] }));
		method.value = "motor";
		const wrapper = mountInDwc(ResonanceLabPage);
		try {
			expect(wrapper.text()).toContain("resonanceLab.controls.motor");
			expect(wrapper.text()).toContain("Length (mm)");
			expect(wrapper.text()).not.toContain("resonanceLab.controls.axis");
		} finally {
			method.value = "sweep";
			wrapper.unmount();
		}
	});
});
