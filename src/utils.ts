export function getMonthSlug(): string {
	const d = new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	return `${yyyy}-${mm}`;
}

// "document.pdf" -> "document_pdf"; leaves no-extension names and dotfiles untouched
export function noteNameFromFile(fileName: string): string {
	const lastDot = fileName.lastIndexOf('.');
	if (lastDot <= 0) return fileName;
	return fileName.slice(0, lastDot) + '_' + fileName.slice(lastDot + 1);
}

// "document.pdf", 2 -> "document-2.pdf"; "README", 2 -> "README-2"
export function dedupeName(fileName: string, i: number): string {
	const lastDot = fileName.lastIndexOf('.');
	if (lastDot <= 0) return `${fileName}-${i}`;
	return `${fileName.slice(0, lastDot)}-${i}${fileName.slice(lastDot)}`;
}

// Rewrite the frontmatter `tags` field to an inline JSON array of quoted strings,
// e.g. `tags: ["a","b"]`. Obsidian's Properties editor re-serializes tags as a
// multi-line YAML block list (`tags:\n  - a\n  - b`); we match that whole block —
// the `tags:` line plus any following `- item` lines — so a rewrite never leaves
// dangling list items behind and mixes the two styles. Requiring whitespace after
// the dash keeps the closing `---` fence from being swallowed.
export function replaceTagsBlock(content: string, tags: string[]): string {
	return content.replace(
		/^tags:[^\n]*(?:\n[ \t]*-[ \t]+[^\n]*)*/m,
		`tags: ${JSON.stringify(tags)}`
	);
}
