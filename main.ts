import { Plugin, normalizePath } from 'obsidian';

import {
	DEFAULT_SETTINGS,
	DroppedFile,
	FileDropSettings,
	MAX_RECENT_FILES,
	PluginData,
	VIEW_TYPE,
	migrateLegacyLlmFields,
} from './src/settings';
import { runMarkitdown, runMsgConversion } from './src/convert';
import { getMonthSlug } from './src/utils';
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
		this.app.workspace.onLayoutReady(() => this.syncIncomingFolder());
	}

	async onunload(): Promise<void> {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginData> | null;
		const rawSettings = (data?.settings ?? {}) as Partial<FileDropSettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, rawSettings);
		this.settings.llmGateways = migrateLegacyLlmFields(rawSettings);
		// Strip legacy fields so they are not re-persisted after migration
		delete (this.settings as any).llmProvider;
		delete (this.settings as any).llmGatewayUrl;
		delete (this.settings as any).llmApiKey;
		delete (this.settings as any).llmModel;
		delete (this.settings as any).llmPrompt;
		this.recentFiles = data?.recentFiles ?? [];
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ settings: this.settings, recentFiles: this.recentFiles });
	}

	getActiveView(): FileDropView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		return leaves.length > 0 ? (leaves[0].view as FileDropView) : null;
	}

	async processDroppedFile(file: File, category: string, gatewayId: string | null): Promise<void> {
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
		const gateway = gatewayId
			? (this.settings.llmGateways.find((g) => g.id === gatewayId) ?? null)
			: null;

		const isMsgFile =
			file.name.toLowerCase().endsWith('.msg') ||
			file.type === 'application/vnd.ms-outlook' ||
			file.type === 'application/x-msg';
		let markdownBody: string;
		const attachmentFrontmatterLines: string[] = [];

		if (isMsgFile) {
			const msgResult = await runMsgConversion(absolutePath, this.settings.pythonCommand, gateway);

			if (msgResult.attachments.length > 0) {
				const attDirName = `${file.name}.attachments`;
				const attDirPath = normalizePath(`${subfolderPath}/${attDirName}`);
				await this.ensureDir(attDirPath);

				for (const att of msgResult.attachments) {
					const attFilePath = normalizePath(`${attDirPath}/${att.filename}`);
					const attBuf = Buffer.from(att.dataB64, 'base64');
					const attArrayBuffer = attBuf.buffer.slice(attBuf.byteOffset, attBuf.byteOffset + attBuf.byteLength) as ArrayBuffer;
					await vault.adapter.writeBinary(attFilePath, attArrayBuffer);
					attachmentFrontmatterLines.push(`  - "[[${monthSlug}/${category}/${attDirName}/${att.filename}]]"`);
				}
			}

			const bodyParts: string[] = [msgResult.body];
			for (const att of msgResult.attachments) {
				if (att.markdown) {
					bodyParts.push(`---\n\n## Attachment: ${att.filename}\n\n${att.markdown}`);
				}
			}
			markdownBody = bodyParts.join('\n\n');
		} else {
			markdownBody = await runMarkitdown(absolutePath, this.settings.pythonCommand, gateway);
		}

		// Find a unique note path for duplicate drops
		const baseNote = normalizePath(`${subfolderPath}/${file.name}.md`);
		let notePath = baseNote;
		if (await vault.adapter.exists(notePath)) {
			let i = 2;
			while (await vault.adapter.exists(normalizePath(`${subfolderPath}/${file.name}-${i}.md`))) {
				i++;
			}
			notePath = normalizePath(`${subfolderPath}/${file.name}-${i}.md`);
		}

		const frontmatterLines = [
			'---',
			`original-file: "[[${monthSlug}/${category}/${file.name}]]"`,
			'processed: false',
			'verified: false',
			`tags: ${JSON.stringify(this.settings.defaultTags)}`,
		];
		if (attachmentFrontmatterLines.length > 0) {
			frontmatterLines.push('attachments:');
			frontmatterLines.push(...attachmentFrontmatterLines);
		}
		frontmatterLines.push('---', '', markdownBody);

		const noteContent = frontmatterLines.join('\n');
		await vault.create(notePath, noteContent);

		const entry: DroppedFile = {
			filename: file.name,
			filePath: rawFilePath,
			notePath,
			tags: [...this.settings.defaultTags],
			category,
			droppedAt: Date.now(),
			verified: false,
		};
		this.recentFiles.unshift(entry);
		if (this.recentFiles.length > MAX_RECENT_FILES) this.recentFiles.length = MAX_RECENT_FILES;
		await this.saveSettings();
		this.getActiveView()?.renderFileList();
	}

	async syncIncomingFolder(): Promise<void> {
		const { vault, metadataCache } = this.app;
		const incomingDir = normalizePath(this.settings.incomingDir);
		if (!(await vault.adapter.exists(incomingDir))) return;

		const mdFiles = vault.getMarkdownFiles().filter((f) =>
			f.path.startsWith(incomingDir + '/')
		);

		const existingPaths = new Set(this.recentFiles.map((e) => e.notePath));
		let changed = false;

		for (const file of mdFiles) {
			if (existingPaths.has(file.path)) continue;
			const fm = metadataCache.getFileCache(file)?.frontmatter;
			if (!fm || fm.verified !== false) continue;

			const originalFileLink: string = fm['original-file'] ?? '';
			const linkMatch = originalFileLink.match(/\[\[(.+?)\]\]/);
			const relPath = linkMatch ? linkMatch[1] : '';
			const filePath = relPath ? normalizePath(`${incomingDir}/${relPath}`) : '';
			const filename = relPath ? (relPath.split('/').pop() ?? file.name) : file.name;
			const pathParts = relPath.split('/');
			const category = pathParts.length >= 2 ? pathParts[1] : 'default';

			this.recentFiles.push({
				filename,
				filePath,
				notePath: file.path,
				tags: Array.isArray(fm.tags) ? fm.tags : [],
				category,
				droppedAt: file.stat.ctime,
				verified: false,
			});
			changed = true;
		}

		if (changed) {
			await this.saveSettings();
			this.getActiveView()?.renderFileList();
		}
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
