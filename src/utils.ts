// Run `fn` over `items` with at most `limit` calls in flight at once, returning
// the results in input order regardless of completion order. The returned array
// is keyed by the original index, so callers get stable ordering for free.
//
// With limit === 1 this is strictly sequential and behaviorally identical to a
// plain `for await` loop: item N+1 starts only after item N has fully settled.
// `fn` is expected not to reject (callers wrap per-item work in try/catch); if it
// does, the rejection propagates out of the returned promise.
export async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	const max = Math.max(1, Math.floor(limit) || 1);
	let next = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	};

	const workerCount = Math.min(max, items.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}

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

// Local-time base name for pasted clipboard content, e.g. "pasted-2026-06-03-141530".
// Includes seconds so repeated pastes within a minute stay unique on their own.
export function pastedBaseName(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return `pasted-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Map a clipboard blob MIME type to a file extension (no dot).
export function extFromMime(mime: string): string {
	const m = (mime || '').toLowerCase().split(';')[0].trim();
	const map: Record<string, string> = {
		'image/png': 'png',
		'image/jpeg': 'jpg',
		'image/jpg': 'jpg',
		'image/gif': 'gif',
		'image/webp': 'webp',
		'image/bmp': 'bmp',
		'image/svg+xml': 'svg',
		'text/plain': 'txt',
		'text/html': 'html',
		'text/markdown': 'md',
	};
	if (map[m]) return map[m];
	const subtype = m.split('/')[1];
	return subtype && /^[a-z0-9]+$/.test(subtype) ? subtype : 'bin';
}

// Turn an LLM-suggested label into a safe base filename (no extension):
// lowercase, only [a-z0-9-], collapsed/trimmed dashes, capped length.
// Returns `fallback` when nothing usable remains.
export function sanitizeFilename(name: string, fallback: string): string {
	const dot = name.lastIndexOf('.');
	const base = dot > 0 ? name.slice(0, dot) : name;
	const cleaned = base
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 60)
		.replace(/-$/, '');
	return cleaned.length > 0 ? cleaned : fallback;
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
