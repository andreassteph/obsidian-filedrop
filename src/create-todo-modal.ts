import { App, Modal, Notice } from 'obsidian';

import { LlmGateway, isGatewayEnabled } from './settings';
import { generateTodoTask, normalizeTaskLine } from './references';

// Standalone "create a follow-up todo" prompt. The caller supplies the current
// note as context (title/summary/date plus the text around the cursor) so the
// LLM can turn a short instruction into a reasonable Obsidian Tasks line. When
// no gateway is active the user just types the task line directly. Scheduling is
// handled in natural language by the todo prompt (e.g. "follow up in a month" →
// "⏳ <date>") — there is no separate date picker.
export class CreateTodoModal extends Modal {
	constructor(
		app: App,
		private readonly gateway: LlmGateway | null,
		private readonly ctx: { title: string; summary: string; date: string | null; cursorContext?: string },
		private readonly todoPrompt: string,
		private readonly persist: () => Promise<void>,
		private readonly onInsert: (taskLine: string) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const gatewayActive = !!this.gateway && isGatewayEnabled(this.gateway);

		this.contentEl.createEl('h3', { text: 'Create todo' });

		this.contentEl.createEl('div', { cls: 'filedrop-summary-compare-label', text: "What's the follow-up?" });
		const instructionInput = this.contentEl.createEl('textarea', { cls: 'filedrop-change-summary-input' });
		instructionInput.placeholder = gatewayActive
			? 'e.g. follow up in a month'
			: 'e.g. - [ ] follow up with the team';
		instructionInput.rows = 3;

		this.contentEl.createEl('div', { cls: 'filedrop-summary-compare-label', text: 'Task line' });
		const taskInput = this.contentEl.createEl('textarea', { cls: 'filedrop-change-summary-input' });
		taskInput.placeholder = '- [ ] …';
		taskInput.rows = 2;

		const buttons = this.contentEl.createDiv({ cls: 'filedrop-confirm-buttons' });
		const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		if (gatewayActive) {
			const generateBtn = buttons.createEl('button', { cls: 'mod-cta', text: 'Generate' });
			generateBtn.addEventListener('click', async () => {
				const intent = instructionInput.value.trim();
				if (!intent) {
					new Notice('FileDrop: type what the todo should be first.');
					return;
				}
				generateBtn.disabled = true;
				generateBtn.textContent = 'Generating…';
				try {
					const today = new Date().toISOString().slice(0, 10);
					const result = await generateTodoTask(intent, this.ctx, this.gateway!, today, this.todoPrompt, this.persist);
					if (result.ok && result.value) {
						taskInput.value = result.value;
					} else {
						if (!result.ok) console.error('FileDrop: generate todo failed', result.reason, result.detail);
						else console.error('FileDrop: generate todo returned an empty task line');
						new Notice('FileDrop: could not generate todo (see console).');
					}
				} finally {
					generateBtn.disabled = false;
					generateBtn.textContent = 'Generate';
				}
			});
		}

		const insertBtn = buttons.createEl('button', { cls: 'mod-cta', text: 'Insert' });
		insertBtn.addEventListener('click', async () => {
			// Fall back to the raw instruction when the user typed a task line
			// directly (common when no gateway is configured).
			const taskLine = normalizeTaskLine(taskInput.value.trim() || instructionInput.value.trim());
			if (!taskLine) {
				new Notice('FileDrop: nothing to insert — type or generate a task first.');
				return;
			}
			this.close();
			await this.onInsert(taskLine);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
