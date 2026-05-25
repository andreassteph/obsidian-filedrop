import { ItemView, Plugin, WorkspaceLeaf } from 'obsidian';

const VIEW_TYPE = 'filedrop-sidebar';

class FileDropView extends ItemView {
	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'FileDrop';
	}

	getIcon(): string {
		return 'inbox';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('filedrop-container');

		const dropZone = container.createDiv({ cls: 'filedrop-zone' });
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

		dropZone.addEventListener('drop', (e) => {
			e.preventDefault();
			dropZone.removeClass('filedrop-zone--active');

			const files = e.dataTransfer?.files;
			if (!files || files.length === 0) return;

			// TODO: pass files to markitdown for conversion
			Array.from(files).forEach((file) => {
				console.log('[filedrop] dropped:', file.name, file.type);
			});
		});
	}

	async onClose(): Promise<void> {
		// nothing to clean up
	}
}

export default class FileDropPlugin extends Plugin {
	async onload(): Promise<void> {
		this.registerView(VIEW_TYPE, (leaf) => new FileDropView(leaf));

		this.addRibbonIcon('inbox', 'FileDrop', () => this.activateView());

		this.addCommand({
			id: 'open-filedrop',
			name: 'Open FileDrop sidebar',
			callback: () => this.activateView(),
		});
	}

	async onunload(): Promise<void> {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
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
