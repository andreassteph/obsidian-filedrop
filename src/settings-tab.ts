import { App, Notice, PluginSettingTab, Setting } from 'obsidian';

import {
	DEFAULT_SETTINGS,
	LlmGateway,
	LLM_PROVIDERS,
	ModelCapabilities,
	ReferenceConditionGroup,
	RestructureTemplatePair,
	fetchModelsForGateway,
	gatewayUrlIssue,
	getCapabilities,
	isGatewayEnabled,
	probeModel,
} from './settings';
import { checkMarkitdownCli, checkPythonEnv, installPythonRequirements, PYTHON_REQUIREMENTS } from './convert';
import { FileSuggest, FolderSuggest } from './path-suggest';
import type FileDropPlugin from '../main';

export class FileDropSettingTab extends PluginSettingTab {
	private plugin: FileDropPlugin;
	private gatewayModels: Map<string, string[]> = new Map();

	constructor(app: App, plugin: FileDropPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Incoming directory')
			.setDesc('Vault-relative path where dropped files will be stored.')
			.addText((text) =>
				text
					.setPlaceholder('incoming')
					.setValue(this.plugin.settings.incomingDir)
					.onChange(async (value) => {
						this.plugin.settings.incomingDir = value.trim() || DEFAULT_SETTINGS.incomingDir;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName('External linked folder').setHeading();

		new Setting(containerEl)
			.setName('External folder')
			.setDesc('Absolute path to a folder outside the vault. On scan, its top-level files become linked notes under the incoming directory and its top-level subfolders become group notes. Leave empty to disable.')
			.addText((text) =>
				text
					.setPlaceholder('e.g. F:/OneDrive')
					.setValue(this.plugin.settings.externalFolder)
					.onChange(async (value) => {
						this.plugin.settings.externalFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Group file limit')
			.setDesc('Maximum number of files (scanned recursively) a top-level subfolder may contain to be imported as a group. Larger folders are skipped with a warning.')
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.externalGroupFileLimit))
					.setValue(String(this.plugin.settings.externalGroupFileLimit))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.externalGroupFileLimit = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Categories')
			.setDesc('Comma-separated category subfolders shown in the sidebar dropdown.')
			.addText((text) =>
				text
					.setPlaceholder('default, mails, teams')
					.setValue(this.plugin.settings.categories.join(', '))
					.onChange(async (value) => {
						const parsed = value.split(',').map(c => c.trim()).filter(c => c.length > 0);
						this.plugin.settings.categories = parsed.length > 0 ? parsed : DEFAULT_SETTINGS.categories;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Default tags')
			.setDesc('Comma-separated tags pre-applied to every dropped file.')
			.addText((text) =>
				text
					.setPlaceholder('tag1, tag2')
					.setValue(this.plugin.settings.defaultTags.join(', '))
					.onChange(async (value) => {
						this.plugin.settings.defaultTags = value
							.split(',')
							.map(t => t.trim())
							.filter(t => t.length > 0);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Extensions to describe with LLM')
			.setDesc('Comma-separated file extensions (e.g. .exe, .dll, .bin) that skip markitdown and are described by the LLM based on filename. Requires an LLM gateway to be configured.')
			.addText((text) =>
				text
					.setPlaceholder('.exe, .dll, .bin')
					.setValue(this.plugin.settings.describeExtensions)
					.onChange(async (value) => {
						this.plugin.settings.describeExtensions = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Group conversion concurrency')
			.setDesc('How many files in a dropped group are converted in parallel. Higher is faster but uses more CPU and memory (peak memory ≈ this × per-file output). Set to 1 for the previous strictly-sequential behavior.')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.groupConcurrency))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.groupConcurrency = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Large file warning (MB)')
			.setDesc('Show a non-blocking notice when a dropped file exceeds this size, since conversion may be slow. Set to 0 to disable.')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.largeFileWarnMb))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 0) {
							this.plugin.settings.largeFileWarnMb = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('PPTX reflow batch size')
			.setDesc('Number of slides sent to the LLM per reflow call (default 8). Increase for fast models with large context windows; decrease for slow or small-context models.')
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.pptxBatchMaxSlides))
					.setValue(String(this.plugin.settings.pptxBatchMaxSlides))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 1) {
							this.plugin.settings.pptxBatchMaxSlides = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Preferred tags')
			.setDesc('One per line as "tag: description". After conversion the LLM is asked to prefer these tags.')
			.addTextArea((text) =>
				text
					.setPlaceholder('invoice: financial bills and receipts\nmeeting: notes from calls or meetings')
					.setValue(this.plugin.settings.preferredTags)
					.onChange(async (value) => {
						this.plugin.settings.preferredTags = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName('LLM gateways').setHeading();

		this.plugin.settings.llmGateways.forEach((gw, idx) => {
			this.renderGatewayEntry(containerEl, gw, idx);
		});

		new Setting(containerEl)
			.setName('Add gateway')
			.setDesc('Add a new LLM gateway configuration.')
			.addButton((btn) =>
				btn.setButtonText('+ Add gateway').onClick(async () => {
					this.plugin.settings.llmGateways.push({
						id: crypto.randomUUID(),
						name: 'New gateway',
						provider: 'custom',
						baseUrl: '',
						apiKey: '',
						model: '',
						prompt: '',
					});
					await this.plugin.saveSettings();
					this.display();
				})
			);

		new Setting(containerEl)
			.setName('Python command')
			.setDesc('Interpreter where markitdown and openai are installed.')
			.addText((text) =>
				text
					.setPlaceholder('python3')
					.setValue(this.plugin.settings.pythonCommand)
					.onChange(async (value) => {
						this.plugin.settings.pythonCommand = value.trim() || DEFAULT_SETTINGS.pythonCommand;
						await this.plugin.saveSettings();
					})
			);

		const pythonCheckSetting = new Setting(containerEl)
			.setName('Check Python environment')
			.setDesc('Verify that the Python command, markitdown, and openai packages are reachable.');

		const statusEl = pythonCheckSetting.controlEl.createDiv({ cls: 'filedrop-python-status' });

		pythonCheckSetting.addButton((btn) =>
			btn.setButtonText('Check Python').onClick(async () => {
				statusEl.empty();
				statusEl.setText('Checking…');
				const results = await checkPythonEnv(this.plugin.settings.pythonCommand);
				statusEl.empty();
				for (const { label, ok, detail } of results) {
					const row = statusEl.createDiv({ cls: 'filedrop-check-row' });
					row.createSpan({ cls: `filedrop-check-icon filedrop-check-${ok ? 'ok' : 'fail'}`, text: ok ? '✓' : '✗' });
					row.createSpan({ cls: 'filedrop-check-label', text: label });
					if (detail) row.createSpan({ cls: 'filedrop-check-detail', text: detail });
				}
			})
		);

		const cliCheckSetting = new Setting(containerEl)
			.setName('Check markitdown CLI')
			.setDesc('Verify that the markitdown command is available on the system PATH (used when LLM conversion is disabled).');

		const cliStatusEl = cliCheckSetting.controlEl.createDiv({ cls: 'filedrop-python-status' });

		cliCheckSetting.addButton((btn) =>
			btn.setButtonText('Check markitdown').onClick(async () => {
				cliStatusEl.empty();
				cliStatusEl.setText('Checking…');
				const { label, ok, detail } = await checkMarkitdownCli();
				cliStatusEl.empty();
				const row = cliStatusEl.createDiv({ cls: 'filedrop-check-row' });
				row.createSpan({ cls: `filedrop-check-icon filedrop-check-${ok ? 'ok' : 'fail'}`, text: ok ? '✓' : '✗' });
				row.createSpan({ cls: 'filedrop-check-label', text: label });
				if (detail) row.createSpan({ cls: 'filedrop-check-detail', text: detail });
			})
		);

		new Setting(containerEl).setName('Install Python requirements').setHeading();

		new Setting(containerEl)
			.setName('Required packages')
			.setDesc(
				`Installs ${PYTHON_REQUIREMENTS.join(', ')} into the configured Python environment ` +
				'via "python -m pip install". Use this to set up or repair the environment without leaving Obsidian.'
			)
			.addButton((btn) => {
				const outputEl = containerEl.createEl('pre', { cls: 'filedrop-pip-output' });
				outputEl.hide();

				btn.setButtonText('Install packages').onClick(() => {
					outputEl.show();
					outputEl.setText('');
					btn.setDisabled(true);
					btn.setButtonText('Installing…');

					installPythonRequirements(
						this.plugin.settings.pythonCommand,
						(chunk) => {
							outputEl.textContent += chunk;
							outputEl.scrollTop = outputEl.scrollHeight;
						},
						(ok) => {
							btn.setDisabled(false);
							btn.setButtonText('Install packages');
							outputEl.textContent += ok
								? '\n✓ Done.'
								: '\n✗ pip exited with an error — see output above.';
							new Notice(
								ok
									? 'FileDrop: Python packages installed successfully.'
									: 'FileDrop: pip install failed — check settings for details.'
							);
						}
					);
				});
			});

		// Restructure templates
		new Setting(containerEl).setName('Restructure templates').setHeading();
		new Setting(containerEl).setDesc(
			'Template ↔ main-folder pairs, used by both the "Fix to template" and "Create a restructured note" actions in the current-note panel. ' +
			'Each pair binds a template note (headings with per-section guidance lines) to the folder where restructured notes are filed — ' +
			'"Fix to template" only uses the template note, ignoring the target folder. ' +
			'The LLM suggests which pair fits the current note and which subfolder to use.',
		);

		this.plugin.settings.restructureTemplates.forEach((pair, idx) => {
			this.renderRestructurePair(containerEl, pair, idx);
		});

		new Setting(containerEl)
			.setName('Add restructure pair')
			.addButton((btn) =>
				btn.setButtonText('+ Add pair').onClick(async () => {
					this.plugin.settings.restructureTemplates.push({
						id: crypto.randomUUID(),
						name: 'New pair',
						templatePath: '',
						targetFolder: '',
					});
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		// References
		new Setting(containerEl).setName('References').setHeading();

		new Setting(containerEl)
			.setName('Default reference template')
			.setDesc('Template for reference paragraphs inserted into matching notes. Variables: {{date}}, {{type}}, {{summary}}, {{title}}, {{people}}, {{note_link}}')
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.referenceTemplate)
					.onChange(async (value) => {
						this.plugin.settings.referenceTemplate = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 6;
				text.inputEl.style.width = '100%';
				text.inputEl.style.fontFamily = 'monospace';
			});

		new Setting(containerEl)
			.setName('Max matches')
			.setDesc('Maximum number of matching notes the LLM returns per run.')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.referenceMaxMatches))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.referenceMaxMatches = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Todo section')
			.setDesc('Heading in the target note under which a follow-up todo is filed (e.g. "## Tasks").')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.todoSection)
					.onChange(async (value) => {
						this.plugin.settings.todoSection = value.trim() || DEFAULT_SETTINGS.todoSection;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Todo prompt')
			.setDesc('System prompt that turns a plain-English follow-up request into an Obsidian Tasks line. Today\'s date is prepended automatically.')
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.todoPrompt)
					.onChange(async (value) => {
						this.plugin.settings.todoPrompt = value || DEFAULT_SETTINGS.todoPrompt;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 8;
				text.inputEl.style.width = '100%';
				text.inputEl.style.fontFamily = 'monospace';
			});

		this.plugin.settings.referenceGroups.forEach((group, idx) => {
			this.renderReferenceGroup(containerEl, group, idx);
		});

		new Setting(containerEl)
			.setName('Add condition group')
			.setDesc('Define a set of frontmatter conditions identifying notes that should receive references.')
			.addButton((btn) =>
				btn.setButtonText('+ Add group').onClick(async () => {
					this.plugin.settings.referenceGroups.push({
						id: crypto.randomUUID(),
						name: 'New group',
						conditions: [],
						matchFields: ['name', 'title', 'description'],
						targetSection: '# Activities',
						template: '',
					});
					await this.plugin.saveSettings();
					this.display();
				})
			);

		// Auto-populate models for gateways with credentials but no cached models yet
		this.plugin.settings.llmGateways.forEach((gw) => {
			if (!this.gatewayModels.has(gw.id) && gw.baseUrl && gw.apiKey) {
				fetchModelsForGateway(gw).then((models) => {
					if (models.length > 0) {
						this.gatewayModels.set(gw.id, models);
						this.display();
					}
				});
			}
		});
	}

	private renderGatewayEntry(containerEl: HTMLElement, gw: LlmGateway, idx: number): void {
		const wrapperEl = containerEl.createDiv({ cls: 'filedrop-gateway-entry' });

		// Name field + remove button
		new Setting(wrapperEl)
			.setName(`Gateway ${idx + 1}`)
			.addText((text) =>
				text
					.setPlaceholder('My gateway')
					.setValue(gw.name)
					.onChange(async (value) => {
						this.plugin.settings.llmGateways[idx].name = value.trim();
						await this.plugin.saveSettings();
						this.plugin.getActiveView()?.refreshModelSelector();
					})
			)
			.addButton((btn) =>
				btn
					.setIcon('trash')
					.setTooltip('Remove gateway')
					.onClick(async () => {
						this.plugin.settings.llmGateways.splice(idx, 1);
						this.gatewayModels.delete(gw.id);
						await this.plugin.saveSettings();
						this.plugin.getActiveView()?.refreshModelSelector();
						this.display();
					})
			);

		// Provider dropdown
		new Setting(wrapperEl)
			.setName('Provider')
			.addDropdown((dd) => {
				Object.entries(LLM_PROVIDERS).forEach(([id, { label }]) => dd.addOption(id, label));
				dd.setValue(gw.provider);
				dd.onChange(async (value) => {
					this.plugin.settings.llmGateways[idx].provider = value;
					if (value !== 'custom') {
						this.plugin.settings.llmGateways[idx].baseUrl = LLM_PROVIDERS[value].baseUrl;
					}
					this.plugin.settings.llmGateways[idx].model = '';
					this.gatewayModels.delete(gw.id);
					await this.plugin.saveSettings();
					this.display();
				});
			});

		// Base URL
		new Setting(wrapperEl)
			.setName('Base URL')
			.setDesc('https:// required, except for local/LAN hosts.')
			.addText((text) =>
				text
					.setPlaceholder('https://api.openai.com/v1')
					.setValue(gw.baseUrl)
					.onChange(async (value) => {
						const trimmed = value.trim();
						this.plugin.settings.llmGateways[idx].baseUrl = trimmed;
						await this.plugin.saveSettings();
						const issue = gatewayUrlIssue(trimmed);
						if (issue) new Notice(`FileDrop: ${issue}`);
					})
			);

		// API key
		const providerDef = LLM_PROVIDERS[gw.provider] ?? LLM_PROVIDERS.custom;
		new Setting(wrapperEl)
			.setName('API key')
			.setDesc('Stored unencrypted in this vault\'s plugin data.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder(providerDef.keyPlaceholder)
					.setValue(gw.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.llmGateways[idx].apiKey = value.trim();
						await this.plugin.saveSettings();
						this.plugin.getActiveView()?.refreshModelSelector();
					});
			});

		// Model dropdown + refresh button
		const cachedModels = this.gatewayModels.get(gw.id) ?? [];
		const modelOptions = Array.from(
			new Set([...cachedModels, gw.model].filter((m) => m.length > 0))
		);
		new Setting(wrapperEl)
			.setName('Model')
			.addDropdown((dd) => {
				if (modelOptions.length === 0) {
					dd.addOption('', 'No models — refresh →');
					dd.setValue('');
					dd.setDisabled(true);
				} else {
					modelOptions.forEach((m) => dd.addOption(m, m));
					dd.setValue(gw.model);
				}
				dd.onChange(async (value) => {
					this.plugin.settings.llmGateways[idx].model = value;
					await this.plugin.saveSettings();
					this.plugin.getActiveView()?.refreshModelSelector();
					this.display(); // capabilities are per-model — refresh the check summary
				});
			})
			.addExtraButton((btn) =>
				btn
					.setIcon('refresh-cw')
					.setTooltip('Refresh model list')
					.onClick(async () => {
						const models = await fetchModelsForGateway(gw);
						this.gatewayModels.set(gw.id, models);
						this.display();
					})
			);

		// Manual model entry — fallback when the model list can't be fetched.
		new Setting(wrapperEl)
			.setName('Model (manual)')
			.setDesc("Fallback if the model list can't be fetched — type the exact model ID.")
			.addText((text) =>
				text
					.setPlaceholder('e.g. gpt-4o')
					.setValue(gw.model)
					.onChange(async (value) => {
						this.plugin.settings.llmGateways[idx].model = value.trim();
						await this.plugin.saveSettings();
						this.plugin.getActiveView()?.refreshModelSelector();
					})
			);

		// Model compatibility check — probes the gateway+model and stores which
		// request parameters it supports (e.g. max_tokens vs max_completion_tokens).
		const checkSetting = new Setting(wrapperEl)
			.setName('Check model compatibility')
			.setDesc('Verify the model is reachable and detect which request parameters it supports.');

		const checkStatusEl = checkSetting.controlEl.createDiv({ cls: 'filedrop-check-status' });
		const saved = gw.capabilities?.[gw.model];
		if (saved) {
			checkStatusEl.createDiv({ cls: 'filedrop-check-detail', text: this.capabilitySummary(saved) });
		}

		checkSetting.addButton((btn) =>
			btn.setButtonText('Check').onClick(async () => {
				checkStatusEl.empty();
				checkStatusEl.setText('Checking…');
				const result = await probeModel(gw);
				checkStatusEl.empty();
				for (const { label, status, detail } of result.steps) {
					const icon = status === 'ok' ? '✓' : status === 'warn' ? '!' : '✗';
					const row = checkStatusEl.createDiv({ cls: 'filedrop-check-row' });
					row.createSpan({ cls: `filedrop-check-icon filedrop-check-${status === 'ok' ? 'ok' : status === 'warn' ? 'warn' : 'fail'}`, text: icon });
					row.createSpan({ cls: 'filedrop-check-label', text: label });
					if (detail) row.createSpan({ cls: 'filedrop-check-detail', text: detail });
				}
				if (result.ok && result.capabilities) {
					gw.capabilities = { ...(gw.capabilities ?? {}), [gw.model]: result.capabilities };
					await this.plugin.saveSettings();
					checkStatusEl.createDiv({ cls: 'filedrop-check-detail', text: this.capabilitySummary(result.capabilities) });
				}
			})
		);

		// Prompt
		new Setting(wrapperEl)
			.setName('Image description prompt')
			.setDesc('Optional. Steers how images are described. Blank uses markitdown\'s default.')
			.addTextArea((text) =>
				text
					.setPlaceholder('Describe this image in detail.')
					.setValue(gw.prompt)
					.onChange(async (value) => {
						this.plugin.settings.llmGateways[idx].prompt = value;
						await this.plugin.saveSettings();
					})
			);
	}

	private capabilitySummary(caps: ModelCapabilities): string {
		const tokenPart =
			caps.tokenParam === 'none' ? 'no token limit' : `using ${caps.tokenParam}`;
		const parts = [
			tokenPart,
			caps.systemRole ? 'system role' : 'system role folded',
			`vision: ${caps.vision ? 'yes' : 'no'}`,
		];
		const when = caps.checkedAt ? ` (checked ${new Date(caps.checkedAt).toLocaleString()})` : '';
		return `Detected: ${parts.join(' · ')}${when}`;
	}

	private renderRestructurePair(containerEl: HTMLElement, pair: RestructureTemplatePair, idx: number): void {
		const wrapperEl = containerEl.createDiv({ cls: 'filedrop-gateway-entry' });

		new Setting(wrapperEl)
			.setName(`Pair ${idx + 1}`)
			.addText((text) =>
				text
					.setPlaceholder('Pair name, e.g. Meeting → Meetings')
					.setValue(pair.name)
					.onChange(async (value) => {
						this.plugin.settings.restructureTemplates[idx].name = value.trim();
						await this.plugin.saveSettings();
					}),
			)
			.addButton((btn) =>
				btn
					.setIcon('trash')
					.setTooltip('Remove pair')
					.onClick(async () => {
						this.plugin.settings.restructureTemplates.splice(idx, 1);
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(wrapperEl)
			.setName('Template path')
			.setDesc('Vault-relative path to the template note (headings + guidance lines).')
			.addText((text) => {
				text
					.setPlaceholder('e.g. Templates/Meeting.md')
					.setValue(pair.templatePath)
					.onChange(async (value) => {
						this.plugin.settings.restructureTemplates[idx].templatePath = value.trim();
						await this.plugin.saveSettings();
					});
				new FileSuggest(this.app, text.inputEl, async (file) => {
					text.setValue(file.path);
					this.plugin.settings.restructureTemplates[idx].templatePath = file.path;
					await this.plugin.saveSettings();
				});
			});

		new Setting(wrapperEl)
			.setName('Target folder')
			.setDesc('Vault-relative main folder where restructured notes are filed (a subfolder is suggested per note).')
			.addText((text) => {
				text
					.setPlaceholder('e.g. Meetings')
					.setValue(pair.targetFolder)
					.onChange(async (value) => {
						this.plugin.settings.restructureTemplates[idx].targetFolder = value.trim();
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, text.inputEl, async (folder) => {
					text.setValue(folder.path);
					this.plugin.settings.restructureTemplates[idx].targetFolder = folder.path;
					await this.plugin.saveSettings();
				});
			});
	}

	private renderReferenceGroup(containerEl: HTMLElement, group: ReferenceConditionGroup, idx: number): void {
		const wrapperEl = containerEl.createDiv({ cls: 'filedrop-gateway-entry' });

		new Setting(wrapperEl)
			.setName(`Group ${idx + 1}`)
			.addText((text) =>
				text
					.setPlaceholder('Group name, e.g. Customers')
					.setValue(group.name)
					.onChange(async (value) => {
						this.plugin.settings.referenceGroups[idx].name = value.trim();
						await this.plugin.saveSettings();
					})
			)
			.addButton((btn) =>
				btn
					.setIcon('trash')
					.setTooltip('Remove group')
					.onClick(async () => {
						this.plugin.settings.referenceGroups.splice(idx, 1);
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// Conditions
		const condLabel = wrapperEl.createEl('div', { cls: 'setting-item-name', text: 'Conditions (AND)' });
		condLabel.style.paddingLeft = '16px';
		condLabel.style.paddingTop = '8px';
		condLabel.style.fontSize = 'var(--font-ui-smaller)';
		condLabel.style.color = 'var(--text-muted)';

		group.conditions.forEach((cond, ci) => {
			const condRow = wrapperEl.createDiv({ cls: 'filedrop-ref-cond-row' });
			const fieldInput = condRow.createEl('input');
			fieldInput.type = 'text';
			fieldInput.placeholder = 'field';
			fieldInput.value = cond.field;
			fieldInput.className = 'filedrop-ref-cond-input';
			fieldInput.addEventListener('change', async () => {
				this.plugin.settings.referenceGroups[idx].conditions[ci].field = fieldInput.value.trim();
				await this.plugin.saveSettings();
			});

			condRow.createSpan({ text: '=', cls: 'filedrop-ref-cond-eq' });

			const valueInput = condRow.createEl('input');
			valueInput.type = 'text';
			valueInput.placeholder = 'value';
			valueInput.value = cond.value;
			valueInput.className = 'filedrop-ref-cond-input';
			valueInput.addEventListener('change', async () => {
				this.plugin.settings.referenceGroups[idx].conditions[ci].value = valueInput.value.trim();
				await this.plugin.saveSettings();
			});

			const removeBtn = condRow.createEl('button', { text: '×' });
			removeBtn.className = 'filedrop-ref-cond-remove';
			removeBtn.addEventListener('click', async () => {
				this.plugin.settings.referenceGroups[idx].conditions.splice(ci, 1);
				await this.plugin.saveSettings();
				this.display();
			});
		});

		const addCondBtn = wrapperEl.createEl('button', { text: '+ Add condition', cls: 'filedrop-ref-add-cond' });
		addCondBtn.addEventListener('click', async () => {
			this.plugin.settings.referenceGroups[idx].conditions.push({ field: '', value: '' });
			await this.plugin.saveSettings();
			this.display();
		});

		new Setting(wrapperEl)
			.setName('Match fields')
			.setDesc('Comma-separated frontmatter fields sent to the LLM as context for matching.')
			.addText((text) =>
				text
					.setPlaceholder('name, title, description')
					.setValue(group.matchFields.join(', '))
					.onChange(async (value) => {
						this.plugin.settings.referenceGroups[idx].matchFields = value
							.split(',')
							.map((f) => f.trim())
							.filter((f) => f.length > 0);
						await this.plugin.saveSettings();
					})
			);

		new Setting(wrapperEl)
			.setName('Target section')
			.setDesc('Heading in the target note where references are inserted, e.g. "# Activities".')
			.addText((text) =>
				text
					.setPlaceholder('# Activities')
					.setValue(group.targetSection)
					.onChange(async (value) => {
						this.plugin.settings.referenceGroups[idx].targetSection = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(wrapperEl)
			.setName('Template override')
			.setDesc('Leave blank to use the global template. Variables: {{date}}, {{type}}, {{summary}}, {{title}}, {{people}}, {{note_link}}')
			.addTextArea((text) => {
				text
					.setPlaceholder('Leave blank to use global template')
					.setValue(group.template)
					.onChange(async (value) => {
						this.plugin.settings.referenceGroups[idx].template = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
				text.inputEl.style.width = '100%';
				text.inputEl.style.fontFamily = 'monospace';
			});
	}
}
