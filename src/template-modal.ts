import { App, Modal, Notice, TFile } from 'obsidian';

import { LlmGateway } from './settings';
import { TemplateNote, applyTemplateFrontmatter, fillTemplateFrontmatter } from './templates';
import type FileDropPlugin from '../main';

// Confirms which template to apply to the current note, then fills the chosen
// template's frontmatter via the LLM and merges it in (keeping existing
// frontmatter and the body unchanged).
export class TemplateModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: FileDropPlugin,
		private readonly noteFile: TFile,
		private readonly noteFrontmatter: Record<string, unknown>,
		private readonly noteBody: string,
		private readonly ranked: TemplateNote[],
		private readonly usedLlm: boolean,
		private readonly gateway: LlmGateway | null,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: `Fix to template — ${this.noteFile.basename}` });

		if (this.ranked.length === 0) {
			contentEl.createEl('p', { text: 'No templates found in the configured template folder.' });
			const row = contentEl.createDiv({ cls: 'filedrop-ref-modal-buttons' });
			row.createEl('button', { text: 'Close' }).addEventListener('click', () => this.close());
			return;
		}

		contentEl.createEl('p', {
			text: this.usedLlm
				? 'The selected template was matched by the LLM. Confirm or pick another:'
				: 'Select the template to apply:',
			cls: 'filedrop-ref-modal-hint',
		});

		const list = contentEl.createDiv({ cls: 'filedrop-ref-modal-list' });
		const radios: HTMLInputElement[] = [];
		const groupName = `filedrop-template-${this.noteFile.path}`;

		this.ranked.forEach((template, i) => {
			const item = list.createDiv({ cls: 'filedrop-ref-modal-item' });
			const radio = item.createEl('input');
			radio.type = 'radio';
			radio.name = groupName;
			radio.checked = i === 0;
			radios.push(radio);

			const labelEl = item.createDiv({ cls: 'filedrop-ref-modal-label' });
			labelEl.createEl('strong', { text: template.name });

			const fields = Object.keys(template.frontmatter);
			if (fields.length) {
				labelEl.createDiv({ text: fields.join(', '), cls: 'filedrop-ref-modal-desc' });
			} else {
				labelEl.createDiv({ text: '(no frontmatter fields)', cls: 'filedrop-ref-modal-desc' });
			}
		});

		const btnRow = contentEl.createDiv({ cls: 'filedrop-ref-modal-buttons' });
		btnRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());

		const applyBtn = btnRow.createEl('button', { text: 'Apply template', cls: 'mod-cta' });
		applyBtn.addEventListener('click', async () => {
			const selected = this.ranked[radios.findIndex((r) => r.checked)] ?? this.ranked[0];
			applyBtn.disabled = true;
			applyBtn.textContent = 'Applying…';
			try {
				const fill = await fillTemplateFrontmatter(
					selected,
					this.noteFile.basename,
					this.noteFrontmatter,
					this.noteBody,
					this.gateway,
					() => this.plugin.saveSettings(),
				);
				if (!fill.ok) {
					new Notice('FileDrop: could not fill template fields (see console). Applying empty fields.');
				}
				const filled = fill.ok ? fill.value : {};
				const added = await applyTemplateFrontmatter(this.app, this.noteFile, selected, filled);
				new Notice(
					added.length
						? `FileDrop: applied "${selected.name}" — added ${added.length} field${added.length !== 1 ? 's' : ''}.`
						: `FileDrop: "${selected.name}" added no new fields (all already present).`,
				);
				this.close();
			} catch (e) {
				console.error('FileDrop: failed to apply template', e);
				new Notice('FileDrop: failed to apply template (see console).');
				applyBtn.disabled = false;
				applyBtn.textContent = 'Apply template';
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
