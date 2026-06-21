import { App, ItemView, Modal, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';

import { DroppedFile, LlmOpError, STATUS_LABELS, VIEW_TYPE, isConvertingStatus, isGatewayEnabled, parsePreferredTags, suggestTags, summarizeContent } from './settings';
import { extFromMime, pastedBaseName, replaceTagsBlock } from './utils';
import { findCandidateNotes, extractActivityMetadata, fillMetadataWithLLM, matchCandidatesWithLLM, MatchedNote } from './references';
import { ReferenceModal } from './reference-modal';
import type FileDropPlugin from '../main';

export class FileDropView extends ItemView {
	private plugin: FileDropPlugin;
	private fileListEl: HTMLElement | null = null;
	private selectedCategory: string;
	selectedGatewayId: string | null = null;
	private modelSelectEl: HTMLSelectElement | null = null;
	private hiddenNotePaths = new Set<string>();
	private showVerified = false;
	private groupBtnEl: HTMLButtonElement | null = null;
	private groupStatusEl: HTMLElement | null = null;
	private currentNoteSection: HTMLElement | null = null;
	private currentNotePathEl: HTMLElement | null = null;
	private currentNoteActionRow: HTMLElement | null = null;

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

		// Model / gateway selector (top)
		const modelRow = container.createDiv({ cls: 'filedrop-category-row' });
		modelRow.createEl('label', { cls: 'filedrop-category-label', text: 'Model' });
		this.modelSelectEl = modelRow.createEl('select', { cls: 'filedrop-category-select' });
		this.populateModelSelect(this.modelSelectEl);
		this.modelSelectEl.addEventListener('change', () => {
			this.selectedGatewayId = this.modelSelectEl!.value || null;
		});

		// "Current note" section (above drop area, always visible)
		this.currentNoteSection = container.createDiv({ cls: 'filedrop-currentnote-section' });
		const currentNoteHeader = this.currentNoteSection.createDiv({ cls: 'filedrop-currentnote-header' });
		currentNoteHeader.createSpan({ cls: 'filedrop-currentnote-label', text: 'Current note' });
		this.currentNotePathEl = currentNoteHeader.createSpan({ cls: 'filedrop-currentnote-path', text: 'No note open' });
		this.currentNoteActionRow = this.currentNoteSection.createDiv({ cls: 'filedrop-currentnote-actions' });

		this.createIconActionButton(this.currentNoteActionRow, 'file-text', 'Generate summary with the selected LLM', () => this.summarizeCurrentNote());
		this.createIconActionButton(this.currentNoteActionRow, 'tags', 'Suggest tags with the selected LLM', () => this.suggestTagsForCurrentNote());
		if (this.plugin.settings.referenceGroups.length > 0) {
			this.createIconActionButton(this.currentNoteActionRow, 'link', 'Find and add references to matching notes', () => this.addReferencesForCurrentNote());
		}

		this.updateCurrentNotePanel(this.app.workspace.getActiveFile());
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			this.updateCurrentNotePanel(file ?? null);
		}));

		// Collapsible drop area (category + drop zone)
		const dropSection = container.createDiv({ cls: 'filedrop-droparea filedrop-dropfiles-section' });
		const dropHeader = dropSection.createDiv({ cls: 'filedrop-droparea-header' });
		dropHeader.createSpan({ cls: 'filedrop-droparea-caret', text: '▾' });
		dropHeader.createSpan({ cls: 'filedrop-droparea-title', text: 'Drop files' });
		const dropBody = dropSection.createDiv({ cls: 'filedrop-droparea-body' });
		dropHeader.addEventListener('click', () => {
			dropSection.toggleClass('filedrop-droparea--collapsed', !dropSection.hasClass('filedrop-droparea--collapsed'));
		});

		const controlsRow = dropBody.createDiv({ cls: 'filedrop-controls-row' });
		this.groupBtnEl = controlsRow.createEl('button', { cls: 'filedrop-group-btn', text: 'Group' });
		this.groupBtnEl.title = 'Toggle group mode — batch multiple files into one note';
		this.groupBtnEl.addEventListener('click', (e) => {
			e.stopPropagation();
			if (this.plugin.groupModeActive) {
				if (this.plugin.groupQueueCount > 0) {
					this.plugin.finalizeAndStopGroupMode();
				} else {
					this.plugin.stopGroupMode();
				}
			} else {
				this.plugin.startGroupMode(this.selectedCategory, this.selectedGatewayId);
			}
		});
		const categorySelect = controlsRow.createEl('select', { cls: 'filedrop-category-select' });
		this.plugin.settings.categories.forEach((cat) => {
			const opt = categorySelect.createEl('option', { value: cat, text: cat });
			if (cat === this.selectedCategory) opt.selected = true;
		});
		categorySelect.addEventListener('change', () => {
			this.selectedCategory = categorySelect.value;
		});
		categorySelect.addEventListener('click', (e) => e.stopPropagation());

		const pasteBtn = controlsRow.createEl('button', { cls: 'filedrop-paste-btn', text: '📋 Paste' });
		pasteBtn.title = 'Paste clipboard image, text, or file into the vault';
		pasteBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			pasteBtn.disabled = true;
			const original = pasteBtn.getText();
			pasteBtn.setText('Pasting…');
			try {
				await this.pasteFromClipboard();
			} finally {
				pasteBtn.disabled = false;
				pasteBtn.setText(original);
			}
		});

		// Group status bar (hidden when group mode is off)
		this.groupStatusEl = dropBody.createDiv({ cls: 'filedrop-group-status' });
		this.groupStatusEl.style.display = 'none';

		// Drop zone
		const dropZone = dropBody.createDiv({ cls: 'filedrop-zone' });
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
				await this.plugin.processDroppedFile(file, this.selectedCategory, this.selectedGatewayId);
			}
		});

		// Update filelist row + show-verified toggle
		const updateRow = container.createDiv({ cls: 'filedrop-update-row' });
		const updateBtn = updateRow.createEl('button', {
			cls: 'filedrop-update-btn',
			text: '↻ Update filelist',
		});
		updateBtn.addEventListener('click', async () => {
			updateBtn.disabled = true;
			updateBtn.setText('Scanning…');
			this.hiddenNotePaths.clear();
			try {
				await this.plugin.updateFileList();
			} finally {
				updateBtn.disabled = false;
				updateBtn.setText('↻ Update filelist');
			}
		});

		if (this.plugin.settings.externalFolder.trim()) {
			const scanBtn = updateRow.createEl('button', {
				cls: 'filedrop-update-btn',
				text: '⇄ Scan external',
			});
			scanBtn.addEventListener('click', async () => {
				scanBtn.disabled = true;
				scanBtn.setText('Scanning…');
				try {
					await this.plugin.scanExternalFolder(this.selectedGatewayId);
				} finally {
					scanBtn.disabled = false;
					scanBtn.setText('⇄ Scan external');
				}
			});
		}

		const showVerifiedLabel = updateRow.createEl('label', { cls: 'filedrop-showverified-label' });
		const showVerifiedCheckbox = showVerifiedLabel.createEl('input', { cls: 'filedrop-showverified-checkbox' });
		showVerifiedCheckbox.type = 'checkbox';
		showVerifiedCheckbox.checked = this.showVerified;
		showVerifiedLabel.appendText('Show verified');
		showVerifiedCheckbox.addEventListener('change', () => {
			this.showVerified = showVerifiedCheckbox.checked;
			this.renderFileList();
		});

		// Recent files list
		this.fileListEl = container.createDiv({ cls: 'filedrop-recent' });
		this.renderFileList();
	}

	async onClose(): Promise<void> {
		// nothing to clean up
	}

	// Read the clipboard and route its first usable representation (image, then
	// text, then any other blob) through the normal drop pipeline. Images and
	// text request a content-derived filename; anything else keeps the
	// algorithmic `pasted-<timestamp>` name. Group mode (if active) queues it.
	private async pasteFromClipboard(): Promise<void> {
		if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
			new Notice('FileDrop: clipboard access is not available here');
			return;
		}

		let clipItems: ClipboardItem[];
		try {
			clipItems = await navigator.clipboard.read();
		} catch (err) {
			new Notice(`FileDrop: could not read clipboard — ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (clipItems.length === 0) {
			new Notice('FileDrop: clipboard is empty');
			return;
		}

		const item = clipItems[0];
		// Prefer an image, then plain text, then any remaining representation.
		const imageType = item.types.find((t) => t.startsWith('image/'));
		const type = imageType ?? (item.types.includes('text/plain') ? 'text/plain' : item.types[0]);
		if (!type) {
			new Notice('FileDrop: nothing usable on the clipboard');
			return;
		}

		const blob = await item.getType(type);
		const nameFromContent = type.startsWith('image/') || type.startsWith('text/');
		const ext = extFromMime(type);
		const fileName = ext ? `${pastedBaseName()}.${ext}` : pastedBaseName();
		const file = new File([blob], fileName, { type });

		await this.plugin.processDroppedFile(file, this.selectedCategory, this.selectedGatewayId, { nameFromContent });
	}

	private populateModelSelect(el: HTMLSelectElement): void {
		el.empty();
		const noneOpt = el.createEl('option', { value: '', text: '— None —' });
		noneOpt.selected = !this.selectedGatewayId;
		this.plugin.settings.llmGateways
			.filter((gw) => isGatewayEnabled(gw))
			.forEach((gw) => {
				const opt = el.createEl('option', { value: gw.id, text: `${gw.name} (${gw.model})` });
				opt.selected = gw.id === this.selectedGatewayId;
			});
	}

	refreshModelSelector(): void {
		if (!this.modelSelectEl) return;
		if (!this.plugin.settings.llmGateways.some((g) => g.id === this.selectedGatewayId)) {
			this.selectedGatewayId = null;
		}
		this.populateModelSelect(this.modelSelectEl);
	}

	onGroupModeChanged(): void {
		const active = this.plugin.groupModeActive;
		if (this.groupBtnEl) {
			this.groupBtnEl.toggleClass('filedrop-group-btn--active', active);
			this.groupBtnEl.setText(active ? 'Finalize Group' : 'Group');
			this.groupBtnEl.title = active
				? `Finalize group "${this.plugin.groupCurrentName}" (${this.plugin.groupQueueCount} file(s) queued)`
				: 'Toggle group mode — batch multiple files into one note';
		}
		if (this.groupStatusEl) {
			if (active) {
				this.groupStatusEl.style.display = '';
				this.groupStatusEl.empty();
				const count = this.plugin.groupQueueCount;
				const name = this.plugin.groupCurrentName;
				this.groupStatusEl.createEl('span', {
					cls: 'filedrop-group-status-badge',
					text: count > 0
						? `"${name}" — ${count} file${count !== 1 ? 's' : ''} queued`
						: 'Drop files to add to group',
				});
			} else {
				this.groupStatusEl.style.display = 'none';
				this.groupStatusEl.empty();
			}
		}
	}

	promptGroupFinish(): void {
		new GroupFinishModal(
			this.app,
			this.plugin.groupCurrentName,
			this.plugin.groupQueueCount,
			async () => { await this.plugin.finalizeAndStopGroupMode(); },
			() => { this.plugin.resetGroupIdleTimer(); },
		).open();
	}

	// Build a compact icon button for a current-note action. While the async
	// handler runs, the icon is swapped for a spinner and the button disabled.
	private createIconActionButton(parent: HTMLElement, icon: string, tooltip: string, handler: () => Promise<void>): HTMLButtonElement {
		const btn = parent.createEl('button', { cls: 'filedrop-currentnote-action' });
		setIcon(btn, icon);
		btn.title = tooltip;
		btn.setAttribute('aria-label', tooltip);
		btn.addEventListener('click', async () => {
			btn.disabled = true;
			setIcon(btn, 'loader');
			try {
				await handler();
			} finally {
				btn.disabled = false;
				setIcon(btn, icon);
			}
		});
		return btn;
	}

	private updateCurrentNotePanel(file: TFile | null): void {
		if (!this.currentNotePathEl || !this.currentNoteActionRow) return;
		const isMarkdown = file instanceof TFile && file.extension === 'md';
		if (!file) {
			this.currentNotePathEl.setText('No note open');
			this.currentNoteActionRow.style.display = 'none';
		} else if (!isMarkdown) {
			this.currentNotePathEl.setText(`${file.path} (not a markdown note)`);
			this.currentNoteActionRow.style.display = 'none';
		} else {
			this.currentNotePathEl.setText(file.path);
			this.currentNoteActionRow.style.display = '';
		}
	}

	renderFileList(): void {
		if (!this.fileListEl) return;
		this.fileListEl.empty();

		const unverified = this.plugin.recentFiles
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => !this.hiddenNotePaths.has(entry.notePath))
			.filter(({ entry }) => this.showVerified || (!entry.verified && entry.status !== 'verified'))
			.filter(({ entry }) => !entry.processed);

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

		const status = entry.status ?? 'unknown';
		const baseLabel = STATUS_LABELS[status] ?? status;
		const progressUnit = status === 'converting-llm-image' ? 'image' : 'page';
		const progressSuffix = entry.pageProgress && isConvertingStatus(status)
			? ` (${progressUnit} ${entry.pageProgress.current}/${entry.pageProgress.total})`
			: '';
		headerRow.createEl('span', {
			cls: `filedrop-status filedrop-status--${status}`,
			text: baseLabel + progressSuffix,
		});

		const inProgress = status === 'moving' || isConvertingStatus(status);

		const verifiedLabel = headerRow.createEl('label', { cls: 'filedrop-verified-label' });
		const verifiedCheckbox = verifiedLabel.createEl('input', { cls: 'filedrop-verified-checkbox' });
		verifiedCheckbox.type = 'checkbox';
		verifiedCheckbox.checked = entry.verified === true || status === 'verified';
		verifiedCheckbox.disabled = inProgress;
		verifiedLabel.appendText('verified');
		verifiedCheckbox.addEventListener('change', async () => {
			if (verifiedCheckbox.checked) await this.markVerified(index);
		});

		const trashBtn = headerRow.createEl('button', { cls: 'filedrop-entry-trash' });
		setIcon(trashBtn, 'trash-2');
		trashBtn.title = 'Delete file and note';
		trashBtn.disabled = inProgress;
		trashBtn.addEventListener('click', () => {
			new ConfirmModal(
				this.app,
				`Delete "${entry.filename}" and its note? This cannot be undone.`,
				() => this.removeEntry(index),
			).open();
		});

		const hideBtn = headerRow.createEl('button', { cls: 'filedrop-entry-hide', text: '×' });
		hideBtn.title = 'Dismiss (cancels if converting)';
		hideBtn.addEventListener('click', () => this.hideEntry(entry));

		const rerunBtn = headerRow.createEl('button', { cls: 'filedrop-entry-rerun', text: '↺' });
		rerunBtn.title = 'Re-run conversion';
		rerunBtn.disabled = inProgress;
		rerunBtn.addEventListener('click', async () => {
			await this.plugin.rerunConversion(entry, this.selectedGatewayId);
		});
	}

	private async addReferencesForNote(noteFile: TFile, sourceFilePath?: string): Promise<void> {
		const gateway = this.plugin.settings.llmGateways.find((g) => g.id === this.selectedGatewayId) ?? null;
		const filePath = sourceFilePath ?? noteFile.path;

		const content = await this.app.vault.read(noteFile);
		const fmEnd = content.indexOf('\n---\n');
		const body = fmEnd >= 0 ? content.slice(fmEnd + 5) : content;

		const rawFm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {};
		const existingSummary: string = rawFm.summary ?? '';

		const gatewayActive = !!gateway && isGatewayEnabled(gateway);

		// Build metadata from cached fields if they exist, otherwise extract fresh
		let metadata: { date: string | null; type: string | null; people: string[] | null };
		let metadataFillPromise: ReturnType<typeof fillMetadataWithLLM> | null = null;
		const hasCachedDate = 'file_date' in rawFm && rawFm.file_date;
		const hasCachedType = 'file_type' in rawFm && rawFm.file_type;
		const hasCachedPeople = 'file_people' in rawFm && rawFm.file_people;

		if (hasCachedDate && hasCachedType && hasCachedPeople) {
			metadata = {
				date: String(rawFm.file_date),
				type: String(rawFm.file_type),
				people: Array.isArray(rawFm.file_people) ? rawFm.file_people.map(String) : null,
			};
		} else {
			metadata = extractActivityMetadata(body, filePath, noteFile.stat);
			const hasNullMetadata = metadata.date === null || metadata.type === null || metadata.people === null;
			if (gatewayActive && hasNullMetadata) {
				metadataFillPromise = fillMetadataWithLLM(metadata, body, gateway!, () => this.plugin.saveSettings());
			}
		}

		// The metadata fill and the summary both depend only on `body` and are
		// independent of each other, so run them concurrently instead of in series.
		const summaryPromise = (gatewayActive && !existingSummary)
			? summarizeContent(body, gateway!, undefined, () => this.plugin.saveSettings())
			: null;

		const [fillResult, summaryResult] = await Promise.all([metadataFillPromise, summaryPromise]);
		if (fillResult?.ok) metadata = fillResult.value;

		let summary = existingSummary;
		if (summaryResult?.ok) {
			await this.writeNoteSummary(noteFile.path, summaryResult.value);
			summary = summaryResult.value;
		}

		const groupCandidates = findCandidateNotes(this.app, this.plugin.settings.referenceGroups);

		// Build full frontmatter for matching
		const noteFrontmatter: Record<string, unknown> = { ...rawFm };
		if (summary) noteFrontmatter['summary'] = summary;

		const matchResult = gatewayActive
			? await matchCandidatesWithLLM(body, noteFrontmatter, groupCandidates, gateway!, this.plugin.settings.referenceMaxMatches, () => this.plugin.saveSettings())
			: null;

		let matchedNotes: MatchedNote[] = [];
		if (matchResult?.ok) {
			matchedNotes = matchResult.value;
		} else if (matchResult && !matchResult.ok) {
			new Notice(`FileDrop: matching failed — ${this.llmErrorMessage(matchResult.reason, matchResult.detail)}. Showing all candidates.`);
		}

		// No gateway, or matching failed — show all candidates unranked
		if (!gatewayActive || (matchResult && !matchResult.ok)) {
			const seen = new Set<string>();
			for (const { group, candidates } of groupCandidates) {
				for (const candidate of candidates) {
					if (!seen.has(candidate.file.path)) {
						seen.add(candidate.file.path);
						matchedNotes.push({ candidate, group });
					}
				}
			}
		}

		new ReferenceModal(this.app, this.plugin, noteFile.basename, noteFile, metadata, summary, matchedNotes, matchResult?.ok ?? false, gateway).open();
	}

	private hideEntry(entry: DroppedFile): void {
		const s = entry.status ?? 'unknown';
		if (s === 'moving' || isConvertingStatus(s)) {
			this.plugin.cancelConversion(entry.notePath);
		}
		const idx = this.plugin.recentFiles.findIndex((e) => e.notePath === entry.notePath);
		if (idx !== -1) {
			this.plugin.recentFiles.splice(idx, 1);
			void this.plugin.saveSettings();
		}
		this.renderFileList();
	}

	private async removeEntry(index: number): Promise<void> {
		const entry = this.plugin.recentFiles[index];
		// External entries reference a raw file outside the vault that we don't
		// own — only remove the generated note, never the external source.
		if (!entry.external) {
			try { await this.app.vault.adapter.remove(entry.filePath); } catch { /* best-effort */ }
		}
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
		this.plugin.recentFiles[index].status = 'verified';
		await this.plugin.saveSettings();
		await this.rewriteNoteVerified(this.plugin.recentFiles[index].notePath);
		this.renderFileList();
	}

	private llmErrorMessage(reason: LlmOpError, detail?: string): string {
		const base: Record<LlmOpError, string> = {
			'insecure-url': 'refusing to use an insecure gateway URL — use HTTPS or localhost',
			'empty-content': detail ?? 'note body is empty or contains a conversion error',
			'timeout': 'the LLM gateway timed out',
			'api-error': detail ? `gateway error — ${detail}` : 'the gateway returned an error (see console for details)',
			'no-reply': 'the LLM returned an empty response',
		};
		return base[reason];
	}

	private async summarizeCurrentNote(): Promise<void> {
		const gateway = this.plugin.settings.llmGateways.find((g) => g.id === this.selectedGatewayId) ?? null;
		if (!gateway || !isGatewayEnabled(gateway)) {
			new Notice('FileDrop: select an LLM model first.');
			return;
		}

		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== 'md') {
			new Notice('FileDrop: no markdown note is active.');
			return;
		}

		const content = await this.app.vault.read(file);
		const i = content.indexOf('\n---\n');
		const body = i >= 0 ? content.slice(i + 5) : content;

		// Summary and metadata-fill both read only `body` and are independent, so
		// kick them off together. Extract metadata first to know whether a fill is needed.
		let metadata = extractActivityMetadata(body, file.path, file.stat);
		const hasNullMetadata = metadata.date === null || metadata.type === null || metadata.people === null;
		const fillPromise = (isGatewayEnabled(gateway) && hasNullMetadata)
			? fillMetadataWithLLM(metadata, body, gateway, () => this.plugin.saveSettings())
			: null;

		const [result, fillResult] = await Promise.all([
			summarizeContent(body, gateway, undefined, () => this.plugin.saveSettings()),
			fillPromise,
		]);
		if (!result.ok) {
			new Notice(`FileDrop: could not generate a summary — ${this.llmErrorMessage(result.reason, result.detail)}.`);
			return;
		}
		if (fillResult?.ok) metadata = fillResult.value;

		await this.writeNoteSummaryAndMetadata(file.path, result.value, metadata);
		new Notice('FileDrop: summary added.');
	}

	private async suggestTagsForCurrentNote(): Promise<void> {
		const gateway = this.plugin.settings.llmGateways.find((g) => g.id === this.selectedGatewayId) ?? null;
		if (!gateway || !isGatewayEnabled(gateway)) {
			new Notice('FileDrop: select an LLM model first.');
			return;
		}

		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== 'md') {
			new Notice('FileDrop: no markdown note is active.');
			return;
		}

		const content = await this.app.vault.read(file);
		const i = content.indexOf('\n---\n');
		const body = i >= 0 ? content.slice(i + 5) : content;

		const result = await suggestTags(body, gateway, parsePreferredTags(this.plugin.settings.preferredTags), undefined, () => this.plugin.saveSettings());
		if (!result.ok) {
			new Notice(`FileDrop: could not suggest tags — ${this.llmErrorMessage(result.reason, result.detail)}.`);
			return;
		}
		if (result.value.length === 0) {
			new Notice('FileDrop: the LLM suggested no tags for this content.');
			return;
		}

		const existing: string[] = this.app.metadataCache.getFileCache(file)?.frontmatter?.tags ?? [];
		const merged = Array.from(new Set([...existing, ...result.value]));
		await this.rewriteNoteTags(file.path, merged);
		new Notice('FileDrop: tags suggested.');
	}

	private async addReferencesForCurrentNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== 'md') {
			new Notice('FileDrop: no markdown note is active.');
			return;
		}
		await this.addReferencesForNote(file);
	}

	private async writeNoteSummary(notePath: string, summary: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);
		const line = `summary: ${JSON.stringify(summary)}`;
		let updated: string;
		if (/^summary:.*$/m.test(content)) {
			updated = content.replace(/^summary:.*$/m, line);
		} else {
			const c = content.indexOf('\n---\n');
			if (c < 0) return;
			updated = content.slice(0, c) + '\n' + line + content.slice(c);
		}
		await this.app.vault.modify(file, updated);
	}

	private async writeNoteSummaryAndMetadata(
		notePath: string,
		summary: string,
		metadata: { date: string | null; type: string | null; people: string[] | null },
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);

		const fmEndIndex = content.indexOf('\n---\n');
		if (fmEndIndex < 0) return;

		const fmStart = content.slice(0, fmEndIndex);
		const fmBody = content.slice(fmEndIndex);

		// Build replacement lines for frontmatter fields
		const lines: string[] = [];
		lines.push(`summary: ${JSON.stringify(summary)}`);
		if (metadata.date) lines.push(`file_date: ${JSON.stringify(metadata.date)}`);
		if (metadata.type) lines.push(`file_type: ${JSON.stringify(metadata.type)}`);
		if (metadata.people && metadata.people.length > 0) {
			lines.push(`file_people: [${metadata.people.map((p) => JSON.stringify(p)).join(', ')}]`);
		}

		const newLines = lines.join('\n');

		// Replace existing lines or add new ones
		let updated = fmStart;
		for (const line of lines) {
			const field = line.split(':')[0];
			const fieldRegex = new RegExp(`^${field}:.*$`, 'm');
			if (fieldRegex.test(updated)) {
				updated = updated.replace(fieldRegex, line);
			} else {
				updated += '\n' + line;
			}
		}
		updated += fmBody;

		await this.app.vault.modify(file, updated);
	}

	private async rewriteNoteTags(notePath: string, tags: string[]): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);
		const updated = replaceTagsBlock(content, tags);
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

class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => void;

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.contentEl.createEl('p', { text: this.message });
		const buttons = this.contentEl.createDiv({ cls: 'filedrop-confirm-buttons' });
		const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		const deleteBtn = buttons.createEl('button', { cls: 'mod-warning', text: 'Delete' });
		deleteBtn.addEventListener('click', () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class GroupFinishModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly groupName: string,
		private readonly fileCount: number,
		private readonly onFinalize: () => Promise<void>,
		private readonly onKeepAdding: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const count = this.fileCount;
		this.contentEl.createEl('p', {
			text: `No files dropped for 20 seconds. Group "${this.groupName}" has ${count} file${count !== 1 ? 's' : ''} queued. Is the group finished?`,
		});
		const buttons = this.contentEl.createDiv({ cls: 'filedrop-confirm-buttons' });
		const keepBtn = buttons.createEl('button', { text: 'Keep adding' });
		keepBtn.addEventListener('click', () => {
			this.resolved = true;
			this.onKeepAdding();
			this.close();
		});
		const finalizeBtn = buttons.createEl('button', { cls: 'mod-cta', text: 'Finalize group' });
		finalizeBtn.addEventListener('click', async () => {
			this.resolved = true;
			this.close();
			await this.onFinalize();
		});
	}

	onClose(): void {
		if (!this.resolved) this.onKeepAdding();
		this.contentEl.empty();
	}
}
