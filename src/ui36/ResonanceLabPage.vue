<!--
  Resonance Lab - the lab page, DWC 3.6 (Vue 2.7 / Vuetify 2) edition.

  Structurally identical to ../ui37/ResonanceLabPage.vue and driven by exactly the same composable;
  only the markup differs, because Vuetify 2 and Vuetify 4 disagree about almost every prop name.
  The recurring translations, for whoever keeps these two in step:

    variant="outlined"  -> outlined            variant="tonal"   -> text (alerts) / outlined (cards)
    variant="text"      -> text                density="compact" -> dense
    prepend-icon="x"    -> <v-icon left>x</…>  #append-inner     -> #append
    size="small"        -> small               item-title        -> item-text
    v-list-subheader    -> v-subheader         v-checkbox-btn    -> v-simple-checkbox
    closable            -> dismissible         closable-chips    -> deletable-chips

  Two Vue-2-isms to watch: `:key` may not sit on a <template v-for> (it goes on the child), and
  v-list-item needs an explicit v-list-item-content wrapper. Vuetify 2 also has no `ga-*` gap
  utilities, so the few this page relied on are recreated in the scoped styles at the bottom.
-->
<template>
	<v-container fluid class="d-flex flex-column fill-height pa-0">
		<!-- Top strip: title + global actions -->
		<div class="d-flex align-center rlab-ga-2 px-3 py-2">
			<v-icon large class="mr-1">mdi-sine-wave</v-icon>
			<span class="text-subtitle-1 font-weight-medium">{{ $t("plugins.resonanceLab.title") }}</span>
			<v-spacer />
			<v-btn text :disabled="running || !isConnected" @click="openCaptureBrowser">
				<v-icon left>mdi-folder-open-outline</v-icon>{{ $t("plugins.resonanceLab.controls.captures") }}
			</v-btn>
			<v-btn text :disabled="running" @click="filePicker?.click()">
				<v-icon left>mdi-file-upload-outline</v-icon>{{ $t("plugins.resonanceLab.controls.loadCsv") }}
			</v-btn>
			<v-btn icon small :title="$t('plugins.resonanceLab.settings.open')" @click="settingsOpen = true">
				<v-icon>mdi-cog-outline</v-icon>
			</v-btn>
			<v-btn icon small :title="$t('plugins.resonanceLab.help.open')" @click="helpDialog = true">
				<v-icon>mdi-help-circle-outline</v-icon>
			</v-btn>
			<v-btn icon small :title="$t('plugins.resonanceLab.controls.diagnostics')" @click="downloadDiagnostics">
				<v-icon>mdi-bug-outline</v-icon>
			</v-btn>
			<v-btn icon small :title="$t('plugins.resonanceLab.controls.about')" @click="aboutOpen = true">
				<v-icon>mdi-information-outline</v-icon>
			</v-btn>
			<input ref="filePicker" type="file" accept=".csv" class="d-none" @change="loadLocalCsv">
		</div>

		<AboutDialog v-model="aboutOpen" plugin-id="ResonanceLab" title="Resonance Lab"
			:description="aboutDescription" :model="model"
			repo="https://github.com/jaysuk/resonance-lab"
			:update-available="updateState?.updateAvailable ?? false" :latest-version="updateState?.latestVersion"
			:checking="checking" :applying="updateApplying" :pending-reload="pendingReload" :auto-check="autoCheck"
			@check-update="onCheckUpdate" @apply-update="applyUpdateNow" @toggle-auto-check="onToggleAutoCheck" />

		<!-- Plugin settings -->
		<v-dialog v-model="settingsOpen" max-width="520">
			<v-card>
				<v-card-title class="d-flex align-center">
					<v-icon class="mr-2">mdi-cog-outline</v-icon>{{ $t("plugins.resonanceLab.settings.title") }}
				</v-card-title>
				<v-card-text>
					<v-text-field v-model="programDir" dense outlined
								  :label="$t('plugins.resonanceLab.settings.programDir')" :placeholder="DEFAULT_PROGRAM_DIR" hide-details="auto">
						<template #append><HelpTip :text="$t('plugins.resonanceLab.settings.programDirHint')" /></template>
					</v-text-field>
					<div class="text-caption text--secondary mt-2">{{ $t("plugins.resonanceLab.settings.programDirNote") }}</div>
				</v-card-text>
				<v-card-actions>
					<v-btn text @click="programDir = DEFAULT_PROGRAM_DIR">{{ $t("plugins.resonanceLab.settings.reset") }}</v-btn>
					<v-spacer />
					<v-btn color="primary" text @click="settingsOpen = false">{{ $t("plugins.resonanceLab.settings.done") }}</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<v-dialog v-model="confirmGcodeOpen" max-width="520">
			<v-card>
				<v-card-title class="d-flex align-center">
					<v-icon class="mr-2" color="warning">mdi-alert-outline</v-icon>{{ $t("plugins.resonanceLab.confirmGcode.title") }}
				</v-card-title>
				<v-card-text>
					<div class="mb-2">{{ $t("plugins.resonanceLab.confirmGcode.body") }}</div>
					<pre class="rlab-gcode-preview">{{ adv.customMoves }}</pre>
					<v-checkbox v-model="skipGcodeConfirm" dense hide-details :label="$t('plugins.resonanceLab.confirmGcode.dontAskAgain')" />
				</v-card-text>
				<v-card-actions>
					<v-btn text @click="confirmGcodeOpen = false">{{ $t("plugins.resonanceLab.confirmGcode.cancel") }}</v-btn>
					<v-spacer />
					<v-btn color="primary" text @click="confirmGcodeOpen = false; measure();">{{ $t("plugins.resonanceLab.confirmGcode.confirm") }}</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<!-- Shaper config.g save: which tool(s) should this apply to? RRF's M593 is machine-wide, so
			 "this tool only" means re-asserting it from that tool's own tpost<N>.g on every pickup. -->
		<v-dialog v-model="shaperScopeDialogOpen" max-width="480">
			<v-card v-if="pendingShaperFit">
				<v-card-title class="d-flex align-center">
					<v-icon class="mr-2">mdi-content-save-outline</v-icon>
					{{ $t("plugins.resonanceLab.config.scopeTitle", { shaper: displayName(pendingShaperFit.name), freq: pendingShaperFit.freq.toFixed(1) }) }}
				</v-card-title>
				<v-card-text>
					<div class="text-body-2 text--secondary mb-3">{{ $t("plugins.resonanceLab.config.scopeBody") }}</div>
					<div class="mb-3">
						<v-btn block color="primary" outlined @click="chooseShaperScope('all')">
							{{ $t("plugins.resonanceLab.config.scopeAll") }}
						</v-btn>
						<div class="text-caption text--secondary mt-1">{{ $t("plugins.resonanceLab.config.scopeAllHint") }}</div>
					</div>
					<div v-if="activeTool >= 0">
						<v-btn block color="primary" outlined @click="chooseShaperScope('tool')">
							{{ $t("plugins.resonanceLab.config.scopeTool", { tool: activeToolLabel }) }}
						</v-btn>
						<div class="text-caption text--secondary mt-1">{{ $t("plugins.resonanceLab.config.scopeToolHint", { tool: activeToolLabel }) }}</div>
					</div>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text @click="cancelShaperScope">{{ $t("plugins.resonanceLab.config.cancel") }}</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<!-- config.g / tpost<N>.g diff preview, confirm, then (for config.g) offer to restart. -->
		<v-dialog v-model="configDialogOpen" max-width="640" scrollable persistent>
			<v-card v-if="configPlan">
				<v-card-title class="d-flex align-center">
					<v-icon class="mr-2">mdi-file-document-edit-outline</v-icon>
					<span class="flex-grow-1">{{ configPlan.path }}</span>
				</v-card-title>
				<v-card-text style="max-height: 55vh">
					<template v-if="!configSaved">
						<v-alert v-if="configPlan.blocked" type="error" text dense class="mb-3">
							{{ configPlan.blocked }}
						</v-alert>
						<template v-else>
							<v-alert v-if="configPlan.appended" type="info" text dense class="mb-2">
								{{ $t("plugins.resonanceLab.config.appendedNote", { code: configCode, file: configFileName }) }}
							</v-alert>
							<v-alert v-if="configPlan.disabledDuplicateFound" type="warning" text dense class="mb-2">
								{{ $t("plugins.resonanceLab.config.disabledDuplicateNote", { code: configCode, file: configFileName }) }}
							</v-alert>
							<v-alert v-for="(note, i) in configNotes" :key="i" type="warning" text dense class="mb-2">
								{{ $t("plugins.resonanceLab.config.crossFileNote", { note }) }}
							</v-alert>
							<div class="rlab-gcode-preview rlab-config-diff">
								<div v-for="(d, i) in configPlan.diff" :key="i"
									 :style="{
										 color: d.type === 'added' ? '#4caf50' : d.type === 'removed' ? '#f44336' : 'inherit',
										 textDecoration: d.type === 'removed' ? 'line-through' : 'none',
										 opacity: d.type === 'same' ? 0.55 : 1,
									 }">{{ (d.type === "added" ? "+ " : d.type === "removed" ? "- " : "  ") + d.text }}</div>
							</div>
							<div class="text-caption text--secondary mt-2">{{ $t("plugins.resonanceLab.config.backupNote") }}</div>
						</template>
						<v-alert v-if="configDialogError" type="error" text dense class="mt-3">{{ configDialogError }}</v-alert>
					</template>
					<template v-else>
						<v-alert type="success" text dense class="mb-3">{{ $t("plugins.resonanceLab.config.saved") }}</v-alert>
						<template v-if="configNeedsRestart">
							<div class="text-subtitle-2 mb-1">{{ $t("plugins.resonanceLab.config.restartTitle") }}</div>
							<div class="text-body-2 text--secondary mb-3">{{ $t("plugins.resonanceLab.config.restartHint") }}</div>
						</template>
					</template>
				</v-card-text>
				<v-card-actions>
					<template v-if="!configSaved">
						<v-btn text @click="closeConfigDialog">{{ $t("plugins.resonanceLab.config.cancel") }}</v-btn>
						<v-spacer />
						<v-btn v-if="!configPlan.blocked" color="primary" outlined :loading="configDialogBusy" @click="confirmConfigSave">
							{{ $t("plugins.resonanceLab.config.save") }}
						</v-btn>
					</template>
					<template v-else-if="configNeedsRestart">
						<v-btn text @click="closeConfigDialog">{{ $t("plugins.resonanceLab.config.skipRestart") }}</v-btn>
						<v-spacer />
						<v-btn outlined @click="restartAfterSave('runConfig')">{{ $t("plugins.resonanceLab.config.runConfigNow") }}</v-btn>
						<v-btn color="primary" outlined @click="restartAfterSave('reset')">{{ $t("plugins.resonanceLab.config.restartNow") }}</v-btn>
					</template>
					<template v-else>
						<v-spacer />
						<v-btn color="primary" outlined @click="closeConfigDialog">{{ $t("plugins.resonanceLab.config.close") }}</v-btn>
					</template>
				</v-card-actions>
			</v-card>
		</v-dialog>
		<v-divider />

		<div class="d-flex flex-grow-1" style="min-height: 0">
			<!-- Task rail: pick the job by what you want to achieve -->
			<v-list nav dense class="flex-shrink-0 py-2 rlab-task-rail" style="width: 232px">
				<v-subheader>{{ $t("plugins.resonanceLab.rail.goals") }}</v-subheader>
				<v-list-item v-for="td in goalTasks" :key="td.id" :input-value="method === td.id" :disabled="running" @click="selectTask(td.id)">
					<v-list-item-icon class="mr-3"><v-icon>{{ td.icon }}</v-icon></v-list-item-icon>
					<v-list-item-content>
						<v-list-item-title>{{ $t(`plugins.resonanceLab.tasks.${td.id}.title`) }}</v-list-item-title>
					</v-list-item-content>
				</v-list-item>
				<v-subheader>{{ $t("plugins.resonanceLab.rail.diagnostics") }}</v-subheader>
				<v-list-item v-for="td in diagTasks" :key="td.id" :input-value="method === td.id" :disabled="running" @click="selectTask(td.id)">
					<v-list-item-icon class="mr-3"><v-icon>{{ td.icon }}</v-icon></v-list-item-icon>
					<v-list-item-content>
						<v-list-item-title>{{ $t(`plugins.resonanceLab.tasks.${td.id}.title`) }}</v-list-item-title>
					</v-list-item-content>
				</v-list-item>
			</v-list>
			<v-divider vertical />

			<!-- Task panel -->
			<div class="flex-grow-1 d-flex flex-column pa-3" style="min-width: 0; min-height: 0; overflow-y: auto">
				<!-- What this task does -->
				<div class="d-flex align-center rlab-ga-2">
					<v-icon large>{{ activeTask.icon }}</v-icon>
					<div class="text-h6">{{ $t(`plugins.resonanceLab.tasks.${method}.title`) }}</div>
				</div>
				<div class="text-body-2 text--secondary mt-1 mb-3" style="max-width: 80ch">
					{{ $t(`plugins.resonanceLab.tasks.${method}.blurb`) }}
				</div>

				<!-- Self-update offer -->
				<v-alert v-if="pendingReload" type="success" text dense class="mb-3">
					<div class="d-flex align-center">
						<span class="flex-grow-1">{{ $t("plugins.resonanceLab.update.installed") }}</span>
						<v-btn small color="success" @click="reload"><v-icon left>mdi-restart</v-icon>{{ $t("plugins.resonanceLab.update.reload") }}</v-btn>
					</div>
				</v-alert>
				<v-alert v-else-if="updateState?.scenario === 'pluginUpdate'" type="info" text dense class="mb-3">
					<div class="d-flex align-center">
						<span class="flex-grow-1">{{ $t("plugins.resonanceLab.update.available", { version: updateState.latestVersion }) }}</span>
						<v-btn small color="primary" :loading="updateApplying" @click="applyUpdateNow"><v-icon left>mdi-download</v-icon>{{ $t("plugins.resonanceLab.update.apply") }}</v-btn>
					</div>
				</v-alert>

				<!-- Readiness -->
				<v-alert v-if="!isConnected" type="info" text dense class="mb-3">
					{{ $t("plugins.resonanceLab.notConnected") }}
				</v-alert>
				<v-alert v-else-if="accelItems.length === 0" type="warning" text dense class="mb-3">
					{{ $t("plugins.resonanceLab.accelMissing") }}
				</v-alert>
				<v-alert v-else-if="error" type="error" text dense dismissible class="mb-3" @input="error = ''">
					{{ error }}
				</v-alert>

				<!-- Parameters: only the controls this task actually uses -->
				<v-sheet v-if="isConnected && accelItems.length > 0" outlined rounded class="pa-3 mb-3">
					<div class="d-flex flex-wrap align-center rlab-ga-3">
						<v-select v-if="accelItems.length > 1" v-model="selectedAccel" :items="accelItems" item-text="label" return-object
								  dense outlined hide-details style="min-width: 220px"
								  :label="$t('plugins.resonanceLab.controls.accelerometer')" :disabled="running" />
						<div v-else-if="selectedAccel" class="text-body-2">
							<span class="text--secondary">{{ $t("plugins.resonanceLab.controls.accelerometer") }}:</span> {{ selectedAccel.label }}
						</div>
						<v-select v-if="method === 'sweep'" v-model="selectedAxes" :items="axisItems" multiple chips deletable-chips
								  dense outlined hide-details style="min-width: 170px"
								  :label="$t('plugins.resonanceLab.controls.axes')" :disabled="running" />
						<v-select v-else-if="activeTask.usesAxis" v-model="selectedAxis" :items="axisItems" dense outlined
								  hide-details style="max-width: 110px" :label="$t('plugins.resonanceLab.controls.axis')" :disabled="running" />
						<v-chip v-else small><v-icon left small>mdi-axis-arrow</v-icon>{{ taskAxisNote }}</v-chip>
						<v-text-field v-if="method !== 'axescheck'" v-model.number="adv.zHeight" type="number" dense outlined clearable
									  hide-details :label="$t('plugins.resonanceLab.controls.zHeight')" placeholder="current" style="max-width: 140px" :disabled="running">
							<template #append><HelpTip text="Move to this Z height (mm) before measuring. Leave blank to measure at the machine's current Z position." /></template>
						</v-text-field>
						<v-text-field v-if="activeTask.params.includes('startFreq')" v-model.number="adv.startFreq" type="number" dense outlined hide-details label="Start (Hz)" style="max-width: 132px" :disabled="running"><template #append><HelpTip text="Lowest frequency of the sweep, in Hz. Start a little below where you expect resonances (often 5–15 Hz)." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('endFreq')" v-model.number="adv.endFreq" type="number" dense outlined hide-details label="End (Hz)" style="max-width: 132px" :disabled="running"><template #append><HelpTip text="Highest frequency of the sweep, in Hz. Cover the range your input shaper acts on (commonly up to ~100–150 Hz)." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('hzPerSec')" v-model.number="adv.hzPerSec" type="number" dense outlined hide-details label="Sweep (Hz/s)" style="max-width: 142px" :disabled="running"><template #append><HelpTip text="How fast the sweep ramps through the frequency range, in Hz per second. Slower sweeps give cleaner data but take longer." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('beltStart')" v-model.number="adv.beltStart" type="number" dense outlined hide-details label="Start (Hz)" style="max-width: 132px" :disabled="running"><template #append><HelpTip text="Lowest frequency for the belt-tension test, in Hz." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('beltEnd')" v-model.number="adv.beltEnd" type="number" dense outlined hide-details label="End (Hz)" style="max-width: 132px" :disabled="running"><template #append><HelpTip text="Highest frequency for the belt-tension test, in Hz." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('beltHz')" v-model.number="adv.beltHz" type="number" dense outlined hide-details label="Sweep (Hz/s)" style="max-width: 142px" :disabled="running"><template #append><HelpTip text="Sweep rate for the belt-tension test, in Hz per second." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('exciteFreq')" v-model.number="adv.exciteFreq" type="number" dense outlined hide-details label="Frequency (Hz)" style="max-width: 152px" :disabled="running"><template #append><HelpTip text="Single frequency to excite the axis at, in Hz — used to dwell on a suspected resonance." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('exciteSeconds')" v-model.number="adv.exciteSeconds" type="number" dense outlined hide-details label="Duration (s)" style="max-width: 132px" :disabled="running"><template #append><HelpTip text="How long to excite at the chosen frequency, in seconds." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('speedMin')" v-model.number="adv.speedMin" type="number" dense outlined hide-details label="Min (mm/s)" style="max-width: 132px" :disabled="running"><template #append><HelpTip text="Lowest test speed, in mm/s." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('speedMax')" v-model.number="adv.speedMax" type="number" dense outlined hide-details label="Max (mm/s)" style="max-width: 132px" :disabled="running"><template #append><HelpTip text="Highest test speed, in mm/s." /></template></v-text-field>
						<v-text-field v-if="activeTask.params.includes('speedStep')" v-model.number="adv.speedStep" type="number" dense outlined hide-details label="Step (mm/s)" style="max-width: 132px" :disabled="running"><template #append><HelpTip text="Speed increment between test runs, in mm/s." /></template></v-text-field>
						<v-spacer />
						<v-btn color="primary" :loading="running" :disabled="!canMeasure" @click="onMeasureClick">
							<v-icon left>mdi-play</v-icon>{{ $t("plugins.resonanceLab.controls.measure") }}
						</v-btn>
					</div>
					<v-textarea v-if="activeTask.params.includes('customMoves')" v-model="adv.customMoves" class="mt-3" dense outlined
								rows="4" hide-details :label="$t('plugins.resonanceLab.controls.customMoves')" :disabled="running" />
					<div class="text-caption text--secondary mt-2">
						{{ $t(`plugins.resonanceLab.tasks.${method}.run`) }} · {{ $t("plugins.resonanceLab.durationLabel", { dur: durationEstimate }) }}
					</div>
				</v-sheet>

				<!-- Progress -->
				<v-alert v-if="running" type="info" text dense class="mb-3">
					<div class="d-flex align-center rlab-ga-2">
						<v-progress-circular indeterminate size="16" width="2" />
						<span class="flex-grow-1">
							{{ $t("plugins.resonanceLab.runningTask", { task: $t(`plugins.resonanceLab.tasks.${method}.title`) }) }}
							<template v-if="method === 'belts' && beltPhase"> — {{ $t(`plugins.resonanceLab.belts.phase${beltPhase}`) }}</template>
							<template v-if="method === 'belts' && beltEstablishingTiming"> ({{ $t('plugins.resonanceLab.belts.phaseTiming') }})</template>
						</span>
						<v-btn small text :disabled="cancelRequested" @click="cancelRequested = true">
							<v-icon v-if="!cancelRequested" left>mdi-stop-circle-outline</v-icon>
							{{ cancelRequested ? $t("plugins.resonanceLab.cancel.cancelling") : $t("plugins.resonanceLab.cancel.button") }}
						</v-btn>
					</div>
					<div v-if="cancelRequested" class="text-caption text--secondary mt-1">
						{{ $t("plugins.resonanceLab.cancel.notice") }}
					</div>
				</v-alert>

				<!-- Loading a saved capture: prominent, replaces whatever was on screen (already cleared) -->
				<div v-if="loadingCapture" class="flex-grow-1 d-flex flex-column align-center justify-center text--secondary">
					<v-progress-circular indeterminate size="56" width="4" color="primary" class="mb-4" />
					<div class="text-h6">{{ $t("plugins.resonanceLab.captures.loading") }}</div>
				</div>

				<!-- Results: verdict + chart get all remaining space -->
				<template v-else-if="result">
					<div v-if="multiResults.length" class="mb-2">
						<v-btn small text @click="backToOverlay">
							<v-icon left>mdi-arrow-left</v-icon>{{ $t("plugins.resonanceLab.multi.back") }}
						</v-btn>
					</div>
					<v-alert v-if="result.analysis.overflows > 0" type="warning" text dense class="mb-2">
						{{ $t("plugins.resonanceLab.overflows", { count: result.analysis.overflows }) }}
					</v-alert>

					<v-card v-if="verdict" outlined :color="verdict.color" class="mb-3 rlab-tonal">
						<v-card-text class="d-flex align-center flex-wrap rlab-ga-3 py-3">
							<v-icon large>{{ verdict.icon }}</v-icon>
							<div class="flex-grow-1">
								<div class="text-subtitle-1 font-weight-medium">{{ verdict.headline }}</div>
								<div class="text-body-2">{{ verdict.detail }}</div>
							</div>
							<v-select v-if="rec" v-model="overlay" :items="overlayItems" item-text="title" item-value="value"
									  dense outlined hide-details style="max-width: 260px"
									  :label="$t('plugins.resonanceLab.results.compare')" />
							<v-btn v-if="rec" color="primary" :loading="applying" :disabled="!isConnected" @click="applyShaper">
								<v-icon left>mdi-check</v-icon>{{ $t("plugins.resonanceLab.results.apply", { shaper: displayName(overlay) }) }}
							</v-btn>
							<v-btn v-if="rec" text :loading="configDialogBusy" :disabled="!isConnected" @click="saveShaper">
								<v-icon left>mdi-content-save-outline</v-icon>{{ $t("plugins.resonanceLab.results.save") }}
							</v-btn>
							<v-btn v-if="appliedFit" text :loading="running" :disabled="!isConnected" @click="verify">
								<v-icon left>mdi-check-decagram-outline</v-icon>{{ $t("plugins.resonanceLab.results.verify") }}
							</v-btn>
						</v-card-text>
					</v-card>

					<v-alert v-if="verifyResult" :type="verifyResult.reduction > 0.5 ? 'success' : 'warning'" text class="mb-2">
						{{ $t("plugins.resonanceLab.results.verified", { shaper: displayName(verifyResult.shaper.name), freq: verifyResult.shaper.freq.toFixed(1), reduction: (verifyResult.reduction * 100).toFixed(0) }) }}
					</v-alert>
					<div v-if="!verifyResult && result.capture" class="d-flex align-center justify-end rlab-ga-3 mb-1">
						<v-checkbox v-if="chartMode === 'spectrum' && result.capture.axes.length > 1" v-model="showChannels" dense hide-details
									:label="$t('plugins.resonanceLab.results.showChannels')" />
						<v-btn-toggle v-model="chartMode" dense mandatory>
							<v-btn value="spectrum" small><v-icon left>mdi-chart-bell-curve</v-icon>{{ $t("plugins.resonanceLab.results.spectrum") }}</v-btn>
							<v-btn value="spectrogram" small><v-icon left>mdi-blur-linear</v-icon>{{ $t("plugins.resonanceLab.results.spectrogram") }}</v-btn>
						</v-btn-toggle>
					</div>
					<div style="flex: 1 1 0; min-height: 420px">
						<SpectrogramView v-if="!verifyResult && chartMode === 'spectrogram' && spectrogram" :spec="spectrogram" />
						<LineChart v-else-if="verifyResult"
								   :labels="verifyResult.before.labels"
								   :series="[
								   	{ label: $t('plugins.resonanceLab.results.before'), data: verifyResult.before.data, color: '#2196f3' },
								   	{ label: $t('plugins.resonanceLab.results.after', { shaper: displayName(verifyResult.shaper.name), freq: verifyResult.shaper.freq.toFixed(1) }), data: verifyResult.after, color: '#4caf50' },
								   ]"
								   x-title="Frequency (Hz)" y-title="Vibration (normalised)" />
						<SpectrumChart v-else :analysis="result.analysis" :overlay-shaper="overlay"
									   :channel-labels="result.capture?.axes" :show-channels="showChannels" />
					</div>

					<div class="d-flex align-center flex-wrap rlab-ga-4 mt-2 text-caption text--secondary">
						<span>{{ $t("plugins.resonanceLab.results.source", { source: result.source }) }}</span>
						<span>{{ $t("plugins.resonanceLab.results.samples", { count: result.analysis.sampleCount, rate: result.analysis.samplingRate }) }}</span>
						<span v-for="p in result.analysis.peaks.slice(0, 3)" :key="p.freq">
							{{ $t("plugins.resonanceLab.results.peak", { freq: p.freq.toFixed(1) }) }}<template v-if="p.dampingRatio"> (ζ≈{{ p.dampingRatio.toFixed(3) }})</template>
						</span>
					</div>
				</template>

				<!-- Accelerometer orientation check result -->
				<template v-else-if="orientationResult">
					<v-card outlined :color="orientationResult.solution.iParam ? 'success' : 'warning'" class="mb-3 rlab-tonal">
						<v-card-text class="d-flex align-center flex-wrap rlab-ga-3 py-3">
							<v-icon large>{{ orientationResult.solution.iParam ? "mdi-axis-arrow-info" : "mdi-axis-arrow-lock" }}</v-icon>
							<div class="flex-grow-1">
								<div class="text-subtitle-1 font-weight-medium">{{ orientationResult.solution.summary.join(" · ") }}</div>
								<div v-if="orientationResult.solution.iParam" class="text-body-2">
									{{ $t("plugins.resonanceLab.orientation.suggest") }}
									<code>M955 P{{ orientationResult.accelId }} I{{ orientationResult.solution.iParam }}</code>
								</div>
								<div v-else class="text-body-2">{{ $t("plugins.resonanceLab.orientation.underdetermined") }}</div>
								<div v-if="orientationResult.solution.conflicts.length" class="text-caption warning--text">
									{{ $t("plugins.resonanceLab.orientation.conflict", { axes: orientationResult.solution.conflicts.join(", ") }) }}
								</div>
								<div v-if="orientationResult.coupling > 0.6" class="text-caption warning--text">
									{{ $t("plugins.resonanceLab.orientation.coupling", { pct: (orientationResult.coupling * 100).toFixed(0) }) }}
								</div>
							</div>
							<v-btn v-if="orientationResult.solution.iParam" color="primary" :disabled="!isConnected" @click="applyOrientation">
								<v-icon left>mdi-check</v-icon>{{ $t("plugins.resonanceLab.orientation.apply") }}
							</v-btn>
							<v-btn v-if="orientationResult.solution.iParam" text :loading="configDialogBusy" :disabled="!isConnected" @click="saveOrientationToConfig">
								<v-icon left>mdi-content-save-outline</v-icon>{{ $t("plugins.resonanceLab.orientation.save") }}
							</v-btn>
						</v-card-text>
					</v-card>
				</template>

				<!-- Belt comparison result -->
				<template v-else-if="beltResult && beltVerdict && beltChart">
					<v-card outlined :color="beltVerdict.color" class="mb-3 rlab-tonal">
						<v-card-text class="d-flex align-center rlab-ga-3 py-3">
							<v-icon large>{{ beltVerdict.icon }}</v-icon>
							<div>
								<div class="text-subtitle-1 font-weight-medium">{{ beltVerdict.headline }}</div>
								<div class="text-body-2">{{ beltVerdict.detail }}</div>
							</div>
						</v-card-text>
					</v-card>
					<div style="flex: 1 1 0; min-height: 420px">
						<LineChart :labels="beltChart.labels" :series="beltChart.series"
								   x-title="Frequency (Hz)" y-title="Vibration" />
					</div>
				</template>

				<!-- Vibration profile result -->
				<template v-else-if="profileResult && profileVerdict && profileChart">
					<v-card outlined :color="profileVerdict.color" class="mb-3 rlab-tonal">
						<v-card-text class="d-flex align-center rlab-ga-3 py-3">
							<v-icon large>{{ profileVerdict.icon }}</v-icon>
							<div>
								<div class="text-subtitle-1 font-weight-medium">{{ profileVerdict.headline }}</div>
								<div class="text-body-2">{{ profileVerdict.detail }}</div>
							</div>
						</v-card-text>
					</v-card>
					<div style="flex: 1 1 0; min-height: 420px">
						<LineChart :labels="profileChart.labels" :series="profileChart.series"
								   x-title="Speed (mm/s)" y-title="Vibration energy" />
					</div>
				</template>

				<!-- Multi-axis calibration overlay -->
				<template v-else-if="multiResults.length && multiChart">
					<v-card v-if="combinedSummary" outlined color="primary" class="mb-2 rlab-tonal">
						<v-card-text class="d-flex align-center flex-wrap rlab-ga-3 py-3">
							<v-icon large>mdi-check-decagram-outline</v-icon>
							<div class="flex-grow-1">
								<div class="text-subtitle-1 font-weight-medium">
									{{ $t("plugins.resonanceLab.multi.combined", { shaper: combinedSummary.display, freq: combinedSummary.freq.toFixed(1) }) }}
								</div>
								<div class="text-body-2">
									{{ combinedSummary.agrees ? $t("plugins.resonanceLab.multi.agree") : $t("plugins.resonanceLab.multi.combinedDetail", { perAxis: combinedSummary.perAxisText }) }}
								</div>
							</div>
							<v-btn color="primary" :loading="applying" :disabled="!isConnected" @click="applyShaperFit(combinedSummary.name, combinedSummary.freq, combinedSummary.dampingRatio)">
								<v-icon left>mdi-check</v-icon>{{ $t("plugins.resonanceLab.results.apply", { shaper: combinedSummary.display }) }}
							</v-btn>
							<v-btn text :loading="configDialogBusy" :disabled="!isConnected"
								   @click="saveShaperFit(combinedSummary.name, combinedSummary.freq, combinedSummary.dampingRatio)">
								<v-icon left>mdi-content-save-outline</v-icon>{{ $t("plugins.resonanceLab.results.save") }}
							</v-btn>
							<v-btn v-if="appliedFit" text :loading="running" :disabled="!isConnected" @click="verifyMulti">
								<v-icon left>mdi-check-decagram-outline</v-icon>{{ $t("plugins.resonanceLab.results.verify") }}
							</v-btn>
						</v-card-text>
					</v-card>
					<v-alert v-if="multiVerifyResult" type="success" text class="mb-2">
						{{ $t("plugins.resonanceLab.multi.verified", {
							shaper: displayName(multiVerifyResult.shaper.name), freq: multiVerifyResult.shaper.freq.toFixed(1),
							perAxis: multiVerifyResult.perAxis.map((p) => `${p.axis} −${(p.reduction * 100).toFixed(0)}%`).join(" · "),
						}) }}
					</v-alert>
					<v-card outlined color="info" class="mb-3 rlab-tonal">
						<v-card-text class="py-3">
							<div class="text-subtitle-1 font-weight-medium mb-2">{{ $t("plugins.resonanceLab.multi.headline") }}</div>
							<div v-for="row in multiRows" :key="row.axis" class="d-flex align-center rlab-ga-3 py-1">
								<v-chip small label outlined :style="{ borderColor: row.color, color: row.color }">{{ row.axis }}</v-chip>
								<span class="text-body-2 text--secondary">
									<template v-if="row.fit">{{ $t("plugins.resonanceLab.multi.row", { peak: row.peak, shaper: row.fit.display, freq: row.fit.freq.toFixed(1), reduction: row.fit.reduction }) }}</template>
									<template v-else>{{ $t("plugins.resonanceLab.multi.quiet", { peak: row.peak }) }}</template>
								</span>
								<v-spacer />
								<v-btn small text @click="inspectAxis(row.axis)">
									<v-icon left>mdi-chart-bell-curve</v-icon>{{ $t("plugins.resonanceLab.multi.inspect") }}
								</v-btn>
								<v-btn v-if="row.fit" small text :loading="applying" :disabled="!isConnected" @click="applyShaperFit(row.fit.name, row.fit.freq, row.fit.dampingRatio)">
									<v-icon left>mdi-check</v-icon>{{ $t("plugins.resonanceLab.results.apply", { shaper: row.fit.display }) }}
								</v-btn>
								<v-btn v-if="row.fit" icon small :loading="configDialogBusy" :disabled="!isConnected"
									   :title="$t('plugins.resonanceLab.results.save')" @click="saveShaperFit(row.fit.name, row.fit.freq, row.fit.dampingRatio)">
									<v-icon small>mdi-content-save-outline</v-icon>
								</v-btn>
							</div>
							<div class="text-caption text--secondary mt-2">{{ $t("plugins.resonanceLab.multi.note") }}</div>
						</v-card-text>
					</v-card>
					<div style="flex: 1 1 0; min-height: 420px">
						<LineChart v-if="multiVerifyChart" :labels="multiVerifyChart.labels" :series="multiVerifyChart.series"
								   x-title="Frequency (Hz)" y-title="Vibration (normalised)" />
						<LineChart v-else :labels="multiChart.labels" :series="multiChart.series"
								   x-title="Frequency (Hz)" y-title="Vibration (normalised)" />
					</div>
				</template>

				<!-- Empty state -->
				<div v-else-if="!running" class="flex-grow-1 d-flex flex-column align-center justify-center text--secondary">
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
					<v-icon class="mr-2">mdi-help-circle-outline</v-icon>{{ $t("plugins.resonanceLab.help.title") }}
				</v-card-title>
				<v-card-text style="max-height: 65vh">
					<!-- Vue 2 cannot key a <template v-for>, so the wrapper div carries it. -->
					<div v-for="sec in helpSections" :key="sec">
						<div class="text-subtitle-2 mt-3">{{ $t(`plugins.resonanceLab.help.${sec}.heading`) }}</div>
						<div class="text-body-2 text--secondary">{{ $t(`plugins.resonanceLab.help.${sec}.body`) }}</div>
					</div>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text @click="helpDialog = false">{{ $t("plugins.resonanceLab.captures.cancel") }}</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<!-- Capture browser -->
		<v-dialog v-model="captureBrowser" max-width="640" scrollable>
			<v-card>
				<v-card-title class="d-flex align-center">
					<v-icon class="mr-2">mdi-folder-open-outline</v-icon>
					{{ $t("plugins.resonanceLab.captures.title") }}
					<v-spacer />
					<v-progress-circular v-if="loadingCapture" indeterminate size="20" width="2" class="mr-2" />
					<v-btn icon small :disabled="loadingCapture" :title="$t('plugins.resonanceLab.captures.refresh')" @click="refreshRemoteCaptures">
						<v-icon>mdi-refresh</v-icon>
					</v-btn>
				</v-card-title>
				<v-card-subtitle class="text-wrap">{{ $t("plugins.resonanceLab.captures.hint") }}</v-card-subtitle>
				<v-card-text style="max-height: 60vh">
					<div v-if="loadingCapture && remoteFiles.length === 0" class="text--secondary py-6 text-center">
						<v-progress-circular indeterminate size="24" width="2" class="mb-2" /><br>
						{{ $t("plugins.resonanceLab.captures.loading") }}
					</div>
					<div v-else-if="remoteFiles.length === 0" class="text--secondary py-6 text-center">{{ $t("plugins.resonanceLab.controls.noCaptures") }}</div>
					<div v-for="g in groupedCaptures" :key="g.day">
						<div class="text-overline text--secondary mt-2">{{ g.day }}</div>
						<v-list-item v-for="f in g.items" :key="f.name" class="px-0" @click="toggleFile(f.name)">
							<v-list-item-action class="mr-3">
								<!-- Display-only: v-simple-checkbox emits no `click`, so the toggle comes from the
								     row's own @click that this bubbles up to (one toggle, not two). -->
								<v-simple-checkbox :value="selectedFiles.includes(f.name)" dense :ripple="false" />
							</v-list-item-action>
							<v-list-item-content>
								<v-list-item-title class="d-flex align-center rlab-ga-2">
									<v-icon small>{{ captureMeta(f.kind).icon }}</v-icon>
									<span>{{ captureMeta(f.kind).label }}</span>
									<v-chip v-if="f.axis" x-small label>{{ f.axis }}</v-chip>
								</v-list-item-title>
								<v-list-item-subtitle>
									{{ f.when.getTime() ? f.when.toLocaleTimeString() : f.name }}<template v-if="f.size"> · {{ Math.round(f.size / 1024) }} kB</template>
								</v-list-item-subtitle>
							</v-list-item-content>
						</v-list-item>
					</div>
				</v-card-text>
				<v-card-actions>
					<span class="text-caption text--secondary ml-2">{{ $t("plugins.resonanceLab.captures.selected", { count: selectedFiles.length }) }}</span>
					<v-spacer />
					<v-btn text @click="captureBrowser = false">{{ $t("plugins.resonanceLab.captures.cancel") }}</v-btn>
					<v-btn color="primary" :disabled="selectedFiles.length === 0 || loadingCapture" @click="loadSelectedCaptures">
						<v-icon left>mdi-download</v-icon>{{ $t("plugins.resonanceLab.captures.load") }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-container>
</template>

<script setup lang="ts">
// The DWC 3.6 (Vue 2.7 / Vuetify 2) view. All behaviour lives in the shared composable - this file
// is the Vuetify 2 template plus the Vuex host wiring, and its 3.7 sibling is the same template
// written for Vuetify 4. Keep them in step: a change there almost always needs one here too.
import { createHost } from "./host";
import { useResonanceLab } from "../core/useResonanceLab";
import { DEFAULT_PROGRAM_DIR } from "../capture/orchestrator";
import { beltResult, method, multiResults, orientationResult, profileResult, selectedAxes, selectedAxis } from "../state";
import { applyUpdateNow, applying as updateApplying, checking, pendingReload, updateState } from "../updateCheck";
import AboutDialog from "./AboutDialog.vue";
import HelpTip from "./HelpTip.vue";
import LineChart from "./components/LineChart.vue";
import SpectrogramView from "./components/SpectrogramView.vue";
import SpectrumChart from "./components/SpectrumChart.vue";

const {
	model,
	reload,
	aboutOpen,
	autoCheck,
	aboutDescription,
	onCheckUpdate,
	onToggleAutoCheck,
	settingsOpen,
	programDir,
	isConnected,
	running,
	result,
	error,
	applying,
	filePicker,
	helpDialog,
	helpSections,
	beltPhase,
	beltEstablishingTiming,
	accelItems,
	selectedAccel,
	axisItems,
	adv,
	goalTasks,
	diagTasks,
	activeTask,
	taskAxisNote,
	selectTask,
	durationEstimate,
	canMeasure,
	cancelRequested,
	confirmGcodeOpen,
	skipGcodeConfirm,
	onMeasureClick,
	measure,
	verifyResult,
	appliedFit,
	multiVerifyResult,
	verify,
	verifyMulti,
	beltChart,
	beltVerdict,
	profileChart,
	profileVerdict,
	multiChart,
	multiVerifyChart,
	multiRows,
	combinedSummary,
	inspectAxis,
	backToOverlay,
	chartMode,
	showChannels,
	spectrogram,
	captureBrowser,
	selectedFiles,
	loadingCapture,
	remoteFiles,
	captureMeta,
	refreshRemoteCaptures,
	groupedCaptures,
	openCaptureBrowser,
	toggleFile,
	loadSelectedCaptures,
	loadLocalCsv,
	rec,
	overlay,
	overlayItems,
	displayName,
	verdict,
	downloadDiagnostics,
	applyOrientation,
	applyShaperFit,
	applyShaper,
	shaperScopeDialogOpen,
	pendingShaperFit,
	configDialogOpen,
	configDialogBusy,
	configDialogError,
	configPlan,
	configNotes,
	configSaved,
	configNeedsRestart,
	configCode,
	configFileName,
	activeTool,
	activeToolLabel,
	saveOrientationToConfig,
	saveShaperFit,
	saveShaper,
	cancelShaperScope,
	chooseShaperScope,
	confirmConfigSave,
	restartAfterSave,
	closeConfigDialog,
} = useResonanceLab(createHost());
</script>

<style scoped>
/* Task-rail item titles were being truncated with an ellipsis ("Accelerometer orien...") - the
   longest labels don't fit Vuetify's default single-line, nowrap-and-ellipsis title even at the
   rail's 232px width. Let them wrap onto a second line instead. */
.rlab-task-rail >>> .v-list-item__title {
	white-space: normal;
	line-height: 1.25;
}

/* Vuetify 2 has no `ga-*` gap utilities (they arrived in Vuetify 3), so the handful this layout
   relies on are defined here rather than reworking the flex rows into margin-based spacing. */
.rlab-ga-2 { gap: 8px; }
.rlab-ga-3 { gap: 12px; }
.rlab-ga-4 { gap: 16px; }

/* Vuetify 2 has no `variant="tonal"` either. An outlined card with a translucent wash of the
   theme colour is the closest equivalent: `color` alone would paint the whole card solid and make
   the body text unreadable, so the background is toned down and the text left to the theme. */
.rlab-tonal {
	background-color: transparent !important;
}
.rlab-tonal >>> .v-card__text {
	color: inherit;
}

.rlab-gcode-preview {
	max-height: 200px;
	overflow: auto;
	padding: 8px;
	border-radius: 4px;
	background: rgba(127, 127, 127, 0.12);
	font-size: 0.8rem;
	white-space: pre-wrap;
	font-family: monospace;
}
/* The config.g/tpost<N>.g diff can be a whole file's worth of mostly-unchanged lines - taller than
   the plain custom-G-code preview above, which is only ever a handful of user-typed lines. */
.rlab-config-diff {
	max-height: 320px;
}
</style>
