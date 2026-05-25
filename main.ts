import { App, ItemView, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile } = require('child_process') as typeof import('child_process');

const VIEW_TYPE = 'filedrop-sidebar';
const MAX_RECENT_FILES = 50;
const MARKITDOWN_TIMEOUT_MS = 30_000;

interface FileDropSettings {
	incomingDir: string;
	categories: string[];
	defaultTags: string[];
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
};

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

async function runMarkitdown(absolutePath: string): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			'markitdown',
			[absolutePath],
			{ timeout: MARKITDOWN_TIMEOUT_MS },
			(error: Error | null, stdout: string) => {
				if (error) {
					new Notice('FileDrop: markitdown unavailable or failed — note created without body.');
					resolve('');
				} else {
					resolve(stdout.trim());
				}
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

class FileDropSettingTab extends PluginSettingTab {
	private plugin: FileDropPlugin;

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
		const absolutePath = basePath ? `${basePath}/${rawFilePath}` : rawFilePath;
		const markdownBody = await runMarkitdown(absolutePath);

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
