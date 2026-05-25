import { App, ItemView, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, normalizePath, requestUrl } from 'obsidian';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile } = require('child_process') as typeof import('child_process');
const { join: pathJoin } = require('path') as typeof import('path');

const VIEW_TYPE = 'filedrop-sidebar';
const MAX_RECENT_FILES = 50;
const MARKITDOWN_TIMEOUT_MS = 30_000;
const LLM_TIMEOUT_MS = 120_000;

// Inline Python that runs markitdown's LLM image-description path against an
// OpenAI-compatible gateway. Passed via `python -c`; config comes from env vars.
const PY_SCRIPT = [
	'import sys, os',
	'from markitdown import MarkItDown',
	'from openai import OpenAI',
	'client = OpenAI(api_key=os.environ["FILEDROP_LLM_KEY"], base_url=os.environ.get("FILEDROP_LLM_URL") or None)',
	'kwargs = {"llm_client": client, "llm_model": os.environ["FILEDROP_LLM_MODEL"]}',
	'prompt = os.environ.get("FILEDROP_LLM_PROMPT")',
	'if prompt:',
	'    kwargs["llm_prompt"] = prompt',
	'md = MarkItDown(**kwargs)',
	'sys.stdout.write(md.convert(sys.argv[1]).text_content)',
].join('\n');

interface FileDropSettings {
	incomingDir: string;
	categories: string[];
	defaultTags: string[];
	llmGatewayUrl: string;
	llmApiKey: string;
	llmModel: string;
	llmPrompt: string;
	pythonCommand: string;
}

interface DroppedFile {
	filename: string;
	filePath: string;   // vault-relative path to raw file
	notePath: string;   // vault-relative path to .md note
	tags: string[];
	category: string;
	droppedAt: number;
}

interface PluginData {
	settings: FileDropSettings;
	recentFiles: DroppedFile[];
}

const DEFAULT_SETTINGS: FileDropSettings = {
	incomingDir: 'incoming',
	categories: ['default', 'mails', 'teams'],
	defaultTags: [],
	llmGatewayUrl: '',
	llmApiKey: '',
	llmModel: '',
	llmPrompt: '',
	pythonCommand: 'python3',
};

function isLlmEnabled(settings: FileDropSettings): boolean {
	return settings.llmApiKey.length > 0 && settings.llmModel.length > 0;
}

// True for loopback, RFC 1918 private ranges, link-local, and mDNS/.localhost
// names — hosts where an unencrypted gateway connection stays on the local
// machine or LAN. Assumes plain dotted-decimal / standard IPv6 (the user
// configures their own gateway; this is not an anti-SSRF guard).
function isLocalHost(hostname: string): boolean {
	let h = hostname.toLowerCase();
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // strip IPv6 brackets

	if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;

	if (h.includes(':')) { // IPv6
		if (h === '::1') return true;                       // loopback
		if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local fc00::/7
		if (h.startsWith('fe80')) return true;              // link-local
		return false;
	}

	const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	const a = Number(m[1]);
	const b = Number(m[2]);
	if (a === 127) return true;                       // 127.0.0.0/8 loopback
	if (a === 10) return true;                         // 10.0.0.0/8
	if (a === 192 && b === 168) return true;           // 192.168.0.0/16
	if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
	if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local
	return false;
}

// Returns a human-readable problem with the gateway URL, or null if it is safe
// to send the API key to. Blank = default OpenAI (https) = safe.
function gatewayUrlIssue(url: string): string | null {
	if (!url) return null;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return 'Gateway URL is not a valid URL.';
	}
	if (parsed.protocol === 'https:') return null;
	if (parsed.protocol === 'http:') {
		return isLocalHost(parsed.hostname)
			? null
			: 'Gateway uses http:// to a non-local host — your API key would be sent unencrypted. Use https:// or a local address.';
	}
	return 'Gateway URL must start with http:// or https://.';
}

function isGatewayUrlSecure(url: string): boolean {
	return gatewayUrlIssue(url) === null;
}

async function fetchModels(settings: FileDropSettings): Promise<string[]> {
	if (!settings.llmGatewayUrl || !settings.llmApiKey) {
		new Notice('FileDrop: set the gateway URL and API key before refreshing models.');
		return [];
	}
	const issue = gatewayUrlIssue(settings.llmGatewayUrl);
	if (issue) {
		new Notice(`FileDrop: ${issue}`);
		return [];
	}
	const modelsUrl = `${settings.llmGatewayUrl.replace(/\/+$/, '')}/models`;
	try {
		const res = await requestUrl({
			url: modelsUrl,
			headers: { Authorization: `Bearer ${settings.llmApiKey}` },
		});
		const data = (res.json?.data ?? []) as { id?: string }[];
		return data
			.map((m) => m.id)
			.filter((id): id is string => typeof id === 'string')
			.sort();
	} catch (err) {
		new Notice('FileDrop: could not fetch models from the gateway.');
		return [];
	}
}

function getMonthSlug(): string {
	const d = new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	return `${yyyy}-${mm}`;
}

function getBasename(filename: string): string {
	const lastDot = filename.lastIndexOf('.');
	return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

function conversionErrorBody(title: string, detail: string): string {
	return `> [!error] Conversion error: ${title}\n> ${detail.replace(/\n/g, '\n> ')}`;
}

async function runMarkitdown(absolutePath: string, settings: FileDropSettings): Promise<string> {
	if (isLlmEnabled(settings) && !isGatewayUrlSecure(settings.llmGatewayUrl)) {
		new Notice('FileDrop: refusing to send the API key over an insecure connection — converting without LLM.');
	} else if (isLlmEnabled(settings)) {
		return new Promise((resolve) => {
			execFile(
				settings.pythonCommand,
				['-c', PY_SCRIPT, absolutePath],
				{
					timeout: LLM_TIMEOUT_MS,
					env: {
						...process.env,
						FILEDROP_LLM_URL: settings.llmGatewayUrl,
						FILEDROP_LLM_KEY: settings.llmApiKey,
						FILEDROP_LLM_MODEL: settings.llmModel,
						FILEDROP_LLM_PROMPT: settings.llmPrompt,
					},
				},
				(error: Error | null, stdout: string) => {
					if (error) {
						new Notice('FileDrop: LLM conversion failed — see note body for details.');
						resolve(conversionErrorBody('LLM conversion failed', error.message));
						return;
					}
					if (!stdout.trim()) {
						resolve(conversionErrorBody('Conversion produced no output', 'markitdown exited successfully but returned empty content.'));
						return;
					}
					resolve(stdout.trim());
				}
			);
		});
	}

	return new Promise((resolve) => {
		execFile(
			'markitdown',
			[absolutePath],
			{ timeout: MARKITDOWN_TIMEOUT_MS },
			(error: Error | null, stdout: string) => {
				if (error) {
					new Notice('FileDrop: markitdown failed — see note body for details.');
					resolve(conversionErrorBody('markitdown conversion failed', error.message));
					return;
				}
				if (!stdout.trim()) {
					resolve(conversionErrorBody('Conversion produced no output', 'markitdown exited successfully but returned empty content.'));
					return;
				}
				resolve(stdout.trim());
			}
		);
	});
}

class FileDropView extends ItemView {
	private plugin: FileDropPlugin;
	private fileListEl: HTMLElement | null = null;
	private selectedCategory: string;

	constructor(leaf: WorkspaceLeaf, plugin: FileDropPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.selectedCategory = plugin.settings.categories[0] ?? 'default';
	}

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return 'FileDrop'; }
	getIcon(): string { return 'inbox'; }

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('filedrop-container');

		// Category selector
		const categoryRow = container.createDiv({ cls: 'filedrop-category-row' });
		categoryRow.createEl('label', { cls: 'filedrop-category-label', text: 'Category' });
		const categorySelect = categoryRow.createEl('select', { cls: 'filedrop-category-select' });
		this.plugin.settings.categories.forEach((cat) => {
			const opt = categorySelect.createEl('option', { value: cat, text: cat });
			if (cat === this.selectedCategory) opt.selected = true;
		});
		categorySelect.addEventListener('change', () => {
			this.selectedCategory = categorySelect.value;
		});

		// Drop zone
		const dropZone = container.createDiv({ cls: 'filedrop-zone' });
		dropZone.createDiv({ cls: 'filedrop-icon' });
		dropZone.createEl('p', { cls: 'filedrop-label', text: 'Drop files here' });
		dropZone.createEl('p', {
			cls: 'filedrop-sublabel',
			text: 'Files will be converted and inserted into your vault',
		});

		dropZone.addEventListener('dragover', (e) => {
			e.preventDefault();
			dropZone.addClass('filedrop-zone--active');
		});

		dropZone.addEventListener('dragleave', (e) => {
			if (!dropZone.contains(e.relatedTarget as Node)) {
				dropZone.removeClass('filedrop-zone--active');
			}
		});

		dropZone.addEventListener('drop', async (e) => {
			e.preventDefault();
			dropZone.removeClass('filedrop-zone--active');
			const files = e.dataTransfer?.files;
			if (!files || files.length === 0) return;
			for (const file of Array.from(files)) {
				await this.plugin.processDroppedFile(file, this.selectedCategory);
			}
		});

		// Recent files list
		this.fileListEl = container.createDiv({ cls: 'filedrop-recent' });
		this.renderFileList();
	}

	async onClose(): Promise<void> {
		// nothing to clean up
	}

	renderFileList(): void {
		if (!this.fileListEl) return;
		this.fileListEl.empty();

		const entries = this.plugin.recentFiles;
		if (entries.length === 0) {
			this.fileListEl.createEl('p', { cls: 'filedrop-empty', text: 'No files yet.' });
			return;
		}

		// Group entries by parent folder (everything before the last /)
		const groups = new Map<string, { entry: DroppedFile; index: number }[]>();
		entries.forEach((entry, index) => {
			const lastSlash = entry.filePath.lastIndexOf('/');
			const folder = lastSlash >= 0 ? entry.filePath.slice(0, lastSlash) : '';
			if (!groups.has(folder)) groups.set(folder, []);
			groups.get(folder)!.push({ entry, index });
		});

		groups.forEach((groupEntries, folder) => {
			const groupEl = this.fileListEl!.createDiv({ cls: 'filedrop-group' });
			groupEl.createDiv({ cls: 'filedrop-group-header', text: folder });
			groupEntries.forEach(({ entry, index }) => {
				this.renderFileEntry(groupEl, entry, index);
			});
		});
	}

	private renderFileEntry(container: HTMLElement, entry: DroppedFile, index: number): void {
		const entryEl = container.createDiv({ cls: 'filedrop-entry' });

		const headerRow = entryEl.createDiv({ cls: 'filedrop-entry-header' });
		const nameEl = headerRow.createEl('span', { cls: 'filedrop-entry-name', text: entry.filename });
		nameEl.addEventListener('click', () => {
			this.app.workspace.openLinkText(entry.notePath, '', false);
		});
		const removeBtn = headerRow.createEl('button', { cls: 'filedrop-entry-remove', text: '×' });
		removeBtn.addEventListener('click', () => this.removeEntry(index));

		const tagsRow = entryEl.createDiv({ cls: 'filedrop-entry-tags' });
		entry.tags.forEach((tag, tagIndex) => {
			const chip = tagsRow.createEl('span', { cls: 'filedrop-tag-chip', text: tag });
			chip.addEventListener('click', () => {
				const newTags = entry.tags.filter((_, i) => i !== tagIndex);
				this.updateEntryTags(index, newTags);
			});
		});

		const tagInput = tagsRow.createEl('input', { cls: 'filedrop-tag-input' });
		tagInput.type = 'text';
		tagInput.placeholder = 'add tag…';
		tagInput.addEventListener('keydown', async (e) => {
			if (e.key === 'Enter') {
				const val = tagInput.value.trim();
				if (val && !entry.tags.includes(val)) {
					await this.updateEntryTags(index, [...entry.tags, val]);
				}
			}
		});
	}

	private async updateEntryTags(index: number, newTags: string[]): Promise<void> {
		this.plugin.recentFiles[index].tags = newTags;
		await this.plugin.saveSettings();
		await this.rewriteNoteTags(this.plugin.recentFiles[index].notePath, newTags);
		this.renderFileList();
	}

	private async removeEntry(index: number): Promise<void> {
		const entry = this.plugin.recentFiles[index];
		try { await this.app.vault.adapter.remove(entry.filePath); } catch { /* best-effort */ }
		try {
			const noteFile = this.app.vault.getAbstractFileByPath(entry.notePath);
			if (noteFile instanceof TFile) await this.app.vault.delete(noteFile);
		} catch { /* best-effort */ }
		this.plugin.recentFiles.splice(index, 1);
		await this.plugin.saveSettings();
		this.renderFileList();
	}

	private async rewriteNoteTags(notePath: string, tags: string[]): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);
		const updated = content.replace(/^tags:.*$/m, `tags: ${JSON.stringify(tags)}`);
		await this.app.vault.modify(file, updated);
	}
}

interface PythonCheckResult {
	label: string;
	ok: boolean;
	detail?: string;
}

function runPythonCheck(cmd: string, args: string[]): Promise<PythonCheckResult & { stdout: string }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 10_000 }, (error: Error | null, stdout: string, stderr: string) => {
			resolve({ label: '', ok: !error, stdout: stdout.trim(), detail: error ? (stderr.trim() || error.message).split('\n')[0] : undefined });
		});
	});
}

async function checkMarkitdownCli(): Promise<PythonCheckResult> {
	const result = await runPythonCheck('markitdown', ['--version']);
	return {
		label: 'markitdown CLI',
		ok: result.ok,
		detail: result.ok ? result.stdout : result.detail,
	};
}

async function checkPythonEnv(pythonCmd: string): Promise<PythonCheckResult[]> {
	const results: PythonCheckResult[] = [];

	const versionCheck = await runPythonCheck(pythonCmd, ['--version']);
	results.push({
		label: `Python (${pythonCmd})`,
		ok: versionCheck.ok,
		detail: versionCheck.ok ? versionCheck.stdout : versionCheck.detail,
	});

	if (!versionCheck.ok) return results;

	const markitdownCheck = await runPythonCheck(pythonCmd, ['-c', 'import markitdown; print("ok")']);
	results.push({ label: 'markitdown package', ok: markitdownCheck.ok, detail: markitdownCheck.ok ? undefined : markitdownCheck.detail });

	const openaiCheck = await runPythonCheck(pythonCmd, ['-c', 'import openai; print("ok")']);
	results.push({ label: 'openai package', ok: openaiCheck.ok, detail: openaiCheck.ok ? undefined : openaiCheck.detail });

	return results;
}

class FileDropSettingTab extends PluginSettingTab {
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

export default class FileDropPlugin extends Plugin {
	settings: FileDropSettings;
	recentFiles: DroppedFile[];

	async onload(): Promise<void> {
		await this.loadSettings();
		this.registerView(VIEW_TYPE, (leaf) => new FileDropView(leaf, this));
		this.addRibbonIcon('inbox', 'FileDrop', () => this.activateView());
		this.addCommand({
			id: 'open-filedrop',
			name: 'Open FileDrop sidebar',
			callback: () => this.activateView(),
		});
		this.addSettingTab(new FileDropSettingTab(this.app, this));
	}

	async onunload(): Promise<void> {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
		this.recentFiles = data?.recentFiles ?? [];
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ settings: this.settings, recentFiles: this.recentFiles });
	}

	getActiveView(): FileDropView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		return leaves.length > 0 ? (leaves[0].view as FileDropView) : null;
	}

	async processDroppedFile(file: File, category: string): Promise<void> {
		const { vault } = this.app;
		const monthSlug = getMonthSlug();
		const subfolderPath = normalizePath(`${this.settings.incomingDir}/${monthSlug}/${category}`);

		await this.ensureDir(normalizePath(this.settings.incomingDir));
		await this.ensureDir(normalizePath(`${this.settings.incomingDir}/${monthSlug}`));
		await this.ensureDir(subfolderPath);

		const rawFilePath = normalizePath(`${subfolderPath}/${file.name}`);
		const buffer = await file.arrayBuffer();
		await vault.adapter.writeBinary(rawFilePath, buffer);

		const basePath: string | undefined = (vault.adapter as any).basePath;
		const absolutePath = basePath ? pathJoin(basePath, rawFilePath) : rawFilePath;
		const markdownBody = await runMarkitdown(absolutePath, this.settings);

		// Find a unique note path for duplicate drops
		const baseNote = normalizePath(`${subfolderPath}/${getBasename(file.name)}.md`);
		let notePath = baseNote;
		if (await vault.adapter.exists(notePath)) {
			let i = 2;
			while (await vault.adapter.exists(normalizePath(`${subfolderPath}/${getBasename(file.name)}-${i}.md`))) {
				i++;
			}
			notePath = normalizePath(`${subfolderPath}/${getBasename(file.name)}-${i}.md`);
		}

		const noteContent = [
			'---',
			`original-file: "[[${monthSlug}/${category}/${file.name}]]"`,
			'processed: false',
			`tags: ${JSON.stringify(this.settings.defaultTags)}`,
			'---',
			'',
			markdownBody,
		].join('\n');
		await vault.create(notePath, noteContent);

		const entry: DroppedFile = {
			filename: file.name,
			filePath: rawFilePath,
			notePath,
			tags: [...this.settings.defaultTags],
			category,
			droppedAt: Date.now(),
		};
		this.recentFiles.unshift(entry);
		if (this.recentFiles.length > MAX_RECENT_FILES) this.recentFiles.length = MAX_RECENT_FILES;
		await this.saveSettings();
		this.getActiveView()?.renderFileList();
	}

	private async ensureDir(path: string): Promise<void> {
		if (!(await this.app.vault.adapter.exists(path))) {
			await this.app.vault.adapter.mkdir(path);
		}
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getRightLeaf(false);
		await leaf?.setViewState({ type: VIEW_TYPE, active: true });
		if (leaf) workspace.revealLeaf(leaf);
	}
}
