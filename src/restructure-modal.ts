import { App, Modal, Notice, TFile, normalizePath } from 'obsidian';

import { LlmGateway } from './settings';
import {
	RestructurePair,
	existingSubfolders,
	factCheckNoteBody,
	restructureNoteBody,
	suggestSubfolder,
} from './restructure';
import { applyTemplateFrontmatter, fillTemplateFrontmatter } from './templates';
import { dedupeName } from './utils';
import type FileDropPlugin from '../main';

// Confirms which restructure pair and target subfolder to use, then creates a
// NEW note: the source note restructured into the chosen template's headings
// (per-section guidance, source-only content), fact-checked, with template
// frontmatter filled and a back-link to the original.
export class RestructureModal extends Modal {
	private selectedIndex = 0;
	private subfolderInput: HTMLInputElement | null = null;
	private subfolderStatus: HTMLElement | null = null;
	private suggesting = false;

	constructor(
		app: App,
		private readonly plugin: FileDropPlugin,
		private readonly noteFile: TFile,
		private readonly noteFrontmatter: Record<string, unknown>,
		private readonly noteBody: string,
		private readonly ranked: RestructurePair[],
		private readonly usedLlm: boolean,
		private readonly gateway: LlmGateway | null,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: `Restructure into new note — ${this.noteFile.basename}` });

		if (this.ranked.length === 0) {
			contentEl.createEl('p', { text: 'No restructure templates are configured.' });
			const row = contentEl.createDiv({ cls: 'filedrop-ref-modal-buttons' });
			row.createEl('button', { text: 'Close' }).addEventListener('click', () => this.close());
			return;
		}

		contentEl.createEl('p', {
			text: this.usedLlm
				? 'The selected template was matched by the LLM. Confirm or pick another:'
				: 'Select the template to restructure into:',
			cls: 'filedrop-ref-modal-hint',
		});

		const list = contentEl.createDiv({ cls: 'filedrop-ref-modal-list' });
		const radios: HTMLInputElement[] = [];
		const groupName = `filedrop-restructure-${this.noteFile.path}`;

		this.ranked.forEach((pair, i) => {
			const item = list.createDiv({ cls: 'filedrop-ref-modal-item' });
			const radio = item.createEl('input');
			radio.type = 'radio';
			radio.name = groupName;
			radio.checked = i === 0;
			radio.addEventListener('change', () => {
				if (radio.checked) {
					this.selectedIndex = i;
					void this.refreshSubfolderSuggestion();
				}
			});
			radios.push(radio);

			const labelEl = item.createDiv({ cls: 'filedrop-ref-modal-label' });
			labelEl.createEl('strong', { text: pair.config.name || pair.template.name });
			labelEl.createDiv({ text: `→ ${pair.config.targetFolder}`, cls: 'filedrop-ref-modal-desc' });
		});

		// Title for the new note (defaults to the source basename).
		const titleSetting = contentEl.createDiv({ cls: 'filedrop-ref-cond-row' });
		titleSetting.createSpan({ text: 'Title', cls: 'setting-item-name' });
		const titleInput = titleSetting.createEl('input');
		titleInput.type = 'text';
		titleInput.value = this.noteFile.basename;
		titleInput.className = 'filedrop-ref-cond-input';

		// Subfolder (LLM-suggested, editable).
		const subSetting = contentEl.createDiv({ cls: 'filedrop-ref-cond-row' });
		subSetting.createSpan({ text: 'Subfolder', cls: 'setting-item-name' });
		this.subfolderInput = subSetting.createEl('input');
		this.subfolderInput.type = 'text';
		this.subfolderInput.placeholder = '(target folder root)';
		this.subfolderInput.className = 'filedrop-ref-cond-input';
		this.subfolderStatus = contentEl.createDiv({ cls: 'filedrop-ref-modal-desc' });

		const btnRow = contentEl.createDiv({ cls: 'filedrop-ref-modal-buttons' });
		btnRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());

		const createBtn = btnRow.createEl('button', { text: 'Create note', cls: 'mod-cta' });
		createBtn.addEventListener('click', async () => {
			createBtn.disabled = true;
			createBtn.textContent = 'Working…';
			try {
				await this.createRestructuredNote(this.ranked[this.selectedIndex], titleInput.value.trim());
				this.close();
			} catch (e) {
				console.error('FileDrop: failed to create restructured note', e);
				new Notice('FileDrop: failed to create restructured note (see console).');
				createBtn.disabled = false;
				createBtn.textContent = 'Create note';
			}
		});

		void this.refreshSubfolderSuggestion();
	}

	// Ask the LLM for the best subfolder under the selected pair's target folder
	// and prefill the input. Existing subfolders are listed as a hint.
	private async refreshSubfolderSuggestion(): Promise<void> {
		if (!this.subfolderInput || !this.subfolderStatus) return;
		const pair = this.ranked[this.selectedIndex];
		const existing = existingSubfolders(this.app, pair.config.targetFolder);

		this.suggesting = true;
		this.subfolderStatus.setText('Suggesting subfolder…');
		const res = await suggestSubfolder(
			this.noteFile.basename,
			this.noteFrontmatter,
			this.noteBody,
			existing,
			this.gateway,
			() => this.plugin.saveSettings(),
		);
		this.suggesting = false;
		// Ignore a stale response if the user switched pairs meanwhile.
		if (this.ranked[this.selectedIndex] !== pair) return;

		const suggestion = res.ok ? res.value : { subfolder: '', isNew: false };
		this.subfolderInput.value = suggestion.subfolder;
		const existingHint = existing.length ? `Existing: ${existing.join(', ')}` : 'No existing subfolders';
		const newHint = suggestion.subfolder && suggestion.isNew ? ' — suggesting a NEW subfolder' : '';
		this.subfolderStatus.setText(`${existingHint}${newHint}`);
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = normalizePath(path).split('/').filter(Boolean);
		let cur = '';
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(cur))) {
				await this.app.vault.adapter.mkdir(cur);
			}
		}
	}

	private async createRestructuredNote(pair: RestructurePair, title: string): Promise<void> {
		if (this.suggesting) {
			new Notice('FileDrop: still suggesting a subfolder — try again in a moment.');
			throw new Error('subfolder suggestion in progress');
		}
		const persist = () => this.plugin.saveSettings();

		// 1. Restructure body, then fact-check it against the source.
		const drafted = await restructureNoteBody(
			pair,
			this.noteFile.basename,
			this.noteFrontmatter,
			this.noteBody,
			this.gateway,
			persist,
		);
		if (!drafted.ok) {
			new Notice('FileDrop: could not restructure the note (see console).');
			throw new Error(`restructure failed: ${drafted.reason}`);
		}
		const body = await factCheckNoteBody(this.noteBody, drafted.value, this.gateway, persist);

		// 2. Resolve the destination path (target folder + optional subfolder).
		const subfolder = (this.subfolderInput?.value ?? '').trim().replace(/^\/+|\/+$/g, '');
		const baseFolder = pair.config.targetFolder.replace(/\/+$/, '').trim();
		const destFolder = normalizePath(subfolder ? `${baseFolder}/${subfolder}` : baseFolder);
		await this.ensureFolder(destFolder);

		const safeTitle = (title || this.noteFile.basename).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'note';
		let fileName = `${safeTitle}.md`;
		let attempt = 1;
		while (this.app.vault.getAbstractFileByPath(normalizePath(`${destFolder}/${fileName}`))) {
			fileName = dedupeName(`${safeTitle}.md`, ++attempt);
		}
		const notePath = normalizePath(`${destFolder}/${fileName}`);

		// 3. Create the note, fill template frontmatter, add a source back-link.
		const newFile = await this.app.vault.create(notePath, body.trim() ? `\n${body.trim()}\n` : '\n');

		const fill = await fillTemplateFrontmatter(
			pair.template,
			this.noteFile.basename,
			this.noteFrontmatter,
			this.noteBody,
			this.gateway,
			persist,
		);
		await applyTemplateFrontmatter(this.app, newFile, pair.template, fill.ok ? fill.value : {});
		await this.app.fileManager.processFrontMatter(newFile, (fm: Record<string, unknown>) => {
			fm.source = `[[${this.noteFile.basename}]]`;
		});

		await this.app.workspace.getLeaf(true).openFile(newFile);
		new Notice(`FileDrop: created "${newFile.basename}" from "${pair.config.name || pair.template.name}".`);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
