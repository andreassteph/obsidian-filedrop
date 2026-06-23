import { AbstractInputSuggest, App, TFile, TFolder } from 'obsidian';

const SUGGESTION_LIMIT = 50;

function matches(path: string, query: string): boolean {
	return path.toLowerCase().includes(query.toLowerCase());
}

export class FileSuggest extends AbstractInputSuggest<TFile> {
	constructor(app: App, inputEl: HTMLInputElement, onSelect: (file: TFile) => void) {
		super(app, inputEl);
		this.onSelect((file) => onSelect(file));
	}

	getSuggestions(query: string): TFile[] {
		const files = this.app.vault.getMarkdownFiles();
		const filtered = query ? files.filter((f) => matches(f.path, query)) : files;
		return filtered.slice(0, SUGGESTION_LIMIT);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}
}

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, inputEl: HTMLInputElement, onSelect: (folder: TFolder) => void) {
		super(app, inputEl);
		this.onSelect((folder) => onSelect(folder));
	}

	getSuggestions(query: string): TFolder[] {
		const folders: TFolder[] = [];
		const collect = (folder: TFolder) => {
			folders.push(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) collect(child);
			}
		};
		collect(this.app.vault.getRoot());

		const filtered = query ? folders.filter((f) => matches(f.path, query)) : folders;
		return filtered.slice(0, SUGGESTION_LIMIT);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path === '/' ? '/ (vault root)' : folder.path);
	}
}
