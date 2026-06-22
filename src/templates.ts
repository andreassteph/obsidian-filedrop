import { App, TFile } from 'obsidian';

import { LlmGateway, LlmResult, callChat, isGatewayEnabled, isGatewayUrlSecure, stripThinking } from './settings';

// A note template: a markdown file in the configured template folder whose
// frontmatter defines the set of properties a note of that kind should carry.
export interface TemplateNote {
	file: TFile;
	name: string;                          // basename, e.g. "Meeting"
	frontmatter: Record<string, unknown>;  // template's frontmatter (field → example/default value)
	bodyExcerpt: string;                   // short body excerpt, for matching context
}

const TEMPLATE_TIMEOUT_MS = 60_000;

// Frontmatter keys that, when present, identify the *kind* of a note — used to
// short-circuit matching when a note already declares its type and a template
// declares the same one.
const TYPE_FIELDS = ['type', 'category', 'kind', 'note-type', 'noteType'];

function typeHint(fm: Record<string, unknown>): string | null {
	for (const key of Object.keys(fm)) {
		if (TYPE_FIELDS.includes(key.toLowerCase())) {
			const v = fm[key];
			if (v === null || v === undefined) continue;
			const s = Array.isArray(v) ? v.map(String).join(' ') : String(v);
			if (s.trim()) return s.trim().toLowerCase();
		}
	}
	return null;
}

// Load every markdown file under `folderPath` (recursive) as a TemplateNote,
// reading each one's frontmatter from the metadata cache and a short body
// excerpt for matching context.
export async function findTemplates(app: App, folderPath: string): Promise<TemplateNote[]> {
	const trimmed = folderPath.replace(/\/+$/, '').trim();
	if (!trimmed) return [];
	const prefix = trimmed + '/';
	const files = app.vault.getMarkdownFiles().filter((f) => f.path === trimmed || f.path.startsWith(prefix));

	const templates: TemplateNote[] = [];
	for (const file of files) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		// Strip Obsidian's internal `position` key the cache sometimes attaches.
		const frontmatter: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(fm)) {
			if (k === 'position') continue;
			frontmatter[k] = v;
		}
		let bodyExcerpt = '';
		try {
			const content = await app.vault.read(file);
			const fmEnd = content.indexOf('\n---\n');
			const body = fmEnd >= 0 ? content.slice(fmEnd + 5) : content;
			bodyExcerpt = body.trim().slice(0, 300);
		} catch {
			/* unreadable template — keep frontmatter only */
		}
		templates.push({ file, name: file.basename, frontmatter, bodyExcerpt });
	}
	return templates;
}

// Rank templates for a note, best first. If the note already declares a type
// that matches exactly one template's type (or basename), that template wins
// deterministically without an LLM call. Otherwise the LLM ranks them using the
// note's title, frontmatter, and content. Falls back to the unranked list when
// no gateway is available or the call fails.
export async function rankTemplates(
	noteTitle: string,
	noteFrontmatter: Record<string, unknown>,
	noteBody: string,
	templates: TemplateNote[],
	gateway: LlmGateway | null,
	persist?: () => Promise<void>,
): Promise<{ ranked: TemplateNote[]; usedLlm: boolean }> {
	if (templates.length <= 1) return { ranked: [...templates], usedLlm: false };

	// Deterministic shortcut: a declared note type that matches a template's
	// declared type (or, failing that, its basename) is the obvious pick.
	const noteType = typeHint(noteFrontmatter);
	if (noteType) {
		const byType = templates.filter((t) => typeHint(t.frontmatter) === noteType);
		const exact = byType.length > 0 ? byType : templates.filter((t) => t.name.toLowerCase() === noteType);
		if (exact.length === 1) {
			const rest = templates.filter((t) => t !== exact[0]);
			return { ranked: [exact[0], ...rest], usedLlm: false };
		}
	}

	const gatewayActive = !!gateway && isGatewayEnabled(gateway) && isGatewayUrlSecure(gateway.baseUrl);
	if (!gatewayActive) return { ranked: [...templates], usedLlm: false };

	const lines = templates.map((t, i) => {
		const fmKeys = Object.keys(t.frontmatter);
		const type = typeHint(t.frontmatter);
		const parts = [
			type ? `type: ${type}` : '',
			fmKeys.length ? `fields: ${fmKeys.join(', ')}` : '',
			t.bodyExcerpt ? `body: ${t.bodyExcerpt.replace(/\s+/g, ' ').slice(0, 120)}` : '',
		].filter(Boolean);
		return `[${i}] ${t.name}${parts.length ? ' | ' + parts.join(' | ') : ''}`;
	});

	const fmLines = Object.entries(noteFrontmatter)
		.filter(([, v]) => v !== null && v !== undefined && v !== false)
		.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
		.join('\n');

	const system =
		'You classify a note by choosing which template best fits it. ' +
		'Consider the note title, its existing metadata, and its content. ' +
		'A template that matches the kind/type of the note is the best fit. ' +
		`Return a JSON array of template indices, best match first, e.g. [2, 0, 1]. ` +
		'Include every index exactly once, ranked. Return ONLY the JSON array.';
	const user =
		`Note title: ${noteTitle}\n` +
		(fmLines ? `Note metadata:\n${fmLines}\n` : '') +
		`\nNote content (excerpt):\n${noteBody.slice(0, 3000)}\n\nTemplates:\n${lines.join('\n')}`;

	const result = await callChat(
		gateway!,
		{
			label: 'rankTemplates',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 200,
			temperature: 0,
			timeoutMs: TEMPLATE_TIMEOUT_MS,
		},
		persist,
	);
	if (!result.ok) return { ranked: [...templates], usedLlm: false };

	const cleaned = stripThinking(result.value).trim();
	const arrMatch = cleaned.match(/\[[\s\S]*\]/);
	if (!arrMatch) return { ranked: [...templates], usedLlm: false };
	let indices: unknown;
	try {
		indices = JSON.parse(arrMatch[0]);
	} catch {
		return { ranked: [...templates], usedLlm: false };
	}
	if (!Array.isArray(indices)) return { ranked: [...templates], usedLlm: false };

	const ranked: TemplateNote[] = [];
	const seen = new Set<number>();
	for (const idx of indices) {
		if (typeof idx !== 'number' || idx < 0 || idx >= templates.length || seen.has(idx)) continue;
		seen.add(idx);
		ranked.push(templates[idx]);
	}
	// Append any templates the model omitted so none silently disappear.
	for (let i = 0; i < templates.length; i++) {
		if (!seen.has(i)) ranked.push(templates[i]);
	}
	return { ranked: ranked.length ? ranked : [...templates], usedLlm: true };
}

// Coerce an LLM-returned value to the type implied by the template's example
// value, so e.g. a list field stays a list and a number stays a number.
function coerceToSample(value: unknown, sample: unknown): unknown {
	if (Array.isArray(sample)) {
		if (Array.isArray(value)) return value.map(String);
		if (typeof value === 'string') {
			const trimmed = value.trim();
			if (!trimmed) return [];
			return trimmed.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
		}
		return value === null || value === undefined ? [] : [String(value)];
	}
	if (typeof sample === 'number') {
		const n = Number(value);
		return isNaN(n) ? value : n;
	}
	if (typeof sample === 'boolean') {
		if (typeof value === 'boolean') return value;
		return String(value).toLowerCase() === 'true';
	}
	return value === null || value === undefined ? '' : value;
}

function isEmpty(v: unknown): boolean {
	if (v === null || v === undefined) return true;
	if (typeof v === 'string') return v.trim() === '';
	if (Array.isArray(v)) return v.length === 0;
	return false;
}

// Ask the LLM to fill the chosen template's frontmatter fields for this note.
// Fixed identifier fields (e.g. `type`) keep the template's value; descriptive
// fields are derived from the note. Returns a field→value map (already coerced
// to each field's template type). Never throws — callers check result.ok.
export async function fillTemplateFrontmatter(
	template: TemplateNote,
	noteTitle: string,
	noteFrontmatter: Record<string, unknown>,
	noteBody: string,
	gateway: LlmGateway | null,
	persist?: () => Promise<void>,
): Promise<LlmResult<Record<string, unknown>>> {
	const fields = Object.keys(template.frontmatter);
	if (fields.length === 0) return { ok: true, value: {} };

	// Seed with the template's own values so even without (or on failure of) the
	// LLM the caller has sensible defaults to add.
	const seeded: Record<string, unknown> = {};
	for (const f of fields) seeded[f] = template.frontmatter[f];

	if (!gateway || !isGatewayEnabled(gateway)) return { ok: true, value: seeded };
	if (!isGatewayUrlSecure(gateway.baseUrl)) return { ok: false, reason: 'insecure-url' };

	const fieldLines = fields
		.map((f) => {
			const sample = template.frontmatter[f];
			const shown = Array.isArray(sample) ? `[${sample.map(String).join(', ')}]` : String(sample ?? '');
			return `- ${f}${shown ? ` (template value: ${shown})` : ''}`;
		})
		.join('\n');

	const fmLines = Object.entries(noteFrontmatter)
		.filter(([, v]) => v !== null && v !== undefined && v !== false)
		.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
		.join('\n');

	const system =
		'You fill in metadata (frontmatter) fields for a note based on a chosen template. ' +
		'For each requested field, return a value appropriate for THIS note. ' +
		'For fixed type/category identifier fields, keep the template value. ' +
		'For descriptive fields (date, people, status, summary, etc.) derive the value from the note title and content. ' +
		'Match the value type shown by the template value (a list stays a list, a number stays a number). ' +
		'Use the ISO format YYYY-MM-DD for dates. If a value cannot be determined, use an empty string or empty list. ' +
		'Return ONLY a valid JSON object mapping each field name to its value.';
	const user =
		`Note title: ${noteTitle}\n` +
		(fmLines ? `Existing note metadata:\n${fmLines}\n` : '') +
		`\nFields to fill:\n${fieldLines}\n\nNote content (excerpt):\n${noteBody.slice(0, 6000)}`;

	const result = await callChat(
		gateway,
		{
			label: 'fillTemplate',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 600,
			temperature: 0,
			timeoutMs: TEMPLATE_TIMEOUT_MS,
		},
		persist,
	);
	if (!result.ok) return result;

	const cleaned = stripThinking(result.value).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
	const objMatch = cleaned.match(/\{[\s\S]*\}/);
	if (!objMatch) return { ok: true, value: seeded };
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(objMatch[0]);
	} catch (e) {
		console.error('FileDrop fillTemplateFrontmatter parse error:', e);
		return { ok: true, value: seeded };
	}

	const out: Record<string, unknown> = {};
	for (const f of fields) {
		const sample = template.frontmatter[f];
		if (f in parsed && !isEmpty(parsed[f])) {
			out[f] = coerceToSample(parsed[f], sample);
		} else {
			out[f] = sample; // fall back to the template's own value
		}
	}
	return { ok: true, value: out };
}

// Merge filled template fields into the note's frontmatter, keeping every
// existing field and leaving the body untouched. Only template fields that the
// note is missing (or has empty) are added. Returns the list of fields added.
export async function applyTemplateFrontmatter(
	app: App,
	file: TFile,
	template: TemplateNote,
	filled: Record<string, unknown>,
): Promise<string[]> {
	const added: string[] = [];
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		for (const field of Object.keys(template.frontmatter)) {
			if (!isEmpty(fm[field])) continue; // keep existing values
			const value = field in filled ? filled[field] : template.frontmatter[field];
			if (isEmpty(value)) {
				// Add the key as an empty placeholder only if it's wholly absent,
				// so the note gains the template's shape even without a value.
				if (!(field in fm)) {
					fm[field] = Array.isArray(template.frontmatter[field]) ? [] : '';
					added.push(field);
				}
				continue;
			}
			fm[field] = value;
			added.push(field);
		}
	});
	return added;
}
