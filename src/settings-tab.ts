import { App, Notice, PluginSettingTab, Setting } from 'obsidian';

import {
	DEFAULT_SETTINGS,
	LlmGateway,
	LLM_PROVIDERS,
	ReferenceConditionGroup,
	fetchModelsForGateway,
	gatewayUrlIssue,
	isGatewayEnabled,
} from './settings';
import { checkMarkitdownCli, checkPythonEnv, installPythonRequirements, PYTHON_REQUIREMENTS } from './convert';
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
