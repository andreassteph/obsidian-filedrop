import {
	LlmGateway,
	LlmResult,
	callChat,
	isGatewayEnabled,
	isGatewayUrlSecure,
	stripThinking,
} from './settings';

// A single header extracted from a note, with the raw lines of its section
// (everything up to the next header at any level, or EOF) kept untouched so
// content can be relocated without ever being rewritten.
export interface HeaderSection {
	level: number; // 1-6
	text: string;
	bodyLines: string[];
}

export interface ParsedHeaderNote {
	preambleLines: string[]; // lines before the first header — stays pinned at the top
	sections: HeaderSection[];
}

// A proposed new position/level/text for one ORIGINAL header, referenced by
// its index into ParsedHeaderNote.sections. The entry's position in the
// mapping array IS its new order — there is no separate order field.
export interface HeaderMappingEntry {
	index: number;
	level: number;
	text: string;
}

const HEADER_MAPPING_TIMEOUT_MS = 60_000;
const HEADER_EXCERPT_CHARS = 150;
const PREAMBLE_EXCERPT_CHARS = 300;

function gatewayActive(gateway: LlmGateway | null): gateway is LlmGateway {
	return !!gateway && isGatewayEnabled(gateway) && isGatewayUrlSecure(gateway.baseUrl);
}

function stripFences(s: string): string {
	return stripThinking(s).replace(/^```(?:json|markdown)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function fmLinesOf(fm: Record<string, unknown>): string {
	return Object.entries(fm)
		.filter(([, v]) => v !== null && v !== undefined && v !== false)
		.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
		.join('\n');
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADER_RE = /^#{1,6}\s/;

// Parse a note body into a flat, ordered list of headers (any level) with
// each header's own section content, skipping headers inside fenced code
// blocks. Content before the first header is kept as a separate preamble.
export function parseHeaderSections(body: string): ParsedHeaderNote {
	const lines = body.split('\n');
	const preambleLines: string[] = [];
	const sections: HeaderSection[] = [];
	let current: HeaderSection | null = null;
	let inFence = false;

	for (const line of lines) {
		if (FENCE_RE.test(line)) inFence = !inFence;

		if (!inFence && HEADER_RE.test(line)) {
			const level = /^#+/.exec(line)![0].length;
			const text = line
				.replace(/^#{1,6}\s+/, '')
				.replace(/\s+#+\s*$/, '')
				.trim();
			current = { level, text, bodyLines: [] };
			sections.push(current);
			continue;
		}

		(current ? current.bodyLines : preambleLines).push(line);
	}

	return { preambleLines, sections };
}

// Reassemble the full body from the original sections plus a mapping:
// reorders per the mapping's array order, rewrites each header line to its
// new level/text, and relocates each section's body lines byte-for-byte.
export function reassembleHeaderBody(parsed: ParsedHeaderNote, mapping: HeaderMappingEntry[]): string {
	const out: string[] = [...parsed.preambleLines];
	for (const entry of mapping) {
		const section = parsed.sections[entry.index];
		if (!section) continue;
		out.push('#'.repeat(Math.min(6, Math.max(1, entry.level))) + ' ' + entry.text);
		out.push(...section.bodyLines);
	}
	return out.join('\n');
}

function identityMapping(sections: HeaderSection[]): HeaderMappingEntry[] {
	return sections.map((s, i) => ({ index: i, level: s.level, text: s.text }));
}

// Repair an arbitrary LLM reply into a full, valid 1:1 permutation of the
// original sections: keep well-formed entries (unique, in-range index; valid
// level/text, falling back to the section's own values otherwise), then
// append any original indices the reply omitted, in ascending order. Returns
// null only when `raw` isn't an array at all — every other malformed input
// is repaired rather than rejected, so the LLM can never corrupt content.
function repairMapping(raw: unknown, sections: HeaderSection[]): HeaderMappingEntry[] | null {
	if (!Array.isArray(raw)) return null;

	const seen = new Set<number>();
	const repaired: HeaderMappingEntry[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) continue;
		const index = (item as { index?: unknown }).index;
		if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= sections.length) continue;
		if (seen.has(index)) continue;
		seen.add(index);

		const section = sections[index];
		const rawLevel = (item as { level?: unknown }).level;
		const level = typeof rawLevel === 'number' && Number.isFinite(rawLevel)
			? Math.min(6, Math.max(1, Math.round(rawLevel)))
			: section.level;
		const rawText = (item as { text?: unknown }).text;
		const text = typeof rawText === 'string' && rawText.trim().length > 0 ? rawText.trim() : section.text;

		repaired.push({ index, level, text });
	}
	for (let i = 0; i < sections.length; i++) {
		if (!seen.has(i)) repaired.push({ index: i, level: sections[i].level, text: sections[i].text });
	}
	return repaired;
}

function headerListPrompt(sections: HeaderSection[]): string {
	return sections
		.map((s, i) => {
			const excerpt = s.bodyLines.join(' ').replace(/\s+/g, ' ').trim().slice(0, HEADER_EXCERPT_CHARS);
			return `[${i}] H${s.level} "${s.text}"${excerpt ? ` — excerpt: ${excerpt}` : ''}`;
		})
		.join('\n');
}

const MAPPING_SYSTEM_PROMPT =
	'You reorganize the headers of a note. Propose a new reading order and, optionally, a new heading level (1-6) ' +
	"and new wording for each header. Every original header must appear in your output EXACTLY ONCE, referenced by " +
	'its original index. NEVER merge two headers, split one, drop one, or invent a new one — you are only ' +
	'reordering/relabeling headers, never touching their content. ' +
	'Return ONLY a JSON array, in your proposed new order: ' +
	'[{"index": <original index>, "level": <1-6>, "text": "<new header text>"}, ...], ' +
	'one entry per original index, each index used exactly once.';

function buildMappingUserPrompt(
	noteTitle: string,
	noteFrontmatter: Record<string, unknown>,
	parsed: ParsedHeaderNote,
	instruction: string | null,
): string {
	const fmLines = fmLinesOf(noteFrontmatter);
	const preambleExcerpt = parsed.preambleLines.join(' ').replace(/\s+/g, ' ').trim().slice(0, PREAMBLE_EXCERPT_CHARS);
	return (
		`Note title: ${noteTitle}\n` +
		(fmLines ? `Note metadata:\n${fmLines}\n` : '') +
		(preambleExcerpt ? `\nPreamble (before first header):\n${preambleExcerpt}\n` : '') +
		(instruction ? `\nInstruction for how to change the order: ${instruction}\n` : '') +
		`\nHeaders:\n${headerListPrompt(parsed.sections)}`
	);
}

// Silent-fallback initial suggestion: returns the identity mapping (original
// order/level/text) when there's nothing to reorder, no gateway is
// available, or the call fails — the modal is still useful for manual
// reordering in that case.
export async function suggestHeaderMapping(
	noteTitle: string,
	noteFrontmatter: Record<string, unknown>,
	parsed: ParsedHeaderNote,
	instruction: string | null,
	gateway: LlmGateway | null,
	persist?: () => Promise<void>,
): Promise<{ mapping: HeaderMappingEntry[]; usedLlm: boolean }> {
	const identity = identityMapping(parsed.sections);
	if (parsed.sections.length <= 1) return { mapping: identity, usedLlm: false };
	if (!gatewayActive(gateway)) return { mapping: identity, usedLlm: false };

	const result = await callChat(
		gateway,
		{
			label: 'suggestHeaderMapping',
			messages: [
				{ role: 'system', content: MAPPING_SYSTEM_PROMPT },
				{ role: 'user', content: buildMappingUserPrompt(noteTitle, noteFrontmatter, parsed, instruction) },
			],
			maxTokens: 2000,
			temperature: 0,
			timeoutMs: HEADER_MAPPING_TIMEOUT_MS,
		},
		persist,
	);
	if (!result.ok) return { mapping: identity, usedLlm: false };

	const arrMatch = stripFences(result.value).match(/\[[\s\S]*\]/);
	if (!arrMatch) return { mapping: identity, usedLlm: false };
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(arrMatch[0]);
	} catch {
		return { mapping: identity, usedLlm: false };
	}

	const repaired = repairMapping(parsedJson, parsed.sections);
	if (!repaired) return { mapping: identity, usedLlm: false };
	return { mapping: repaired, usedLlm: true };
}

// Explicit-result revise call for the modal's Revise button: re-runs the
// mapping call with the current proposal and a user instruction. Mirrors
// reviseSummary()'s gating/error shape.
export async function reviseHeaderMapping(
	noteTitle: string,
	noteFrontmatter: Record<string, unknown>,
	parsed: ParsedHeaderNote,
	currentMapping: HeaderMappingEntry[],
	instruction: string,
	gateway: LlmGateway | null,
	persist?: () => Promise<void>,
): Promise<LlmResult<HeaderMappingEntry[]>> {
	if (!gateway || !isGatewayEnabled(gateway)) return { ok: false, reason: 'api-error', detail: 'no gateway configured' };
	if (!isGatewayUrlSecure(gateway.baseUrl)) return { ok: false, reason: 'insecure-url' };

	const currentOrderLines = currentMapping
		.map((entry) => {
			const orig = parsed.sections[entry.index];
			return `H${entry.level} "${entry.text}" (was H${orig.level} "${orig.text}")`;
		})
		.join('\n');
	const user =
		`${buildMappingUserPrompt(noteTitle, noteFrontmatter, parsed, instruction)}\n\n` +
		`Current proposed order:\n${currentOrderLines}`;

	const result = await callChat(
		gateway,
		{
			label: 'reviseHeaderMapping',
			messages: [
				{ role: 'system', content: MAPPING_SYSTEM_PROMPT },
				{ role: 'user', content: user },
			],
			maxTokens: 2000,
			temperature: 0,
			timeoutMs: HEADER_MAPPING_TIMEOUT_MS,
		},
		persist,
	);
	if (!result.ok) return result;

	const arrMatch = stripFences(result.value).match(/\[[\s\S]*\]/);
	if (!arrMatch) return { ok: false, reason: 'no-reply' };
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(arrMatch[0]);
	} catch {
		return { ok: false, reason: 'no-reply' };
	}

	const repaired = repairMapping(parsedJson, parsed.sections);
	if (!repaired) return { ok: false, reason: 'no-reply' };
	return { ok: true, value: repaired };
}
