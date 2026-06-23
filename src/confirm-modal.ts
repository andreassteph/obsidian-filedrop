import { App, Modal } from 'obsidian';

// A small generic yes/no dialog. `confirmModal()` resolves to `true` when the user
// confirms and `false` when they cancel or dismiss it (so the promise never hangs).
export class ConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly opts: { title: string; message: string; confirmText: string; cancelText: string },
		private readonly resolve: (value: boolean) => void,
	) {
		super(app);
	}

	private done(value: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(value);
		this.close();
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this.opts.title });
		contentEl.createEl('p', { text: this.opts.message });

		const btnRow = contentEl.createDiv({ cls: 'filedrop-ref-modal-buttons' });

		const cancelBtn = btnRow.createEl('button', { text: this.opts.cancelText });
		cancelBtn.addEventListener('click', () => this.done(false));

		const confirmBtn = btnRow.createEl('button', { text: this.opts.confirmText, cls: 'mod-cta' });
		confirmBtn.addEventListener('click', () => this.done(true));
	}

	onClose(): void {
		this.contentEl.empty();
		// Dismissed without a button press (Esc / click-away) counts as cancel.
		this.done(false);
	}
}

export function confirmModal(
	app: App,
	opts: { title: string; message: string; confirmText: string; cancelText: string },
): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, opts, resolve).open());
}
