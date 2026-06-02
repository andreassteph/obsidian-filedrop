import { App, ItemView, Modal, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';

import { DroppedFile, LlmOpError, STATUS_LABELS, VIEW_TYPE, isConvertingStatus, isGatewayEnabled, parsePreferredTags, reviseSummary, suggestTags, summarizeContent } from './settings';
import { replaceTagsBlock } from './utils';
import { findCandidateNotes, extractActivityMetadata, fillMetadataWithLLM, matchCandidatesWithLLM, MatchedNote, ActivityMetadata } from './references';
import { ReferenceModal } from './reference-modal';
import type FileDropPlugin from '../main';

export class FileDropView extends ItemView {
	private plugin: FileDropPlugin;
	private fileListEl: HTMLElement | null = null;
	private selectedCategory: string;
	private selectedGatewayId: string | null = null;
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

		// Collapsible "Current note" section (above drop area, starts collapsed)
		this.currentNoteSection = container.createDiv({ cls: 'filedrop-droparea filedrop-currentnote-section filedrop-droparea--collapsed' });
		const currentNoteHeader = this.currentNoteSection.createDiv({ cls: 'filedrop-droparea-header' });
		currentNoteHeader.createSpan({ cls: 'filedrop-droparea-caret', text: '▾' });
		currentNoteHeader.createSpan({ cls: 'filedrop-droparea-title', text: 'Current note' });
		currentNoteHeader.addEventListener('click', () => {
			this.currentNoteSection!.toggleClass('filedrop-droparea--collapsed', !this.currentNoteSection!.hasClass('filedrop-droparea--collapsed'));
		});
		const currentNoteBody = this.currentNoteSection.createDiv({ cls: 'filedrop-droparea-body' });
		this.currentNotePathEl = currentNoteBody.createDiv({ cls: 'filedrop-currentnote-path', text: 'No note open' });
		this.currentNoteActionRow = currentNoteBody.createDiv({ cls: 'filedrop-currentnote-actions' });

		const cnSummaryBtn = this.currentNoteActionRow.createEl('button', { cls: 'filedrop-entry-summary', text: 'Add summary' });
		cnSummaryBtn.title = 'Generate summary with the selected LLM';
		cnSummaryBtn.addEventListener('click', async () => {
			cnSummaryBtn.disabled = true;
			cnSummaryBtn.setText('Summarizing…');
			try {
				await this.summarizeCurrentNote();
			} finally {
				cnSummaryBtn.disabled = false;
				cnSummaryBtn.setText('Add summary');
			}
		});

		const cnTagsBtn = this.currentNoteActionRow.createEl('button', { cls: 'filedrop-entry-suggest-tags', text: 'Suggest tags' });
		cnTagsBtn.title = 'Suggest tags with the selected LLM';
		cnTagsBtn.addEventListener('click', async () => {
			cnTagsBtn.disabled = true;
			cnTagsBtn.setText('Suggesting…');
			try {
				await this.suggestTagsForCurrentNote();
			} finally {
				cnTagsBtn.disabled = false;
				cnTagsBtn.setText('Suggest tags');
			}
		});

		if (this.plugin.settings.referenceGroups.length > 0) {
			const cnRefsBtn = this.currentNoteActionRow.createEl('button', { cls: 'filedrop-entry-add-refs', text: 'Add references' });
			cnRefsBtn.title = 'Find and add references to matching notes';
			cnRefsBtn.addEventListener('click', async () => {
				cnRefsBtn.disabled = true;
				cnRefsBtn.setText('Finding references…');
				try {
					await this.addReferencesForCurrentNote();
				} finally {
					cnRefsBtn.disabled = false;
					cnRefsBtn.setText('Add references');
				}
			});
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
		headerRow.createEl('span', {
			cls: `filedrop-status filedrop-status--${status}`,
			text: STATUS_LABELS[status] ?? status,
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

		const summaryRow = entryEl.createDiv({ cls: 'filedrop-entry-summary-row' });
		const hasSummary = this.entryHasSummary(entry);
		const summaryLabel = hasSummary ? 'Change summary' : 'Add summary';
		const summaryBtn = summaryRow.createEl('button', { cls: 'filedrop-entry-summary', text: summaryLabel });
		summaryBtn.title = hasSummary
			? 'Revise the existing summary with the selected LLM'
			: 'Generate summary with the selected LLM';
		summaryBtn.disabled = inProgress;
		summaryBtn.addEventListener('click', async () => {
			if (this.entryHasSummary(entry)) {
				await this.changeSummaryForEntry(entry, summaryBtn);
				return;
			}
			summaryBtn.disabled = true;
			summaryBtn.setText('Summarizing…');
			try {
				await this.summarizeEntry(entry);
			} finally {
				summaryBtn.disabled = false;
				summaryBtn.setText(this.entryHasSummary(entry) ? 'Change summary' : 'Add summary');
			}
		});

		const suggestBtn = summaryRow.createEl('button', { cls: 'filedrop-entry-suggest-tags', text: 'Suggest tags' });
		suggestBtn.title = 'Suggest tags with the selected LLM';
		suggestBtn.disabled = inProgress;
		suggestBtn.addEventListener('click', async () => {
			suggestBtn.disabled = true;
			suggestBtn.setText('Suggesting…');
			try {
				await this.suggestTagsForEntry(entry, index);
			} finally {
				suggestBtn.disabled = false;
				suggestBtn.setText('Suggest tags');
			}
		});

		if (this.plugin.settings.referenceGroups.length > 0) {
			const refsBtn = summaryRow.createEl('button', { cls: 'filedrop-entry-add-refs', text: 'Add references' });
			refsBtn.title = 'Find and add references to matching notes';
			refsBtn.disabled = inProgress;
			refsBtn.addEventListener('click', async () => {
				refsBtn.disabled = true;
				refsBtn.setText('Finding references…');
				try {
					await this.addReferencesForEntry(entry);
				} finally {
					refsBtn.disabled = false;
					refsBtn.setText('Add references');
				}
			});
		}

		const tagInput = summaryRow.createEl('input', { cls: 'filedrop-tag-input' });
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

	private async addReferencesForEntry(entry: DroppedFile): Promise<void> {
		const noteFile = this.app.vault.getAbstractFileByPath(entry.notePath);
		if (!(noteFile instanceof TFile)) {
			new Notice('FileDrop: could not find the note.');
			return;
		}
		await this.addReferencesForNote(noteFile, entry.filePath);
	}

	private async addReferencesForNote(noteFile: TFile, sourceFilePath?: string): Promise<void> {
		const gateway = this.plugin.settings.llmGateways.find((g) => g.id === this.selectedGatewayId) ?? null;
		const filePath = sourceFilePath ?? noteFile.path;

		const content = await this.app.vault.read(noteFile);
		const fmEnd = content.indexOf('\n---\n');
		const body = fmEnd >= 0 ? content.slice(fmEnd + 5) : content;

		const rawFm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {};
		const existingSummary: string = rawFm.summary ?? '';

		// Build metadata from cached fields if they exist, otherwise extract fresh
		let metadata: { date: string | null; type: string | null; people: string[] | null };
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
			const gatewayActive = !!gateway && isGatewayEnabled(gateway);
			const hasNullMetadata = metadata.date === null || metadata.type === null || metadata.people === null;

			if (gatewayActive && hasNullMetadata) {
				const fillResult = await fillMetadataWithLLM(metadata, body, gateway!, () => this.plugin.saveSettings());
				if (fillResult.ok) metadata = fillResult.value;
			}
		}

		const groupCandidates = findCandidateNotes(this.app, this.plugin.settings.referenceGroups);
		const gatewayActive = !!gateway && isGatewayEnabled(gateway);

		// Generate summary if missing
		let summary = existingSummary;
		if (gatewayActive && !existingSummary) {
			const summaryResult = await summarizeContent(body, gateway!, undefined, () => this.plugin.saveSettings());
			if (summaryResult.ok) {
				await this.writeNoteSummary(noteFile.path, summaryResult.value);
				summary = summaryResult.value;
			}
		}

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

	private entryHasSummary(entry: DroppedFile): boolean {
		const file = this.app.vault.getAbstractFileByPath(entry.notePath);
		if (!(file instanceof TFile)) return false;
		const summary = this.app.metadataCache.getFileCache(file)?.frontmatter?.summary;
		return typeof summary === 'string' && summary.trim().length > 0;
	}

	private async changeSummaryForEntry(entry: DroppedFile, summaryBtn: HTMLButtonElement): Promise<void> {
		const gateway = this.plugin.settings.llmGateways.find((g) => g.id === this.selectedGatewayId) ?? null;
		if (!gateway || !isGatewayEnabled(gateway)) {
			new Notice('FileDrop: select an LLM model first.');
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(entry.notePath);
		if (!(file instanceof TFile)) {
			new Notice('FileDrop: could not find the note to summarize.');
			return;
		}

		const currentSummary = String(this.app.metadataCache.getFileCache(file)?.frontmatter?.summary ?? '');
		const persist = () => this.plugin.saveSettings();

		summaryBtn.disabled = true;

		const onRevise = async (baseSummary: string, instruction: string): Promise<ReviseResult> => {
			const content = await this.app.vault.read(file);
			const i = content.indexOf('\n---\n');
			const body = i >= 0 ? content.slice(i + 5) : content;

			const result = await reviseSummary(body, baseSummary, instruction, gateway, undefined, persist);
			if (!result.ok) {
				return { ok: false, message: this.llmErrorMessage(result.reason, result.detail) };
			}

			// Overwrite-all metadata: re-derive every field from the document.
			let metadata = extractActivityMetadata(body, entry.filePath, file.stat);
			const fillResult = await fillMetadataWithLLM(metadata, body, gateway, persist);
			if (fillResult.ok) metadata = fillResult.value;

			return { ok: true, summary: result.value, metadata };
		};

		const onAccept = async (summary: string, metadata: ActivityMetadata): Promise<void> => {
			await this.writeNoteSummaryAndMetadata(entry.notePath, summary, metadata);
			new Notice('FileDrop: summary updated.');
		};

		const onClose = () => {
			summaryBtn.disabled = false;
			summaryBtn.setText(this.entryHasSummary(entry) ? 'Change summary' : 'Add summary');
		};

		new ChangeSummaryModal(this.app, currentSummary, onRevise, onAccept, onClose).open();
	}

	private async summarizeEntry(entry: DroppedFile): Promise<void> {
		const gateway = this.plugin.settings.llmGateways.find((g) => g.id === this.selectedGatewayId) ?? null;
		if (!gateway || !isGatewayEnabled(gateway)) {
			new Notice('FileDrop: select an LLM model first.');
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(entry.notePath);
		if (!(file instanceof TFile)) {
			new Notice('FileDrop: could not find the note to summarize.');
			return;
		}

		const content = await this.app.vault.read(file);
		const i = content.indexOf('\n---\n');
		const body = i >= 0 ? content.slice(i + 5) : content;

		// Extract summary
		const result = await summarizeContent(body, gateway, undefined, () => this.plugin.saveSettings());
		if (!result.ok) {
			new Notice(`FileDrop: could not generate a summary — ${this.llmErrorMessage(result.reason, result.detail)}.`);
			return;
		}

		// Extract metadata and optionally fill gaps with LLM
		let metadata = extractActivityMetadata(body, entry.filePath, file.stat);
		const hasNullMetadata = metadata.date === null || metadata.type === null || metadata.people === null;
		if (isGatewayEnabled(gateway) && hasNullMetadata) {
			const fillResult = await fillMetadataWithLLM(metadata, body, gateway, () => this.plugin.saveSettings());
			if (fillResult.ok) metadata = fillResult.value;
		}

		// Save summary and metadata to frontmatter
		await this.writeNoteSummaryAndMetadata(entry.notePath, result.value, metadata);
		new Notice('FileDrop: summary added.');
	}

	private async suggestTagsForEntry(entry: DroppedFile, index: number): Promise<void> {
		const gateway = this.plugin.settings.llmGateways.find((g) => g.id === this.selectedGatewayId) ?? null;
		if (!gateway || !isGatewayEnabled(gateway)) {
			new Notice('FileDrop: select an LLM model first.');
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(entry.notePath);
		if (!(file instanceof TFile)) {
			new Notice('FileDrop: could not find the note to tag.');
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

		const merged = Array.from(new Set([...entry.tags, ...result.value]));
		await this.updateEntryTags(index, merged);
		new Notice('FileDrop: tags suggested.');
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

		const result = await summarizeContent(body, gateway, undefined, () => this.plugin.saveSettings());
		if (!result.ok) {
			new Notice(`FileDrop: could not generate a summary — ${this.llmErrorMessage(result.reason, result.detail)}.`);
			return;
		}

		let metadata = extractActivityMetadata(body, file.path, file.stat);
		const hasNullMetadata = metadata.date === null || metadata.type === null || metadata.people === null;
		if (isGatewayEnabled(gateway) && hasNullMetadata) {
			const fillResult = await fillMetadataWithLLM(metadata, body, gateway, () => this.plugin.saveSettings());
			if (fillResult.ok) metadata = fillResult.value;
		}

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

type ReviseResult =
	| { ok: true; summary: string; metadata: ActivityMetadata }
	| { ok: false; message: string };

const SUMMARY_PRESETS: { label: string; instruction: string }[] = [
	{ label: 'Shorter', instruction: 'Make the summary shorter and more concise.' },
	{ label: 'Longer', instruction: 'Make the summary longer and more detailed.' },
	{ label: 'Simpler', instruction: 'Rewrite the summary in plain, simpler language.' },
];

class ChangeSummaryModal extends Modal {
	private proposedSummary = '';
	private proposedMetadata: ActivityMetadata = { date: null, type: null, people: null };

	constructor(
		app: App,
		private readonly originalSummary: string,
		private readonly onRevise: (baseSummary: string, instruction: string) => Promise<ReviseResult>,
		private readonly onAccept: (summary: string, metadata: ActivityMetadata) => Promise<void>,
		private readonly onCloseCb: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.renderInstructionStep();
	}

	private renderInstructionStep(): void {
		this.contentEl.empty();
		this.contentEl.createEl('h3', { text: 'Change summary' });
		this.contentEl.createEl('p', {
			cls: 'filedrop-change-summary-current',
			text: this.originalSummary,
		});
		this.contentEl.createEl('p', {
			text: 'Describe how the summary should be changed. The LLM revises it using the full document and the current summary as context.',
		});

		const input = this.contentEl.createEl('textarea', { cls: 'filedrop-change-summary-input' });
		input.placeholder = 'e.g. focus on the financial figures, mention the deadline…';
		input.rows = 4;

		const presets = this.contentEl.createDiv({ cls: 'filedrop-change-summary-presets' });
		for (const preset of SUMMARY_PRESETS) {
			const presetBtn = presets.createEl('button', { text: preset.label });
			presetBtn.addEventListener('click', () => {
				const existing = input.value.trim();
				input.value = existing ? `${existing}\n${preset.instruction}` : preset.instruction;
				input.focus();
			});
		}

		const buttons = this.contentEl.createDiv({ cls: 'filedrop-confirm-buttons' });
		const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		const submitBtn = buttons.createEl('button', { cls: 'mod-cta', text: 'Change summary' });
		const submit = async () => {
			const instruction = input.value.trim();
			if (!instruction) {
				new Notice('FileDrop: describe how the summary should change.');
				return;
			}
			await this.runRevise(this.originalSummary, instruction, submitBtn, [cancelBtn, ...Array.from(presets.children) as HTMLButtonElement[]]);
		};
		submitBtn.addEventListener('click', submit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				void submit();
			}
		});

		window.setTimeout(() => input.focus(), 0);
	}

	private renderPreviewStep(): void {
		this.contentEl.empty();
		this.contentEl.createEl('h3', { text: 'Review summary' });

		const compare = this.contentEl.createDiv({ cls: 'filedrop-summary-compare' });
		const oldCol = compare.createDiv({ cls: 'filedrop-summary-compare-col' });
		oldCol.createEl('div', { cls: 'filedrop-summary-compare-label', text: 'Current' });
		oldCol.createEl('p', { cls: 'filedrop-change-summary-current', text: this.originalSummary });
		const newCol = compare.createDiv({ cls: 'filedrop-summary-compare-col' });
		newCol.createEl('div', { cls: 'filedrop-summary-compare-label', text: 'Proposed' });
		newCol.createEl('p', { cls: 'filedrop-change-summary-current', text: this.proposedSummary });

		const meta = this.contentEl.createDiv({ cls: 'filedrop-summary-meta' });
		meta.createEl('div', { cls: 'filedrop-summary-compare-label', text: 'New metadata' });
		const people = this.proposedMetadata.people;
		const metaRows: [string, string][] = [
			['Date', this.proposedMetadata.date ?? '—'],
			['Type', this.proposedMetadata.type ?? '—'],
			['People', people && people.length > 0 ? people.join(', ') : '—'],
		];
		const list = meta.createEl('ul', { cls: 'filedrop-summary-meta-list' });
		for (const [key, value] of metaRows) {
			list.createEl('li', { text: `${key}: ${value}` });
		}

		this.contentEl.createEl('p', {
			text: 'Not quite right? Add another instruction and regenerate, or accept the proposed summary.',
		});
		const refine = this.contentEl.createEl('textarea', { cls: 'filedrop-change-summary-input' });
		refine.placeholder = 'e.g. keep it to two sentences…';
		refine.rows = 3;

		const buttons = this.contentEl.createDiv({ cls: 'filedrop-confirm-buttons' });
		const discardBtn = buttons.createEl('button', { text: 'Discard' });
		discardBtn.addEventListener('click', () => this.close());
		const regenBtn = buttons.createEl('button', { text: 'Regenerate' });
		regenBtn.addEventListener('click', async () => {
			const instruction = refine.value.trim();
			if (!instruction) {
				new Notice('FileDrop: describe how to refine the summary.');
				return;
			}
			await this.runRevise(this.proposedSummary, instruction, regenBtn, [discardBtn, acceptBtn]);
		});
		const acceptBtn = buttons.createEl('button', { cls: 'mod-cta', text: 'Accept' });
		acceptBtn.addEventListener('click', async () => {
			acceptBtn.disabled = true;
			acceptBtn.setText('Saving…');
			try {
				await this.onAccept(this.proposedSummary, this.proposedMetadata);
				this.close();
			} finally {
				acceptBtn.disabled = false;
				acceptBtn.setText('Accept');
			}
		});
	}

	// Run a revise call with a loading state on `actionBtn`; on success store the
	// proposal and (re-)render the preview step.
	private async runRevise(
		baseSummary: string,
		instruction: string,
		actionBtn: HTMLButtonElement,
		otherBtns: HTMLButtonElement[],
	): Promise<void> {
		const originalText = actionBtn.textContent ?? '';
		actionBtn.disabled = true;
		actionBtn.setText('Revising…');
		for (const b of otherBtns) b.disabled = true;
		try {
			const result = await this.onRevise(baseSummary, instruction);
			if (!result.ok) {
				new Notice(`FileDrop: could not change the summary — ${result.message}.`);
				return;
			}
			this.proposedSummary = result.summary;
			this.proposedMetadata = result.metadata;
			this.renderPreviewStep();
		} finally {
			// Buttons that still exist (failure path stays on the same step).
			actionBtn.disabled = false;
			actionBtn.setText(originalText);
			for (const b of otherBtns) b.disabled = false;
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.onCloseCb();
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
