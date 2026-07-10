import { App, TFile, TFolder } from 'obsidian';

import {
	LlmGateway,
	LlmResult,
	TemplatePair,
	callChat,
	isGatewayEnabled,
	isGatewayUrlSecure,
	stripThinking,
} from './settings';
import { TemplateNote } from './templates';

// A resolved template pair: its config, the template note it points at
// (reused by fillTemplateFrontmatter/applyTemplateFrontmatter), and the
// template's FULL body (headings + per-section guidance lines).
export interface CreateFromTemplatePair {
	config: TemplatePair;
	template: TemplateNote;
	body: string;
}

const RANK_TIMEOUT_MS = 60_000;
// Drafting and fact-checking can be slow on reasoning models, mirror the
// long timeout used by summarizeContent.
const DRAFT_BODY_TIMEOUT_MS = 180_000;
const MAX_FACT_CHECK_ROUNDS = 3;

function gatewayActive(gateway: LlmGateway | null): gateway is LlmGateway {
	return !!gateway && isGatewayEnabled(gateway) && isGatewayUrlSecure(gateway.baseUrl);
}

function splitBody(content: string): string {
	const fmEnd = content.indexOf('\n---\n');
	return fmEnd >= 0 ? content.slice(fmEnd + 5) : content;
}

function fmLinesOf(fm: Record<string, unknown>): string {
	return Object.entries(fm)
		.filter(([, v]) => v !== null && v !== undefined && v !== false)
		.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
		.join('\n');
}

function stripFences(s: string): string {
	return stripThinking(s).replace(/^```(?:json|markdown)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

// Resolve each configured pair into a CreateFromTemplatePair, reading the
// template's frontmatter (from the metadata cache) and full body. Pairs whose
// template file is missing or whose target folder is blank are skipped.
export async function loadTemplatePairs(
	app: App,
	pairs: TemplatePair[],
): Promise<CreateFromTemplatePair[]> {
	const out: CreateFromTemplatePair[] = [];
	for (const config of pairs) {
		const path = config.templatePath.trim();
		if (!path || !config.targetFolder.trim()) continue;
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;

		const rawFm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const frontmatter: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(rawFm)) {
			if (k === 'position') continue;
			frontmatter[k] = v;
		}
		let body = '';
		try {
			body = splitBody(await app.vault.read(file)).trim();
		} catch {
			/* unreadable template — keep frontmatter only */
		}
		out.push({
			config,
			template: { file, name: file.basename, frontmatter, bodyExcerpt: body.slice(0, 300) },
			body,
		});
	}
	return out;
}

// Rank pairs for a note, best first, leaning primarily on the note's
// frontmatter. Falls back to the unranked list when no gateway is available or
// the call fails.
export async function rankTemplatePairs(
	noteTitle: string,
	noteFrontmatter: Record<string, unknown>,
	noteBody: string,
	pairs: CreateFromTemplatePair[],
	gateway: LlmGateway | null,
	persist?: () => Promise<void>,
): Promise<{ ranked: CreateFromTemplatePair[]; usedLlm: boolean }> {
	if (pairs.length <= 1) return { ranked: [...pairs], usedLlm: false };
	if (!gatewayActive(gateway)) return { ranked: [...pairs], usedLlm: false };

	const lines = pairs.map((p, i) => {
		const fmKeys = Object.keys(p.template.frontmatter);
		const parts = [
			fmKeys.length ? `fields: ${fmKeys.join(', ')}` : '',
			p.body ? `body: ${p.body.replace(/\s+/g, ' ').slice(0, 120)}` : '',
		].filter(Boolean);
		return `[${i}] ${p.config.name || p.template.name}${parts.length ? ' | ' + parts.join(' | ') : ''}`;
	});
	const fmLines = fmLinesOf(noteFrontmatter);

	const system =
		'You choose which template a note belongs to. ' +
		"Base your decision primarily on the note's metadata (frontmatter), then its title and content. " +
		'Return a JSON array of template indices, best match first, e.g. [2, 0, 1]. ' +
		'Include every index exactly once, ranked. Return ONLY the JSON array.';
	const user =
		`Note title: ${noteTitle}\n` +
		(fmLines ? `Note metadata:\n${fmLines}\n` : '') +
		`\nNote content (excerpt):\n${noteBody.slice(0, 3000)}\n\nTemplates:\n${lines.join('\n')}`;

	const result = await callChat(
		gateway,
		{
			label: 'rankTemplatePairs',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 200,
			temperature: 0,
			timeoutMs: RANK_TIMEOUT_MS,
		},
		persist,
	);
	if (!result.ok) return { ranked: [...pairs], usedLlm: false };

	const arrMatch = stripThinking(result.value).match(/\[[\s\S]*\]/);
	if (!arrMatch) return { ranked: [...pairs], usedLlm: false };
	let indices: unknown;
	try {
		indices = JSON.parse(arrMatch[0]);
	} catch {
		return { ranked: [...pairs], usedLlm: false };
	}
	if (!Array.isArray(indices)) return { ranked: [...pairs], usedLlm: false };

	const ranked: CreateFromTemplatePair[] = [];
	const seen = new Set<number>();
	for (const idx of indices) {
		if (typeof idx !== 'number' || idx < 0 || idx >= pairs.length || seen.has(idx)) continue;
		seen.add(idx);
		ranked.push(pairs[idx]);
	}
	for (let i = 0; i < pairs.length; i++) {
		if (!seen.has(i)) ranked.push(pairs[i]);
	}
	return { ranked: ranked.length ? ranked : [...pairs], usedLlm: true };
}

// The immediate subfolder names directly under a target folder, for offering as
// existing-subfolder choices.
export function existingSubfolders(app: App, targetFolder: string): string[] {
	const folder = app.vault.getAbstractFileByPath(targetFolder.replace(/\/+$/, '').trim());
	if (!(folder instanceof TFolder)) return [];
	return folder.children.filter((c): c is TFolder => c instanceof TFolder).map((c) => c.name);
}

// Pick the best-fitting existing subfolder under the target folder, or propose a
// concise new one when none fit. Falls back to the target-folder root (empty
// subfolder) when no gateway is available or the call fails.
export async function suggestSubfolder(
	noteTitle: string,
	noteFrontmatter: Record<string, unknown>,
	noteBody: string,
	existing: string[],
	gateway: LlmGateway | null,
	persist?: () => Promise<void>,
): Promise<LlmResult<{ subfolder: string; isNew: boolean }>> {
	if (!gatewayActive(gateway)) return { ok: true, value: { subfolder: '', isNew: false } };

	const fmLines = fmLinesOf(noteFrontmatter);
	const system =
		'You file a note into a subfolder. Choose the best-fitting subfolder from the existing list. ' +
		'If none of them fit, propose a concise new subfolder name (a short, descriptive folder name, no slashes). ' +
		'Return ONLY a JSON object: {"subfolder": "<name>", "isNew": true|false}. ' +
		'Use isNew:false when you picked one of the existing subfolders, true when you invented a new name.';
	const user =
		`Note title: ${noteTitle}\n` +
		(fmLines ? `Note metadata:\n${fmLines}\n` : '') +
		`\nExisting subfolders:\n${existing.length ? existing.map((s) => `- ${s}`).join('\n') : '(none)'}` +
		`\n\nNote content (excerpt):\n${noteBody.slice(0, 3000)}`;

	const result = await callChat(
		gateway,
		{
			label: 'suggestSubfolder',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 100,
			temperature: 0,
			timeoutMs: RANK_TIMEOUT_MS,
		},
		persist,
	);
	if (!result.ok) return result;

	const objMatch = stripFences(result.value).match(/\{[\s\S]*\}/);
	if (!objMatch) return { ok: true, value: { subfolder: '', isNew: false } };
	try {
		const parsed = JSON.parse(objMatch[0]) as { subfolder?: unknown; isNew?: unknown };
		const subfolder = typeof parsed.subfolder === 'string' ? parsed.subfolder.trim().replace(/^\/+|\/+$/g, '') : '';
		const matchesExisting = existing.some((e) => e.toLowerCase() === subfolder.toLowerCase());
		const isNew = subfolder ? (parsed.isNew === true && !matchesExisting) : false;
		return { ok: true, value: { subfolder, isNew } };
	} catch {
		return { ok: true, value: { subfolder: '', isNew: false } };
	}
}

// Draft the source note into the pair's template: keep the template's
// headings in order, fill each section per its guidance line (which may call for
// a summary, a list, an extracted value, near-verbatim text, etc.), strip the
// guidance lines, and use ONLY content present in the source. Returns the new
// note's markdown body. Falls back to the raw source body when no gateway is
// available or the call fails.
export async function draftNoteFromTemplate(
	pair: CreateFromTemplatePair,
	noteTitle: string,
	noteFrontmatter: Record<string, unknown>,
	noteBody: string,
	gateway: LlmGateway | null,
	persist?: () => Promise<void>,
): Promise<LlmResult<string>> {
	if (!gatewayActive(gateway)) return { ok: true, value: noteBody };

	const fmLines = fmLinesOf(noteFrontmatter);
	const system =
		'You reformat an existing note into a target template. ' +
		'The template defines section headings, each followed by a guidance line describing what belongs in that section. ' +
		"Produce markdown that keeps the template's headings in order; under each heading fill the content FOLLOWING that section's guidance " +
		'(it may ask for a summary, a list, an extracted value, near-verbatim text, etc. — do exactly what the guidance says). ' +
		'Use ONLY information present in the source note — do not add facts or invent anything not present in the source. ' +
		'Omit the guidance lines from your output. If the source has nothing for a section, leave it empty. ' +
		'Output ONLY the markdown body — no frontmatter, no code fences.';
	const user =
		`Target template (headings + guidance):\n${pair.body}\n\n` +
		`Source note title: ${noteTitle}\n` +
		(fmLines ? `Source note metadata:\n${fmLines}\n` : '') +
		`\nSource note content:\n${noteBody.slice(0, 12000)}`;

	const result = await callChat(
		gateway,
		{
			label: 'draftNoteFromTemplate',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 4000,
			temperature: 0,
			timeoutMs: DRAFT_BODY_TIMEOUT_MS,
		},
		persist,
	);
	if (!result.ok) return result;
	return { ok: true, value: stripFences(result.value) };
}

// Verify the drafted body against the source: every number, date, name and
// key fact must be supported by the source; correct any that aren't. Re-runs
// after each correction until the check reports no change (capped at
// MAX_FACT_CHECK_ROUNDS). Never throws — on failure the last good body is kept.
export async function factCheckNoteBody(
	sourceBody: string,
	restructuredBody: string,
	gateway: LlmGateway | null,
	persist?: () => Promise<void>,
): Promise<string> {
	if (!gatewayActive(gateway)) return restructuredBody;

	const system =
		'You verify a drafted note against its source. ' +
		'Check every number, date, name, quantity and key fact in the drafted note: each must be directly supported by the source. ' +
		"Correct any value that is wrong, fabricated, or unsupported (replace it with the source's value, or remove it if the source has none). " +
		'Do not otherwise rewrite, expand, or re-summarize the note — keep its structure and wording. ' +
		'Return ONLY a JSON object: {"corrected": "<full markdown body>", "changed": true|false}.';

	let current = restructuredBody;
	for (let round = 0; round < MAX_FACT_CHECK_ROUNDS; round++) {
		const user = `Source note:\n${sourceBody.slice(0, 12000)}\n\nDrafted note:\n${current}`;
		const result = await callChat(
			gateway,
			{
				label: 'factCheckDraft',
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user },
				],
				maxTokens: 4000,
				temperature: 0,
				timeoutMs: DRAFT_BODY_TIMEOUT_MS,
			},
			persist,
		);
		if (!result.ok) return current;

		const objMatch = stripFences(result.value).match(/\{[\s\S]*\}/);
		if (!objMatch) return current;
		let parsed: { corrected?: unknown; changed?: unknown };
		try {
			parsed = JSON.parse(objMatch[0]);
		} catch (e) {
			console.error('FileDrop factCheckNoteBody parse error:', e);
			return current;
		}
		const corrected = typeof parsed.corrected === 'string' ? parsed.corrected.trim() : '';
		if (corrected) current = corrected;
		if (parsed.changed !== true) break; // clean — stop
	}
	return current;
}
