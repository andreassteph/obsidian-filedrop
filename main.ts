import { Notice, Plugin, TFile, normalizePath } from 'obsidian';

import {
	DEFAULT_SETTINGS,
	DroppedFile,
	FileDropSettings,
	MAX_RECENT_FILES,
	PluginData,
	VIEW_TYPE,
	isErrorBody,
	migrateLegacyLlmFields,
	parsePreferredTags,
	suggestTags,
} from './src/settings';
import { runMarkitdown, runMsgConversion } from './src/convert';
import { dedupeName, getMonthSlug, noteNameFromFile, replaceTagsBlock } from './src/utils';
import { FileDropView } from './src/view';
import { FileDropSettingTab } from './src/settings-tab';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { join: pathJoin } = require('path') as typeof import('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createHash } = require('crypto') as typeof import('crypto');

const sha256 = (buf: ArrayBuffer): string =>
	createHash('sha256').update(Buffer.from(buf)).digest('hex');

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

		const buffer = await file.arrayBuffer();
		const newHash = sha256(buffer);

		// Resolve a raw-file name before writing: skip identical re-drops, and
		// give a differing same-named drop a unique name so both coexist.
		let rawName = file.name;
		let rawFilePath = normalizePath(`${subfolderPath}/${rawName}`);
		let dupIndex = 1;
		while (await vault.adapter.exists(rawFilePath)) {
			const existing = await vault.adapter.readBinary(rawFilePath);
			if (sha256(existing) === newHash) {
				new Notice('Already imported — skipped');
				return;
			}
			dupIndex++;
			rawName = dedupeName(file.name, dupIndex);
			rawFilePath = normalizePath(`${subfolderPath}/${rawName}`);
		}
		// The raw name is already unique, so the derived note name is too.
		const notePath = normalizePath(`${subfolderPath}/${noteNameFromFile(rawName)}.md`);

		// Insert placeholder immediately so the file appears in the list before
		// any I/O starts. Not persisted yet — no stale entry survives a restart.
		const entry: DroppedFile = {
			filename: rawName,
			filePath: rawFilePath,
			notePath,
			tags: [],
			category,
			droppedAt: Date.now(),
			verified: false,
			status: 'moving',
		};
		this.recentFiles.unshift(entry);
		if (this.recentFiles.length > MAX_RECENT_FILES) this.recentFiles.length = MAX_RECENT_FILES;
		this.getActiveView()?.renderFileList();

		try {
			await vault.adapter.writeBinary(rawFilePath, buffer);

			// File stored — switch to markitdown phase before running it
			entry.status = 'converting-markitdown';
			this.getActiveView()?.renderFileList();

			const onPhase = (phase: 'markitdown' | 'llm-image') => {
				entry.status = phase === 'llm-image' ? 'converting-llm-image' : 'converting-markitdown';
				this.getActiveView()?.renderFileList();
			};

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
			let attachmentHadError = false;

			if (isMsgFile) {
				const msgResult = await runMsgConversion(absolutePath, this.settings.pythonCommand, gateway, onPhase);

				if (msgResult.attachments.length > 0) {
					const attDirName = `${rawName}.attachments`;
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
					if (!att.markdown) continue;
					bodyParts.push(`---\n\n## Attachment: ${att.filename}\n\n${att.markdown}`);
					if (isErrorBody(att.markdown)) attachmentHadError = true;
				}
				markdownBody = bodyParts.join('\n\n');
			} else {
				markdownBody = await runMarkitdown(absolutePath, this.settings.pythonCommand, gateway, onPhase);
			}

			entry.status = 'converting-llm-tags';
			this.getActiveView()?.renderFileList();

			const tagResult = await suggestTags(markdownBody, gateway, parsePreferredTags(this.settings.preferredTags));
			const mergedTags = Array.from(new Set([...this.settings.defaultTags, ...(tagResult.ok ? tagResult.value : [])]));

			const frontmatterLines = [
				'---',
				`original-file: "[[${monthSlug}/${category}/${rawName}]]"`,
				'processed: false',
				'verified: false',
				`tags: ${JSON.stringify(mergedTags)}`,
			];
			if (attachmentFrontmatterLines.length > 0) {
				frontmatterLines.push('attachments:');
				frontmatterLines.push(...attachmentFrontmatterLines);
			}
			frontmatterLines.push('---', '', markdownBody);

			await vault.create(notePath, frontmatterLines.join('\n'));

			entry.tags = [...mergedTags];
			entry.status = isErrorBody(markdownBody) || attachmentHadError ? 'error' : 'converted';
			await this.saveSettings();
			this.getActiveView()?.renderFileList();
		} catch (e) {
			entry.status = 'error';
			await this.saveSettings();
			this.getActiveView()?.renderFileList();
			new Notice(`FileDrop: conversion failed — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async rerunConversion(entry: DroppedFile, gatewayId: string | null): Promise<void> {
		const { vault } = this.app;

		entry.status = 'converting-markitdown';
		this.getActiveView()?.renderFileList();

		try {
			const basePath: string | undefined = (vault.adapter as any).basePath;
			const absolutePath = basePath ? pathJoin(basePath, entry.filePath) : entry.filePath;
			const gateway = gatewayId
				? (this.settings.llmGateways.find((g) => g.id === gatewayId) ?? null)
				: null;

			const onPhase = (phase: 'markitdown' | 'llm-image') => {
				entry.status = phase === 'llm-image' ? 'converting-llm-image' : 'converting-markitdown';
				this.getActiveView()?.renderFileList();
			};

			const isMsgFile = entry.filename.toLowerCase().endsWith('.msg');
			let newBody: string;
			let attachmentHadError = false;

			if (isMsgFile) {
				const msgResult = await runMsgConversion(absolutePath, this.settings.pythonCommand, gateway, onPhase);
				const bodyParts: string[] = [msgResult.body];
				for (const att of msgResult.attachments) {
					if (!att.markdown) continue;
					bodyParts.push(`---\n\n## Attachment: ${att.filename}\n\n${att.markdown}`);
					if (isErrorBody(att.markdown)) attachmentHadError = true;
				}
				newBody = bodyParts.join('\n\n');
			} else {
				newBody = await runMarkitdown(absolutePath, this.settings.pythonCommand, gateway, onPhase);
			}

			entry.status = 'converting-llm-tags';
			this.getActiveView()?.renderFileList();

			const noteFile = vault.getAbstractFileByPath(entry.notePath);
			if (!(noteFile instanceof TFile)) return;
			const content = await vault.read(noteFile);
			const closingIdx = content.indexOf('\n---\n');
			if (closingIdx < 0) return;

			const tagResult = await suggestTags(newBody, gateway, parsePreferredTags(this.settings.preferredTags));
			const mergedTags = Array.from(new Set([...this.settings.defaultTags, ...(tagResult.ok ? tagResult.value : [])]));
			const frontmatter = replaceTagsBlock(content.slice(0, closingIdx + 5), mergedTags);

			await vault.modify(noteFile, frontmatter + '\n' + newBody);

			entry.tags = [...mergedTags];
			entry.status = isErrorBody(newBody) || attachmentHadError ? 'error' : 'converted';
			await this.saveSettings();
			this.getActiveView()?.renderFileList();
		} catch (e) {
			entry.status = 'error';
			await this.saveSettings();
			this.getActiveView()?.renderFileList();
			new Notice(`FileDrop: re-conversion failed — ${e instanceof Error ? e.message : String(e)}`);
		}
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

	async updateFileList(): Promise<void> {
		const { vault, metadataCache } = this.app;
		const incomingDir = normalizePath(this.settings.incomingDir);
		if (!(await vault.adapter.exists(incomingDir))) {
			new Notice('FileDrop: incoming folder does not exist.');
			return;
		}

		const trackedNotePaths = new Set(this.recentFiles.map((e) => e.notePath));
		const trackedFilePaths = new Set(this.recentFiles.map((e) => e.filePath));
		let added = 0;

		// Refresh verified/processed for already-tracked entries
		for (const entry of this.recentFiles) {
			const file = vault.getAbstractFileByPath(entry.notePath);
			if (!(file instanceof TFile)) continue;
			const fm = metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			entry.verified = fm.verified === true;
			entry.processed = fm.processed === true;
			if (entry.verified && entry.status !== 'verified') entry.status = 'verified';
		}

		// Pick up untracked .md filedrop notes (verified or not)
		const mdFiles = vault.getMarkdownFiles().filter((f) =>
			f.path.startsWith(incomingDir + '/')
		);
		for (const file of mdFiles) {
			if (trackedNotePaths.has(file.path)) continue;
			const fm = metadataCache.getFileCache(file)?.frontmatter;
			if (!fm || !fm['original-file']) continue;

			const linkMatch = String(fm['original-file']).match(/\[\[(.+?)\]\]/);
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
				verified: fm.verified === true,
			});
			trackedNotePaths.add(file.path);
			trackedFilePaths.add(filePath);
			added++;
		}

		// Find raw files without a tracked .md — create stub + add to filelist
		const rawFiles = vault.getFiles().filter((f) =>
			f.path.startsWith(incomingDir + '/') &&
			!f.path.endsWith('.md') &&
			!f.path.includes('.attachments/')
		);
		for (const file of rawFiles) {
			if (trackedFilePaths.has(file.path)) continue;
			const dir = file.path.slice(0, file.path.lastIndexOf('/'));
			const notePath = normalizePath(`${dir}/${noteNameFromFile(file.name)}.md`);
			if (trackedNotePaths.has(notePath)) continue;

			const pathParts = file.path.slice(incomingDir.length + 1).split('/');
			const monthSlug = pathParts[0] ?? '';
			const category = pathParts.length >= 3 ? pathParts[1] : 'default';

			if (!(await vault.adapter.exists(notePath))) {
				await vault.create(notePath, [
					'---',
					`original-file: "[[${monthSlug}/${category}/${file.name}]]"`,
					'processed: false',
					'verified: false',
					'tags: []',
					'---',
					'',
				].join('\n'));
			}

			this.recentFiles.push({
				filename: file.name,
				filePath: file.path,
				notePath,
				tags: [],
				category,
				droppedAt: file.stat.ctime,
				verified: false,
			});
			trackedNotePaths.add(notePath);
			trackedFilePaths.add(file.path);
			added++;
		}

		this.recentFiles.sort((a, b) => b.droppedAt - a.droppedAt);
		if (this.recentFiles.length > MAX_RECENT_FILES) this.recentFiles.length = MAX_RECENT_FILES;
		await this.saveSettings();
		this.getActiveView()?.renderFileList();
		new Notice(`FileDrop: filelist updated — ${added} file(s) added.`);
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
