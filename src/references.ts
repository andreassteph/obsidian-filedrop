import { App, TFile } from 'obsidian';

import { LlmGateway, LlmResult, ReferenceConditionGroup, callChat, isGatewayEnabled, isGatewayUrlSecure, stripThinking } from './settings';

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
		date = new Date(fileStat.ctime).toISOString().slice(0, 7);
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
	persist?: () => Promise<void>,
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

	// Route through callChat so this honors the model's detected capabilities
	// (token-param name, system-role folding) and auto-corrects on a parameter
	// error — the same path that makes summarizeContent robust.
	const result = await callChat(
		gateway,
		{
			label: 'fillMetadata',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 300,
			temperature: 0,
			timeoutMs: REFERENCE_TIMEOUT_MS,
		},
		persist
	);
	if (!result.ok) return result;

	const cleaned = stripThinking(result.value).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
	const objMatch = cleaned.match(/\{[\s\S]*\}/);
	if (!objMatch) return { ok: false, reason: 'no-reply' };
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(objMatch[0]);
	} catch (e) {
		console.error('FileDrop fillMetadataWithLLM parse error:', e);
		return { ok: false, reason: 'no-reply' };
	}

	const out: ActivityMetadata = { ...metadata };
	if (!out.date && typeof parsed.date === 'string') out.date = parsed.date;
	if (!out.type && typeof parsed.type === 'string') out.type = parsed.type;
	if (!out.people && Array.isArray(parsed.people)) out.people = parsed.people.map(String);
	return { ok: true, value: out };
}

export async function matchCandidatesWithLLM(
	noteContent: string,
	noteFrontmatter: Record<string, unknown>,
	groupCandidates: GroupCandidates[],
	gateway: LlmGateway,
	maxMatches: number,
	persist?: () => Promise<void>,
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

	// Route through callChat so this honors the model's detected capabilities
	// (token-param name, system-role folding) and auto-corrects on a parameter
	// error — the same path that makes summarizeContent robust.
	const result = await callChat(
		gateway,
		{
			label: 'matchCandidates',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 2000,
			temperature: 0,
			timeoutMs: REFERENCE_TIMEOUT_MS,
		},
		persist
	);
	if (!result.ok) return result;

	const cleaned = stripThinking(result.value).trim();
	const arrMatch = cleaned.match(/\[[\s\S]*\]/);
	if (!arrMatch) return { ok: true, value: [] };
	let indices: unknown;
	try {
		indices = JSON.parse(arrMatch[0]);
	} catch (e) {
		console.error('FileDrop matchCandidatesWithLLM parse error:', e);
		return { ok: true, value: [] };
	}
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
}

export async function generateTodoTask(
	intent: string,
	context: { title: string; summary: string; date: string | null; noteContent?: string; cursorContext?: string },
	gateway: LlmGateway,
	today: string,
	promptRules: string,
	persist?: () => Promise<void>,
	currentTask?: string,
): Promise<LlmResult<string>> {
	if (!isGatewayEnabled(gateway)) return { ok: false, reason: 'api-error', detail: 'no gateway configured' };
	if (!isGatewayUrlSecure(gateway.baseUrl)) return { ok: false, reason: 'insecure-url' };

	const system = `Today's date is ${today}.\n${promptRules}`;
	const contextLines = [
		`Note title: ${context.title}`,
		context.date ? `Document date: ${context.date}` : '',
		context.summary ? `Note summary: ${context.summary.slice(0, 2000)}` : '',
		context.noteContent ? `Full note content:\n${context.noteContent.slice(0, 6000)}` : '',
		context.cursorContext ? `Cursor context:\n${context.cursorContext.slice(0, 3000)}` : '',
	].filter(Boolean).join('\n');
	// Three modes: revise an existing task line per an instruction, generate
	// fresh from an intent (original behavior), or — when called again with no
	// instruction — regenerate from scratch per the guidelines, discarding
	// whatever task line was there before.
	let user: string;
	if (intent && currentTask) {
		user = `${contextLines}\n\nCurrent task line: ${currentTask}\n\nRequested change: ${intent}\n\nUpdate the task line to reflect the requested change. Keep it a single Tasks-formatted line.`;
	} else if (intent) {
		user = `${contextLines}\n\nTodo request: ${intent}`;
	} else {
		user = `${contextLines}\n\nGenerate a sensible follow-up task line based on the note context and the guidelines above.`;
	}

	// Route through callChat so this honors the model's detected capabilities
	// (token-param name, system-role folding) and auto-corrects on a parameter
	// error — the same path used by the other reference LLM helpers.
	const result = await callChat(
		gateway,
		{
			label: 'generateTodo',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			// Generous budget: reasoning models can spend most of a small cap on
			// hidden thinking and return an empty task line otherwise.
			maxTokens: 600,
			temperature: 0,
			timeoutMs: REFERENCE_TIMEOUT_MS,
		},
		persist
	);
	if (!result.ok) return result;

	return { ok: true, value: normalizeTaskLine(result.value) };
}

// Reduce an LLM reply (or raw user text) to a single Obsidian Tasks line.
// Prefers the first existing checklist line; otherwise turns the cleaned text
// into one by prefixing "- [ ] ".
export function normalizeTaskLine(raw: string): string {
	const cleaned = stripThinking(raw).replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, '').trim();
	const lines = cleaned.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
	const task = lines.find((l) => /^[-*]\s*\[[ xX]\]/.test(l));
	if (task) return task.replace(/^[*]/, '-');
	const text = (lines[0] ?? cleaned).replace(/^[-*]\s+/, '').trim();
	return text ? `- [ ] ${text}` : '';
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

// Append a single task line at the end of the named section, creating the
// section if it doesn't exist. Unlike insertReferenceIntoNote this does not
// reorder by date — tasks are kept in insertion order.
export function insertTaskIntoNote(content: string, taskLine: string, sectionHeader: string): string {
	const fmEnd = content.indexOf('\n---\n');
	const bodyStart = fmEnd >= 0 ? fmEnd + 5 : 0;
	const body = content.slice(bodyStart);

	const sectionLevel = headingLevel(sectionHeader.trim());
	const lines = body.split('\n');

	let sectionIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === sectionHeader.trim()) {
			sectionIdx = i;
			break;
		}
	}

	if (sectionIdx === -1) {
		const separator = content.endsWith('\n') ? '\n' : '\n\n';
		return content + separator + sectionHeader + '\n\n' + taskLine + '\n';
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

	// Append after the last non-empty line within the section.
	let insertAt = sectionEnd;
	while (insertAt > sectionIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;

	const newLines = [...lines.slice(0, insertAt), taskLine, ...lines.slice(insertAt)];
	return content.slice(0, bodyStart) + newLines.join('\n');
}
