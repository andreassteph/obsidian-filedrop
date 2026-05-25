import { App, Notice, PluginSettingTab, Setting } from 'obsidian';

import { DEFAULT_SETTINGS, fetchModels, gatewayUrlIssue } from './settings';
import { checkMarkitdownCli, checkPythonEnv } from './convert';
import type FileDropPlugin from '../main';

export class FileDropSettingTab extends PluginSettingTab {
	private plugin: FileDropPlugin;
	private availableModels: string[] = [];

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

		new Setting(containerEl).setName('LLM image processing').setHeading();

		new Setting(containerEl)
			.setName('Gateway URL')
			.setDesc('OpenAI-compatible base URL. https:// required, except for local/LAN hosts. Blank uses the default OpenAI endpoint.')
			.addText((text) =>
				text
					.setPlaceholder('https://api.openai.com/v1')
					.setValue(this.plugin.settings.llmGatewayUrl)
					.onChange(async (value) => {
						const trimmed = value.trim();
						this.plugin.settings.llmGatewayUrl = trimmed;
						await this.plugin.saveSettings();
						const issue = gatewayUrlIssue(trimmed);
						if (issue) new Notice(`FileDrop: ${issue}`);
					})
			);

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Stored unencrypted in this vault’s plugin data. Used only to call your gateway.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('sk-…')
					.setValue(this.plugin.settings.llmApiKey)
					.onChange(async (value) => {
						this.plugin.settings.llmApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		const modelOptions = Array.from(
			new Set([...this.availableModels, this.plugin.settings.llmModel].filter((m) => m.length > 0))
		);
		new Setting(containerEl)
			.setName('Model')
			.setDesc('Model used for image descriptions. Refresh to load options from the gateway.')
			.addDropdown((dropdown) => {
				if (modelOptions.length === 0) {
					dropdown.addOption('', 'No models — refresh →');
					dropdown.setValue('');
					dropdown.setDisabled(true);
				} else {
					modelOptions.forEach((m) => dropdown.addOption(m, m));
					dropdown.setValue(this.plugin.settings.llmModel);
				}
				dropdown.onChange(async (value) => {
					this.plugin.settings.llmModel = value;
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton((btn) => {
				btn.setIcon('refresh-cw')
					.setTooltip('Refresh model list')
					.onClick(async () => {
						this.availableModels = await fetchModels(this.plugin.settings);
						this.display();
					});
			});

		new Setting(containerEl)
			.setName('Image description prompt')
			.setDesc('Optional. Steers how images are described. Blank uses markitdown’s default.')
			.addTextArea((text) =>
				text
					.setPlaceholder('Describe this image in detail.')
					.setValue(this.plugin.settings.llmPrompt)
					.onChange(async (value) => {
						this.plugin.settings.llmPrompt = value;
						await this.plugin.saveSettings();
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

		// Auto-populate models on first open when credentials are present.
		if (
			this.availableModels.length === 0 &&
			this.plugin.settings.llmGatewayUrl &&
			this.plugin.settings.llmApiKey
		) {
			fetchModels(this.plugin.settings).then((models) => {
				if (models.length > 0) {
					this.availableModels = models;
					this.display();
				}
			});
		}
	}
}
