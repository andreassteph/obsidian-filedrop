import { App, TFile, normalizePath } from 'obsidian';

import {
	LlmGateway,
	LlmOpError,
	NoteToolName,
	isGatewayEnabled,
	parsePreferredTags,
	reviseSummary,
	suggestTags,
	summarizeContent,
} from './settings';
import {
	ActivityMetadata,
	MatchedNote,
	extractActivityMetadata,
	fillMetadataWithLLM,
	findCandidateNotes,
	generateTodoTask,
	insertReferenceIntoNote,
	insertTaskIntoNote,
	matchCandidatesWithLLM,
	normalizeTaskLine,
	renderReferenceBlock,
} from './references';
import { TemplateNote, applyTemplateFrontmatter, fillTemplateFrontmatter, loadTemplatesFromPaths, rankTemplates } from './templates';
import {
	CreateFromTemplatePair,
	existingSubfolders,
	factCheckNoteBody,
	loadTemplatePairs,
	rankTemplatePairs,
	draftNoteFromTemplate,
	suggestSubfolder,
} from './create-from-template';
import {
	HeaderMappingEntry,
	parseHeaderSections,
	reassembleHeaderBody,
	reviseHeaderMapping,
	suggestHeaderMapping,
} from './header-restructure';
import { dedupeName, ensureFolder, replaceTagsBlock } from './utils';
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
	| 'no-gateway'
	| 'no-template'
	| 'no-headers'
	| 'tool-disabled';

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

export interface CreateTodoOptions extends BaseNoteOptions {
	/** Plain-English follow-up request, or (when raw is true) the literal task text/line. */
	intent: string;
	/** Note the task line is written into. Defaults to the same note as `note`. */
	targetNote?: string;
	/** Section heading the task is filed under. Defaults to settings.todoSection. */
	section?: string;
	/** Skip the LLM: normalize `intent` directly into a task line (no gateway required). */
	raw?: boolean;
}

export interface AddReferencesOptions extends BaseNoteOptions {
	/** Cap on LLM-matched notes (default settings.referenceMaxMatches). Ignored when `targets` is given. */
	maxMatches?: number;
	/** Explicit target note path(s)/basename(s) to reference into, bypassing LLM matching entirely. */
	targets?: string[];
	/** Reference-block template. Used (with `section`) only when `targets` is given. */
	template?: string;
	/** Section header for explicit targets. Used only when `targets` is given. */
	section?: string;
	/** Optional follow-up todo intent; generated and written into the first referenced note. */
	todo?: string;
}

export interface FixFrontmatterOptions extends BaseNoteOptions {
	/** Template vault path or basename among the configured template pairs. Omit to auto-rank. */
	template?: string;
}

export interface CreateFromTemplateOptions extends BaseNoteOptions {
	/** TemplatePair id or name. Omit to auto-rank. */
	pair?: string;
	/** New note's title/basename. Defaults to the source note's basename. */
	title?: string;
	/** Destination subfolder under the pair's targetFolder ('' = folder root). Omit to let the LLM suggest one. */
	subfolder?: string;
}

export interface RestructureNoteOptions extends BaseNoteOptions {
	/** Guidance for the LLM's proposed header mapping. */
	instruction?: string;
	/** Explicit mapping to apply. Given alone, applied as-is with no LLM call; given with `instruction`, revised by the LLM (requires a gateway). */
	mapping?: HeaderMappingEntry[];
}

/** The public API object exposed on the plugin instance. */
export interface FileDropApi {
	summarize(
		options?: SummarizeOptions,
	): Promise<NoteToolResult<{ summary: string; metadata?: ActivityMetadata }>>;
	suggestTags(
		options?: SuggestTagsOptions,
	): Promise<NoteToolResult<{ tags: string[]; added: string[] }>>;
	createTodo(
		options: CreateTodoOptions,
	): Promise<NoteToolResult<{ task: string; targetNote: string }>>;
	addReferences(
		options?: AddReferencesOptions,
	): Promise<NoteToolResult<{ referencedNotes: string[]; matched: boolean; todo?: string }>>;
	fixFrontmatter(
		options?: FixFrontmatterOptions,
	): Promise<NoteToolResult<{ template: string; filled: Record<string, unknown>; added?: string[] }>>;
	createFromTemplate(
		options?: CreateFromTemplateOptions,
	): Promise<NoteToolResult<{ notePath: string; template: string; subfolder: string; subfolderIsNew: boolean; body?: string }>>;
	restructureNote(
		options?: RestructureNoteOptions,
	): Promise<NoteToolResult<{ mapping: HeaderMappingEntry[]; usedLlm: boolean }>>;
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

	// Strip Obsidian's internal `position` key the metadata cache sometimes attaches.
	private cleanFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(fm)) {
			if (k === 'position') continue;
			out[k] = v;
		}
		return out;
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

	async createTodo(
		options: CreateTodoOptions,
	): Promise<NoteToolResult<{ task: string; targetNote: string }>> {
		const noteRes = this.resolveNote(options.note);
		if (!noteRes.ok) return noteRes;
		const contextFile = noteRes.file;

		let targetFile = contextFile;
		if (options.targetNote && options.targetNote.trim().length > 0) {
			const targetRes = this.resolveNote(options.targetNote);
			if (!targetRes.ok) return targetRes;
			targetFile = targetRes.file;
		}

		const content = await this.app.vault.read(contextFile);
		const rawFm = this.app.metadataCache.getFileCache(contextFile)?.frontmatter ?? {};
		const summary: string = typeof rawFm.summary === 'string' ? rawFm.summary : '';
		const date: string | null = rawFm.file_date ? String(rawFm.file_date) : null;
		const noteContent = content.slice(0, 6000);

		let task: string;
		if (options.raw) {
			task = normalizeTaskLine(options.intent);
			if (!task) return { ok: false, reason: 'no-reply', detail: 'empty task line' };
		} else {
			const gateway = this.resolveGateway(options.gateway);
			if (!gateway || !isGatewayEnabled(gateway)) return { ok: false, reason: 'no-gateway' };
			const today = new Date().toISOString().slice(0, 10);
			const result = await generateTodoTask(
				options.intent,
				{ title: contextFile.basename, summary, date, noteContent },
				gateway,
				today,
				this.plugin.settings.todoPrompt,
				this.persist,
			);
			if (!result.ok) return result;
			task = result.value;
		}

		if (!options.preview) {
			await writeTaskToNote(this.app, targetFile.path, task, options.section ?? this.plugin.settings.todoSection);
		}
		return { ok: true, task, targetNote: targetFile.path };
	}

	async addReferences(
		options: AddReferencesOptions = {},
	): Promise<NoteToolResult<{ referencedNotes: string[]; matched: boolean; todo?: string }>> {
		const noteRes = this.resolveNote(options.note);
		if (!noteRes.ok) return noteRes;
		const file = noteRes.file;

		const gateway = this.resolveGateway(options.gateway);
		const gatewayActive = !!gateway && isGatewayEnabled(gateway);

		const content = await this.app.vault.read(file);
		const body = this.readBody(content);
		const rawFm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const existingSummary: string = typeof rawFm.summary === 'string' ? rawFm.summary : '';

		let metadata: ActivityMetadata;
		const hasCachedDate = 'file_date' in rawFm && rawFm.file_date;
		const hasCachedType = 'file_type' in rawFm && rawFm.file_type;
		const hasCachedPeople = 'file_people' in rawFm && rawFm.file_people;
		if (hasCachedDate && hasCachedType && hasCachedPeople) {
			metadata = {
				date: String(rawFm.file_date),
				type: String(rawFm.file_type),
				people: Array.isArray(rawFm.file_people) ? rawFm.file_people.map(String) : null,
			};
		} else {
			metadata = extractActivityMetadata(body, file.path, file.stat);
			const hasNullMetadata = metadata.date === null || metadata.type === null || metadata.people === null;
			if (gatewayActive && hasNullMetadata) {
				const fillResult = await fillMetadataWithLLM(metadata, body, gateway!, this.persist);
				if (fillResult.ok) metadata = fillResult.value;
			}
		}

		let summary = existingSummary;
		if (gatewayActive && !existingSummary) {
			const summaryResult = await summarizeContent(body, gateway!, undefined, this.persist);
			if (summaryResult.ok) {
				summary = summaryResult.value;
				if (!options.preview) await writeNoteSummary(this.app, file.path, summary);
			}
		}

		const noteFrontmatter: Record<string, unknown> = { ...rawFm };
		if (summary) noteFrontmatter.summary = summary;

		type ReferenceTarget = { file: TFile; template: string; section: string };
		let targets: ReferenceTarget[] = [];
		let matched = false;

		if (options.targets && options.targets.length > 0) {
			for (const t of options.targets) {
				const res = this.resolveNote(t);
				if (!res.ok) return res;
				targets.push({
					file: res.file,
					template: options.template ?? this.plugin.settings.referenceTemplate,
					section: options.section ?? this.plugin.settings.referenceGroups[0]?.targetSection ?? '# References',
				});
			}
		} else {
			if (!gatewayActive) return { ok: false, reason: 'no-gateway' };
			const groupCandidates = findCandidateNotes(this.app, this.plugin.settings.referenceGroups);
			const matchResult = await matchCandidatesWithLLM(
				body,
				noteFrontmatter,
				groupCandidates,
				gateway!,
				options.maxMatches ?? this.plugin.settings.referenceMaxMatches,
				this.persist,
			);
			if (!matchResult.ok) return matchResult;
			matched = true;
			targets = matchResult.value.map((m: MatchedNote) => ({
				file: m.candidate.file,
				template: m.group.template || this.plugin.settings.referenceTemplate,
				section: m.group.targetSection,
			}));
		}

		const vars = {
			date: metadata.date ?? '',
			type: metadata.type ?? '',
			summary,
			title: file.basename,
			people: (metadata.people ?? []).join(', '),
			note_link: `[[${file.path.replace(/\.md$/, '')}]]`,
		};

		const referencedNotes: string[] = [];
		for (const target of targets) {
			const block = renderReferenceBlock(target.template, vars);
			if (!options.preview) {
				const current = await this.app.vault.read(target.file);
				const updated = insertReferenceIntoNote(current, block, target.section);
				await this.app.vault.modify(target.file, updated);
			}
			referencedNotes.push(target.file.path);
		}

		let todo: string | undefined;
		if (options.todo && gatewayActive && referencedNotes.length > 0) {
			const today = new Date().toISOString().slice(0, 10);
			const todoResult = await generateTodoTask(
				options.todo,
				{ title: file.basename, summary, date: metadata.date, noteContent: content.slice(0, 6000) },
				gateway!,
				today,
				this.plugin.settings.todoPrompt,
				this.persist,
			);
			if (todoResult.ok) {
				todo = todoResult.value;
				if (!options.preview) {
					await writeTaskToNote(this.app, targets[0].file.path, todo, this.plugin.settings.todoSection);
				}
			}
		}

		return todo !== undefined
			? { ok: true, referencedNotes, matched, todo }
			: { ok: true, referencedNotes, matched };
	}

	async fixFrontmatter(
		options: FixFrontmatterOptions = {},
	): Promise<NoteToolResult<{ template: string; filled: Record<string, unknown>; added?: string[] }>> {
		const noteRes = this.resolveNote(options.note);
		if (!noteRes.ok) return noteRes;
		const file = noteRes.file;
		const gateway = this.resolveGateway(options.gateway);

		const paths = this.plugin.settings.templatePairs.map((p) => p.templatePath);
		const templates = (await loadTemplatesFromPaths(this.app, paths)).filter((t) => t.file.path !== file.path);
		if (templates.length === 0) {
			return { ok: false, reason: 'no-template', detail: 'no template pairs configured' };
		}

		const content = await this.app.vault.read(file);
		const body = this.readBody(content);
		const noteFrontmatter = this.cleanFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {});

		let selected: TemplateNote;
		if (options.template && options.template.trim().length > 0) {
			const wanted = options.template.trim();
			const byPath = templates.filter((t) => t.file.path === wanted);
			const matches = byPath.length > 0 ? byPath : templates.filter((t) => t.name.toLowerCase() === wanted.toLowerCase());
			if (matches.length !== 1) {
				return { ok: false, reason: 'no-template', detail: `template "${wanted}" ${matches.length === 0 ? 'not found' : 'ambiguous'}` };
			}
			selected = matches[0];
		} else {
			const { ranked } = await rankTemplates(file.basename, noteFrontmatter, body, templates, gateway, this.persist);
			selected = ranked[0];
		}

		const fill = await fillTemplateFrontmatter(selected, file.basename, noteFrontmatter, body, gateway, this.persist);
		if (!fill.ok) return fill;

		if (options.preview) {
			return { ok: true, template: selected.name, filled: fill.value };
		}
		const added = await applyTemplateFrontmatter(this.app, file, selected, fill.value);
		return { ok: true, template: selected.name, filled: fill.value, added };
	}

	async createFromTemplate(
		options: CreateFromTemplateOptions = {},
	): Promise<NoteToolResult<{ notePath: string; template: string; subfolder: string; subfolderIsNew: boolean; body?: string }>> {
		const noteRes = this.resolveNote(options.note);
		if (!noteRes.ok) return noteRes;
		const file = noteRes.file;
		const gateway = this.resolveGateway(options.gateway);

		const pairs = (await loadTemplatePairs(this.app, this.plugin.settings.templatePairs))
			.filter((p) => p.template.file.path !== file.path);
		if (pairs.length === 0) {
			return { ok: false, reason: 'no-template', detail: 'no usable template pairs configured' };
		}

		const content = await this.app.vault.read(file);
		const body = this.readBody(content);
		const noteFrontmatter = this.cleanFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {});

		let pair: CreateFromTemplatePair;
		if (options.pair && options.pair.trim().length > 0) {
			const wanted = options.pair.trim();
			const byId = pairs.filter((p) => p.config.id === wanted);
			const byName = byId.length > 0 ? byId : pairs.filter((p) => p.config.name.toLowerCase() === wanted.toLowerCase());
			const matches = byName.length > 0 ? byName : pairs.filter((p) => p.template.name.toLowerCase() === wanted.toLowerCase());
			if (matches.length !== 1) {
				return { ok: false, reason: 'no-template', detail: `template pair "${wanted}" ${matches.length === 0 ? 'not found' : 'ambiguous'}` };
			}
			pair = matches[0];
		} else {
			const { ranked } = await rankTemplatePairs(file.basename, noteFrontmatter, body, pairs, gateway, this.persist);
			pair = ranked[0];
		}

		const drafted = await draftNoteFromTemplate(pair, file.basename, noteFrontmatter, body, gateway, this.persist);
		if (!drafted.ok) return drafted;
		const finalBody = await factCheckNoteBody(body, drafted.value, gateway, this.persist);

		let subfolder: string;
		let subfolderIsNew: boolean;
		if (options.subfolder !== undefined) {
			subfolder = options.subfolder.trim().replace(/^\/+|\/+$/g, '');
			subfolderIsNew = false;
		} else {
			const existing = existingSubfolders(this.app, pair.config.targetFolder);
			const suggestion = await suggestSubfolder(file.basename, noteFrontmatter, body, existing, gateway, this.persist);
			subfolder = suggestion.ok ? suggestion.value.subfolder : '';
			subfolderIsNew = suggestion.ok ? suggestion.value.isNew : false;
		}

		const baseFolder = pair.config.targetFolder.replace(/\/+$/, '').trim();
		const destFolder = normalizePath(subfolder ? `${baseFolder}/${subfolder}` : baseFolder);

		const safeTitle = (options.title || file.basename).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'note';
		let fileName = `${safeTitle}.md`;
		let attempt = 1;
		while (this.app.vault.getAbstractFileByPath(normalizePath(`${destFolder}/${fileName}`))) {
			fileName = dedupeName(`${safeTitle}.md`, ++attempt);
		}
		const notePath = normalizePath(`${destFolder}/${fileName}`);

		// The one tool that defaults to preview mode, since it creates a
		// brand-new file as a side effect — only options.preview === false applies it.
		if (options.preview !== false) {
			return { ok: true, notePath, template: pair.template.name, subfolder, subfolderIsNew, body: finalBody };
		}

		await ensureFolder(this.app, destFolder);
		const newFile = await this.app.vault.create(notePath, finalBody.trim() ? `\n${finalBody.trim()}\n` : '\n');
		const fill = await fillTemplateFrontmatter(pair.template, file.basename, noteFrontmatter, body, gateway, this.persist);
		await applyTemplateFrontmatter(this.app, newFile, pair.template, fill.ok ? fill.value : {});
		await this.app.fileManager.processFrontMatter(newFile, (fm: Record<string, unknown>) => {
			fm.source = `[[${file.basename}]]`;
		});

		return { ok: true, notePath: newFile.path, template: pair.template.name, subfolder, subfolderIsNew };
	}

	async restructureNote(
		options: RestructureNoteOptions = {},
	): Promise<NoteToolResult<{ mapping: HeaderMappingEntry[]; usedLlm: boolean }>> {
		const noteRes = this.resolveNote(options.note);
		if (!noteRes.ok) return noteRes;
		const file = noteRes.file;
		const gateway = this.resolveGateway(options.gateway);

		// Keep the RAW frontmatter block (not cleanFrontmatter's parsed object) —
		// the write path re-prepends it verbatim, exactly like
		// HeaderRestructureModal's Apply button.
		const content = await this.app.vault.read(file);
		const fmEnd = content.indexOf('\n---\n');
		const fmBlock = fmEnd >= 0 ? content.slice(0, fmEnd + 5) : '';
		const body = fmEnd >= 0 ? content.slice(fmEnd + 5) : content;
		const noteFrontmatter = this.cleanFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {});

		const parsed = parseHeaderSections(body);
		if (parsed.sections.length <= 1) {
			return { ok: false, reason: 'no-headers', detail: 'note needs at least two headers to restructure' };
		}

		const hasMapping = options.mapping !== undefined;
		const instruction = options.instruction?.trim() || null;

		let mapping: HeaderMappingEntry[];
		let usedLlm: boolean;
		if (hasMapping && instruction) {
			// Explicit mapping + instruction -> LLM revise; hard-requires a
			// gateway, propagate its LlmResult failure as-is.
			const revised = await reviseHeaderMapping(file.basename, noteFrontmatter, parsed, options.mapping!, instruction, gateway, this.persist);
			if (!revised.ok) return revised;
			mapping = revised.value;
			usedLlm = true;
		} else if (hasMapping) {
			// Explicit mapping, no instruction -> apply as-is, no LLM call.
			mapping = options.mapping!;
			usedLlm = false;
		} else {
			// No mapping (instruction optional) -> suggest; gateway optional,
			// suggestHeaderMapping degrades to the identity mapping without one.
			const suggestion = await suggestHeaderMapping(file.basename, noteFrontmatter, parsed, instruction, gateway, this.persist);
			mapping = suggestion.mapping;
			usedLlm = suggestion.usedLlm;
		}

		// Defaults to preview:true (like createFromTemplate) — only preview===false applies it.
		if (options.preview !== false) return { ok: true, mapping, usedLlm };

		const newBody = reassembleHeaderBody(parsed, mapping);
		await this.app.vault.modify(file, fmBlock + newBody);
		return { ok: true, mapping, usedLlm };
	}
}

/**
 * Build the public, serializable API object bound to a NoteTools instance.
 * Toggles are read live off plugin.settings.noteToolsApi on every call, so
 * flipping a setting takes effect immediately without a plugin reload. Every
 * method always exists on the returned object — a disabled tool resolves to
 * { ok: false, reason: 'tool-disabled' } rather than being omitted, so a
 * caller never hits "not a function".
 */
export function buildFileDropApi(tools: NoteTools, plugin: FileDropPlugin): FileDropApi {
	const disabled = (name: NoteToolName): Promise<{ ok: false; reason: 'tool-disabled'; detail: string }> =>
		Promise.resolve({ ok: false, reason: 'tool-disabled', detail: name });
	const enabled = (name: NoteToolName) => plugin.settings.noteToolsApi[name] !== false;

	return {
		summarize: (options) => (enabled('summarize') ? tools.summarize(options) : disabled('summarize')),
		suggestTags: (options) => (enabled('suggestTags') ? tools.suggestTags(options) : disabled('suggestTags')),
		createTodo: (options) => (enabled('createTodo') ? tools.createTodo(options) : disabled('createTodo')),
		addReferences: (options) => (enabled('addReferences') ? tools.addReferences(options) : disabled('addReferences')),
		fixFrontmatter: (options) => (enabled('fixFrontmatter') ? tools.fixFrontmatter(options) : disabled('fixFrontmatter')),
		createFromTemplate: (options) => (enabled('createFromTemplate') ? tools.createFromTemplate(options) : disabled('createFromTemplate')),
		restructureNote: (options) => (enabled('restructureNote') ? tools.restructureNote(options) : disabled('restructureNote')),
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

export async function writeTaskToNote(app: App, notePath: string, taskLine: string, sectionHeader: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return;
	const content = await app.vault.read(file);
	await app.vault.modify(file, insertTaskIntoNote(content, taskLine, sectionHeader));
}
