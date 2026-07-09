<!--
  Resonance Lab - the lab page.

  Layout: a task rail on the left lists the jobs (calibrate, belt tension, vibration-vs-speed,
  orientation + a diagnostics group); the panel on the right explains the selected task, shows only
  the controls that task actually uses, then gives the rest of the space to the chart and verdict.
  Each task owns its parameters and its "what will happen" blurb, so nothing on screen is inert.
-->
<template>
	<v-container fluid class="d-flex flex-column fill-height pa-0">
		<!-- Top strip: title + global actions -->
		<div class="d-flex align-center ga-2 px-3 py-2">
			<v-icon size="large" class="me-1">mdi-sine-wave</v-icon>
			<span class="text-subtitle-1 font-weight-medium">{{ $t("plugins.resonanceLab.title") }}</span>
			<v-spacer />
			<v-btn variant="text" prepend-icon="mdi-folder-open-outline" :disabled="running || !isConnected" @click="openCaptureBrowser">
				{{ $t("plugins.resonanceLab.controls.captures") }}
			</v-btn>
			<v-btn variant="text" prepend-icon="mdi-file-upload-outline" :disabled="running" @click="filePicker?.click()">
				{{ $t("plugins.resonanceLab.controls.loadCsv") }}
			</v-btn>
			<v-btn icon="mdi-cog-outline" variant="text" size="small" :title="$t('plugins.resonanceLab.settings.open')" @click="settingsOpen = true" />
			<v-btn icon="mdi-help-circle-outline" variant="text" size="small" :title="$t('plugins.resonanceLab.help.open')" @click="helpDialog = true" />
			<v-btn icon="mdi-bug-outline" variant="text" size="small" :title="$t('plugins.resonanceLab.controls.diagnostics')" @click="downloadDiagnostics" />
			<v-btn icon="mdi-information-outline" variant="text" size="small" :title="$t('plugins.resonanceLab.controls.about')" @click="aboutOpen = true" />
			<input ref="filePicker" type="file" accept=".csv" class="d-none" @change="loadLocalCsv">
		</div>

		<AboutDialog v-model="aboutOpen" plugin-id="ResonanceLab" title="Resonance Lab"
			:description="aboutDescription" :model="machineStore.model"
			repo="https://github.com/jaysuk/resonance-lab"
			:update-available="updateState?.updateAvailable ?? false" :latest-version="updateState?.latestVersion"
			:checking="checking" :applying="updateApplying" :pending-reload="pendingReload" :auto-check="autoCheck"
			@check-update="onCheckUpdate" @apply-update="applyUpdateNow" @toggle-auto-check="onToggleAutoCheck" />

		<!-- Plugin settings -->
		<v-dialog v-model="settingsOpen" max-width="520">
			<v-card>
				<v-card-title class="d-flex align-center">
					<v-icon class="me-2">mdi-cog-outline</v-icon>{{ $t("plugins.resonanceLab.settings.title") }}
				</v-card-title>
				<v-card-text>
					<v-text-field v-model="programDir" density="compact" variant="outlined"
								  :label="$t('plugins.resonanceLab.settings.programDir')" :placeholder="DEFAULT_PROGRAM_DIR" hide-details="auto">
						<template #append-inner><HelpTip :text="$t('plugins.resonanceLab.settings.programDirHint')" /></template>
					</v-text-field>
					<div class="text-caption text-medium-emphasis mt-2">{{ $t("plugins.resonanceLab.settings.programDirNote") }}</div>
				</v-card-text>
				<v-card-actions>
					<v-btn variant="text" @click="programDir = DEFAULT_PROGRAM_DIR">{{ $t("plugins.resonanceLab.settings.reset") }}</v-btn>
					<v-spacer />
					<v-btn color="primary" variant="tonal" @click="settingsOpen = false">{{ $t("plugins.resonanceLab.settings.done") }}</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
		<v-dialog v-model="confirmGcodeOpen" max-width="520">
			<v-card>
				<v-card-title class="d-flex align-center">
					<v-icon class="me-2" color="warning">mdi-alert-outline</v-icon>{{ $t("plugins.resonanceLab.confirmGcode.title") }}
				</v-card-title>
				<v-card-text>
					<div class="mb-2">{{ $t("plugins.resonanceLab.confirmGcode.body") }}</div>
					<pre class="rlab-gcode-preview">{{ adv.customMoves }}</pre>
					<v-checkbox v-model="skipGcodeConfirm" density="compact" hide-details :label="$t('plugins.resonanceLab.confirmGcode.dontAskAgain')" />
				</v-card-text>
				<v-card-actions>
					<v-btn variant="text" @click="confirmGcodeOpen = false">{{ $t("plugins.resonanceLab.confirmGcode.cancel") }}</v-btn>
					<v-spacer />
					<v-btn color="primary" variant="tonal" @click="confirmGcodeOpen = false; measure();">{{ $t("plugins.resonanceLab.confirmGcode.confirm") }}</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
		<v-divider />

		<div class="d-flex flex-grow-1" style="min-height: 0">
			<!-- Task rail: pick the job by what you want to achieve -->
			<v-list nav density="compact" class="flex-shrink-0 py-2 rlab-task-rail" style="width: 232px">
				<v-list-subheader>{{ $t("plugins.resonanceLab.rail.goals") }}</v-list-subheader>
				<v-list-item v-for="td in goalTasks" :key="td.id" :active="method === td.id" :disabled="running"
							 :prepend-icon="td.icon" :title="$t(`plugins.resonanceLab.tasks.${td.id}.title`)" @click="selectTask(td.id)" />
				<v-list-subheader>{{ $t("plugins.resonanceLab.rail.diagnostics") }}</v-list-subheader>
				<v-list-item v-for="td in diagTasks" :key="td.id" :active="method === td.id" :disabled="running"
							 :prepend-icon="td.icon" :title="$t(`plugins.resonanceLab.tasks.${td.id}.title`)" @click="selectTask(td.id)" />
			</v-list>
			<v-divider vertical />

			<!-- Task panel -->
			<div class="flex-grow-1 d-flex flex-column pa-3" style="min-width: 0; overflow-y: auto">
				<!-- What this task does -->
				<div class="d-flex align-center ga-2">
					<v-icon size="large">{{ activeTask.icon }}</v-icon>
					<div class="text-h6">{{ $t(`plugins.resonanceLab.tasks.${method}.title`) }}</div>
				</div>
				<div class="text-body-2 text-medium-emphasis mt-1 mb-3" style="max-width: 80ch">
					{{ $t(`plugins.resonanceLab.tasks.${method}.blurb`) }}
				</div>

				<!-- Self-update offer -->
				<v-alert v-if="pendingReload" type="success" variant="tonal" density="compact" class="mb-3">
					{{ $t("plugins.resonanceLab.update.installed") }}
					<template #append><v-btn size="small" color="success" prepend-icon="mdi-restart" @click="reload">{{ $t("plugins.resonanceLab.update.reload") }}</v-btn></template>
				</v-alert>
				<v-alert v-else-if="updateState?.scenario === 'pluginUpdate'" type="info" variant="tonal" density="compact" class="mb-3">
					{{ $t("plugins.resonanceLab.update.available", { version: updateState.latestVersion }) }}
					<template #append><v-btn size="small" color="primary" :loading="updateApplying" prepend-icon="mdi-download" @click="applyUpdateNow">{{ $t("plugins.resonanceLab.update.apply") }}</v-btn></template>
				</v-alert>

				<!-- Readiness -->
				<v-alert v-if="!isConnected" type="info" variant="tonal" density="compact" class="mb-3">
					{{ $t("plugins.resonanceLab.notConnected") }}
				</v-alert>
				<v-alert v-else-if="accelItems.length === 0" type="warning" variant="tonal" density="compact" class="mb-3">
					{{ $t("plugins.resonanceLab.accelMissing") }}
				</v-alert>
				<v-alert v-else-if="error" type="error" variant="tonal" density="compact" class="mb-3" closable @click:close="error = ''">
					{{ error }}
				</v-alert>

				<!-- Parameters: only the controls this task actually uses -->
				<v-sheet v-if="isConnected && accelItems.length > 0" border rounded class="pa-3 mb-3">
					<div class="d-flex flex-wrap align-center ga-3">
						<v-select v-if="accelItems.length > 1" v-model="selectedAccel" :items="accelItems" item-title="label" return-object
								  density="compact" variant="outlined" hide-details style="min-width: 220px"
								  :label="$t('plugins.resonanceLab.controls.accelerometer')" :disabled="running" />
						<div v-else-if="selectedAccel" class="text-body-2">
							<span class="text-medium-emphasis">{{ $t("plugins.resonanceLab.controls.accelerometer") }}:</span> {{ selectedAccel.label }}
						</div>
						<v-select v-if="method === 'sweep'" v-model="selectedAxes" :items="axisItems" multiple chips closable-chips
								  density="compact" variant="outlined" hide-details style="min-width: 170px"
								  :label="$t('plugins.resonanceLab.controls.axes')" :disabled="running" />
						<v-select v-else-if="activeTask.usesAxis" v-model="selectedAxis" :items="axisItems" density="compact" variant="outlined"
								  hide-details style="max-width: 110px" :label="$t('plugins.resonanceLab.controls.axis')" :disabled="running" />
						<v-chip v-else size="small" variant="tonal" prepend-icon="mdi-axis-arrow">{{ taskAxisNote }}</v-chip>
						<v-text-field v-if="method !== 'axescheck'" v-model.number="adv.zHeight" type="number" density="compact" variant="outlined" clearable
									  hide-details :label="$t('plugins.resonanceLab.controls.zHeight')" placeholder="current" style="max-width: 140px" :disabled="running">
							<template #append-inner><HelpTip text="Move to this Z height (mm) before measuring. Leave blank to measure at the machine's current Z position." /></template>
						</v-text-field>
						<v-text-field v-if="activeTask.params.includes('startFreq')" v-model.number="adv.startFreq" type="number" density="compact" variant="outlined" hide-details label="Start (Hz)" style="max-width: 132px" :disabled="running"><template #append-inner><HelpTip text="Lowest frequency of the sweep, in Hz. Start a little below where you expect resonances (often 5–15 Hz)." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('endFreq')" v-model.number="adv.endFreq" type="number" density="compact" variant="outlined" hide-details label="End (Hz)" style="max-width: 132px" :disabled="running"><template #append-inner><HelpTip text="Highest frequency of the sweep, in Hz. Cover the range your input shaper acts on (commonly up to ~100–150 Hz)." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('hzPerSec')" v-model.number="adv.hzPerSec" type="number" density="compact" variant="outlined" hide-details label="Sweep (Hz/s)" style="max-width: 142px" :disabled="running"><template #append-inner><HelpTip text="How fast the sweep ramps through the frequency range, in Hz per second. Slower sweeps give cleaner data but take longer." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('beltStart')" v-model.number="adv.beltStart" type="number" density="compact" variant="outlined" hide-details label="Start (Hz)" style="max-width: 132px" :disabled="running"><template #append-inner><HelpTip text="Lowest frequency for the belt-tension test, in Hz." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('beltEnd')" v-model.number="adv.beltEnd" type="number" density="compact" variant="outlined" hide-details label="End (Hz)" style="max-width: 132px" :disabled="running"><template #append-inner><HelpTip text="Highest frequency for the belt-tension test, in Hz." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('beltHz')" v-model.number="adv.beltHz" type="number" density="compact" variant="outlined" hide-details label="Sweep (Hz/s)" style="max-width: 142px" :disabled="running"><template #append-inner><HelpTip text="Sweep rate for the belt-tension test, in Hz per second." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('exciteFreq')" v-model.number="adv.exciteFreq" type="number" density="compact" variant="outlined" hide-details label="Frequency (Hz)" style="max-width: 152px" :disabled="running"><template #append-inner><HelpTip text="Single frequency to excite the axis at, in Hz — used to dwell on a suspected resonance." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('exciteSeconds')" v-model.number="adv.exciteSeconds" type="number" density="compact" variant="outlined" hide-details label="Duration (s)" style="max-width: 132px" :disabled="running"><template #append-inner><HelpTip text="How long to excite at the chosen frequency, in seconds." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('speedMin')" v-model.number="adv.speedMin" type="number" density="compact" variant="outlined" hide-details label="Min (mm/s)" style="max-width: 132px" :disabled="running"><template #append-inner><HelpTip text="Lowest test speed, in mm/s." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('speedMax')" v-model.number="adv.speedMax" type="number" density="compact" variant="outlined" hide-details label="Max (mm/s)" style="max-width: 132px" :disabled="running"><template #append-inner><HelpTip text="Highest test speed, in mm/s." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('speedStep')" v-model.number="adv.speedStep" type="number" density="compact" variant="outlined" hide-details label="Step (mm/s)" style="max-width: 132px" :disabled="running"><template #append-inner><HelpTip text="Speed increment between test runs, in mm/s." /></template></v-text-field>
						<v-spacer />
						<v-btn color="primary" prepend-icon="mdi-play" :loading="running" :disabled="!canMeasure" @click="onMeasureClick">
							{{ $t("plugins.resonanceLab.controls.measure") }}
						</v-btn>
					</div>
					<v-textarea v-if="activeTask.params.includes('customMoves')" v-model="adv.customMoves" class="mt-3" density="compact" variant="outlined"
								rows="4" hide-details :label="$t('plugins.resonanceLab.controls.customMoves')" :disabled="running" />
					<div class="text-caption text-medium-emphasis mt-2">
						{{ $t(`plugins.resonanceLab.tasks.${method}.run`) }} · {{ $t("plugins.resonanceLab.durationLabel", { dur: durationEstimate }) }}
					</div>
				</v-sheet>

				<!-- Progress -->
				<v-alert v-if="running" type="info" variant="tonal" density="compact" class="mb-3">
					<div class="d-flex align-center ga-2">
						<v-progress-circular indeterminate size="16" width="2" />
						<span class="flex-grow-1">
							{{ $t("plugins.resonanceLab.runningTask", { task: $t(`plugins.resonanceLab.tasks.${method}.title`) }) }}
							<template v-if="method === 'belts' && beltPhase"> — {{ $t(`plugins.resonanceLab.belts.phase${beltPhase}`) }}</template>
							<template v-if="method === 'belts' && beltEstablishingTiming"> ({{ $t('plugins.resonanceLab.belts.phaseTiming') }})</template>
						</span>
						<v-btn size="small" variant="text" :disabled="cancelRequested"
							   :prepend-icon="cancelRequested ? undefined : 'mdi-stop-circle-outline'"
							   @click="cancelRequested = true">
							{{ cancelRequested ? $t("plugins.resonanceLab.cancel.cancelling") : $t("plugins.resonanceLab.cancel.button") }}
						</v-btn>
					</div>
					<div v-if="cancelRequested" class="text-caption text-medium-emphasis mt-1">
						{{ $t("plugins.resonanceLab.cancel.notice") }}
					</div>
				</v-alert>
				<!-- Loading a saved capture: prominent, replaces whatever was on screen (already cleared) -->
				<div v-if="loadingCapture" class="flex-grow-1 d-flex flex-column align-center justify-center text-medium-emphasis">
					<v-progress-circular indeterminate size="56" width="4" color="primary" class="mb-4" />
					<div class="text-h6">{{ $t("plugins.resonanceLab.captures.loading") }}</div>
				</div>

				<!-- Results: verdict + chart get all remaining space -->
				<template v-else-if="result">
					<div v-if="multiResults.length" class="mb-2">
						<v-btn size="small" variant="text" prepend-icon="mdi-arrow-left" @click="backToOverlay">
							{{ $t("plugins.resonanceLab.multi.back") }}
						</v-btn>
					</div>
					<v-alert v-if="result.analysis.overflows > 0" type="warning" variant="tonal" density="compact" class="mb-2">
						{{ $t("plugins.resonanceLab.overflows", { count: result.analysis.overflows }) }}
					</v-alert>

					<v-card v-if="verdict" variant="tonal" :color="verdict.color" class="mb-3">
						<v-card-text class="d-flex align-center flex-wrap ga-3 py-3">
							<v-icon size="large">{{ verdict.icon }}</v-icon>
							<div class="flex-grow-1">
								<div class="text-subtitle-1 font-weight-medium">{{ verdict.headline }}</div>
								<div class="text-body-2">{{ verdict.detail }}</div>
							</div>
							<v-select v-if="rec" v-model="overlay" :items="overlayItems" item-title="title" item-value="value"
									  density="compact" variant="outlined" hide-details style="max-width: 260px"
									  :label="$t('plugins.resonanceLab.results.compare')" />
							<v-btn v-if="rec" color="primary" prepend-icon="mdi-check" :loading="applying" :disabled="!isConnected" @click="applyShaper">
								{{ $t("plugins.resonanceLab.results.apply", { shaper: displayName(overlay) }) }}
							</v-btn>
							<v-btn v-if="appliedFit" variant="tonal" prepend-icon="mdi-check-decagram-outline" :loading="running" :disabled="!isConnected" @click="verify">
								{{ $t("plugins.resonanceLab.results.verify") }}
							</v-btn>
						</v-card-text>
					</v-card>

					<v-alert v-if="verifyResult" :type="verifyResult.reduction > 0.5 ? 'success' : 'warning'" variant="tonal" density="comfortable" class="mb-2">
						{{ $t("plugins.resonanceLab.results.verified", { reduction: (verifyResult.reduction * 100).toFixed(0) }) }}
					</v-alert>
					<div v-if="!verifyResult && result.capture" class="d-flex align-center justify-end ga-3 mb-1">
						<v-checkbox v-if="chartMode === 'spectrum' && result.capture.axes.length > 1" v-model="showChannels" density="compact" hide-details
									:label="$t('plugins.resonanceLab.results.showChannels')" />
						<v-btn-toggle v-model="chartMode" density="compact" variant="outlined" mandatory>
							<v-btn value="spectrum" size="small" prepend-icon="mdi-chart-bell-curve">{{ $t("plugins.resonanceLab.results.spectrum") }}</v-btn>
							<v-btn value="spectrogram" size="small" prepend-icon="mdi-blur-linear">{{ $t("plugins.resonanceLab.results.spectrogram") }}</v-btn>
						</v-btn-toggle>
					</div>
					<div class="flex-grow-1" style="min-height: 420px">
						<SpectrogramView v-if="!verifyResult && chartMode === 'spectrogram' && spectrogram" :spec="spectrogram" />
						<LineChart v-else-if="verifyResult"
								   :labels="verifyResult.before.labels"
								   :series="[
								   	{ label: $t('plugins.resonanceLab.results.before'), data: verifyResult.before.data, color: '#2196f3' },
								   	{ label: $t('plugins.resonanceLab.results.after'), data: verifyResult.after, color: '#4caf50' },
								   ]"
								   x-title="Frequency (Hz)" y-title="Vibration (normalised)" />
						<SpectrumChart v-else :analysis="result.analysis" :overlay-shaper="overlay"
									   :channel-labels="result.capture?.axes" :show-channels="showChannels" />
					</div>

					<div class="d-flex align-center flex-wrap ga-4 mt-2 text-caption text-medium-emphasis">
						<span>{{ $t("plugins.resonanceLab.results.source", { source: result.source }) }}</span>
						<span>{{ $t("plugins.resonanceLab.results.samples", { count: result.analysis.sampleCount, rate: result.analysis.samplingRate }) }}</span>
						<span v-for="p in result.analysis.peaks.slice(0, 3)" :key="p.freq">
							{{ $t("plugins.resonanceLab.results.peak", { freq: p.freq.toFixed(1) }) }}<template v-if="p.dampingRatio"> (ζ≈{{ p.dampingRatio.toFixed(3) }})</template>
						</span>
					</div>
				</template>

				<!-- Accelerometer orientation check result -->
				<template v-else-if="orientationResult">
					<v-card variant="tonal" :color="orientationResult.solution.iParam ? 'success' : 'warning'" class="mb-3">
						<v-card-text class="d-flex align-center flex-wrap ga-3 py-3">
							<v-icon size="large">{{ orientationResult.solution.iParam ? "mdi-axis-arrow-info" : "mdi-axis-arrow-lock" }}</v-icon>
							<div class="flex-grow-1">
								<div class="text-subtitle-1 font-weight-medium">{{ orientationResult.solution.summary.join(" · ") }}</div>
								<div v-if="orientationResult.solution.iParam" class="text-body-2">
									{{ $t("plugins.resonanceLab.orientation.suggest") }}
									<code>M955 P{{ orientationResult.accelId }} I{{ orientationResult.solution.iParam }}</code>
								</div>
								<div v-else class="text-body-2">{{ $t("plugins.resonanceLab.orientation.underdetermined") }}</div>
								<div v-if="orientationResult.solution.conflicts.length" class="text-caption text-warning">
									{{ $t("plugins.resonanceLab.orientation.conflict", { axes: orientationResult.solution.conflicts.join(", ") }) }}
								</div>
								<div v-if="orientationResult.coupling > 0.6" class="text-caption text-warning">
									{{ $t("plugins.resonanceLab.orientation.coupling", { pct: (orientationResult.coupling * 100).toFixed(0) }) }}
								</div>
							</div>
							<v-btn v-if="orientationResult.solution.iParam" color="primary" prepend-icon="mdi-check" :disabled="!isConnected"
								   @click="applyOrientation">
								{{ $t("plugins.resonanceLab.orientation.apply") }}
							</v-btn>
						</v-card-text>
					</v-card>
				</template>

				<!-- Belt comparison result -->
				<template v-else-if="beltResult && beltVerdict && beltChart">
					<v-card variant="tonal" :color="beltVerdict.color" class="mb-3">
						<v-card-text class="d-flex align-center ga-3 py-3">
							<v-icon size="large">{{ beltVerdict.icon }}</v-icon>
							<div>
								<div class="text-subtitle-1 font-weight-medium">{{ beltVerdict.headline }}</div>
								<div class="text-body-2">{{ beltVerdict.detail }}</div>
							</div>
						</v-card-text>
					</v-card>
					<div class="flex-grow-1" style="min-height: 420px">
						<LineChart :labels="beltChart.labels" :series="beltChart.series"
								   x-title="Frequency (Hz)" y-title="Vibration" />
					</div>
				</template>

				<!-- Vibration profile result -->
				<template v-else-if="profileResult && profileVerdict && profileChart">
					<v-card variant="tonal" :color="profileVerdict.color" class="mb-3">
						<v-card-text class="d-flex align-center ga-3 py-3">
							<v-icon size="large">{{ profileVerdict.icon }}</v-icon>
							<div>
								<div class="text-subtitle-1 font-weight-medium">{{ profileVerdict.headline }}</div>
								<div class="text-body-2">{{ profileVerdict.detail }}</div>
							</div>
						</v-card-text>
					</v-card>
					<div class="flex-grow-1" style="min-height: 420px">
						<LineChart :labels="profileChart.labels" :series="profileChart.series"
								   x-title="Speed (mm/s)" y-title="Vibration energy" />
					</div>
				</template>

				<!-- Multi-axis calibration overlay -->
				<template v-else-if="multiResults.length && multiChart">
					<v-card v-if="combinedSummary" variant="tonal" color="primary" class="mb-2">
						<v-card-text class="d-flex align-center flex-wrap ga-3 py-3">
							<v-icon size="large">mdi-check-decagram-outline</v-icon>
							<div class="flex-grow-1">
								<div class="text-subtitle-1 font-weight-medium">
									{{ $t("plugins.resonanceLab.multi.combined", { shaper: combinedSummary.display, freq: combinedSummary.freq.toFixed(1) }) }}
								</div>
								<div class="text-body-2">
									{{ combinedSummary.agrees ? $t("plugins.resonanceLab.multi.agree") : $t("plugins.resonanceLab.multi.combinedDetail", { perAxis: combinedSummary.perAxisText }) }}
								</div>
							</div>
							<v-btn color="primary" prepend-icon="mdi-check" :loading="applying" :disabled="!isConnected" @click="applyShaperFit(combinedSummary.name, combinedSummary.freq)">
								{{ $t("plugins.resonanceLab.results.apply", { shaper: combinedSummary.display }) }}
							</v-btn>
						</v-card-text>
					</v-card>
					<v-card variant="tonal" color="info" class="mb-3">
						<v-card-text class="py-3">
							<div class="text-subtitle-1 font-weight-medium mb-2">{{ $t("plugins.resonanceLab.multi.headline") }}</div>
							<div v-for="row in multiRows" :key="row.axis" class="d-flex align-center ga-3 py-1">
								<v-chip size="small" label variant="outlined" :style="{ borderColor: row.color, color: row.color }">{{ row.axis }}</v-chip>
								<span class="text-body-2 text-medium-emphasis">
									<template v-if="row.fit">{{ $t("plugins.resonanceLab.multi.row", { peak: row.peak, shaper: row.fit.display, freq: row.fit.freq.toFixed(1), reduction: row.fit.reduction }) }}</template>
									<template v-else>{{ $t("plugins.resonanceLab.multi.quiet", { peak: row.peak }) }}</template>
								</span>
								<v-spacer />
								<v-btn size="small" variant="text" prepend-icon="mdi-chart-bell-curve" @click="inspectAxis(row.axis)">
									{{ $t("plugins.resonanceLab.multi.inspect") }}
								</v-btn>
								<v-btn v-if="row.fit" size="small" variant="text" prepend-icon="mdi-check" :loading="applying" :disabled="!isConnected" @click="applyShaperFit(row.fit.name, row.fit.freq)">
									{{ $t("plugins.resonanceLab.results.apply", { shaper: row.fit.display }) }}
								</v-btn>
							</div>
							<div class="text-caption text-medium-emphasis mt-2">{{ $t("plugins.resonanceLab.multi.note") }}</div>
						</v-card-text>
					</v-card>
					<div class="flex-grow-1" style="min-height: 420px">
						<LineChart :labels="multiChart.labels" :series="multiChart.series"
								   x-title="Frequency (Hz)" y-title="Vibration (normalised)" />
					</div>
				</template>

				<!-- Empty state -->
				<div v-else-if="!running" class="flex-grow-1 d-flex flex-column align-center justify-center text-medium-emphasis">
					<v-icon size="64" class="mb-3">mdi-sine-wave</v-icon>
					<div class="text-body-1">{{ $t("plugins.resonanceLab.emptyState") }}</div>
					<div class="text-caption mt-1">{{ $t("plugins.resonanceLab.emptyHint") }}</div>
				</div>
			</div>
		</div>

		<!-- Interpretation help -->
		<v-dialog v-model="helpDialog" max-width="640" scrollable>
			<v-card>
				<v-card-title class="d-flex align-center">
					<v-icon class="me-2">mdi-help-circle-outline</v-icon>{{ $t("plugins.resonanceLab.help.title") }}
				</v-card-title>
				<v-card-text style="max-height: 65vh">
					<template v-for="sec in helpSections" :key="sec">
						<div class="text-subtitle-2 mt-3">{{ $t(`plugins.resonanceLab.help.${sec}.heading`) }}</div>
						<div class="text-body-2 text-medium-emphasis">{{ $t(`plugins.resonanceLab.help.${sec}.body`) }}</div>
					</template>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn variant="text" @click="helpDialog = false">{{ $t("plugins.resonanceLab.captures.cancel") }}</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<!-- Capture browser -->
		<v-dialog v-model="captureBrowser" max-width="640" scrollable>
			<v-card>
				<v-card-title class="d-flex align-center">
					<v-icon class="me-2">mdi-folder-open-outline</v-icon>
					{{ $t("plugins.resonanceLab.captures.title") }}
					<v-spacer />
					<v-progress-circular v-if="loadingCapture" indeterminate size="20" width="2" class="me-2" />
					<v-btn icon="mdi-refresh" variant="text" size="small" :disabled="loadingCapture" :title="$t('plugins.resonanceLab.captures.refresh')" @click="refreshRemoteCaptures" />
				</v-card-title>
				<v-card-subtitle class="text-wrap">{{ $t("plugins.resonanceLab.captures.hint") }}</v-card-subtitle>
				<v-card-text style="max-height: 60vh">
					<div v-if="loadingCapture && remoteFiles.length === 0" class="text-medium-emphasis py-6 text-center">
						<v-progress-circular indeterminate size="24" width="2" class="mb-2" /><br>
						{{ $t("plugins.resonanceLab.captures.loading") }}
					</div>
					<div v-else-if="remoteFiles.length === 0" class="text-medium-emphasis py-6 text-center">{{ $t("plugins.resonanceLab.controls.noCaptures") }}</div>
					<template v-for="g in groupedCaptures" :key="g.day">
						<div class="text-overline text-medium-emphasis mt-2">{{ g.day }}</div>
						<v-list-item v-for="f in g.items" :key="f.name" class="px-0" @click="toggleFile(f.name)">
							<template #prepend>
								<v-checkbox-btn :model-value="selectedFiles.includes(f.name)" density="compact" @click.stop="toggleFile(f.name)" />
							</template>
							<v-list-item-title class="d-flex align-center ga-2">
								<v-icon size="small">{{ captureMeta(f.kind).icon }}</v-icon>
								<span>{{ captureMeta(f.kind).label }}</span>
								<v-chip v-if="f.axis" size="x-small" label variant="tonal">{{ f.axis }}</v-chip>
							</v-list-item-title>
							<v-list-item-subtitle>
								{{ f.when.getTime() ? f.when.toLocaleTimeString() : f.name }}<template v-if="f.size"> · {{ Math.round(f.size / 1024) }} kB</template>
							</v-list-item-subtitle>
						</v-list-item>
					</template>
				</v-card-text>
				<v-card-actions>
					<span class="text-caption text-medium-emphasis ms-2">{{ $t("plugins.resonanceLab.captures.selected", { count: selectedFiles.length }) }}</span>
					<v-spacer />
					<v-btn variant="text" @click="captureBrowser = false">{{ $t("plugins.resonanceLab.captures.cancel") }}</v-btn>
					<v-btn color="primary" :disabled="selectedFiles.length === 0 || loadingCapture" prepend-icon="mdi-download" @click="loadSelectedCaptures">
						{{ $t("plugins.resonanceLab.captures.load") }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-container>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";
import i18n from "@/i18n";

import { AboutDialog, buildReport, downloadReport, HelpTip } from "dwc-plugin-runtime";

import { compareBelts } from "./analysis/belts";
import { analyzeAxisBurst, detectVerticalAxis, solveOrientation } from "./analysis/axesMap";
import { analyseCapture } from "./analysis/pipeline";
import { findBestShaperCombined, type CombinedRecommendationResult } from "./analysis/recommend";
import { SHAPER_DISPLAY_NAMES, type ShaperName } from "./analysis/shapers";
import { buildVibrationProfile } from "./analysis/vibration";
import { cropCaptureToDuration, parseAccelCsv } from "./capture/csv";
import {
	beltEstimatedDurationSec, DEFAULT_PROGRAM_DIR, downloadCapture, findAccelerometers, parseAccelRateFromReport,
	resizeForActualRate, runBeltCapture, runFixedExcitation, runNativeCapture, runSpeedPointCapture, runSweepCapture,
	type MachineIO,
} from "./capture/orchestrator";
import { computeSpectrogram } from "./analysis/stft";
import LineChart from "./components/LineChart.vue";
import SpectrogramView from "./components/SpectrogramView.vue";
import SpectrumChart from "./components/SpectrumChart.vue";
import {
	beltResult, combinedRec, lastResult, measurementRunning, method, multiResults, orientationResult,
	profileResult, selectedAxes, selectedAxis, type CaptureMethod, type MultiAxisResult,
} from "./state";
import { applyUpdateNow, applying as updateApplying, checking, pendingReload, runUpdateCheck, setUpdateChecksEnabled, updateChecksEnabled, updateState } from "./updateCheck";

// The on-load update check runs once from index.ts at plugin-load time (not here), so it still
// happens for an embeddable-summary-panel-only install that never opens this page.
const reload = () => window.location.reload();

const machineStore = useMachineStore();

const aboutOpen = ref(false);
const autoCheck = ref(updateChecksEnabled());
const aboutDescription = "Measures and tunes printer resonance / input shaping from accelerometer captures.";
function onCheckUpdate(): void { void runUpdateCheck({ force: true, notify: true }); }
function onToggleAutoCheck(v: boolean): void { autoCheck.value = v; setUpdateChecksEnabled(v); }
const uiStore = useUiStore();

// ── Plugin-wide settings (program-file folder) ──────────────────────────────
const settingsOpen = ref(false);
const LS_PROGRAM_DIR = "resonanceLab.programDir";
function loadProgramDir(): string {
	try {
		return localStorage.getItem(LS_PROGRAM_DIR) || DEFAULT_PROGRAM_DIR;
	} catch {
		return DEFAULT_PROGRAM_DIR;
	}
}
const programDir = ref(loadProgramDir());
/** The folder actually used for uploads - falls back to the default if the field is blank/whitespace. */
const effectiveProgramDir = computed(() => programDir.value.trim() || DEFAULT_PROGRAM_DIR);
watch(programDir, (v) => {
	try {
		localStorage.setItem(LS_PROGRAM_DIR, v);
	} catch {
		// storage disabled - not fatal, just won't persist across sessions
	}
});
const t = (k: string, args?: Record<string, unknown>) => i18n.global.t(`plugins.resonanceLab.${k}`, args ?? {});

const isConnected = computed(() => machineStore.isConnected);
const running = measurementRunning;
const result = lastResult;
const error = ref("");
const applying = ref(false);
const filePicker = ref<HTMLInputElement | null>(null);
const helpDialog = ref(false);
const helpSections = ["spectrum", "spectrogram", "belts", "profile"] as const;
/** Which belt is currently recording, so the progress alert can name it. */
const beltPhase = ref<"A" | "B" | null>(null);
/** True while belt A's own recording is also establishing the real motion timing (first run at these parameters - see the belts branch of measure()). */
const beltEstablishingTiming = ref(false);

// ── Controls ─────────────────────────────────────────────────────────────────
const accelItems = computed(() => findAccelerometers(machineStore.model));
const selectedAccel = ref<{ id: string; label: string } | null>(null);
// Keep a real accelerometer selected: default to the first, and never leave a stale pick.
// (Previously the picker could read empty while measurements silently used accelItems[0].)
watch(accelItems, (items) => {
	if (items.length === 0) {
		selectedAccel.value = null;
	} else if (!selectedAccel.value || !items.some((i) => i.id === selectedAccel.value!.id)) {
		selectedAccel.value = items[0];
	}
}, { immediate: true });

const axisItems = computed(() => {
	const axes = (machineStore.model as { move?: { axes?: Array<{ letter?: string; visible?: boolean }> } }).move?.axes ?? [];
	const letters = axes.filter((a) => a.visible !== false && a.letter).map((a) => a.letter!);
	return letters.length > 0 ? letters : ["X", "Y"];
});
// selectedAxis / selectedAxes / method live in ./state so the chosen task + axes (and the matching
// result) persist across leaving the page. Calibration can sweep several axes and overlay them.
type Method = CaptureMethod;

const LS_Z_HEIGHT = "resonanceLab.zHeight";
function loadZHeight(): number | null {
	try {
		const raw = localStorage.getItem(LS_Z_HEIGHT);
		if (raw === null) {
			return null;
		}
		const v = Number(raw);
		return Number.isNaN(v) ? null : v;
	} catch {
		return null;
	}
}

const adv = ref({
	startFreq: 5, endFreq: 135, hzPerSec: 1,
	beltStart: 15, beltEnd: 95, beltHz: 2,
	exciteFreq: 40, exciteSeconds: 10,
	speedMin: 30, speedMax: 180, speedStep: 30,
	customMoves: "",
	/** Move to this Z (mm) before measuring; null = leave Z at whatever it currently is. */
	zHeight: loadZHeight() as number | null,
});

watch(() => adv.value.zHeight, (v) => {
	try {
		if (typeof v === "number" && !Number.isNaN(v)) {
			localStorage.setItem(LS_Z_HEIGHT, String(v));
		} else {
			localStorage.removeItem(LS_Z_HEIGHT);
		}
	} catch {
		// storage disabled - not fatal, just won't persist across sessions
	}
});

// Each task is a self-contained job: its icon, whether it uses a single axis, and exactly which
// parameters it exposes. The panel renders only these, so no irrelevant knob is ever shown.
interface TaskDef { id: Method; group: "goal" | "diag"; icon: string; usesAxis: boolean; params: Array<string> }
const TASKS: ReadonlyArray<TaskDef> = [
	{ id: "sweep", group: "goal", icon: "mdi-tune-variant", usesAxis: true, params: ["startFreq", "endFreq", "hzPerSec"] },
	{ id: "belts", group: "goal", icon: "mdi-scale-balance", usesAxis: false, params: ["beltStart", "beltEnd", "beltHz"] },
	{ id: "profile", group: "goal", icon: "mdi-speedometer", usesAxis: true, params: ["speedMin", "speedMax", "speedStep"] },
	{ id: "axescheck", group: "goal", icon: "mdi-axis-arrow", usesAxis: false, params: [] },
	{ id: "excite", group: "diag", icon: "mdi-pulse", usesAxis: true, params: ["exciteFreq", "exciteSeconds"] },
	{ id: "move", group: "diag", icon: "mdi-arrow-left-right", usesAxis: true, params: [] },
	{ id: "custom", group: "diag", icon: "mdi-code-braces", usesAxis: true, params: ["customMoves"] },
];
const goalTasks = computed(() => TASKS.filter((td) => td.group === "goal"));
const diagTasks = computed(() => TASKS.filter((td) => td.group === "diag"));
const activeTask = computed(() => TASKS.find((td) => td.id === method.value) ?? TASKS[0]);
const taskAxisNote = computed(() => (activeTask.value.usesAxis ? "" : t(`tasks.${method.value}.axisNote`)));

function selectTask(id: Method): void {
	if (running.value) {
		return;
	}
	method.value = id;
	// A fresh task starts clean — drop the previous run's verdict and chart.
	lastResult.value = null;
	beltResult.value = null;
	profileResult.value = null;
	orientationResult.value = null;
	verifyResult.value = null;
	multiResults.value = [];
	combinedRec.value = null;
	error.value = "";
}

/** Rough wall-clock estimate for the active task, derived from its live parameters. */
const durationEstimate = computed(() => {
	const a = adv.value;
	let secs: number;
	switch (method.value) {
		case "sweep": secs = ((a.endFreq - a.startFreq) / Math.max(0.1, a.hzPerSec) + 6) * Math.max(1, selectedAxes.value.length); break;
		case "belts": {
			// Always exactly 2 physical sweeps now (belt A self-times its own recording instead of a
			// separate probe move - see the belts branch of measure()). On a cold cache, belt A may
			// run a little longer than this estimate while it establishes the real motion time.
			const perBelt = (a.beltEnd - a.beltStart) / Math.max(0.1, a.beltHz) + 8;
			secs = 2 * perBelt;
			break;
		}
		case "profile": {
			let s = 0;
			for (let v = a.speedMin; v <= a.speedMax; v += Math.max(1, a.speedStep)) {
				s += 240 / Math.max(1, v) + 4;
			}
			secs = s;
			break;
		}
		case "excite": secs = a.exciteSeconds + 4; break;
		case "axescheck": secs = 10; break;
		default: secs = 6; break;
	}
	const rounded = Math.max(2, Math.round(secs));
	return rounded >= 90 ? `~${Math.round(rounded / 60)} min` : `~${rounded}s`;
});

const canMeasure = computed(() => isConnected.value && !running.value && !loadingCapture.value
	&& (selectedAccel.value !== null || accelItems.value.length > 0)
	&& (method.value !== "sweep" || selectedAxes.value.length > 0));

// ── Measurement ──────────────────────────────────────────────────────────────
/**
 * The firmware's completed-sampling-run counter for an accelerometer
 * (`boards[].accelerometer.runs`). Ticks the instant the CSV is closed — the authoritative
 * "recording done" signal. Accel ids are "<canAddress>.0" (CAN boards) or "0" (mainboard).
 */
function readAccelRuns(accelId: string): number {
	const boardId = parseInt(accelId, 10) || 0;
	const boards = (machineStore.model as { boards?: Array<{ canAddress?: number | null; accelerometer?: { runs?: number } | null } | null> }).boards ?? [];
	const board = boards.find((b) => b && b.accelerometer && (b.canAddress ?? 0) === boardId);
	return board?.accelerometer?.runs ?? 0;
}

/** Resolve when the run counter rises above `from` (watched on the object model); reject on timeout. */
function awaitAccelRun(accelId: string, from: number, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		// May have already ticked between arming and now — don't miss the edge.
		if (readAccelRuns(accelId) > from) {
			resolve();
			return;
		}
		const stop = watch(() => readAccelRuns(accelId), (now) => {
			if (now > from) {
				cleanup();
				resolve();
			}
		});
		const timer = setTimeout(() => { cleanup(); reject(new Error(t("captureTimeout"))); }, timeoutMs);
		function cleanup(): void { stop(); clearTimeout(timer); }
	});
}

/** Machine motion status from the object model (e.g. "idle", "busy", "processing", "paused"). */
function machineStatus(): string {
	return String((machineStore.model as { state?: { status?: string } }).state?.status ?? "");
}

/** Resolve once motion has stopped (status idle/paused/halted). Resolves on timeout — never blocks the run. */
function awaitMotionIdle(timeoutMs: number): Promise<void> {
	const stopped = () => ["idle", "off", "halted", "paused", "pausing", "cancelling"].includes(machineStatus());
	return new Promise((resolve) => {
		if (stopped()) {
			resolve();
			return;
		}
		const stop = watch(machineStatus, () => { if (stopped()) { cleanup(); resolve(); } });
		const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
		function cleanup(): void { stop(); clearTimeout(timer); }
	});
}

/** Resolve once motion has actually started (status left the idle set); reject after `timeoutMs`. */
function awaitMotionBusy(timeoutMs: number): Promise<void> {
	const busy = () => !["idle", "off", "halted", "paused", "pausing", "cancelling"].includes(machineStatus());
	return new Promise((resolve, reject) => {
		if (busy()) {
			resolve();
			return;
		}
		const stop = watch(machineStatus, () => { if (busy()) { cleanup(); resolve(); } });
		const timer = setTimeout(() => { cleanup(); reject(new Error("motion never started")); }, timeoutMs);
		function cleanup(): void { stop(); clearTimeout(timer); }
	});
}

const io: MachineIO = {
	sendCode: async (code) => String(await machineStore.sendCode(code) ?? ""),
	upload: async (path, content) => { await machineStore.upload({ filename: path, content }, false, false, true); },
	download: async (path) => String(await machineStore.download({ filename: path, type: "text" }, false, false, false)),
	accelRuns: (accelId) => readAccelRuns(accelId),
	awaitAccelRun: (accelId, from, timeoutMs) => awaitAccelRun(accelId, from, timeoutMs),
	awaitIdle: (timeoutMs) => awaitMotionIdle(timeoutMs),
	awaitBusy: (timeoutMs) => awaitMotionBusy(timeoutMs),
	delete: async (path) => { await machineStore.delete(path); },
	makeDirectory: async (path) => { await machineStore.makeDirectory(path); },
};

/** Centre of the selected axis's travel, from the object model (fallback: current position). */
function axisCenter(): number {
	const axes = (machineStore.model as { move?: { axes?: Array<{ letter?: string; min?: number; max?: number; userPosition?: number | null }> } }).move?.axes ?? [];
	const ax = axes.find((a) => a.letter === selectedAxis.value);
	if (ax && typeof ax.min === "number" && typeof ax.max === "number" && ax.max > ax.min) {
		return Math.round((ax.min + ax.max) / 2);
	}
	return ax?.userPosition ?? 0;
}

/** Centre of an arbitrary axis's travel (for the dual-axis belt test). */
function centerOf(letter: string): number {
	const axes = (machineStore.model as { move?: { axes?: Array<{ letter?: string; min?: number; max?: number }> } }).move?.axes ?? [];
	const ax = axes.find((a) => a.letter === letter);
	return ax && typeof ax.min === "number" && typeof ax.max === "number" && ax.max > ax.min
		? Math.round((ax.min + ax.max) / 2) : 0;
}

/**
 * Move to the user-set Z height (if any) before measuring. RRF's own M208 soft limits still apply to
 * a normal G1 move (only G1/G0 H2 bypasses them), so an out-of-range value surfaces as a normal
 * G-code error from sendCode rather than needing to be pre-validated here.
 */
async function moveToZIfSet(): Promise<void> {
	if (typeof adv.value.zHeight === "number" && !Number.isNaN(adv.value.zHeight)) {
		await io.sendCode(`G1 Z${adv.value.zHeight} F600 M400`);
	}
}

// ── Cancel a running measurement ─────────────────────────────────────────────
// RRF has no way to interrupt an in-progress M98 macro from the same G-code channel other than a
// full M112 emergency stop (which also disables heaters/drives - checked against the firmware
// source, see CLAUDE.md), so this can't stop the machine's CURRENT motion. What it CAN do: give up
// waiting immediately and stop the measurement from starting any FURTHER step (the next axis, the
// next belt, ...), since the abandoned promise is simply never awaited again once this rejects.
class MeasurementCancelledError extends Error {
	constructor() { super("Measurement cancelled"); this.name = "MeasurementCancelledError"; }
}
const cancelRequested = ref(false);

function raceCancellable<T>(promise: Promise<T>): Promise<T> {
	if (cancelRequested.value) {
		return Promise.reject(new MeasurementCancelledError());
	}
	return new Promise<T>((resolve, reject) => {
		const stop = watch(cancelRequested, (v) => {
			if (v) {
				stop();
				reject(new MeasurementCancelledError());
			}
		});
		promise.then(
			(v) => { stop(); resolve(v); },
			(e) => { stop(); reject(e); },
		);
	});
}

/**
 * The real belt motion time only depends on the sweep parameters and travel centres, so a repeat
 * belt test with the same settings can reuse a previous measurement instead of re-probing (RRF has
 * no way to stop an in-progress M956 recording early - see PLAN.md's B4 finding - so avoiding the
 * probe run entirely isn't possible; caching it for repeat runs is the next best thing).
 */
function beltMotionCacheKey(startFreq: number, endFreq: number, hzPerSec: number, centerX: number, centerY: number): string {
	return `resonanceLab.beltMotionSec.${startFreq}-${endFreq}-${hzPerSec}-${centerX}-${centerY}`;
}
function readCachedBeltMotionSec(key: string): number | undefined {
	try {
		const n = parseFloat(window.localStorage.getItem(key) ?? "");
		return n > 0 ? n : undefined;
	} catch {
		return undefined; // storage disabled - just means this run re-probes
	}
}
function writeCachedBeltMotionSec(key: string, sec: number): void {
	try {
		window.localStorage.setItem(key, sec.toFixed(2));
	} catch {
		// storage disabled - not fatal, next run just re-probes too
	}
}

/** Read the accelerometer's currently-configured M955 orientation from its report (default 20 = identity). */
async function readAccelOrientation(accelId: string): Promise<number> {
	try {
		const reply = await io.sendCode(`M955 P${accelId}`);
		const m = /orientation[:\s]+(\d+)/i.exec(reply);
		return m ? parseInt(m[1], 10) : 20;
	} catch {
		return 20;
	}
}

/**
 * Read the accelerometer's real sample rate (Hz) from its M955 report. The recorder is armed for a
 * fixed sample COUNT, so this must match reality: assume too high and M956 keeps sampling long after
 * the motion ends (machine idle while the recording finishes — the 20-30s belt-test stall). Default
 * 1000 if the report can't be parsed.
 */
async function readAccelRate(accelId: string): Promise<number> {
	try {
		const reply = await io.sendCode(`M955 P${accelId}`);
		const rate = parseAccelRateFromReport(reply);
		return rate >= 100 && rate <= 20000 ? rate : 1000;
	} catch {
		return 1000;
	}
}

// Custom G-code (the "custom" method) runs whatever the user typed verbatim, unlike every other
// task's fixed, reviewed move profile - so it gets a review step first. Skippable per-session (not
// persisted) once the user has seen it, so a repeated re-run of the same profile isn't nagged.
const confirmGcodeOpen = ref(false);
const skipGcodeConfirm = ref(false);

function onMeasureClick(): void {
	if (method.value === "custom" && adv.value.customMoves.trim() && !skipGcodeConfirm.value) {
		confirmGcodeOpen.value = true;
		return;
	}
	void measure();
}

async function measure(): Promise<void> {
	const accel = selectedAccel.value ?? accelItems.value[0];
	if (!accel) {
		return;
	}
	// Guard: every visible axis must be homed before we shake the machine.
	const axesModel = (machineStore.model as { move?: { axes?: Array<{ visible?: boolean; homed?: boolean }> } }).move?.axes ?? [];
	if (axesModel.some((a) => a.visible !== false && a.homed === false)) {
		error.value = t("notHomed");
		return;
	}
	cancelRequested.value = false;
	running.value = true;
	error.value = "";
	beltResult.value = null;
	profileResult.value = null;
	orientationResult.value = null;
	verifyResult.value = null;
	multiResults.value = [];
	combinedRec.value = null;
	try {
		if (method.value === "belts" && !String((machineStore.model as { move?: { kinematics?: { name?: string } } }).move?.kinematics?.name ?? "").toLowerCase().includes("core")) {
			error.value = t("belts.notCoreXY");
			running.value = false;
			return;
		}
		if (method.value !== "axescheck") {
			await moveToZIfSet();
		}
		// Size every recording to the accelerometer's real rate (not an assumed 1000 Hz), so M956
		// stops near the end of the motion instead of over-sampling into idle time.
		const sampleRate = await readAccelRate(accel.id);
		if (method.value === "excite") {
			const run = await raceCancellable(runFixedExcitation(io, {
				accelerometer: accel, axis: selectedAxis.value, center: axisCenter(),
				freq: adv.value.exciteFreq, seconds: adv.value.exciteSeconds, expectedSampleRate: sampleRate,
				programDir: effectiveProgramDir.value,
			}));
			finish(parse(await raceCancellable(downloadCapture(io, run))), `${selectedAxis.value} · ${adv.value.exciteFreq} Hz`);
		} else if (method.value === "axescheck") {
			// Measure the RAW mounting. Any orientation already configured in M955 makes the chip report
			// machine-aligned axes, so without this we'd solve a correction on top of the existing one —
			// e.g. re-running after applying I06 would read "already correct" and suggest the wrong value.
			// Neutralise to identity (I20) for the test, then restore whatever was configured.
			const prevOrientation = await readAccelOrientation(accel.id);
			await io.sendCode(`M955 P${accel.id} I20`);
			try {
				// One sharp move per horizontal axis; gravity (pre-motion DC) pins the vertical.
				const moveResults: Partial<Record<"X" | "Y", ReturnType<typeof analyzeAxisBurst>>> = {};
				let firstCapture: ReturnType<typeof parseAccelCsv> | null = null;
				for (const ax of ["X", "Y"] as const) {
					const run = await raceCancellable(runNativeCapture(io, { accelerometer: accel, axis: ax, center: centerOf(ax), span: 20 }));
					const capture = parseAccelCsv(await raceCancellable(downloadCapture(io, run)));
					firstCapture = firstCapture ?? capture;
					moveResults[ax] = analyzeAxisBurst(capture);
				}
				const gravity = detectVerticalAxis(firstCapture!, moveResults.X!.dc);
				orientationResult.value = { solution: solveOrientation(moveResults, gravity), accelId: accel.id, coupling: Math.max(moveResults.X!.coupling, moveResults.Y!.coupling) };
				lastResult.value = null;
			} finally {
				await io.sendCode(`M955 P${accel.id} I${prevOrientation}`);
			}
		} else if (method.value === "belts") {
			// Tension matching only needs the band the belt resonances live in — a light 15–95 Hz
			// sweep at 2 Hz/s (~40s per belt), not the full calibration band. Defaults are belt-specific.
			const centerX = centerOf("X");
			const centerY = centerOf("Y");
			const opts = {
				accelerometer: accel, centerX, centerY,
				startFreq: adv.value.beltStart, endFreq: adv.value.beltEnd, hzPerSec: adv.value.beltHz,
				expectedSampleRate: sampleRate, programDir: effectiveProgramDir.value,
			};
			// The CoreXY diagonal sweep finishes well before its kinematic estimate, so a count-based
			// recording over-samples into idle time if it doesn't know the real duration in advance.
			// RRF has no way to stop an in-progress M956 recording early (see the audit notes on
			// this), so rather than a separate throwaway probe move (which used to run belt A's exact
			// profile twice in a row), belt A's own recording self-times the real motion — see
			// runBeltCapture's self-sizing mode. A cached measurement from a previous run at these
			// exact parameters skips that entirely and sizes both belts precisely up front.
			const cacheKey = beltMotionCacheKey(opts.startFreq, opts.endFreq, opts.hzPerSec, centerX, centerY);
			const cachedMotionSec = readCachedBeltMotionSec(cacheKey);
			let motionSec = cachedMotionSec ?? 0;

			beltPhase.value = "A";
			let a: ReturnType<typeof parseAccelCsv>;
			if (cachedMotionSec !== undefined) {
				const samplesA = Math.min(200000, Math.ceil((cachedMotionSec + 1.5) * sampleRate));
				const runA = await raceCancellable(runBeltCapture(io, { ...opts, belt: "a", samples: samplesA }));
				a = parseAccelCsv(await raceCancellable(downloadCapture(io, runA)));
			} else {
				beltEstablishingTiming.value = true;
				const runA = await raceCancellable(runBeltCapture(io, { ...opts, belt: "a" }));
				const rawA = parseAccelCsv(await raceCancellable(downloadCapture(io, runA)));
				beltEstablishingTiming.value = false;
				if (runA.motionSec && runA.motionSec > 0) {
					motionSec = runA.motionSec;
					writeCachedBeltMotionSec(cacheKey, motionSec);
					a = cropCaptureToDuration(rawA, motionSec + 1.5);
				} else {
					// Timing signals weren't available - keep the full (oversized) capture uncropped
					// and don't cache anything, so the next run tries again.
					a = rawA;
				}
			}
			console.info("[ResonanceLab] belt A capture", {
				kinematicDurationSec: beltEstimatedDurationSec({ ...opts, belt: "a" }), motionSec,
				samplingRate: a.samplingRate, sampleCount: a.channels[0]?.length ?? 0,
			});

			// Size belt B precisely from the known motion time (falling back to self-sizing too if it
			// isn't known at all). If the firmware's real rate differs from the M955-parsed sizing
			// rate, resize using belt A's ACTUAL trailer rate instead of repeating the same over/under-record.
			const samplesB = motionSec > 0
				? resizeForActualRate(Math.min(200000, Math.ceil((motionSec + 1.5) * sampleRate)), motionSec, sampleRate, a.samplingRate)
				: undefined;

			beltPhase.value = "B";
			const runB = await raceCancellable(runBeltCapture(io, { ...opts, belt: "b", samples: samplesB }));
			const b = parseAccelCsv(await raceCancellable(downloadCapture(io, runB)));
			console.info("[ResonanceLab] belt B capture", { samplingRate: b.samplingRate, sampleCount: b.channels[0]?.length ?? 0 });

			beltPhase.value = null;
			lastResult.value = null;
			// Analyse (and chart) only the swept band, with a little margin either side.
			beltResult.value = compareBelts(a, b, adv.value.beltEnd + 10, Math.max(0, adv.value.beltStart - 5));
		} else if (method.value === "profile") {
			const entries: Array<{ speed: number; capture: ReturnType<typeof parseAccelCsv> }> = [];
			for (let speed = adv.value.speedMin; speed <= adv.value.speedMax; speed += Math.max(1, adv.value.speedStep)) {
				const run = await raceCancellable(runSpeedPointCapture(io, { accelerometer: accel, axis: selectedAxis.value, center: axisCenter(), speed, expectedSampleRate: sampleRate }));
				entries.push({ speed, capture: parseAccelCsv(await raceCancellable(downloadCapture(io, run))) });
			}
			lastResult.value = null;
			profileResult.value = buildVibrationProfile(entries);
		} else if (method.value === "sweep") {
			// Sweep each selected axis in turn. One axis → the rich single-axis verdict; several →
			// overlay them and list a per-axis suggestion (RRF applies one shaper machine-wide).
			const axes = selectedAxes.value.length ? selectedAxes.value : [selectedAxis.value];
			const collected: Array<{ axis: string } & ReturnType<typeof parse>> = [];
			for (const ax of axes) {
				const run = await raceCancellable(runSweepCapture(io, {
					accelerometer: accel, axis: ax, center: centerOf(ax),
					startFreq: adv.value.startFreq, endFreq: adv.value.endFreq, hzPerSec: adv.value.hzPerSec,
					expectedSampleRate: sampleRate, programDir: effectiveProgramDir.value,
				}));
				collected.push({ axis: ax, ...parse(await raceCancellable(downloadCapture(io, run))) });
			}
			if (collected.length === 1) {
				selectedAxis.value = collected[0].axis;
				finish(collected[0], `${collected[0].axis} · ${t("methods.sweep")}`);
			} else {
				lastResult.value = null;
				multiResults.value = collected.map((c) => ({ axis: c.axis, analysis: c.analysis, capture: c.capture }));
				combinedRec.value = computeCombinedRec(multiResults.value);
			}
		} else {
			const run = await raceCancellable(runNativeCapture(io, {
				accelerometer: accel, axis: selectedAxis.value, center: axisCenter(),
				customMoves: method.value === "custom" && adv.value.customMoves.trim()
					? adv.value.customMoves.split("\n").map((l) => l.trim()).filter(Boolean)
					: undefined,
			}));
			const csv = await raceCancellable(downloadCapture(io, run));
			finish(parse(csv), `${selectedAxis.value} · ${t(`methods.${method.value}`)}`);
		}
	} catch (e) {
		if (e instanceof MeasurementCancelledError) {
			uiStore.makeNotification(LogLevel.warning, t("cancel.title"), t("cancel.notification"));
		} else {
			error.value = (e as Error).message || String(e);
		}
	} finally {
		running.value = false;
		cancelRequested.value = false;
		beltPhase.value = null;
		beltEstablishingTiming.value = false;
	}
}

// ── Verify loop & orientation ────────────────────────────────────────────────
// orientationResult + multiResults live in ./state so results persist across leaving the page.
const verifyResult = ref<{ reduction: number; before: { labels: Array<number>; data: Array<number> }; after: Array<number> } | null>(null);
const appliedFit = ref<{ name: ShaperName; freq: number } | null>(null);

/** Re-run the same sweep with the shaper ACTIVE and compare energy before/after. */
async function verify(): Promise<void> {
	const accel = selectedAccel.value ?? accelItems.value[0];
	const before = result.value;
	if (!accel || !before) {
		return;
	}
	cancelRequested.value = false;
	running.value = true;
	error.value = "";
	try {
		await moveToZIfSet();
		const run = await raceCancellable(runSweepCapture(io, {
			accelerometer: accel, axis: before.axis, center: axisCenter(),
			startFreq: adv.value.startFreq, endFreq: adv.value.endFreq, hzPerSec: adv.value.hzPerSec,
			keepShaper: true, expectedSampleRate: await readAccelRate(accel.id), programDir: effectiveProgramDir.value,
		}));
		const after = analyseCapture(parseAccelCsv(await raceCancellable(downloadCapture(io, run))));
		const eBefore = before.analysis.normalized.reduce((a, b) => a + b, 0);
		const eAfter = after.normalized.reduce((a, b) => a + b, 0);
		const labels: Array<number> = [];
		const beforeData: Array<number> = [];
		const afterData: Array<number> = [];
		const maxFreq = 200;
		for (let i = 0; i < before.analysis.spectrum.freqs.length && before.analysis.spectrum.freqs[i] <= maxFreq; i++) {
			labels.push(Math.round(before.analysis.spectrum.freqs[i] * 10) / 10);
			beforeData.push(before.analysis.normalized[i]);
			afterData.push(after.normalized[i] ?? 0);
		}
		verifyResult.value = { reduction: eBefore > 0 ? 1 - eAfter / eBefore : 0, before: { labels, data: beforeData }, after: afterData };
	} catch (e) {
		if (e instanceof MeasurementCancelledError) {
			uiStore.makeNotification(LogLevel.warning, t("cancel.title"), t("cancel.notification"));
		} else {
			error.value = (e as Error).message || String(e);
		}
	} finally {
		running.value = false;
		cancelRequested.value = false;
	}
}
// ── Belt / profile presentation ──────────────────────────────────────────────
const beltChart = computed(() => {
	const r = beltResult.value;
	if (!r) {
		return null;
	}
	return {
		labels: Array.from(r.freqs).map((f) => Math.round(f * 10) / 10),
		series: [
			{ label: t("belts.beltA"), data: Array.from(r.psdA), color: "#2196f3" },
			{ label: t("belts.beltB"), data: Array.from(r.psdB), color: "#ff9800" },
		],
	};
});
const beltVerdict = computed(() => {
	const r = beltResult.value;
	if (!r) {
		return null;
	}
	const sim = (r.similarity * 100).toFixed(0);
	if (r.verdict === "matched") {
		return { color: "success", icon: "mdi-check-decagram", headline: t("belts.matched", { sim }), detail: t("belts.matchedDetail", { peakA: r.peakA.toFixed(1), peakB: r.peakB.toFixed(1) }) };
	}
	if (r.verdict === "tension") {
		const louder = r.energyRatio > 1 ? t("belts.beltA") : t("belts.beltB");
		const ratio = (r.energyRatio > 1 ? r.energyRatio : 1 / r.energyRatio).toFixed(2);
		return { color: "warning", icon: "mdi-scale-unbalanced", headline: t("belts.tension", { sim }), detail: t("belts.tensionDetail", { louder, ratio }) };
	}
	return { color: "error", icon: "mdi-alert-octagon-outline", headline: t("belts.mismatch", { sim }), detail: t("belts.mismatchDetail", { peakA: r.peakA.toFixed(1), peakB: r.peakB.toFixed(1) }) };
});

const profileChart = computed(() => {
	const p = profileResult.value;
	if (!p) {
		return null;
	}
	return {
		labels: p.points.map((pt) => pt.speed),
		series: [{ label: t("profile.energy"), data: p.points.map((pt) => pt.energy), color: "#2196f3" }],
	};
});
const profileVerdict = computed(() => {
	const p = profileResult.value;
	if (!p) {
		return null;
	}
	if (p.problems.length === 0) {
		return { color: "success", icon: "mdi-check-decagram", headline: t("profile.clean"), detail: t("profile.cleanDetail") };
	}
	return {
		color: "warning",
		icon: "mdi-speedometer",
		headline: t("profile.problems", { speeds: p.problems.map((x) => `${x.speed} mm/s`).join(", ") }),
		detail: t("profile.problemsDetail", { quiet: p.quietest.slice(0, 3).map((x) => `${x.speed} mm/s`).join(", ") }),
	};
});

// ── Multi-axis calibration overlay ───────────────────────────────────────────
const AXIS_COLORS: Record<string, string> = { X: "#2196f3", Y: "#ff9800", Z: "#4caf50", U: "#9c27b0", V: "#00bcd4", W: "#e91e63" };
const multiChart = computed(() => {
	const rs = multiResults.value;
	if (rs.length === 0) {
		return null;
	}
	const maxFreq = 200;
	// Common x-axis: the longest in-band freq grid across the runs (same rate ⇒ identical bins).
	let labels: Array<number> = [];
	for (const r of rs) {
		const freqs = r.analysis.spectrum.freqs;
		const lbl: Array<number> = [];
		for (let i = 0; i < freqs.length && freqs[i] <= maxFreq; i++) {
			lbl.push(Math.round(freqs[i] * 10) / 10);
		}
		if (lbl.length > labels.length) {
			labels = lbl;
		}
	}
	return {
		labels,
		series: rs.map((r) => ({
			label: `${r.axis} axis`,
			data: Array.from(r.analysis.normalized).slice(0, labels.length),
			color: AXIS_COLORS[r.axis.toUpperCase()] ?? "#888888",
		})),
	};
});
const multiRows = computed(() => multiResults.value.map((r) => {
	const best = r.analysis.recommendation?.best;
	return {
		axis: r.axis,
		color: AXIS_COLORS[r.axis.toUpperCase()] ?? "#888888",
		peak: r.analysis.peaks[0]?.freq.toFixed(1) ?? "—",
		fit: best ? { name: best.name, display: SHAPER_DISPLAY_NAMES[best.name], freq: best.freq, reduction: (100 - best.vibrations * 100).toFixed(0) } : null,
	};
}));

/**
 * Combined shaper recommendation across every axis that found a resonance - RRF's M593 shaper
 * applies machine-wide, so with 2+ axes this is the actual decision, not each axis's own best.
 * Needs at least two axes with a recommendation; otherwise there's nothing to combine.
 */
function computeCombinedRec(entries: Array<MultiAxisResult>): CombinedRecommendationResult | null {
	const withPeaks = entries.filter((e) => e.analysis.recommendation);
	if (withPeaks.length < 2) {
		return null;
	}
	// Feed the strongest measured peak's damping ratio across all axes into the fit - the same guard
	// the single-axis pipeline uses (pipeline.ts).
	let strongest: { power: number; dampingRatio?: number } | undefined;
	for (const e of withPeaks) {
		const p = e.analysis.peaks[0];
		if (p && (!strongest || p.power > strongest.power)) {
			strongest = p;
		}
	}
	const zeta = strongest?.dampingRatio;
	return findBestShaperCombined(
		withPeaks.map((e) => ({ axis: e.axis, freqBins: e.analysis.spectrum.freqs, psd: e.analysis.normalized })),
		{ dampingRatio: zeta && zeta >= 0.02 && zeta <= 0.3 ? zeta : undefined },
	);
}

/** Presentation for the "recommended for all axes" row: display name, per-axis reduction, agreement. */
const combinedSummary = computed(() => {
	const c = combinedRec.value;
	if (!c) {
		return null;
	}
	const best = c.best;
	const perAxisText = best.perAxis.map((p) => `${p.axis} −${(100 - p.vibrations * 100).toFixed(0)}%`).join(" · ");
	// "All axes agree" when every axis's own independently-chosen best already names this shaper
	// within ~2 Hz - the combined fit is confirming, not trading one axis's resonance off another's.
	const agrees = multiResults.value.every((r) => {
		const ownBest = r.analysis.recommendation?.best;
		return ownBest !== undefined && ownBest.name === best.name && Math.abs(ownBest.freq - best.freq) <= 2;
	});
	return { name: best.name, display: SHAPER_DISPLAY_NAMES[best.name], freq: best.freq, perAxisText, agrees };
});

/** Open one axis of a multi-axis run in the full single-axis view (shaper compare, response, verify). */
function inspectAxis(axis: string): void {
	const r = multiResults.value.find((m) => m.axis === axis);
	if (!r) {
		return;
	}
	selectedAxis.value = r.axis;
	result.value = { axis: r.axis, when: new Date(), source: t("multi.fromOverlay", { axis: r.axis }), analysis: r.analysis, capture: r.capture };
	overlay.value = r.analysis.recommendation?.best.name ?? "mzv";
	chartMode.value = "spectrum";
	appliedFit.value = null;
	verifyResult.value = null;
}

/** Return from a single-axis inspection to the multi-axis overlay (keeps the overlay loaded). */
function backToOverlay(): void {
	result.value = null;
	verifyResult.value = null;
}

function parse(csvText: string) {
	const capture = parseAccelCsv(csvText);
	return {
		capture,
		analysis: analyseCapture(capture),
	};
}

function finish(parsed: ReturnType<typeof parse>, source: string): void {
	result.value = { axis: selectedAxis.value, when: new Date(), source, analysis: parsed.analysis, capture: parsed.capture };
	overlay.value = parsed.analysis.recommendation?.best.name ?? "mzv";
	chartMode.value = "spectrum";
}

// ── Spectrogram view ─────────────────────────────────────────────────────────
const chartMode = ref<"spectrum" | "spectrogram">("spectrum");
/** Overlay each raw captured channel (X/Y/Z as recorded) on the spectrum chart, alongside the
 *  combined curve the recommendation actually runs on - the CSV always carries all axes even though
 *  only one was deliberately excited, and seeing the others helps spot cross-axis coupling. */
const showChannels = ref(false);
const spectrogram = computed(() => {
	const r = result.value;
	if (!r?.capture || chartMode.value !== "spectrogram") {
		return null;
	}
	// Prefer the channel matching the tested axis; fall back to the first.
	const idx = Math.max(0, r.capture.axes.findIndex((a) => a.toUpperCase() === r.axis.toUpperCase()));
	return computeSpectrogram(r.capture.channels[idx], r.capture.samplingRate);
});

// ── Remote capture browser (0:/sys/accelerometer) ───────────────────────────
const CAPTURE_DIR = "0:/sys/accelerometer";
const captureBrowser = ref(false);
const selectedFiles = ref<Array<string>>([]);
/** True while the capture list is being fetched, or a selected capture is being downloaded/parsed. */
const loadingCapture = ref(false);

interface RemoteCapture { name: string; kind: string; axis: string; when: Date; size: number }
const remoteFiles = ref<Array<RemoteCapture>>([]);

/** Our captures are named rlab-<kind>-<axis>-<YYYYMMDDHHMMSS>.csv; parse that for grouping + labels. */
function parseCaptureName(name: string, size: number): RemoteCapture {
	const m = /^rlab-(belta|beltb|sweep|move|fix\d+|speed\d+)-([a-z]+)-(\d{14})\.csv$/i.exec(name);
	if (!m) {
		return { name, kind: "other", axis: "", when: new Date(0), size };
	}
	const s = m[3];
	const when = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
	return { name, kind: m[1].toLowerCase(), axis: m[2].toUpperCase(), when, size };
}

/** Display label + icon for a capture kind. */
function captureMeta(kind: string): { label: string; icon: string } {
	if (kind === "belta") { return { label: t("captures.kinds.belta"), icon: "mdi-scale-balance" }; }
	if (kind === "beltb") { return { label: t("captures.kinds.beltb"), icon: "mdi-scale-balance" }; }
	if (kind === "sweep") { return { label: t("captures.kinds.sweep"), icon: "mdi-tune-variant" }; }
	if (kind === "move") { return { label: t("captures.kinds.move"), icon: "mdi-arrow-left-right" }; }
	if (kind.startsWith("fix")) { return { label: t("captures.kinds.excite"), icon: "mdi-pulse" }; }
	if (kind.startsWith("speed")) { return { label: t("captures.kinds.speed"), icon: "mdi-speedometer" }; }
	return { label: t("captures.kinds.other"), icon: "mdi-file-delimited-outline" };
}

async function refreshRemoteCaptures(): Promise<void> {
	loadingCapture.value = true;
	try {
		const files = await (machineStore as unknown as { getFileList(dir: string): Promise<Array<{ name: string; isDirectory?: boolean; size?: number }>> })
			.getFileList(CAPTURE_DIR);
		remoteFiles.value = files
			.filter((f) => !f.isDirectory && f.name.toLowerCase().endsWith(".csv"))
			.map((f) => parseCaptureName(f.name, f.size ?? 0))
			.sort((a, b) => b.when.getTime() - a.when.getTime() || a.name.localeCompare(b.name));
		selectedFiles.value = [];
	} catch {
		remoteFiles.value = [];
	} finally {
		loadingCapture.value = false;
	}
}

/** Group captures by calendar day for the browser (newest first). */
const groupedCaptures = computed(() => {
	const groups: Array<{ day: string; items: Array<RemoteCapture> }> = [];
	for (const f of remoteFiles.value) {
		const day = f.when.getTime() === 0 ? t("captures.unknownDay") : f.when.toLocaleDateString();
		let g = groups.find((x) => x.day === day);
		if (!g) {
			g = { day, items: [] };
			groups.push(g);
		}
		g.items.push(f);
	}
	return groups;
});

function openCaptureBrowser(): void {
	captureBrowser.value = true;
	void refreshRemoteCaptures();
}

const downloadRemote = (name: string) => io.download(`${CAPTURE_DIR}/${name}`);

function toggleFile(name: string): void {
	const i = selectedFiles.value.indexOf(name);
	if (i >= 0) {
		selectedFiles.value.splice(i, 1);
	} else {
		selectedFiles.value.push(name);
	}
}

function resetResults(): void {
	lastResult.value = null;
	beltResult.value = null;
	profileResult.value = null;
	orientationResult.value = null;
	verifyResult.value = null;
	multiResults.value = [];
	combinedRec.value = null;
}

/**
 * Load the checked captures, choosing the view from what was selected: a Belt A + Belt B pair →
 * tension comparison; several calibration sweeps → multi-axis overlay; anything else → the rich
 * single-capture view.
 */
async function loadSelectedCaptures(): Promise<void> {
	const picks = remoteFiles.value.filter((f) => selectedFiles.value.includes(f.name));
	if (picks.length === 0) {
		return;
	}
	const hasBelt = picks.some((p) => p.kind === "belta" || p.kind === "beltb");
	const beltA = picks.find((p) => p.kind === "belta");
	const beltB = picks.find((p) => p.kind === "beltb");
	if (hasBelt && (!beltA || !beltB)) {
		error.value = t("captures.needBeltPair"); // invalid selection: keep the dialog open
		return;
	}
	captureBrowser.value = false; // selection is valid — dismiss the dialog right away
	error.value = "";
	loadingCapture.value = true;
	resetResults(); // clear whatever was on screen immediately, so stale data never lingers behind the loading state
	try {
		if (beltA && beltB) {
			const [ca, cb] = await Promise.all([downloadRemote(beltA.name), downloadRemote(beltB.name)]);
			beltResult.value = compareBelts(parseAccelCsv(ca), parseAccelCsv(cb), 150, 5);
			return;
		}
		const sweeps = picks.filter((p) => p.kind === "sweep");
		if (sweeps.length > 1) {
			const collected: Array<{ axis: string } & ReturnType<typeof parse>> = [];
			for (const s of sweeps) {
				collected.push({ axis: s.axis, ...parse(await downloadRemote(s.name)) });
			}
			multiResults.value = collected.map((c) => ({ axis: c.axis, analysis: c.analysis, capture: c.capture }));
			combinedRec.value = computeCombinedRec(multiResults.value);
			return;
		}
		const one = picks[0];
		if (one.axis) {
			selectedAxis.value = one.axis;
		}
		finish(parse(await downloadRemote(one.name)), one.name);
	} catch (e) {
		error.value = (e as Error).message || String(e);
	} finally {
		loadingCapture.value = false;
	}
}

async function loadLocalCsv(ev: Event): Promise<void> {
	const file = (ev.target as HTMLInputElement).files?.[0];
	if (!file) {
		return;
	}
	try {
		finish(parse(await file.text()), file.name);
		error.value = "";
	} catch (e) {
		error.value = (e as Error).message || String(e);
	} finally {
		(ev.target as HTMLInputElement).value = "";
	}
}

// ── Verdict ──────────────────────────────────────────────────────────────────
const rec = computed(() => result.value?.analysis.recommendation ?? null);
const overlay = ref<ShaperName>("mzv");
const overlayItems = computed(() => (rec.value?.allShapers ?? []).map((s) => ({
	title: `${SHAPER_DISPLAY_NAMES[s.name]} @ ${s.freq.toFixed(1)} Hz — ${(100 - s.vibrations * 100).toFixed(0)}%`,
	value: s.name,
})));
const displayName = (n: ShaperName) => SHAPER_DISPLAY_NAMES[n];

const verdict = computed(() => {
	const a = result.value?.analysis;
	if (!a) {
		return null;
	}
	if (!rec.value) {
		return { color: "success", icon: "mdi-check-decagram", headline: t("results.quiet"), detail: t("results.quietDetail") };
	}
	const fit = rec.value.allShapers.find((s) => s.name === overlay.value) ?? rec.value.best;
	const reduction = (100 - fit.vibrations * 100).toFixed(0);
	return {
		color: "info",
		icon: "mdi-lightbulb-on-outline",
		headline: t("results.headline", { shaper: SHAPER_DISPLAY_NAMES[fit.name], freq: fit.freq.toFixed(1), reduction }),
		detail: t("results.detail", { peak: a.peaks[0]?.freq.toFixed(1) ?? "?" }),
	};
});

function downloadDiagnostics(): void {
	const r = result.value;
	const state: Record<string, unknown> = { method: method.value };
	// Only one of these is populated at a time in normal use, but a diagnostics report should
	// reflect whatever is actually on screen rather than assuming the single-axis shape.
	if (r) {
		state.singleAxis = {
			axis: r.axis, source: r.source, when: r.when.toISOString(),
			samplingRate: r.analysis.samplingRate, overflows: r.analysis.overflows,
			sampleCount: r.analysis.sampleCount,
			peaks: r.analysis.peaks.slice(0, 5),
			// Strip the per-bin response array - the report only needs the verdict numbers.
			best: r.analysis.recommendation
				? (({ name, freq, vibrations, smoothing }) => ({ name, freq, vibrations, smoothing }))(r.analysis.recommendation.best)
				: null,
		};
	}
	if (multiResults.value.length) {
		state.multiAxis = {
			axes: multiResults.value.map((m) => ({
				axis: m.axis, samplingRate: m.analysis.samplingRate, overflows: m.analysis.overflows,
				sampleCount: m.analysis.sampleCount, peaks: m.analysis.peaks.slice(0, 5),
			})),
			combined: combinedRec.value
				? (({ name, freq, vibrations, perAxis }) => ({ name, freq, vibrations, perAxis }))(combinedRec.value.best)
				: null,
		};
	}
	if (beltResult.value) {
		const b = beltResult.value;
		state.belts = { similarity: b.similarity, energyRatio: b.energyRatio, peakA: b.peakA, peakB: b.peakB, verdict: b.verdict };
	}
	if (profileResult.value) {
		const p = profileResult.value;
		state.profile = { median: p.median, problems: p.problems, quietest: p.quietest };
	}
	if (orientationResult.value) {
		const o = orientationResult.value;
		state.orientation = { iParam: o.solution.iParam, faces: o.solution.faces, conflicts: o.solution.conflicts, coupling: o.coupling };
	}
	if (verifyResult.value) {
		state.verify = { reduction: verifyResult.value.reduction };
	}
	downloadReport(buildReport({
		pluginId: "ResonanceLab",
		model: machineStore.model,
		state,
	}));
}

async function applyOrientation(): Promise<void> {
	const o = orientationResult.value;
	if (!o?.solution.iParam) {
		return;
	}
	await machineStore.sendCode(`M955 P${o.accelId} I${o.solution.iParam}`);
	uiStore.makeNotification(LogLevel.success, "Resonance Lab", t("orientation.applied", { i: o.solution.iParam }));
}

/** Apply a specific shaper as the machine-wide M593 (RRF has no per-axis shaping). */
async function applyShaperFit(name: ShaperName, freq: number): Promise<void> {
	applying.value = true;
	try {
		await machineStore.sendCode(`M593 P"${name}" F${freq.toFixed(1)}`);
		appliedFit.value = { name, freq };
		uiStore.makeNotification(LogLevel.success, "Resonance Lab", t("results.applied", { shaper: SHAPER_DISPLAY_NAMES[name], freq: freq.toFixed(1) }));
	} catch (e) {
		uiStore.makeNotification(LogLevel.error, "Resonance Lab", (e as Error).message || String(e));
	}
	finally {
		applying.value = false;
	}
}

async function applyShaper(): Promise<void> {
	const fit = rec.value?.allShapers.find((s) => s.name === overlay.value) ?? rec.value?.best;
	if (fit) {
		await applyShaperFit(fit.name, fit.freq);
	}
}
</script>

<style scoped>
/* Task-rail item titles were being truncated with an ellipsis ("Accelerometer orien...") - the
   longest labels don't fit Vuetify's default single-line, nowrap-and-ellipsis title even at the
   rail's 220px width. Let them wrap onto a second line instead, so any future/longer label degrades
   gracefully rather than clipping. */
.rlab-task-rail :deep(.v-list-item-title) {
	white-space: normal;
	line-height: 1.25;
}

.rlab-gcode-preview {
	white-space: pre-wrap;
	word-break: break-word;
	background: rgba(128, 128, 128, 0.12);
	border-radius: 4px;
	padding: 8px 10px;
	font-size: 0.8125rem;
	max-height: 220px;
	overflow-y: auto;
}
</style>
