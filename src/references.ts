import { App, TFile, requestUrl } from 'obsidian';

import { LlmGateway, LlmResult, ReferenceConditionGroup, isGatewayEnabled, isGatewayUrlSecure, stripThinking } from './settings';

export interface ActivityMetadata {
	date: string | null;
	type: string | null;
	people: string[] | null;
}

export interface CandidateNote {
	file: TFile;
	name: string;
	contextFields: Record<string, string>;
}

export interface GroupCandidates {
	group: ReferenceConditionGroup;
	candidates: CandidateNote[];
}

export interface MatchedNote {
	candidate: CandidateNote;
	group: ReferenceConditionGroup;
}

const REFERENCE_TIMEOUT_MS = 60_000;

export function findCandidateNotes(app: App, groups: ReferenceConditionGroup[]): GroupCandidates[] {
	const files = app.vault.getMarkdownFiles();
	return groups.map((group) => {
		const candidates: CandidateNote[] = [];
		for (const file of files) {
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			const matches = group.conditions.every((cond) => {
				const val = fm[cond.field];
				if (val === undefined || val === null) return false;
				if (Array.isArray(val)) return val.some((v) => String(v).toLowerCase() === cond.value.toLowerCase());
				return String(val).toLowerCase() === cond.value.toLowerCase();
			});
			if (!matches) continue;
			const contextFields: Record<string, string> = {};
			for (const field of group.matchFields) {
				const v = fm[field];
				if (v !== undefined && v !== null) contextFields[field] = String(v);
			}
			candidates.push({ file, name: file.basename, contextFields });
		}
		return { group, candidates };
	});
}

const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTH_MAP: Record<string, string> = {
	january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
	july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

function toIso(year: string, month: string, day: string): string {
	return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function extractActivityMetadata(
	content: string,
	filePath: string,
	fileStat: { ctime: number },
): ActivityMetadata {
	let date: string | null = null;

	const iso = content.match(/\b(\d{4}-\d{2}-\d{2})\b/);
	if (iso) {
		date = iso[1];
	} else {
		const emailDate = content.match(/^Date:\s*(.+)$/m);
		if (emailDate) {
			const d = new Date(emailDate[1]);
			if (!isNaN(d.getTime())) date = d.toISOString().slice(0, 10);
		}
	}
	if (!date) {
		const mdy = content.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
		if (mdy) date = toIso(mdy[3], mdy[1], mdy[2]);
	}
	if (!date) {
		const dmy = content.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
		if (dmy) date = toIso(dmy[3], dmy[2], dmy[1]);
	}
	if (!date) {
		const named = content.match(new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i'));
		if (named) date = toIso(named[3], MONTH_MAP[named[1].toLowerCase()] ?? '01', named[2]);
	}
	if (!date) {
		date = new Date(fileStat.ctime).toISOString().slice(0, 10);
	}

	let type: string | null = null;
	const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
	const EXT_MAP: Record<string, string> = {
		msg: 'Email', pptx: 'Presentation', ppt: 'Presentation',
		xlsx: 'Spreadsheet', xls: 'Spreadsheet', docx: 'Document', doc: 'Document', pdf: 'PDF',
	};
	if (EXT_MAP[ext]) {
		type = EXT_MAP[ext];
	} else if (/^(From|To|Subject|Date|CC):/m.test(content)) {
		type = 'Email';
	} else if (/\b(Agenda|Minutes|Action Items)\b/i.test(content)) {
		type = 'Meeting Note';
	}

	let people: string[] | null = null;
	const emailHeaderPeople: string[] = [];
	for (const header of ['From', 'To', 'CC']) {
		const m = content.match(new RegExp(`^${header}:\\s*(.+)$`, 'm'));
		if (!m) continue;
		const parts = m[1].split(/[,;]/);
		for (const part of parts) {
			const name = part.replace(/<[^>]+>/g, '').trim();
			if (name) emailHeaderPeople.push(name);
		}
	}
	if (emailHeaderPeople.length > 0) people = emailHeaderPeople;

	return { date, type, people };
}

export async function fillMetadataWithLLM(
	metadata: ActivityMetadata,
	content: string,
	gateway: LlmGateway,
): Promise<LlmResult<ActivityMetadata>> {
	if (!isGatewayEnabled(gateway)) return { ok: false, reason: 'api-error', detail: 'no gateway configured' };
	if (!isGatewayUrlSecure(gateway.baseUrl)) return { ok: false, reason: 'insecure-url' };

	const needed: string[] = [];
	if (!metadata.date) needed.push('date (YYYY-MM-DD format)');
	if (!metadata.type) needed.push('type (e.g. Email, Presentation, Meeting Note, Document, PDF)');
	if (!metadata.people) needed.push('people (array of names mentioned)');
	if (needed.length === 0) return { ok: true, value: metadata };

	const system =
		'Extract structured metadata from a document. ' +
		`Return a JSON object with only these fields: ${needed.map((n) => n.split(' ')[0]).join(', ')}. ` +
		'For date use YYYY-MM-DD. For people use an array of strings. Return ONLY valid JSON.';
	const user = `Fields needed: ${needed.join('; ')}\n\nDocument:\n${content.slice(0, 6000)}`;

	const url = `${gateway.baseUrl.replace(/\/+$/, '')}/chat/completions`;
	const request = requestUrl({
		url,
		method: 'POST',
		throw: false,
		headers: {
			Authorization: `Bearer ${gateway.apiKey}`,
			'x-api-key': gateway.apiKey,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: gateway.model,
			temperature: 0,
			max_tokens: 300,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
		}),
	});

	const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), REFERENCE_TIMEOUT_MS));
	try {
		const res = await Promise.race([request, timeout]);
		if (!res) return { ok: false, reason: 'timeout' };
		if (res.status < 200 || res.status >= 300) {
			return { ok: false, reason: 'api-error', detail: `HTTP ${res.status}` };
		}
		const reply = res.json?.choices?.[0]?.message?.content;
		if (typeof reply !== 'string') return { ok: false, reason: 'no-reply' };

		const cleaned = stripThinking(reply).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
		const objMatch = cleaned.match(/\{[\s\S]*\}/);
		if (!objMatch) return { ok: false, reason: 'no-reply' };
		const parsed = JSON.parse(objMatch[0]);

		const result: ActivityMetadata = { ...metadata };
		if (!result.date && typeof parsed.date === 'string') result.date = parsed.date;
		if (!result.type && typeof parsed.type === 'string') result.type = parsed.type;
		if (!result.people && Array.isArray(parsed.people)) result.people = parsed.people.map(String);
		return { ok: true, value: result };
	} catch (e) {
		console.error('FileDrop fillMetadataWithLLM error:', e);
		return { ok: false, reason: 'api-error', detail: String(e) };
	}
}

export async function matchCandidatesWithLLM(
	noteContent: string,
	noteFrontmatter: Record<string, unknown>,
	groupCandidates: GroupCandidates[],
	gateway: LlmGateway,
	maxMatches: number,
): Promise<LlmResult<MatchedNote[]>> {
	if (!isGatewayEnabled(gateway)) return { ok: false, reason: 'api-error', detail: 'no gateway configured' };
	if (!isGatewayUrlSecure(gateway.baseUrl)) return { ok: false, reason: 'insecure-url' };

	// Build flat candidate list, capping each group at 100 sorted by recency
	const allCandidates: Array<{ candidate: CandidateNote; group: ReferenceConditionGroup }> = [];
	for (const { group, candidates } of groupCandidates) {
		const sorted = [...candidates].sort((a, b) => b.file.stat.mtime - a.file.stat.mtime).slice(0, 100);
		for (const c of sorted) allCandidates.push({ candidate: c, group });
	}
	if (allCandidates.length === 0) return { ok: true, value: [] };

	const lines = allCandidates.map(({ candidate, group }, i) => {
		const fields = Object.entries(candidate.contextFields)
			.map(([k, v]) => `${k}: ${v.slice(0, 80)}`)
			.join(' | ');
		return `[${i}] ${candidate.name}${fields ? ' | ' + fields : ''} (group: ${group.name})`;
	});

	const fmLines = Object.entries(noteFrontmatter)
		.filter(([, v]) => v !== null && v !== undefined && v !== false)
		.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
		.join('\n');

	const system =
		'You help organize documents by linking them to related notes in a knowledge base. ' +
		'Select notes that this document most naturally belongs with, connects to, or would be useful to reference — ' +
		'including indirect relationships (e.g. an installer relates to a software collection, a receipt to a purchase record, a transcript to a project). ' +
		`Return a JSON array of up to ${maxMatches} integer indices, best match first. ` +
		'Return ONLY the JSON array, e.g. [2, 0, 5]. Return [] only if there is truly no plausible connection to any candidate.';
	const user = (fmLines ? `Document metadata:\n${fmLines}\n\n` : '') +
		`Document body (excerpt):\n${noteContent.slice(0, 4000)}\n\nCandidate notes:\n${lines.join('\n')}`;

	const url = `${gateway.baseUrl.replace(/\/+$/, '')}/chat/completions`;
	const request = requestUrl({
		url,
		method: 'POST',
		throw: false,
		headers: {
			Authorization: `Bearer ${gateway.apiKey}`,
			'x-api-key': gateway.apiKey,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: gateway.model,
			temperature: 0,
			max_tokens: 2000,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
		}),
	});

	const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), REFERENCE_TIMEOUT_MS));
	try {
		const res = await Promise.race([request, timeout]);
		if (!res) return { ok: false, reason: 'timeout' };
		if (res.status < 200 || res.status >= 300) {
			return { ok: false, reason: 'api-error', detail: `HTTP ${res.status}` };
		}
		const reply = res.json?.choices?.[0]?.message?.content;
		if (typeof reply !== 'string') return { ok: false, reason: 'no-reply' };

		const cleaned = stripThinking(reply).trim();
		const arrMatch = cleaned.match(/\[[\s\S]*\]/);
		if (!arrMatch) return { ok: true, value: [] };
		const indices: number[] = JSON.parse(arrMatch[0]);
		if (!Array.isArray(indices)) return { ok: true, value: [] };

		const seen = new Set<string>();
		const matched: MatchedNote[] = [];
		for (const idx of indices) {
			if (typeof idx !== 'number' || idx < 0 || idx >= allCandidates.length) continue;
			const { candidate, group } = allCandidates[idx];
			if (seen.has(candidate.file.path)) continue;
			seen.add(candidate.file.path);
			matched.push({ candidate, group });
			if (matched.length >= maxMatches) break;
		}
		return { ok: true, value: matched };
	} catch (e) {
		console.error('FileDrop matchCandidatesWithLLM error:', e);
		return { ok: false, reason: 'api-error', detail: String(e) };
	}
}

export function renderReferenceBlock(
	template: string,
	vars: { date: string; type: string; summary: string; title: string; people: string; note_link: string },
): string {
	return template
		.replace(/\{\{date\}\}/g, vars.date)
		.replace(/\{\{type\}\}/g, vars.type)
		.replace(/\{\{summary\}\}/g, vars.summary)
		.replace(/\{\{title\}\}/g, vars.title)
		.replace(/\{\{people\}\}/g, vars.people)
		.replace(/\{\{note_link\}\}/g, vars.note_link);
}

const DATE_PATTERNS = [
	/\b(\d{4}-\d{2}-\d{2})\b/,
	/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
	/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/,
	new RegExp(`\\b(?:${MONTH_NAMES})\\s+\\d{1,2},?\\s+\\d{4}\\b`, 'i'),
];

function parseDateFromLine(line: string): string | null {
	const iso = line.match(/\b(\d{4}-\d{2}-\d{2})\b/);
	if (iso) return iso[1];
	const mdy = line.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
	if (mdy) return toIso(mdy[3], mdy[1], mdy[2]);
	const dmy = line.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
	if (dmy) return toIso(dmy[3], dmy[2], dmy[1]);
	const named = line.match(new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i'));
	if (named) return toIso(named[3], MONTH_MAP[named[1].toLowerCase()] ?? '01', named[2]);
	return null;
}

function headingLevel(line: string): number {
	const m = line.match(/^(#{1,6})\s/);
	return m ? m[1].length : 0;
}

export function insertReferenceIntoNote(content: string, referenceBlock: string, sectionHeader: string): string {
	// Find start of body (after frontmatter)
	const fmEnd = content.indexOf('\n---\n');
	const bodyStart = fmEnd >= 0 ? fmEnd + 5 : 0;
	const body = content.slice(bodyStart);

	const sectionLevel = headingLevel(sectionHeader.trim());
	const lines = body.split('\n');

	// Find the section header line index
	let sectionIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === sectionHeader.trim()) {
			sectionIdx = i;
			break;
		}
	}

	if (sectionIdx === -1) {
		// Section doesn't exist — append it
		const separator = content.endsWith('\n') ? '\n' : '\n\n';
		return content + separator + sectionHeader + '\n\n' + referenceBlock;
	}

	// Find the end of this section (next heading of same or higher level, or EOF)
	let sectionEnd = lines.length;
	for (let i = sectionIdx + 1; i < lines.length; i++) {
		const lvl = headingLevel(lines[i]);
		if (lvl > 0 && lvl <= sectionLevel) {
			sectionEnd = i;
			break;
		}
	}

	// Parse the new entry's date
	const newDate = parseDateFromLine(referenceBlock);

	// Find chronological insertion point within the section (newest first)
	// Scan existing entries — each entry starts with a non-empty line after section header
	let insertAt = sectionEnd; // default: append at end of section
	if (newDate) {
		for (let i = sectionIdx + 1; i < sectionEnd; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			const existingDate = parseDateFromLine(line);
			if (existingDate && existingDate < newDate) {
				insertAt = i;
				break;
			}
		}
	}

	// Build new lines array with the reference block inserted
	const refLines = referenceBlock.split('\n');
	const newLines = [
		...lines.slice(0, insertAt),
		...refLines,
		'',
		...lines.slice(insertAt),
	];

	return content.slice(0, bodyStart) + newLines.join('\n');
}
