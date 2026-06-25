import { App, TFile } from 'obsidian';

import {
	LlmGateway,
	LlmOpError,
	isGatewayEnabled,
	parsePreferredTags,
	reviseSummary,
	suggestTags,
	summarizeContent,
} from './settings';
import { ActivityMetadata, extractActivityMetadata, fillMetadataWithLLM } from './references';
import { replaceTagsBlock } from './utils';
import type FileDropPlugin from '../main';

// ---------------------------------------------------------------------------
// Result shape
//
// The note tools are exposed as an in-process API (QuickAdd-style: reachable
// via app.plugins.plugins["obsidian-filedrop"].api), so every method returns a
// plain, serializable object instead of throwing or showing UI. `reason`
// extends the LLM error codes with the note/gateway resolution failures.
// ---------------------------------------------------------------------------

export type NoteToolError =
	| LlmOpError
	| 'note-not-found'
	| 'note-ambiguous'
	| 'not-markdown'
	| 'no-gateway';

export type NoteToolResult<T> =
	| ({ ok: true } & T)
	| { ok: false; reason: NoteToolError; detail?: string };

/** Common options shared by every note tool. */
export interface BaseNoteOptions {
	/** Note path or basename. Defaults to the active note. */
	note?: string;
	/** Gateway id or name. Defaults to the selected/first-enabled gateway. */
	gateway?: string;
	/** When true, return the result without writing it back to the note. */
	preview?: boolean;
}

export interface SummarizeOptions extends BaseNoteOptions {
	/** When present, revise the note's existing summary per this instruction. */
	instruction?: string;
	/** Also fill file_date/file_type/file_people when generating a fresh summary (default true). */
	includeMetadata?: boolean;
}

export interface SuggestTagsOptions extends BaseNoteOptions {
	/** Max number of tags to request (default 6, handled by suggestTags). */
	maxTags?: number;
	/** Union the suggestions with existing tags (default true) vs. replace them. */
	merge?: boolean;
}

/** The public API object exposed on the plugin instance. */
export interface FileDropApi {
	summarize(
		options?: SummarizeOptions,
	): Promise<NoteToolResult<{ summary: string; metadata?: ActivityMetadata }>>;
	suggestTags(
		options?: SuggestTagsOptions,
	): Promise<NoteToolResult<{ tags: string[]; added: string[] }>>;
}

type NoteResolution = { ok: true; file: TFile } | { ok: false; reason: NoteToolError; detail?: string };

export class NoteTools {
	constructor(
		private readonly app: App,
		private readonly plugin: FileDropPlugin,
	) {}

	private persist = (): Promise<void> => this.plugin.saveSettings();

	/**
	 * Map a `note` parameter (vault path or basename) to a markdown TFile,
	 * defaulting to the active note. Returns a typed failure instead of throwing.
	 */
	private resolveNote(note?: string): NoteResolution {
		if (!note || note.trim().length === 0) {
			const active = this.app.workspace.getActiveFile();
			if (!(active instanceof TFile)) return { ok: false, reason: 'note-not-found', detail: 'no active note' };
			if (active.extension !== 'md') return { ok: false, reason: 'not-markdown', detail: active.path };
			return { ok: true, file: active };
		}

		// Exact path first.
		const byPath = this.app.vault.getAbstractFileByPath(note);
		if (byPath instanceof TFile) {
			if (byPath.extension !== 'md') return { ok: false, reason: 'not-markdown', detail: byPath.path };
			return { ok: true, file: byPath };
		}

		// Fall back to a basename match across markdown notes.
		const wanted = note.replace(/\.md$/i, '').toLowerCase();
		const matches = this.app.vault.getMarkdownFiles().filter((f) => f.basename.toLowerCase() === wanted);
		if (matches.length === 1) return { ok: true, file: matches[0] };
		if (matches.length > 1) {
			return { ok: false, reason: 'note-ambiguous', detail: `${matches.length} notes named "${note}"` };
		}
		return { ok: false, reason: 'note-not-found', detail: note };
	}

	/**
	 * Resolve the gateway by id or name, defaulting to the sidebar's selected
	 * gateway and then the first enabled one.
	 */
	private resolveGateway(gateway?: string): LlmGateway | null {
		const gateways = this.plugin.settings.llmGateways;
		if (gateway && gateway.trim().length > 0) {
			const wanted = gateway.toLowerCase();
			return gateways.find((g) => g.id === gateway || g.name.toLowerCase() === wanted) ?? null;
		}
		const selectedId = this.plugin.getActiveView()?.selectedGatewayId ?? null;
		const selected = selectedId ? gateways.find((g) => g.id === selectedId) : null;
		if (selected && isGatewayEnabled(selected)) return selected;
		return gateways.find((g) => isGatewayEnabled(g)) ?? null;
	}

	private readBody(content: string): string {
		const i = content.indexOf('\n---\n');
		return i >= 0 ? content.slice(i + 5) : content;
	}

	async summarize(
		options: SummarizeOptions = {},
	): Promise<NoteToolResult<{ summary: string; metadata?: ActivityMetadata }>> {
		const noteRes = this.resolveNote(options.note);
		if (!noteRes.ok) return noteRes;
		const gateway = this.resolveGateway(options.gateway);
		if (!gateway || !isGatewayEnabled(gateway)) return { ok: false, reason: 'no-gateway' };

		const file = noteRes.file;
		const content = await this.app.vault.read(file);
		const body = this.readBody(content);

		// Revise path: when an instruction is supplied, revise the existing
		// summary rather than regenerating from scratch.
		if (options.instruction && options.instruction.trim().length > 0) {
			const current: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.summary;
			const currentSummary = typeof current === 'string' ? current : '';
			const result = await reviseSummary(body, currentSummary, options.instruction, gateway, undefined, this.persist);
			if (!result.ok) return result;
			if (!options.preview) await writeNoteSummary(this.app, file.path, result.value);
			return { ok: true, summary: result.value };
		}

		const includeMetadata = options.includeMetadata !== false;
		let metadata = extractActivityMetadata(body, file.path, file.stat);
		const hasNullMetadata = metadata.date === null || metadata.type === null || metadata.people === null;
		const fillPromise = includeMetadata && hasNullMetadata
			? fillMetadataWithLLM(metadata, body, gateway, this.persist)
			: null;

		const [result, fillResult] = await Promise.all([
			summarizeContent(body, gateway, undefined, this.persist),
			fillPromise,
		]);
		if (!result.ok) return result;
		if (fillResult?.ok) metadata = fillResult.value;

		if (!options.preview) {
			if (includeMetadata) await writeNoteSummaryAndMetadata(this.app, file.path, result.value, metadata);
			else await writeNoteSummary(this.app, file.path, result.value);
		}
		return includeMetadata
			? { ok: true, summary: result.value, metadata }
			: { ok: true, summary: result.value };
	}

	async suggestTags(
		options: SuggestTagsOptions = {},
	): Promise<NoteToolResult<{ tags: string[]; added: string[] }>> {
		const noteRes = this.resolveNote(options.note);
		if (!noteRes.ok) return noteRes;
		const gateway = this.resolveGateway(options.gateway);
		if (!gateway || !isGatewayEnabled(gateway)) return { ok: false, reason: 'no-gateway' };

		const file = noteRes.file;
		const content = await this.app.vault.read(file);
		const body = this.readBody(content);

		const result = await suggestTags(
			body,
			gateway,
			parsePreferredTags(this.plugin.settings.preferredTags),
			options.maxTags !== undefined ? { maxTags: options.maxTags } : undefined,
			this.persist,
		);
		if (!result.ok) return result;

		const existingRaw = this.app.metadataCache.getFileCache(file)?.frontmatter?.tags;
		const existing: string[] = Array.isArray(existingRaw) ? existingRaw.map(String) : [];
		const merge = options.merge !== false;
		const tags = merge ? Array.from(new Set([...existing, ...result.value])) : Array.from(new Set(result.value));
		const added = result.value.filter((t) => !existing.includes(t));

		if (!options.preview) await rewriteNoteTags(this.app, file.path, tags);
		return { ok: true, tags, added };
	}
}

/** Build the public, serializable API object bound to a NoteTools instance. */
export function buildFileDropApi(tools: NoteTools): FileDropApi {
	return {
		summarize: (options) => tools.summarize(options),
		suggestTags: (options) => tools.suggestTags(options),
	};
}

// ---------------------------------------------------------------------------
// Frontmatter writers
//
// Shared by both the sidebar view (src/view.ts) and the note-tools service so
// there is a single write path for summaries, metadata, and tags.
// ---------------------------------------------------------------------------

export async function writeNoteSummary(app: App, notePath: string, summary: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return;
	const content = await app.vault.read(file);
	const line = `summary: ${JSON.stringify(summary)}`;
	let updated: string;
	if (/^summary:.*$/m.test(content)) {
		updated = content.replace(/^summary:.*$/m, line);
	} else {
		const c = content.indexOf('\n---\n');
		if (c < 0) return;
		updated = content.slice(0, c) + '\n' + line + content.slice(c);
	}
	await app.vault.modify(file, updated);
}

export async function writeNoteSummaryAndMetadata(
	app: App,
	notePath: string,
	summary: string,
	metadata: { date: string | null; type: string | null; people: string[] | null },
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return;
	const content = await app.vault.read(file);

	const fmEndIndex = content.indexOf('\n---\n');
	if (fmEndIndex < 0) return;

	const fmStart = content.slice(0, fmEndIndex);
	const fmBody = content.slice(fmEndIndex);

	// Build replacement lines for frontmatter fields
	const lines: string[] = [];
	lines.push(`summary: ${JSON.stringify(summary)}`);
	if (metadata.date) lines.push(`file_date: ${JSON.stringify(metadata.date)}`);
	if (metadata.type) lines.push(`file_type: ${JSON.stringify(metadata.type)}`);
	if (metadata.people && metadata.people.length > 0) {
		lines.push(`file_people: [${metadata.people.map((p) => JSON.stringify(p)).join(', ')}]`);
	}

	// Replace existing lines or add new ones
	let updated = fmStart;
	for (const line of lines) {
		const field = line.split(':')[0];
		const fieldRegex = new RegExp(`^${field}:.*$`, 'm');
		if (fieldRegex.test(updated)) {
			updated = updated.replace(fieldRegex, line);
		} else {
			updated += '\n' + line;
		}
	}
	updated += fmBody;

	await app.vault.modify(file, updated);
}

export async function rewriteNoteTags(app: App, notePath: string, tags: string[]): Promise<void> {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return;
	const content = await app.vault.read(file);
	const updated = replaceTagsBlock(content, tags);
	await app.vault.modify(file, updated);
}
