import { Notice, Plugin, TFile, normalizePath } from 'obsidian';

import {
	DEFAULT_SETTINGS,
	DroppedFile,
	FileDropSettings,
	LlmGateway,
	MAX_RECENT_FILES,
	PluginData,
	VIEW_TYPE,
	isErrorBody,
	migrateLegacyLlmFields,
	parsePreferredTags,
	suggestFilename,
	suggestTags,
} from './src/settings';
import { runMarkitdown, runMsgConversion } from './src/convert';
import { dedupeName, getMonthSlug, noteNameFromFile, replaceTagsBlock, sanitizeFilename } from './src/utils';
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

	// Cancellation tokens for in-flight conversions (keyed by notePath)
	private cancelledConversions = new Set<string>();

	cancelConversion(notePath: string): void {
		this.cancelledConversions.add(notePath);
	}

	// Group mode state
	groupModeActive = false;
	private readonly GROUP_IDLE_MS = 20_000;
	private groupQueue: File[] = [];
	private _groupName: string | null = null;
	private groupCategory = '';
	private groupGatewayId: string | null = null;
	private groupTimeoutId: number | null = null;
	// True when the active group contains pasted image/text, so the finalized
	// group note is named from its combined content rather than the first file.
	private groupNameFromContent = false;

	get groupQueueCount(): number { return this.groupQueue.length; }
	get groupCurrentName(): string { return this._groupName ?? ''; }

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
		this.clearGroupTimer();
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}

	startGroupMode(category: string, gatewayId: string | null): void {
		this.groupModeActive = true;
		this.groupQueue = [];
		this._groupName = null;
		this.groupNameFromContent = false;
		this.groupCategory = category;
		this.groupGatewayId = gatewayId;
		this.getActiveView()?.onGroupModeChanged();
	}

	stopGroupMode(): void {
		this.clearGroupTimer();
		this.groupModeActive = false;
		this.groupQueue = [];
		this._groupName = null;
		this.groupNameFromContent = false;
		this.getActiveView()?.onGroupModeChanged();
	}

	async finalizeAndStopGroupMode(): Promise<void> {
		this.clearGroupTimer();
		const queue = [...this.groupQueue];
		const name = this._groupName ?? 'group';
		const category = this.groupCategory;
		const gatewayId = this.groupGatewayId;
		const nameFromContent = this.groupNameFromContent;
		this.groupModeActive = false;
		this.groupQueue = [];
		this._groupName = null;
		this.groupNameFromContent = false;
		this.getActiveView()?.onGroupModeChanged();
		if (queue.length > 0) {
			await this.processFileGroup(queue, name, category, gatewayId, nameFromContent);
		}
	}

	resetGroupIdleTimer(): void {
		this.clearGroupTimer();
		this.groupTimeoutId = window.setTimeout(() => {
			this.getActiveView()?.promptGroupFinish();
		}, this.GROUP_IDLE_MS);
	}

	private clearGroupTimer(): void {
		if (this.groupTimeoutId !== null) {
			clearTimeout(this.groupTimeoutId);
			this.groupTimeoutId = null;
		}
	}

	private queueFileForGroup(file: File): void {
		if (this._groupName === null) {
			const dot = file.name.lastIndexOf('.');
			this._groupName = dot > 0 ? file.name.slice(0, dot) : file.name;
		}
		this.groupQueue.push(file);
		this.resetGroupIdleTimer();
		this.getActiveView()?.onGroupModeChanged();
	}

	// Ask the LLM for a content-derived base name and rename the already-written
	// raw file to it (deduping within the folder). Returns the new raw name/path,
	// or null to keep the provisional name (no gateway, weak/empty suggestion, or
	// rename failure). Used for pasted images/text.
	private async renameFromContent(
		subfolderPath: string,
		rawName: string,
		rawFilePath: string,
		content: string,
		gateway: LlmGateway | null,
	): Promise<{ rawName: string; rawFilePath: string } | null> {
		const result = await suggestFilename(content, gateway, undefined, () => this.saveSettings());
		if (!result.ok) return null;
		const base = sanitizeFilename(result.value, '');
		if (!base) return null;

		const lastDot = rawName.lastIndexOf('.');
		const ext = lastDot > 0 ? rawName.slice(lastDot) : '';
		let candidate = `${base}${ext}`;
		let candidatePath = normalizePath(`${subfolderPath}/${candidate}`);
		let idx = 1;
		while (candidatePath !== rawFilePath && (await this.app.vault.adapter.exists(candidatePath))) {
			idx++;
			candidate = dedupeName(`${base}${ext}`, idx);
			candidatePath = normalizePath(`${subfolderPath}/${candidate}`);
		}
		if (candidatePath === rawFilePath) return null;

		try {
			await this.app.vault.adapter.rename(rawFilePath, candidatePath);
		} catch {
			return null;
		}
		return { rawName: candidate, rawFilePath: candidatePath };
	}

	private async processFileGroup(
		files: File[],
		groupBaseName: string,
		category: string,
		gatewayId: string | null,
		nameFromContent = false,
	): Promise<void> {
		const { vault } = this.app;
		const monthSlug = getMonthSlug();
		const subfolderPath = normalizePath(`${this.settings.incomingDir}/${monthSlug}/${category}`);

		await this.ensureDir(normalizePath(this.settings.incomingDir));
		await this.ensureDir(normalizePath(`${this.settings.incomingDir}/${monthSlug}`));
		await this.ensureDir(subfolderPath);

		// May be replaced once conversion gives us combined content to name from.
		let groupDirName = `${groupBaseName}.group`;
		let groupDirPath = normalizePath(`${subfolderPath}/${groupDirName}`);
		await this.ensureDir(groupDirPath);

		let noteName = noteNameFromFile(groupDirName);
		let notePath = normalizePath(`${subfolderPath}/${noteName}.md`);
		let dupIdx = 1;
		while (await vault.adapter.exists(notePath)) {
			dupIdx++;
			noteName = noteNameFromFile(dedupeName(groupDirName, dupIdx));
			notePath = normalizePath(`${subfolderPath}/${noteName}.md`);
		}

		const gateway = gatewayId
			? (this.settings.llmGateways.find((g) => g.id === gatewayId) ?? null)
			: null;

		const entry: DroppedFile = {
			filename: `${groupBaseName} (group, ${files.length} file${files.length !== 1 ? 's' : ''})`,
			filePath: groupDirPath,
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
			const basePath: string | undefined = (vault.adapter as any).basePath;
			const attachmentFrontmatterLines: string[] = [];
			const bodyParts: string[] = [];
			let anyError = false;

			entry.status = 'converting-markitdown';
			this.getActiveView()?.renderFileList();

			for (const file of files) {
				const buffer = await file.arrayBuffer();
				let rawName = file.name;
				let rawFilePath = normalizePath(`${groupDirPath}/${rawName}`);
				let fDupIdx = 1;
				while (await vault.adapter.exists(rawFilePath)) {
					fDupIdx++;
					rawName = dedupeName(file.name, fDupIdx);
					rawFilePath = normalizePath(`${groupDirPath}/${rawName}`);
				}
				await vault.adapter.writeBinary(rawFilePath, buffer);
				attachmentFrontmatterLines.push(
					`  - "[[${monthSlug}/${category}/${groupDirName}/${rawName}]]"`
				);

				const absolutePath = basePath ? pathJoin(basePath, rawFilePath) : rawFilePath;
				const onPhase = (phase: 'markitdown' | 'llm-image') => {
					entry.status = phase === 'llm-image' ? 'converting-llm-image' : 'converting-markitdown';
					this.getActiveView()?.renderFileList();
				};

				const isMsgFile =
					rawName.toLowerCase().endsWith('.msg') ||
					file.type === 'application/vnd.ms-outlook' ||
					file.type === 'application/x-msg';

				let markdown: string;
				try {
					if (isMsgFile) {
						const msgResult = await runMsgConversion(absolutePath, this.settings.pythonCommand, gateway, onPhase);
						const attParts: string[] = [msgResult.body];
						for (const att of msgResult.attachments) {
							if (!att.markdown) continue;
							const attPath = normalizePath(`${groupDirPath}/${att.filename}`);
							const attBuf = Buffer.from(att.dataB64, 'base64');
							const ab = attBuf.buffer.slice(attBuf.byteOffset, attBuf.byteOffset + attBuf.byteLength) as ArrayBuffer;
							await vault.adapter.writeBinary(attPath, ab);
							attachmentFrontmatterLines.push(
								`  - "[[${monthSlug}/${category}/${groupDirName}/${att.filename}]]"`
							);
							attParts.push(`---\n\n## Attachment: ${att.filename}\n\n${att.markdown}`);
							if (isErrorBody(att.markdown)) anyError = true;
						}
						markdown = attParts.join('\n\n');
					} else {
						markdown = await runMarkitdown(absolutePath, this.settings.pythonCommand, gateway, onPhase, this.settings.describeExtensions);
					}
					if (isErrorBody(markdown)) anyError = true;
				} catch (e) {
					markdown = `> [!error] Conversion failed\n> ${e instanceof Error ? e.message : String(e)}`;
					anyError = true;
				}

				bodyParts.push(`## ${rawName}\n\n${markdown}`);
			}

			entry.status = 'converting-llm-tags';
			this.getActiveView()?.renderFileList();

			const combinedBody = bodyParts.join('\n\n---\n\n');

			// Pasted groups get a content-derived name. Rename the provisional
			// `<base>.group` directory and recompute every path/link that embeds it
			// so updateFileList stays consistent. Silent fallback on any failure.
			if (nameFromContent && !anyError) {
				const result = await suggestFilename(combinedBody, gateway, undefined, () => this.saveSettings());
				const base = result.ok ? sanitizeFilename(result.value, '') : '';
				if (base) {
					let newDirName = `${base}.group`;
					let newDirPath = normalizePath(`${subfolderPath}/${newDirName}`);
					let newNotePath = normalizePath(`${subfolderPath}/${noteNameFromFile(newDirName)}.md`);
					let idx = 1;
					while (
						newDirPath !== groupDirPath &&
						((await vault.adapter.exists(newDirPath)) || (await vault.adapter.exists(newNotePath)))
					) {
						idx++;
						newDirName = `${dedupeName(base, idx)}.group`;
						newDirPath = normalizePath(`${subfolderPath}/${newDirName}`);
						newNotePath = normalizePath(`${subfolderPath}/${noteNameFromFile(newDirName)}.md`);
					}
					if (newDirPath !== groupDirPath) {
						try {
							await vault.adapter.rename(groupDirPath, newDirPath);
							const oldSegment = `/${groupDirName}/`;
							const newSegment = `/${newDirName}/`;
							for (let i = 0; i < attachmentFrontmatterLines.length; i++) {
								attachmentFrontmatterLines[i] = attachmentFrontmatterLines[i].replace(oldSegment, newSegment);
							}
							groupBaseName = base;
							groupDirName = newDirName;
							groupDirPath = newDirPath;
							noteName = noteNameFromFile(newDirName);
							notePath = newNotePath;
							entry.filename = `${base} (group, ${files.length} file${files.length !== 1 ? 's' : ''})`;
							entry.filePath = groupDirPath;
							entry.notePath = notePath;
							this.getActiveView()?.renderFileList();
						} catch {
							/* keep provisional name */
						}
					}
				}
			}

			const tagResult = await suggestTags(combinedBody, gateway, parsePreferredTags(this.settings.preferredTags), undefined, () => this.saveSettings());
			const mergedTags = Array.from(new Set([...this.settings.defaultTags, ...(tagResult.ok ? tagResult.value : [])]));

			const frontmatterLines = [
				'---',
				`original-file: "[[${monthSlug}/${category}/${groupDirName}]]"`,
				`group-name: ${JSON.stringify(groupBaseName)}`,
				'processed: false',
				'verified: false',
				`tags: ${JSON.stringify(mergedTags)}`,
				'attachments:',
				...attachmentFrontmatterLines,
				'---',
				'',
				combinedBody,
			];

			await vault.create(notePath, frontmatterLines.join('\n'));

			entry.tags = [...mergedTags];
			entry.status = anyError ? 'error' : 'converted';
			await this.saveSettings();
			this.getActiveView()?.renderFileList();
		} catch (e) {
			entry.status = 'error';
			await this.saveSettings();
			this.getActiveView()?.renderFileList();
			new Notice(`FileDrop: group conversion failed — ${e instanceof Error ? e.message : String(e)}`);
		}
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

	async processDroppedFile(
		file: File,
		category: string,
		gatewayId: string | null,
		opts?: { nameFromContent?: boolean },
	): Promise<void> {
		if (this.groupModeActive) {
			if (opts?.nameFromContent) this.groupNameFromContent = true;
			this.queueFileForGroup(file);
			return;
		}

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
		// Both may be replaced below once conversion gives us content to name from.
		let notePath = normalizePath(`${subfolderPath}/${noteNameFromFile(rawName)}.md`);

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

			if (this.cancelledConversions.delete(notePath)) return;

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
				markdownBody = await runMarkitdown(absolutePath, this.settings.pythonCommand, gateway, onPhase, this.settings.describeExtensions);
			}

			if (this.cancelledConversions.delete(notePath)) return;

			// Pasted images/text get a content-derived name now that conversion has
			// produced something to name them from. Renames the raw file and updates
			// the note path; falls back silently to the provisional `pasted-…` name
			// when no gateway is configured or the call fails.
			if (opts?.nameFromContent && !isMsgFile && !isErrorBody(markdownBody)) {
				const renamed = await this.renameFromContent(subfolderPath, rawName, rawFilePath, markdownBody, gateway);
				if (renamed) {
					rawName = renamed.rawName;
					rawFilePath = renamed.rawFilePath;
					notePath = normalizePath(`${subfolderPath}/${noteNameFromFile(rawName)}.md`);
					entry.filename = rawName;
					entry.filePath = rawFilePath;
					entry.notePath = notePath;
					this.getActiveView()?.renderFileList();
				}
			}

			entry.status = 'converting-llm-tags';
			this.getActiveView()?.renderFileList();

			const tagResult = await suggestTags(markdownBody, gateway, parsePreferredTags(this.settings.preferredTags), undefined, () => this.saveSettings());
			const mergedTags = Array.from(new Set([...this.settings.defaultTags, ...(tagResult.ok ? tagResult.value : [])]));

			if (this.cancelledConversions.delete(notePath)) return;

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
				newBody = await runMarkitdown(absolutePath, this.settings.pythonCommand, gateway, onPhase, this.settings.describeExtensions);
			}

			entry.status = 'converting-llm-tags';
			this.getActiveView()?.renderFileList();

			const noteFile = vault.getAbstractFileByPath(entry.notePath);
			if (!(noteFile instanceof TFile)) return;
			const content = await vault.read(noteFile);
			const closingIdx = content.indexOf('\n---\n');
			if (closingIdx < 0) return;

			const tagResult = await suggestTags(newBody, gateway, parsePreferredTags(this.settings.preferredTags), undefined, () => this.saveSettings());
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
			!f.path.includes('.attachments/') &&
			!f.path.includes('.group/')
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

		// Find untracked .group/ directories and create one note per group
		const groupDirs = new Map<string, { dir: string; files: TFile[]; minCtime: number }>();
		for (const file of vault.getFiles().filter((f) => f.path.includes('.group/'))) {
			const groupMatch = file.path.match(/^(.+\.group)(\/|$)/);
			if (!groupMatch) continue;
			const groupDirPath = groupMatch[1];
			if (trackedFilePaths.has(groupDirPath)) continue;

			if (!groupDirs.has(groupDirPath)) {
				groupDirs.set(groupDirPath, {
					dir: groupDirPath,
					files: [],
					minCtime: file.stat.ctime,
				});
			}
			const entry = groupDirs.get(groupDirPath)!;
			entry.files.push(file);
			entry.minCtime = Math.min(entry.minCtime, file.stat.ctime);
		}

		for (const { dir: groupDirPath, files: groupFiles, minCtime } of groupDirs.values()) {
			if (groupFiles.length === 0) continue;

			const groupDirName = groupDirPath.split('/').pop()!;
			const groupBaseName = groupDirName.replace(/\.group$/, '');
			const pathParts = groupDirPath.slice(incomingDir.length + 1).split('/');
			const monthSlug = pathParts[0] ?? '';
			const subfolderPath = groupDirPath.slice(0, groupDirPath.lastIndexOf('/'));
			const category = pathParts.length >= 2 ? pathParts[1] : 'default';

			let noteName = noteNameFromFile(groupDirName);
			let notePath = normalizePath(`${subfolderPath}/${noteName}.md`);
			let dupIdx = 1;
			while (await vault.adapter.exists(notePath)) {
				dupIdx++;
				noteName = noteNameFromFile(dedupeName(groupDirName, dupIdx));
				notePath = normalizePath(`${subfolderPath}/${noteName}.md`);
			}

			if (trackedNotePaths.has(notePath)) continue;

			if (!(await vault.adapter.exists(notePath))) {
				await vault.create(notePath, [
					'---',
					`original-file: "[[${monthSlug}/${category}/${groupDirName}]]"`,
					'processed: false',
					'verified: false',
					'tags: []',
					'---',
					'',
				].join('\n'));
			}

			this.recentFiles.push({
				filename: `${groupBaseName} (group, ${groupFiles.length} file${groupFiles.length !== 1 ? 's' : ''})`,
				filePath: groupDirPath,
				notePath,
				tags: [],
				category,
				droppedAt: minCtime,
				verified: false,
			});
			trackedNotePaths.add(notePath);
			trackedFilePaths.add(groupDirPath);
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
