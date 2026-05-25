import { Plugin, normalizePath } from 'obsidian';

import {
	DEFAULT_SETTINGS,
	DroppedFile,
	FileDropSettings,
	MAX_RECENT_FILES,
	PluginData,
	VIEW_TYPE,
} from './src/settings';
import { runMarkitdown } from './src/convert';
import { getBasename, getMonthSlug } from './src/utils';
import { FileDropView } from './src/view';
import { FileDropSettingTab } from './src/settings-tab';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { join: pathJoin } = require('path') as typeof import('path');

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
