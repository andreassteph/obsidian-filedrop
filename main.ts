import { Notice, Plugin, TFile, normalizePath } from 'obsidian';

import {
	DEFAULT_SETTINGS,
	DroppedFile,
	FileDropSettings,
	LlmGateway,
	MAX_RECENT_FILES,
	PluginData,
	VIEW_TYPE,
	hasErrorCallout,
	hasWarningCallout,
	isErrorBody,
	migrateLegacyLlmFields,
	parsePreferredTags,
	renderSlidesPlain,
	structurePptxSlides,
	suggestFilename,
	suggestTags,
} from './src/settings';
import { MsgAttachment, OnPhase, OnProgress, convertPptx, runMarkitdown, runMsgConversion } from './src/convert';
import { dedupeName, getMonthSlug, mapWithConcurrency, noteNameFromFile, replaceTagsBlock, rewriteImageLinks, sanitizeFilename } from './src/utils';
import { FileDropView } from './src/view';
import { FileDropSettingTab } from './src/settings-tab';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { join: pathJoin, dirname: pathDirname, basename: pathBasename } = require('path') as typeof import('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createHash } = require('crypto') as typeof import('crypto');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs') as typeof import('fs');

const sha256 = (buf: ArrayBuffer): string =>
	createHash('sha256').update(Buffer.from(buf)).digest('hex');

// Build a clickable file:// URL for a raw file that lives outside the vault.
// Backslashes are normalized to forward slashes so Windows paths work, and the
// path is prefixed with a leading slash to yield the file:///<path> form.
const externalFileUrl = (absPath: string): string => {
	const normalized = absPath.replace(/\\/g, '/');
	const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
	return `file://${encodeURI(withSlash)}`;
};

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
		this.addCommand({
			id: 'filedrop-scan-external',
			name: 'Scan external folder',
			callback: () => this.scanExternalFolder(this.getActiveView()?.selectedGatewayId ?? null),
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

	// Read an extracted .msg attachment out of its temp file and write it into
	// the vault at destPath. The Python helper writes attachment bytes to temp
	// files (not base64 on stdout) to avoid inflation; we stream them in here.
	// Read bytes a Python helper wrote to a temp file and write them into the
	// vault at destPath. Shared by .msg attachments and extracted PPTX pictures.
	private async writeBinaryFromTemp(tempPath: string, destPath: string): Promise<void> {
		const data = await fs.promises.readFile(tempPath);
		const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
		await this.app.vault.adapter.writeBinary(destPath, ab);
	}

	private async writeMsgAttachment(att: MsgAttachment, destPath: string): Promise<void> {
		await this.writeBinaryFromTemp(att.tempPath, destPath);
	}

	// Convert a .pptx into structured Markdown: extract its embedded images into
	// `picturesDirVaultPath` (copied from the Python helper's temp dir), reflow
	// the slides via the LLM (falling back to a deterministic geometry render),
	// and point the image links at `picturesDirName`. `filenamePrefix`
	// disambiguates pictures when several decks share one note (group mode).
	// Falls back to markitdown when structured extraction is unavailable.
	private async convertPptxNote(
		absolutePath: string,
		gateway: LlmGateway | null,
		onPhase: OnPhase | undefined,
		onProgress: OnProgress | undefined,
		picturesDirVaultPath: string,
		picturesDirName: string,
		filenamePrefix = '',
	): Promise<string> {
		const result = await convertPptx(absolutePath, this.settings.pythonCommand, gateway, onPhase, onProgress);
		if (!result) {
			return runMarkitdown(absolutePath, this.settings.pythonCommand, gateway, onPhase, this.settings.describeExtensions, onProgress);
		}

		// Apply the per-source prefix to the picture references so the slide data,
		// the copied files, and the rewritten links all agree.
		if (filenamePrefix) {
			for (const slide of result.slides) {
				for (const el of slide.elements) {
					if (el.type === 'picture') el.filename = `${filenamePrefix}${el.filename}`;
				}
			}
		}

		const writtenNames = new Set<string>();
		if (result.pictures.length > 0) {
			await this.ensureDir(picturesDirVaultPath);
			for (const pic of result.pictures) {
				const destName = `${filenamePrefix}${pic.filename}`;
				await this.writeBinaryFromTemp(pic.tempPath, normalizePath(`${picturesDirVaultPath}/${destName}`));
				writtenNames.add(destName);
			}
			await this.cleanupMsgTempFiles(result.pictures);
		}

		const structured = await structurePptxSlides(result.slides, gateway, () => this.saveSettings());
		const body = structured.ok ? structured.value : renderSlidesPlain(result.slides);
		const linked = rewriteImageLinks(body, picturesDirName, writtenNames);

		// Guard against a model that ignored "echo the ref verbatim": append any
		// extracted image the body never referenced so none is silently orphaned.
		const missing = [...writtenNames].filter(
			(name) => !linked.includes(encodeURI(`${picturesDirName}/${name}`)),
		);
		if (missing.length === 0) return linked;
		const appended = missing.map((name) => `![](${encodeURI(`${picturesDirName}/${name}`)})`).join('\n\n');
		return `${linked}\n\n## Unplaced images\n\n${appended}`;
	}

	// Remove the temp directory holding a .msg's extracted attachments (or a
	// .pptx's extracted pictures). All items share a single mkdtemp dir, so
	// deleting each distinct parent once cleans everything up (best-effort;
	// never throws).
	private async cleanupMsgTempFiles(attachments: Array<{ tempPath?: string }>): Promise<void> {
		const dirs = new Set<string>();
		for (const att of attachments) {
			if (att.tempPath) dirs.add(pathDirname(att.tempPath));
		}
		for (const dir of dirs) {
			try {
				await fs.promises.rm(dir, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		}
	}

	// Warn (non-blocking) when a dropped file is large enough that conversion may
	// be slow. Purely informational — conversion proceeds either way.
	private warnIfLargeFile(name: string, byteLength: number): void {
		const limit = this.settings.largeFileWarnMb;
		if (!limit || limit <= 0) return;
		const mb = byteLength / (1024 * 1024);
		if (mb >= limit) {
			new Notice(`FileDrop: large file ${name} (${mb.toFixed(1)} MB) — conversion may be slow.`);
		}
	}

	// Convert each member file of a group directory individually into a
	// `## <name>` section. Never hand the group directory itself to markitdown:
	// puremagic raises PureError("Not a regular file") on a directory, which
	// markitdown does not catch, aborting the whole conversion. Shared by the
	// initial group drop and by re-running conversion on a group entry.
	private async convertGroupDir(
		groupDirPath: string,
		groupDirName: string,
		monthSlug: string,
		category: string,
		members: { rawName: string; rawFilePath: string }[],
		gateway: LlmGateway | null,
		onPhase: (phase: 'markitdown' | 'llm-image') => void,
		picturesDirVaultPath: string,
		picturesDirName: string,
		isExternal = false,
		onProgress?: OnProgress,
	): Promise<{ bodyParts: string[]; attachmentFrontmatterLines: string[]; anyError: boolean; anyWarning: boolean }> {
		const { vault } = this.app;
		const basePath: string | undefined = (vault.adapter as any).basePath;

		// Convert members concurrently (bounded by groupConcurrency) but assemble
		// every output strictly in member order afterwards. Each worker returns an
		// index-stable result; we never append on completion, so ordering is
		// identical regardless of which file finishes first. With concurrency = 1
		// this is exactly the old sequential loop.
		type MemberResult = {
			body: string;
			attachmentFrontmatterLines: string[];
			anyError: boolean;
			anyWarning: boolean;
		};

		const results = await mapWithConcurrency<typeof members[number], MemberResult>(
			members,
			this.settings.groupConcurrency,
			async ({ rawName, rawFilePath }) => {
				// External members carry an absolute path already; vault members are
				// vault-relative and must be resolved against the vault base path.
				const absolutePath = isExternal ? rawFilePath : (basePath ? pathJoin(basePath, rawFilePath) : rawFilePath);
				const isMsgFile = rawName.toLowerCase().endsWith('.msg');
				const attLines: string[] = [];
				let err = false;
				let warn = false;

				let markdown: string;
				try {
					if (isMsgFile) {
						const msgResult = await runMsgConversion(absolutePath, this.settings.pythonCommand, gateway, onPhase, onProgress);
						// Keep each .msg's attachments in their own `<file.msg>.attachments/`
						// subfolder rather than flat in the group dir. Because
						// vault.adapter.list() is non-recursive, this keeps them out of
						// the member listing on rerun (no duplicate sections) and avoids
						// filename collisions between attachments of different emails.
						// For external groups there is no vault group dir, so attachment
						// markdown is inlined without writing files or wikilinks.
						const attDirName = `${rawName}.attachments`;
						if (!isExternal && msgResult.attachments.length > 0) {
							await this.ensureDir(normalizePath(`${groupDirPath}/${attDirName}`));
						}
						const attParts: string[] = [msgResult.body];
						for (const att of msgResult.attachments) {
							if (!att.markdown) continue;
							if (isExternal) {
								attParts.push(`---\n\n## Attachment: ${att.filename}\n\n${att.markdown}`);
							} else {
								const attPath = normalizePath(`${groupDirPath}/${attDirName}/${att.filename}`);
								await this.writeMsgAttachment(att, attPath);
								attLines.push(
									`  - "[[${monthSlug}/${category}/${groupDirName}/${attDirName}/${att.filename}]]"`
								);
								const attLink = `[[${monthSlug}/${category}/${groupDirName}/${attDirName}/${att.filename}|${att.filename}]]`;
								attParts.push(`---\n\n## Attachment: ${attLink}\n\n${att.markdown}`);
							}
							if (hasErrorCallout(att.markdown)) err = true;
							else if (hasWarningCallout(att.markdown)) warn = true;
						}
						// The Python side writes attachment bytes to temp files for both
						// vault and external groups, so clean them up either way.
						await this.cleanupMsgTempFiles(msgResult.attachments);
						markdown = attParts.join('\n\n');
					} else if (rawName.toLowerCase().endsWith('.pptx')) {
						// Several decks can share one group note, so prefix each deck's
						// pictures (file names + body refs) to avoid Picture19.jpg clashes.
						const prefix = `${rawName.replace(/\W/g, '')}__`;
						markdown = await this.convertPptxNote(
							absolutePath, gateway, onPhase, onProgress,
							picturesDirVaultPath, picturesDirName, prefix,
						);
					} else {
						markdown = await runMarkitdown(absolutePath, this.settings.pythonCommand, gateway, onPhase, this.settings.describeExtensions, onProgress);
					}
					if (hasErrorCallout(markdown)) err = true;
					else if (hasWarningCallout(markdown)) warn = true;
				} catch (e) {
					markdown = `> [!error] Conversion failed\n> ${e instanceof Error ? e.message : String(e)}`;
					err = true;
				}

				return {
					body: `## ${rawName}\n\n${markdown}`,
					attachmentFrontmatterLines: attLines,
					anyError: err,
					anyWarning: warn,
				};
			},
		);

		const bodyParts = results.map((r) => r.body);
		const attachmentFrontmatterLines = results.flatMap((r) => r.attachmentFrontmatterLines);
		const anyError = results.some((r) => r.anyError);
		const anyWarning = results.some((r) => r.anyWarning);

		return { bodyParts, attachmentFrontmatterLines, anyError, anyWarning };
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
			const attachmentFrontmatterLines: string[] = [];

			entry.status = 'converting-markitdown';
			this.getActiveView()?.renderFileList();

			const onPhase = (phase: 'markitdown' | 'llm-image') => {
				entry.status = phase === 'llm-image' ? 'converting-llm-image' : 'converting-markitdown';
				this.getActiveView()?.renderFileList();
			};
			const onProgress: OnProgress = (current, total) => {
				entry.pageProgress = { current, total };
				this.getActiveView()?.renderFileList();
			};

			// Write every dropped file into the group dir first, then convert each
			// individually via convertGroupDir (never the directory itself).
			const members: { rawName: string; rawFilePath: string }[] = [];
			for (const file of files) {
				const buffer = await file.arrayBuffer();
				this.warnIfLargeFile(file.name, buffer.byteLength);
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
				members.push({ rawName, rawFilePath });
			}

			const groupPicturesDirName = `${noteName}_pictures`;
			const converted = await this.convertGroupDir(
				groupDirPath, groupDirName, monthSlug, category, members, gateway, onPhase,
				normalizePath(`${subfolderPath}/${groupPicturesDirName}`), groupPicturesDirName, false, onProgress,
			);
			attachmentFrontmatterLines.push(...converted.attachmentFrontmatterLines);
			const bodyParts = converted.bodyParts;
			const anyError = converted.anyError;
			const anyWarning = converted.anyWarning;

			entry.pageProgress = undefined;
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
			entry.status = anyError ? 'error' : anyWarning ? 'warning' : 'converted';
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
		this.warnIfLargeFile(file.name, buffer.byteLength);
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
			const onProgress: OnProgress = (current, total) => {
				entry.pageProgress = { current, total };
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
			const isPptxFile = file.name.toLowerCase().endsWith('.pptx');
			let markdownBody: string;
			const attachmentFrontmatterLines: string[] = [];
			let attachmentHadError = false;
			let attachmentHadWarning = false;

			if (isMsgFile) {
				const msgResult = await runMsgConversion(absolutePath, this.settings.pythonCommand, gateway, onPhase, onProgress);

				const attDirName = `${rawName}.attachments`;
				if (msgResult.attachments.length > 0) {
					const attDirPath = normalizePath(`${subfolderPath}/${attDirName}`);
					await this.ensureDir(attDirPath);

					for (const att of msgResult.attachments) {
						const attFilePath = normalizePath(`${attDirPath}/${att.filename}`);
						await this.writeMsgAttachment(att, attFilePath);
						attachmentFrontmatterLines.push(`  - "[[${monthSlug}/${category}/${attDirName}/${att.filename}]]"`);
					}
				}

				const bodyParts: string[] = [msgResult.body];
				for (const att of msgResult.attachments) {
					if (!att.markdown) continue;
					const attLink = `[[${monthSlug}/${category}/${attDirName}/${att.filename}|${att.filename}]]`;
					bodyParts.push(`---\n\n## Attachment: ${attLink}\n\n${att.markdown}`);
					if (hasErrorCallout(att.markdown)) attachmentHadError = true;
					else if (hasWarningCallout(att.markdown)) attachmentHadWarning = true;
				}
				await this.cleanupMsgTempFiles(msgResult.attachments);
				markdownBody = bodyParts.join('\n\n');
			} else if (isPptxFile) {
				const picturesDirName = `${noteNameFromFile(rawName)}_pictures`;
				markdownBody = await this.convertPptxNote(
					absolutePath, gateway, onPhase, onProgress,
					normalizePath(`${subfolderPath}/${picturesDirName}`), picturesDirName,
				);
			} else {
				markdownBody = await runMarkitdown(absolutePath, this.settings.pythonCommand, gateway, onPhase, this.settings.describeExtensions, onProgress);
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

			entry.pageProgress = undefined;
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
			entry.status = (hasErrorCallout(markdownBody) || attachmentHadError) ? 'error'
				: (hasWarningCallout(markdownBody) || attachmentHadWarning) ? 'warning'
				: 'converted';
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

		// External entries live outside the vault and cannot be read through the
		// vault adapter — re-import them via the external pipeline instead.
		if (entry.external && entry.sourcePath) {
			const gateway = gatewayId
				? (this.settings.llmGateways.find((g) => g.id === gatewayId) ?? null)
				: null;
			// A manual re-run must convert regardless of whether the source
			// changed, so drop the stored signature to bypass the skip check.
			entry.sourceSignature = undefined;
			try {
				const stat = await fs.promises.stat(entry.sourcePath);
				if (stat.isDirectory()) {
					await this.importExternalGroup(entry.sourcePath, gateway);
				} else {
					await this.importExternalFile(entry.sourcePath, gateway);
				}
			} catch (e) {
				entry.status = 'error';
				new Notice(`FileDrop: re-conversion failed — ${e instanceof Error ? e.message : String(e)}`);
			}
			await this.saveSettings();
			this.getActiveView()?.renderFileList();
			return;
		}

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
			const onProgress: OnProgress = (current, total) => {
				entry.pageProgress = { current, total };
				this.getActiveView()?.renderFileList();
			};

			// Group entries store the `.group` directory as filePath. Converting
			// the directory would hand it to puremagic and fail with
			// "Not a regular file" — instead convert each member file individually.
			const dirStat = await vault.adapter.stat(entry.filePath);
			const isGroup = entry.filePath.endsWith('.group') && dirStat?.type === 'folder';

			const isMsgFile = !isGroup && entry.filename.toLowerCase().endsWith('.msg');
			const isPptxFile = !isGroup && entry.filename.toLowerCase().endsWith('.pptx');
			let newBody: string;
			let attachmentHadError = false;
			let attachmentHadWarning = false;

			if (isGroup) {
				// filePath is `<incomingDir>/<month>/<category>/<groupDirName>`.
				const parts = entry.filePath.split('/');
				const groupDirName = parts[parts.length - 1];
				const category = parts[parts.length - 2] ?? '';
				const monthSlug = parts[parts.length - 3] ?? '';
				const listing = await vault.adapter.list(entry.filePath);
				const members = listing.files
					.filter((p) => !p.toLowerCase().endsWith('.md'))
					.map((p) => ({ rawName: p.split('/').pop() as string, rawFilePath: p }));
				const groupNoteDir = pathDirname(entry.notePath);
				const groupPicturesDirName = `${pathBasename(entry.notePath).replace(/\.md$/i, '')}_pictures`;
				const converted = await this.convertGroupDir(
					entry.filePath, groupDirName, monthSlug, category, members, gateway, onPhase,
					normalizePath(`${groupNoteDir}/${groupPicturesDirName}`), groupPicturesDirName, false, onProgress,
				);
				newBody = converted.bodyParts.join('\n\n---\n\n');
				attachmentHadError = converted.anyError;
				attachmentHadWarning = converted.anyWarning;
			} else if (isMsgFile) {
				const msgResult = await runMsgConversion(absolutePath, this.settings.pythonCommand, gateway, onPhase, onProgress);
				// Match the initial-drop layout: attachments live next to the .msg
				// in `<file.msg>.attachments/` (full name, extension included). The
				// note's frontmatter `attachments:` list already points there.
				const attDirName = `${entry.filename}.attachments`;
				const incomingPrefix = normalizePath(this.settings.incomingDir) + '/';
				const rel = entry.filePath.startsWith(incomingPrefix)
					? entry.filePath.slice(incomingPrefix.length)
					: entry.filePath;
				const rerunMonthSlug = rel.split('/')[0] ?? '';
				const rerunCategory = entry.category;

				// Re-write the extracted attachment binaries next to the .msg so a
				// rerun is self-healing (the dir may have been deleted). The on-disk
				// dir is the real sibling of the .msg; the wikilink omits the
				// incoming prefix, mirroring the initial drop.
				if (msgResult.attachments.length > 0) {
					const attDirPath = normalizePath(`${entry.filePath.split('/').slice(0, -1).join('/')}/${attDirName}`);
					await this.ensureDir(attDirPath);
					for (const att of msgResult.attachments) {
						const attFilePath = normalizePath(`${attDirPath}/${att.filename}`);
						await this.writeMsgAttachment(att, attFilePath);
					}
				}

				const bodyParts: string[] = [msgResult.body];
				for (const att of msgResult.attachments) {
					if (!att.markdown) continue;
					const attLink = `[[${rerunMonthSlug}/${rerunCategory}/${attDirName}/${att.filename}|${att.filename}]]`;
					bodyParts.push(`---\n\n## Attachment: ${attLink}\n\n${att.markdown}`);
					if (hasErrorCallout(att.markdown)) attachmentHadError = true;
					else if (hasWarningCallout(att.markdown)) attachmentHadWarning = true;
				}
				await this.cleanupMsgTempFiles(msgResult.attachments);
				newBody = bodyParts.join('\n\n');
			} else if (isPptxFile) {
				// Dir alongside the note (self-healing — re-extracts into it).
				const noteDir = pathDirname(entry.notePath);
				const picturesDirName = `${pathBasename(entry.notePath).replace(/\.md$/i, '')}_pictures`;
				newBody = await this.convertPptxNote(
					absolutePath, gateway, onPhase, onProgress,
					normalizePath(`${noteDir}/${picturesDirName}`), picturesDirName,
				);
			} else {
				newBody = await runMarkitdown(absolutePath, this.settings.pythonCommand, gateway, onPhase, this.settings.describeExtensions, onProgress);
			}

			entry.pageProgress = undefined;
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
			entry.status = (hasErrorCallout(newBody) || attachmentHadError) ? 'error'
				: (hasWarningCallout(newBody) || attachmentHadWarning) ? 'warning'
				: 'converted';
			await this.saveSettings();
			this.getActiveView()?.renderFileList();
		} catch (e) {
			entry.status = 'error';
			await this.saveSettings();
			this.getActiveView()?.renderFileList();
			new Notice(`FileDrop: re-conversion failed — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ---- External linked folder --------------------------------------------

	// Scan the configured external folder. Top-level files become linked notes
	// (`incoming/<name>_<ext>.md`); top-level subfolders become group notes.
	// Raw files are never copied into the vault — only referenced.
	async scanExternalFolder(gatewayId: string | null = null): Promise<void> {
		const external = this.settings.externalFolder.trim();
		if (!external) {
			new Notice('FileDrop: no external folder configured.');
			return;
		}

		let topEntries: import('fs').Dirent[];
		try {
			topEntries = await fs.promises.readdir(external, { withFileTypes: true });
		} catch (e) {
			new Notice(`FileDrop: cannot read external folder — ${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		await this.ensureDir(normalizePath(this.settings.incomingDir));

		const gateway = gatewayId
			? (this.settings.llmGateways.find((g) => g.id === gatewayId) ?? null)
			: null;

		let added = 0;
		let updated = 0;
		let skipped = 0;
		for (const dirent of topEntries) {
			const absPath = pathJoin(external, dirent.name);
			try {
				const result = dirent.isDirectory()
					? await this.importExternalGroup(absPath, gateway)
					: dirent.isFile()
						? await this.importExternalFile(absPath, gateway)
						: 'skipped';
				if (result === 'added') added++;
				else if (result === 'updated') updated++;
				else skipped++;
			} catch (e) {
				skipped++;
				new Notice(`FileDrop: failed importing "${dirent.name}" — ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		this.recentFiles.sort((a, b) => b.droppedAt - a.droppedAt);
		await this.saveSettings();
		this.getActiveView()?.renderFileList();
		new Notice(`FileDrop: external scan — ${added} added, ${updated} updated, ${skipped} unchanged/skipped.`);
	}

	// size+mtime fingerprint of one or more source paths, used to detect whether
	// an external file/folder changed since its note was last generated.
	private async computeSignature(absPaths: string[]): Promise<string> {
		const parts: string[] = [];
		for (const p of absPaths) {
			const st = await fs.promises.stat(p);
			parts.push(`${p}|${st.size}|${st.mtimeMs}`);
		}
		return createHash('sha256').update(parts.join('\n')).digest('hex');
	}

	// Depth-first list of files under `dir` (recursive). Short-circuits as soon
	// as more than `limit` files are seen so huge trees are not fully walked;
	// `overLimit` then signals the caller to skip the folder entirely. Member
	// names are paths relative to `dir` so nested files stay distinguishable.
	private async listGroupMembersRecursive(
		dir: string,
		limit: number,
	): Promise<{ members: { rawName: string; rawFilePath: string }[]; overLimit: boolean }> {
		const members: { rawName: string; rawFilePath: string }[] = [];
		let overLimit = false;
		const walk = async (current: string): Promise<void> => {
			if (overLimit) return;
			const entries = await fs.promises.readdir(current, { withFileTypes: true });
			for (const e of entries) {
				if (overLimit) return;
				const full = pathJoin(current, e.name);
				if (e.isDirectory()) {
					await walk(full);
				} else if (e.isFile()) {
					if (members.length >= limit) { overLimit = true; return; }
					const rawName = full.slice(dir.length + 1).replace(/\\/g, '/');
					members.push({ rawName, rawFilePath: full });
				}
			}
		};
		await walk(dir);
		return { members, overLimit };
	}

	// Build frontmatter for an external note. The raw file lives outside the
	// vault, so `original-file` is a clickable file:// link rather than a vault
	// wikilink, and `external`/`source-path` mark the entry for re-scans.
	private buildExternalFrontmatter(displayName: string, absPath: string, tags: string[]): string {
		return [
			'---',
			`original-file: "[${displayName}](${externalFileUrl(absPath)})"`,
			'external: true',
			`source-path: "${absPath.replace(/\\/g, '/')}"`,
			'processed: false',
			'verified: false',
			`tags: ${JSON.stringify(tags)}`,
			'---',
		].join('\n');
	}

	// Write/refresh an external note's content while preserving any existing
	// frontmatter (so verified/processed survive a re-scan); only the tags block
	// and body are replaced. Returns whether the note already existed.
	private async writeExternalNote(
		notePath: string,
		displayName: string,
		sourcePath: string,
		tags: string[],
		body: string,
	): Promise<boolean> {
		const { vault } = this.app;
		const existing = vault.getAbstractFileByPath(notePath);
		if (existing instanceof TFile) {
			const content = await vault.read(existing);
			const closingIdx = content.indexOf('\n---\n');
			const frontmatter = closingIdx >= 0
				? replaceTagsBlock(content.slice(0, closingIdx + 5), tags)
				: this.buildExternalFrontmatter(displayName, sourcePath, tags);
			await vault.modify(existing, frontmatter + '\n' + body);
			return true;
		}
		await vault.create(notePath, this.buildExternalFrontmatter(displayName, sourcePath, tags) + '\n' + body);
		return false;
	}

	// Import a single top-level external file. Skips when the note exists and the
	// source is unchanged. Returns 'added' | 'updated' | 'unchanged'.
	private async importExternalFile(
		absPath: string,
		gateway: LlmGateway | null,
	): Promise<'added' | 'updated' | 'unchanged'> {
		const baseName = pathBasename(absPath);
		const notePath = normalizePath(`${this.settings.incomingDir}/${noteNameFromFile(baseName)}.md`);
		const signature = await this.computeSignature([absPath]);

		const existing = this.recentFiles.find((e) => e.external && e.sourcePath === absPath);
		const noteExists = await this.app.vault.adapter.exists(notePath);
		if (noteExists && existing && existing.sourceSignature === signature) return 'unchanged';

		const entry: DroppedFile = existing ?? {
			filename: baseName,
			filePath: absPath,
			notePath,
			tags: [],
			category: 'external',
			droppedAt: Date.now(),
			verified: false,
			external: true,
			sourcePath: absPath,
		};
		if (!existing) {
			this.recentFiles.unshift(entry);
			if (this.recentFiles.length > MAX_RECENT_FILES) this.recentFiles.length = MAX_RECENT_FILES;
		}
		entry.notePath = notePath;
		entry.status = 'converting-markitdown';
		this.getActiveView()?.renderFileList();

		const onPhase = (phase: 'markitdown' | 'llm-image') => {
			entry.status = phase === 'llm-image' ? 'converting-llm-image' : 'converting-markitdown';
			this.getActiveView()?.renderFileList();
		};
		const onProgress: OnProgress = (current, total) => {
			entry.pageProgress = { current, total };
			this.getActiveView()?.renderFileList();
		};

		try {
			const isMsgFile = baseName.toLowerCase().endsWith('.msg');
			const isPptxFile = baseName.toLowerCase().endsWith('.pptx');
			let body: string;
			let attachmentHadError = false;
			let attachmentHadWarning = false;

			if (isMsgFile) {
				const msgResult = await runMsgConversion(absPath, this.settings.pythonCommand, gateway, onPhase, onProgress);
				const parts: string[] = [msgResult.body];
				for (const att of msgResult.attachments) {
					if (!att.markdown) continue;
					parts.push(`---\n\n## Attachment: ${att.filename}\n\n${att.markdown}`);
					if (hasErrorCallout(att.markdown)) attachmentHadError = true;
					else if (hasWarningCallout(att.markdown)) attachmentHadWarning = true;
				}
				body = parts.join('\n\n');
			} else if (isPptxFile) {
				const noteDir = pathDirname(notePath);
				const picturesDirName = `${pathBasename(notePath).replace(/\.md$/i, '')}_pictures`;
				body = await this.convertPptxNote(
					absPath, gateway, onPhase, onProgress,
					normalizePath(`${noteDir}/${picturesDirName}`), picturesDirName,
				);
			} else {
				body = await runMarkitdown(absPath, this.settings.pythonCommand, gateway, onPhase, this.settings.describeExtensions, onProgress);
			}

			entry.pageProgress = undefined;
			entry.status = 'converting-llm-tags';
			this.getActiveView()?.renderFileList();

			const tagResult = await suggestTags(body, gateway, parsePreferredTags(this.settings.preferredTags), undefined, () => this.saveSettings());
			const mergedTags = Array.from(new Set([...this.settings.defaultTags, ...(tagResult.ok ? tagResult.value : [])]));

			const noteExisted = await this.writeExternalNote(notePath, baseName, absPath, mergedTags, body);

			entry.tags = [...mergedTags];
			entry.sourceSignature = signature;
			entry.status = (hasErrorCallout(body) || attachmentHadError) ? 'error'
				: (hasWarningCallout(body) || attachmentHadWarning) ? 'warning'
				: 'converted';
			this.getActiveView()?.renderFileList();
			return noteExisted ? 'updated' : 'added';
		} catch (e) {
			entry.status = 'error';
			this.getActiveView()?.renderFileList();
			new Notice(`FileDrop: conversion failed — ${e instanceof Error ? e.message : String(e)}`);
			return existing ? 'updated' : 'added';
		}
	}

	// Import a top-level external subfolder as a single group note. Folders with
	// more than the configured limit are skipped with a warning. Skips when the
	// note exists and the source is unchanged.
	private async importExternalGroup(
		absDir: string,
		gateway: LlmGateway | null,
	): Promise<'added' | 'updated' | 'unchanged' | 'skipped'> {
		const baseName = pathBasename(absDir);
		const limit = this.settings.externalGroupFileLimit;
		const { members, overLimit } = await this.listGroupMembersRecursive(absDir, limit);
		if (overLimit) {
			new Notice(`FileDrop: skipped "${baseName}" — exceeds ${limit} files.`);
			return 'skipped';
		}
		if (members.length === 0) return 'skipped';

		const notePath = normalizePath(`${this.settings.incomingDir}/${noteNameFromFile(baseName)}.md`);
		const signature = await this.computeSignature(members.map((m) => m.rawFilePath));

		const existing = this.recentFiles.find((e) => e.external && e.sourcePath === absDir);
		const noteExists = await this.app.vault.adapter.exists(notePath);
		if (noteExists && existing && existing.sourceSignature === signature) return 'unchanged';

		const friendlyName = `${baseName} (group, ${members.length} file${members.length !== 1 ? 's' : ''})`;
		const entry: DroppedFile = existing ?? {
			filename: friendlyName,
			filePath: absDir,
			notePath,
			tags: [],
			category: 'external',
			droppedAt: Date.now(),
			verified: false,
			external: true,
			sourcePath: absDir,
		};
		entry.filename = friendlyName;
		entry.notePath = notePath;
		if (!existing) {
			this.recentFiles.unshift(entry);
			if (this.recentFiles.length > MAX_RECENT_FILES) this.recentFiles.length = MAX_RECENT_FILES;
		}
		entry.status = 'converting-markitdown';
		this.getActiveView()?.renderFileList();

		const onPhase = (phase: 'markitdown' | 'llm-image') => {
			entry.status = phase === 'llm-image' ? 'converting-llm-image' : 'converting-markitdown';
			this.getActiveView()?.renderFileList();
		};
		const onProgress: OnProgress = (current, total) => {
			entry.pageProgress = { current, total };
			this.getActiveView()?.renderFileList();
		};

		try {
			const groupPicturesDirName = `${noteNameFromFile(baseName)}_pictures`;
			const converted = await this.convertGroupDir(
				absDir, baseName, '', 'external', members, gateway, onPhase,
				normalizePath(`${this.settings.incomingDir}/${groupPicturesDirName}`), groupPicturesDirName, true, onProgress,
			);
			const combinedBody = converted.bodyParts.join('\n\n---\n\n');

			entry.pageProgress = undefined;
			entry.status = 'converting-llm-tags';
			this.getActiveView()?.renderFileList();

			const tagResult = await suggestTags(combinedBody, gateway, parsePreferredTags(this.settings.preferredTags), undefined, () => this.saveSettings());
			const mergedTags = Array.from(new Set([...this.settings.defaultTags, ...(tagResult.ok ? tagResult.value : [])]));

			const noteExisted = await this.writeExternalNote(notePath, baseName, absDir, mergedTags, combinedBody);

			entry.tags = [...mergedTags];
			entry.sourceSignature = signature;
			entry.status = (hasErrorCallout(combinedBody) || converted.anyError) ? 'error'
				: (hasWarningCallout(combinedBody) || converted.anyWarning) ? 'warning'
				: 'converted';
			this.getActiveView()?.renderFileList();
			return noteExisted ? 'updated' : 'added';
		} catch (e) {
			entry.status = 'error';
			this.getActiveView()?.renderFileList();
			new Notice(`FileDrop: conversion failed — ${e instanceof Error ? e.message : String(e)}`);
			return existing ? 'updated' : 'added';
		}
	}

	/**
	 * Parse all wikilink targets (`[[target|alias]]` / `[[target#heading]]`) out
	 * of a frontmatter value that may be a single string or a list of strings.
	 */
	private parseWikilinkTargets(value: unknown): string[] {
		const targets: string[] = [];
		const collect = (s: string): void => {
			const re = /\[\[(.+?)\]\]/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(s)) !== null) {
				const target = m[1].split('|')[0].split('#')[0].trim();
				if (target) targets.push(target);
			}
		};
		if (typeof value === 'string') collect(value);
		else if (Array.isArray(value)) {
			for (const item of value) if (typeof item === 'string') collect(item);
		}
		return targets;
	}

	/**
	 * Index filedrop notes by the raw source files they own.
	 *
	 * A note's filename is not a stable identity — users rename notes freely.
	 * The `original-file` and `attachments` frontmatter links point at the raw
	 * source files, which stay put across note renames, so we key off those
	 * instead. This lets us re-locate a tracked note after it has been renamed
	 * and recognise raw files / attachments that a note already claims (so they
	 * are not mistaken for new drops).
	 */
	private buildIncomingNoteIndex(incomingDir: string): {
		noteByFilePath: Map<string, TFile>;
		claimedPaths: Set<string>;
	} {
		const { vault, metadataCache } = this.app;
		const noteByFilePath = new Map<string, TFile>();
		const claimedPaths = new Set<string>();

		const mdFiles = vault.getMarkdownFiles().filter((f) =>
			f.path.startsWith(incomingDir + '/')
		);
		for (const file of mdFiles) {
			const fm = metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;

			const originalTargets = this.parseWikilinkTargets(fm['original-file']);
			if (originalTargets.length > 0) {
				const filePath = normalizePath(`${incomingDir}/${originalTargets[0]}`);
				// First note wins so an existing tracked note is not shadowed.
				if (!noteByFilePath.has(filePath)) noteByFilePath.set(filePath, file);
				claimedPaths.add(filePath);
			}
			for (const att of this.parseWikilinkTargets(fm.attachments)) {
				claimedPaths.add(normalizePath(`${incomingDir}/${att}`));
			}
		}

		return { noteByFilePath, claimedPaths };
	}

	/** Count raw member files under each `.group` directory in the incoming folder. */
	private groupMemberCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const f of this.app.vault.getFiles()) {
			const m = f.path.match(/^(.+\.group)(\/|$)/);
			if (!m) continue;
			counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
		}
		return counts;
	}

	/**
	 * Display name for a rediscovered note. Group notes (whose owned path is a
	 * `.group` directory) get the friendly "name (group, N files)" label so they
	 * match how freshly-dropped groups are listed; everything else uses the
	 * source file's name.
	 */
	private displayFilenameFor(filePath: string, fallback: string, groupCounts: Map<string, number>): string {
		if (filePath.endsWith('.group')) {
			const base = (filePath.split('/').pop() ?? '').replace(/\.group$/, '');
			const n = groupCounts.get(filePath) ?? 0;
			return `${base} (group, ${n} file${n !== 1 ? 's' : ''})`;
		}
		return filePath.split('/').pop() ?? fallback;
	}

	async syncIncomingFolder(): Promise<void> {
		const { vault, metadataCache } = this.app;
		const incomingDir = normalizePath(this.settings.incomingDir);
		if (!(await vault.adapter.exists(incomingDir))) return;

		const { noteByFilePath } = this.buildIncomingNoteIndex(incomingDir);
		const trackedFilePaths = new Set(this.recentFiles.map((e) => e.filePath));
		const groupCounts = this.groupMemberCounts();
		let changed = false;

		// Re-locate tracked entries whose note was renamed since last seen.
		for (const entry of this.recentFiles) {
			const note = noteByFilePath.get(entry.filePath);
			if (note && note.path !== entry.notePath) {
				entry.notePath = note.path;
				changed = true;
			}
		}

		// Pick up untracked unverified notes, keyed by the raw file they own so
		// a renamed note is not re-added as a duplicate.
		for (const [filePath, file] of noteByFilePath) {
			if (trackedFilePaths.has(filePath)) continue;
			const fm = metadataCache.getFileCache(file)?.frontmatter;
			if (!fm || fm.verified !== false) continue;

			const relPath = filePath.slice(incomingDir.length + 1);
			const filename = this.displayFilenameFor(filePath, file.name, groupCounts);
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
			trackedFilePaths.add(filePath);
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

		const { noteByFilePath, claimedPaths } = this.buildIncomingNoteIndex(incomingDir);
		const trackedFilePaths = new Set(this.recentFiles.map((e) => e.filePath));
		const groupCounts = this.groupMemberCounts();
		let added = 0;

		// Reconcile tracked entries: re-locate the note via the raw file it owns
		// (handles notes renamed since last seen) and refresh verified/processed.
		for (const entry of this.recentFiles) {
			const note = noteByFilePath.get(entry.filePath);
			if (note && note.path !== entry.notePath) entry.notePath = note.path;
			const file = note ?? vault.getAbstractFileByPath(entry.notePath);
			if (!(file instanceof TFile)) continue;
			const fm = metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			entry.verified = fm.verified === true;
			entry.processed = fm.processed === true;
			if (entry.verified && entry.status !== 'verified') entry.status = 'verified';
		}

		// Pick up untracked filedrop notes (verified or not), keyed by the raw
		// file they own rather than the note path, so a renamed note is not
		// re-added as a duplicate.
		const trackedNotePaths = new Set(this.recentFiles.map((e) => e.notePath));
		for (const [filePath, file] of noteByFilePath) {
			if (trackedFilePaths.has(filePath)) continue;
			const fm = metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;

			const relPath = filePath.slice(incomingDir.length + 1);
			const filename = this.displayFilenameFor(filePath, file.name, groupCounts);
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

		// Pick up external linked notes. Their `original-file` is a file:// link
		// rather than a vault wikilink, so the index above misses them; re-derive
		// the entry from `external`/`source-path` frontmatter so a later scan still
		// recognizes the source. (Normally external entries persist in recentFiles;
		// this recovers them if that data was lost.)
		for (const file of vault.getMarkdownFiles().filter((f) => f.path.startsWith(incomingDir + '/'))) {
			if (trackedNotePaths.has(file.path)) continue;
			const fm = metadataCache.getFileCache(file)?.frontmatter;
			if (!fm || fm.external !== true || typeof fm['source-path'] !== 'string') continue;

			this.recentFiles.push({
				filename: file.basename,
				filePath: fm['source-path'],
				notePath: file.path,
				tags: Array.isArray(fm.tags) ? fm.tags : [],
				category: 'external',
				droppedAt: file.stat.ctime,
				verified: fm.verified === true,
				external: true,
				sourcePath: fm['source-path'],
			});
			trackedNotePaths.add(file.path);
			added++;
		}

		// Find raw files without a tracked .md — create stub + add to filelist.
		// Skip files a note already claims (as original-file or attachment),
		// even if they live outside the .attachments/.group conventions.
		const rawFiles = vault.getFiles().filter((f) =>
			f.path.startsWith(incomingDir + '/') &&
			!f.path.endsWith('.md') &&
			!f.path.includes('.attachments/') &&
			!f.path.includes('.group/') &&
			!claimedPaths.has(f.path)
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
