import { App, Modal, Notice, TFile } from 'obsidian';

import { DroppedFile } from './settings';
import { ActivityMetadata, MatchedNote, renderReferenceBlock, insertReferenceIntoNote } from './references';
import type FileDropPlugin from '../main';

export class ReferenceModal extends Modal {
	private plugin: FileDropPlugin;
	private entry: DroppedFile;
	private noteFile: TFile;
	private metadata: ActivityMetadata;
	private summary: string;
	private matchedNotes: MatchedNote[];
	private ranked: boolean;

	constructor(
		app: App,
		plugin: FileDropPlugin,
		entry: DroppedFile,
		noteFile: TFile,
		metadata: ActivityMetadata,
		summary: string,
		matchedNotes: MatchedNote[],
		ranked: boolean,
	) {
		super(app);
		this.plugin = plugin;
		this.entry = entry;
		this.noteFile = noteFile;
		this.metadata = metadata;
		this.summary = summary;
		this.matchedNotes = matchedNotes;
		this.ranked = ranked;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: `Add References — ${this.entry.filename}` });

		if (this.matchedNotes.length === 0) {
			contentEl.createEl('p', { text: 'No matching notes found.' });
			const btnRow = contentEl.createDiv({ cls: 'filedrop-ref-modal-buttons' });
			btnRow.createEl('button', { text: 'Close' }).addEventListener('click', () => this.close());
			return;
		}

		contentEl.createEl('p', {
			text: 'Select which notes to add a reference to:',
			cls: 'filedrop-ref-modal-hint',
		});

		const list = contentEl.createDiv({ cls: 'filedrop-ref-modal-list' });
		const checkboxes: HTMLInputElement[] = [];

		for (let i = 0; i < this.matchedNotes.length; i++) {
			const match = this.matchedNotes[i];
			const item = list.createDiv({ cls: 'filedrop-ref-modal-item' });
			const cb = item.createEl('input');
			cb.type = 'checkbox';
			// Ranked: pre-select only the top LLM pick. Fallback (unranked): nothing pre-selected.
			cb.checked = this.ranked && i === 0;
			checkboxes.push(cb);

			const labelEl = item.createDiv({ cls: 'filedrop-ref-modal-label' });
			labelEl.createEl('strong', { text: match.candidate.name });
			labelEl.createSpan({ text: ` (${match.group.name})`, cls: 'filedrop-ref-modal-group' });

			const desc = Object.values(match.candidate.contextFields).join(' · ').slice(0, 100);
			if (desc) {
				labelEl.createDiv({ text: desc, cls: 'filedrop-ref-modal-desc' });
			}
		}

		const btnRow = contentEl.createDiv({ cls: 'filedrop-ref-modal-buttons' });

		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const confirmBtn = btnRow.createEl('button', { text: 'Add References', cls: 'mod-cta' });
		confirmBtn.addEventListener('click', async () => {
			confirmBtn.disabled = true;
			confirmBtn.textContent = 'Adding…';

			const selected = this.matchedNotes.filter((_, i) => checkboxes[i].checked);
			if (selected.length === 0) {
				this.close();
				return;
			}

			const globalTemplate = this.plugin.settings.referenceTemplate;
			const vars = {
				date: this.metadata.date ?? '',
				type: this.metadata.type ?? '',
				summary: this.summary,
				title: this.noteFile.basename,
				people: (this.metadata.people ?? []).join(', '),
				note_link: `[[${this.noteFile.path.replace(/\.md$/, '')}]]`,
			};

			let count = 0;
			for (const match of selected) {
				const targetFile = match.candidate.file;
				const template = match.group.template || globalTemplate;
				const block = renderReferenceBlock(template, vars);

				try {
					// Read fresh to avoid stale content
					const current = await this.app.vault.read(targetFile);
					const updated = insertReferenceIntoNote(current, block, match.group.targetSection);
					await this.app.vault.modify(targetFile, updated);
					count++;
				} catch (e) {
					console.error('FileDrop: failed to write reference to', targetFile.path, e);
				}
			}

			new Notice(`FileDrop: added reference to ${count} note${count !== 1 ? 's' : ''}.`);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
