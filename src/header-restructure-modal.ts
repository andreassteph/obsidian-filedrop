import { App, Modal, Notice, TFile } from 'obsidian';

import { LlmGateway, isGatewayEnabled } from './settings';
import {
	HeaderMappingEntry,
	ParsedHeaderNote,
	reassembleHeaderBody,
	reviseHeaderMapping,
} from './header-restructure';
import { llmErrorMessage } from './view';
import type FileDropPlugin from '../main';

// Confirms the proposed header reorder/relevel/rename for a note, lets the
// user tweak it inline or ask the LLM to revise it, then rewrites the SAME
// note's body in place. Section content is never touched — only header lines
// are rewritten/reordered.
export class HeaderRestructureModal extends Modal {
	private busy = false;
	private listEl: HTMLElement | null = null;
	private hintEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly plugin: FileDropPlugin,
		private readonly noteFile: TFile,
		private readonly noteFrontmatter: Record<string, unknown>,
		private readonly fmBlock: string,
		private readonly parsed: ParsedHeaderNote,
		private mapping: HeaderMappingEntry[],
		private usedLlm: boolean,
		private readonly gateway: LlmGateway | null,
	) {
		super(app);
	}

	private persist = (): Promise<void> => this.plugin.saveSettings();

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: `Restructure headers — ${this.noteFile.basename}` });

		this.hintEl = contentEl.createEl('p', { cls: 'filedrop-ref-modal-hint' });
		this.updateHint();

		this.listEl = contentEl.createDiv({ cls: 'filedrop-ref-modal-list' });
		this.renderRows();

		contentEl.createEl('div', { cls: 'filedrop-summary-compare-label', text: 'Instruction for the LLM (optional)' });
		const instructionInput = contentEl.createEl('textarea', { cls: 'filedrop-change-summary-input' });
		instructionInput.placeholder = 'e.g. put setup steps first, keep the overview near the top';
		instructionInput.rows = 2;

		const btnRow = contentEl.createDiv({ cls: 'filedrop-confirm-buttons' });
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const reviseBtn = btnRow.createEl('button', { text: 'Revise' });
		reviseBtn.addEventListener('click', async () => {
			if (this.busy) return;
			const instruction = instructionInput.value.trim();
			if (!instruction) {
				new Notice('FileDrop: describe what to change first.');
				return;
			}
			if (!this.gateway || !isGatewayEnabled(this.gateway)) {
				new Notice('FileDrop: select an LLM model first.');
				return;
			}
			this.busy = true;
			reviseBtn.disabled = true;
			reviseBtn.textContent = 'Revising…';
			try {
				const result = await reviseHeaderMapping(
					this.noteFile.basename,
					this.noteFrontmatter,
					this.parsed,
					this.mapping,
					instruction,
					this.gateway,
					this.persist,
				);
				if (!result.ok) {
					new Notice(`FileDrop: could not revise the header order — ${llmErrorMessage(result.reason, result.detail)}.`);
					return;
				}
				this.mapping = result.value;
				this.usedLlm = true;
				this.updateHint();
				this.renderRows();
			} finally {
				this.busy = false;
				reviseBtn.disabled = false;
				reviseBtn.textContent = 'Revise';
			}
		});

		const applyBtn = btnRow.createEl('button', { text: 'Apply', cls: 'mod-cta' });
		applyBtn.addEventListener('click', async () => {
			if (this.busy) return;
			if (this.mapping.some((entry) => entry.text.trim().length === 0)) {
				new Notice('FileDrop: every header needs text.');
				return;
			}
			this.busy = true;
			applyBtn.disabled = true;
			applyBtn.textContent = 'Working…';
			try {
				const body = reassembleHeaderBody(this.parsed, this.mapping);
				await this.app.vault.modify(this.noteFile, this.fmBlock + body);
				new Notice('FileDrop: note headers restructured.');
				this.close();
			} catch (e) {
				console.error('FileDrop: failed to apply header restructure', e);
				new Notice('FileDrop: could not restructure headers (see console).');
			} finally {
				this.busy = false;
				applyBtn.disabled = false;
				applyBtn.textContent = 'Apply';
			}
		});
	}

	private updateHint(): void {
		if (!this.hintEl) return;
		this.hintEl.setText(
			this.usedLlm
				? 'Suggested reorder — review, edit, or revise:'
				: 'No LLM suggestion available — reorder manually, or configure a gateway and click Revise.',
		);
	}

	private renderRows(): void {
		if (!this.listEl) return;
		this.listEl.empty();

		this.mapping.forEach((entry, i) => {
			const original = this.parsed.sections[entry.index];
			const row = this.listEl!.createDiv({ cls: 'filedrop-header-row' });

			row.createSpan({ cls: 'filedrop-header-row-old', text: `H${original.level} — ${original.text}` });
			row.createSpan({ cls: 'filedrop-header-row-arrow', text: '→' });

			const levelSelect = row.createEl('select', { cls: 'filedrop-header-row-level' });
			for (let level = 1; level <= 6; level++) {
				const opt = levelSelect.createEl('option', { text: `H${level}`, value: String(level) });
				if (level === entry.level) opt.selected = true;
			}
			levelSelect.addEventListener('change', () => {
				entry.level = Number(levelSelect.value);
			});

			const textInput = row.createEl('input', { cls: 'filedrop-header-row-text' });
			textInput.type = 'text';
			textInput.value = entry.text;
			textInput.addEventListener('input', () => {
				entry.text = textInput.value;
			});

			const moveUp = row.createEl('button', { cls: 'filedrop-header-row-move', text: '↑' });
			moveUp.disabled = i === 0;
			moveUp.addEventListener('click', () => {
				[this.mapping[i - 1], this.mapping[i]] = [this.mapping[i], this.mapping[i - 1]];
				this.renderRows();
			});

			const moveDown = row.createEl('button', { cls: 'filedrop-header-row-move', text: '↓' });
			moveDown.disabled = i === this.mapping.length - 1;
			moveDown.addEventListener('click', () => {
				[this.mapping[i], this.mapping[i + 1]] = [this.mapping[i + 1], this.mapping[i]];
				this.renderRows();
			});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
