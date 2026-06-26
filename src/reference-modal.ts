import { App, Modal, Notice, TFile } from 'obsidian';

import { LlmGateway, isGatewayEnabled } from './settings';
import {
	ActivityMetadata,
	MatchedNote,
	renderReferenceBlock,
	insertReferenceIntoNote,
	insertTaskIntoNote,
	generateTodoTask,
	normalizeTaskLine,
} from './references';
import type FileDropPlugin from '../main';

export class ReferenceModal extends Modal {
	private plugin: FileDropPlugin;
	private filename: string;
	private noteFile: TFile;
	private metadata: ActivityMetadata;
	private summary: string;
	private matchedNotes: MatchedNote[];
	private ranked: boolean;
	private gateway: LlmGateway | null;

	constructor(
		app: App,
		plugin: FileDropPlugin,
		filename: string,
		noteFile: TFile,
		metadata: ActivityMetadata,
		summary: string,
		matchedNotes: MatchedNote[],
		ranked: boolean,
		gateway: LlmGateway | null,
	) {
		super(app);
		this.plugin = plugin;
		this.filename = filename;
		this.noteFile = noteFile;
		this.metadata = metadata;
		this.summary = summary;
		this.matchedNotes = matchedNotes;
		this.ranked = ranked;
		this.gateway = gateway;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: `Add References — ${this.filename}` });

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

		// --- Follow-up todo ---
		const gatewayActive = !!this.gateway && isGatewayEnabled(this.gateway);

		const todoLabel = contentEl.createEl('label', { cls: 'filedrop-ref-modal-todo-toggle' });
		const todoCheckbox = todoLabel.createEl('input');
		todoCheckbox.type = 'checkbox';
		todoLabel.appendText(' Add a follow-up todo');

		const todoBox = contentEl.createDiv({ cls: 'filedrop-ref-modal-todo' });
		todoBox.style.display = 'none';

		const todoInstructionLabel = todoBox.createEl('div', { cls: 'filedrop-summary-compare-label', text: "What's the follow-up?" });
		const todoInput = todoBox.createEl('textarea', { cls: 'filedrop-ref-modal-todo-input' });
		todoInput.placeholder = gatewayActive
			? 'e.g. follow up in a month'
			: 'e.g. - [ ] follow up with the team';
		todoInput.rows = 2;
		let hasGeneratedTodo = false;

		todoBox.createEl('div', { cls: 'filedrop-summary-compare-label', text: 'Task line' });
		const todoTaskInput = todoBox.createEl('textarea', { cls: 'filedrop-ref-modal-todo-input' });
		todoTaskInput.placeholder = '- [ ] …';
		todoTaskInput.rows = 2;

		// "Add to" target dropdown — only relevant when more than one note is selected.
		const targetRow = todoBox.createDiv({ cls: 'filedrop-ref-modal-todo-target' });
		targetRow.createSpan({ text: 'Add to: ' });
		const todoTargetSelect = targetRow.createEl('select');

		const refreshTargets = (): void => {
			const selected = this.matchedNotes.filter((_, i) => checkboxes[i].checked);
			const prev = todoTargetSelect.value;
			todoTargetSelect.empty();
			for (const m of selected) {
				const opt = todoTargetSelect.createEl('option');
				opt.value = m.candidate.file.path;
				opt.text = `${m.candidate.name} (${m.group.name})`;
			}
			if (selected.some((m) => m.candidate.file.path === prev)) todoTargetSelect.value = prev;
			// Only ask which note when more than one is selected and the todo is enabled.
			targetRow.style.display = todoCheckbox.checked && selected.length > 1 ? '' : 'none';
		};

		if (gatewayActive) {
			const genRow = todoBox.createDiv({ cls: 'filedrop-ref-modal-todo-gen' });
			const genBtn = genRow.createEl('button', { text: 'Generate' });
			genBtn.addEventListener('click', async () => {
				const intent = todoInput.value.trim();
				if (!hasGeneratedTodo && !intent) {
					new Notice('FileDrop: type what the todo should be first.');
					return;
				}
				genBtn.disabled = true;
				genBtn.textContent = 'Generating…';
				try {
					const today = new Date().toISOString().slice(0, 10);
					const currentTask = hasGeneratedTodo ? todoTaskInput.value.trim() : undefined;
					const noteContent = (await this.app.vault.read(this.noteFile)).slice(0, 6000);
					const result = await generateTodoTask(
						intent,
						{ title: this.noteFile.basename, summary: this.summary, date: this.metadata.date, noteContent },
						this.gateway!,
						today,
						this.plugin.settings.todoPrompt,
						() => this.plugin.saveSettings(),
						currentTask,
					);
					if (result.ok && result.value) {
						todoTaskInput.value = result.value;
						hasGeneratedTodo = true;
						todoInstructionLabel.textContent = 'What to change?';
						todoInput.value = '';
						todoInput.placeholder = 'e.g. push it out a week — leave blank to regenerate';
					} else {
						if (!result.ok) console.error('FileDrop: generate todo failed', result.reason, result.detail);
						else console.error('FileDrop: generate todo returned an empty task line');
						new Notice('FileDrop: could not generate todo (see console).');
					}
				} finally {
					genBtn.disabled = false;
					genBtn.textContent = 'Generate';
				}
			});
		}

		todoCheckbox.addEventListener('change', () => {
			todoBox.style.display = todoCheckbox.checked ? '' : 'none';
			refreshTargets();
		});
		for (const cb of checkboxes) cb.addEventListener('change', refreshTargets);
		refreshTargets();

		const selectedTodoTarget = (): MatchedNote | null => {
			const selected = this.matchedNotes.filter((_, i) => checkboxes[i].checked);
			if (selected.length === 0) return null;
			if (selected.length === 1) return selected[0];
			return selected.find((m) => m.candidate.file.path === todoTargetSelect.value) ?? null;
		};

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

			// Optional follow-up todo, written into a single selected note.
			let todoCount = 0;
			const todoText = todoTaskInput.value.trim() || todoInput.value.trim();
			if (todoCheckbox.checked && todoText) {
				const target = selectedTodoTarget();
				if (!target) {
					new Notice('FileDrop: no note selected for the todo — skipped.');
				} else {
					const taskLine = normalizeTaskLine(todoText);
					if (!taskLine) {
						new Notice('FileDrop: the todo was empty — skipped.');
					} else {
						try {
							const current = await this.app.vault.read(target.candidate.file);
							const updated = insertTaskIntoNote(current, taskLine, this.plugin.settings.todoSection);
							await this.app.vault.modify(target.candidate.file, updated);
							todoCount = 1;
						} catch (e) {
							console.error('FileDrop: failed to write todo to', target.candidate.file.path, e);
							new Notice(`FileDrop: could not write the todo to ${target.candidate.name} (see console).`);
						}
					}
				}
			}

			const todoMsg = todoCount ? `; added ${todoCount} todo` : '';
			new Notice(`FileDrop: added reference to ${count} note${count !== 1 ? 's' : ''}${todoMsg}.`);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
