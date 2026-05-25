import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';

import { DroppedFile, VIEW_TYPE } from './settings';
import type FileDropPlugin from '../main';

export class FileDropView extends ItemView {
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

		const unverified = this.plugin.recentFiles
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => !entry.verified);

		if (unverified.length === 0) {
			this.fileListEl.createEl('p', { cls: 'filedrop-empty', text: 'No files yet.' });
			return;
		}

		// Group entries by parent folder (everything before the last /)
		const groups = new Map<string, { entry: DroppedFile; index: number }[]>();
		unverified.forEach(({ entry, index }) => {
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

		const verifiedLabel = headerRow.createEl('label', { cls: 'filedrop-verified-label' });
		const verifiedCheckbox = verifiedLabel.createEl('input', { cls: 'filedrop-verified-checkbox' });
		verifiedCheckbox.type = 'checkbox';
		verifiedCheckbox.checked = false;
		verifiedLabel.appendText('verified');
		verifiedCheckbox.addEventListener('change', async () => {
			if (verifiedCheckbox.checked) await this.markVerified(index);
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

	private async markVerified(index: number): Promise<void> {
		this.plugin.recentFiles[index].verified = true;
		await this.plugin.saveSettings();
		await this.rewriteNoteVerified(this.plugin.recentFiles[index].notePath);
		this.renderFileList();
	}

	private async rewriteNoteTags(notePath: string, tags: string[]): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);
		const updated = content.replace(/^tags:.*$/m, `tags: ${JSON.stringify(tags)}`);
		await this.app.vault.modify(file, updated);
	}

	private async rewriteNoteVerified(notePath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);
		const updated = content.replace(/^verified:.*$/m, 'verified: true');
		await this.app.vault.modify(file, updated);
	}
}
