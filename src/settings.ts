import { Notice, requestUrl } from 'obsidian';

export const VIEW_TYPE = 'filedrop-sidebar';
export const MAX_RECENT_FILES = 50;

export interface LlmGateway {
	id: string;
	name: string;
	provider: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	prompt: string;
}

export interface ReferenceCondition {
	field: string;
	value: string;
}

export interface ReferenceConditionGroup {
	id: string;
	name: string;
	conditions: ReferenceCondition[];
	matchFields: string[];      // frontmatter fields used as LLM matching context
	targetSection: string;      // e.g. "# Activities"
	template: string;           // empty = use global referenceTemplate
}

export interface FileDropSettings {
	incomingDir: string;
	categories: string[];
	defaultTags: string[];
	preferredTags: string;
	llmGateways: LlmGateway[];
	pythonCommand: string;
	referenceGroups: ReferenceConditionGroup[];
	referenceTemplate: string;
	referenceMaxMatches: number;
	// Legacy fields — read on first load for migration only
	llmProvider?: string;
	llmGatewayUrl?: string;
	llmApiKey?: string;
	llmModel?: string;
	llmPrompt?: string;
}

export interface ProviderDefault {
	label: string;
	baseUrl: string;
	keyPlaceholder: string;
}

// All providers speak the OpenAI Chat Completions API; only the base URL differs.
// Gemini is reached through its OpenAI-compatible endpoint.
export const LLM_PROVIDERS: Record<string, ProviderDefault> = {
	google: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', keyPlaceholder: 'AIza…' },
	openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyPlaceholder: 'sk-…' },
	custom: { label: 'Custom (OpenAI-compatible)', baseUrl: '', keyPlaceholder: 'sk-…' },
};

export type FileDropStatus =
	| 'moving'
	| 'converting'
	| 'converting-markitdown'
	| 'converting-llm-image'
	| 'converting-llm-tags'
	| 'converted'
	| 'verified'
	| 'error';

export const STATUS_LABELS: Record<FileDropStatus, string> = {
	moving: 'moving',
	converting: 'converting',
	'converting-markitdown': 'converting (markitdown)',
	'converting-llm-image': 'converting (llm picture description)',
	'converting-llm-tags': 'converting (llm description)',
	converted: 'converted',
	verified: 'verified',
	error: 'error',
};

export function isConvertingStatus(status: FileDropStatus): boolean {
	return (
		status === 'converting' ||
		status === 'converting-markitdown' ||
		status === 'converting-llm-image' ||
		status === 'converting-llm-tags'
	);
}

export interface DroppedFile {
	filename: string;
	filePath: string;   // vault-relative path to raw file
	notePath: string;   // vault-relative path to .md note
	tags: string[];
	category: string;
	droppedAt: number;
	verified?: boolean;
	processed?: boolean;
	status?: FileDropStatus;
}

export interface PluginData {
	settings: FileDropSettings;
	recentFiles: DroppedFile[];
}

export const DEFAULT_SETTINGS: FileDropSettings = {
	incomingDir: 'incoming',
	categories: ['default', 'mails', 'teams'],
	defaultTags: [],
	preferredTags: '',
	llmGateways: [],
	pythonCommand: 'python3',
	referenceGroups: [],
	referenceTemplate: '{{date}} {{type}}: {{title}}\n{{summary}}\n\nPeople: {{people}}\n\nSource: {{note_link}}',
	referenceMaxMatches: 5,
};

export interface PreferredTag {
	tag: string;
	description: string;
}

// Parse the "Preferred tags" textarea: one "tag: description" per line.
// Split on the first colon so descriptions may contain colons; a line with
// no colon is treated as a bare tag.
export function parsePreferredTags(raw: string): PreferredTag[] {
	if (!raw) return [];
	return raw
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const i = line.indexOf(':');
			if (i === -1) return { tag: line, description: '' };
			return { tag: line.slice(0, i).trim(), description: line.slice(i + 1).trim() };
		})
		.filter((p) => p.tag.length > 0);
}

export function isGatewayEnabled(gw: LlmGateway): boolean {
	return gw.apiKey.length > 0 && gw.model.length > 0;
}

export function migrateLegacyLlmFields(data: Partial<FileDropSettings>): LlmGateway[] {
	const gateways: LlmGateway[] = data.llmGateways ?? [];
	if (gateways.length === 0 && data.llmApiKey && data.llmApiKey.length > 0) {
		return [{
			id: crypto.randomUUID(),
			name: 'Default',
			provider: data.llmProvider ?? 'custom',
			baseUrl: data.llmGatewayUrl ?? '',
			apiKey: data.llmApiKey,
			model: data.llmModel ?? '',
			prompt: data.llmPrompt ?? '',
		}];
	}
	return gateways;
}

// True for loopback, RFC 1918 private ranges, link-local, and mDNS/.localhost
// names — hosts where an unencrypted gateway connection stays on the local
// machine or LAN. Assumes plain dotted-decimal / standard IPv6 (the user
// configures their own gateway; this is not an anti-SSRF guard).
export function isLocalHost(hostname: string): boolean {
	let h = hostname.toLowerCase();
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // strip IPv6 brackets

	if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;

	if (h.includes(':')) { // IPv6
		if (h === '::1') return true;                       // loopback
		if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local fc00::/7
		if (h.startsWith('fe80')) return true;              // link-local
		return false;
	}

	const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	const a = Number(m[1]);
	const b = Number(m[2]);
	if (a === 127) return true;                       // 127.0.0.0/8 loopback
	if (a === 10) return true;                         // 10.0.0.0/8
	if (a === 192 && b === 168) return true;           // 192.168.0.0/16
	if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
	if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local
	return false;
}

// Returns a human-readable problem with the gateway URL, or null if it is safe
// to send the API key to. Blank = default OpenAI (https) = safe.
export function gatewayUrlIssue(url: string): string | null {
	if (!url) return null;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return 'Gateway URL is not a valid URL.';
	}
	if (parsed.protocol === 'https:') return null;
	if (parsed.protocol === 'http:') {
		return isLocalHost(parsed.hostname)
			? null
			: 'Gateway uses http:// to a non-local host — your API key would be sent unencrypted. Use https:// or a local address.';
	}
	return 'Gateway URL must start with http:// or https://.';
}

export function isGatewayUrlSecure(url: string): boolean {
	return gatewayUrlIssue(url) === null;
}

function collectModelIds(node: unknown, out: string[]): void {
	if (typeof node === 'string') {
		if (node.length > 0) out.push(node);
		return;
	}
	if (!node || typeof node !== 'object') return;
	const o = node as Record<string, unknown>;
	// Catalog entry (e.g. Siemens gateway): model names live in a nested `models` list.
	if (Array.isArray(o.models)) {
		for (const m of o.models) collectModelIds(m, out);
		return;
	}
	// Leaf model object: OpenAI uses `id`; others use `name`/`model`.
	const id = o.id ?? o.name ?? o.model;
	if (typeof id === 'string' && id.length > 0) out.push(id);
}

// Gateways disagree on the /models shape: OpenAI returns `{ data: [{ id }] }`,
// Ollama/Google-style return `{ models: [...] }`, and the Siemens gateway returns
// a top-level array of provider entries each carrying a nested `models` list.
export function extractModelIds(json: unknown): string[] {
	const arr: unknown[] = Array.isArray(json)
		? json
		: Array.isArray((json as Record<string, unknown>)?.data)
		? ((json as Record<string, unknown>).data as unknown[])
		: Array.isArray((json as Record<string, unknown>)?.models)
		? ((json as Record<string, unknown>).models as unknown[])
		: [];
	const out: string[] = [];
	for (const item of arr) collectModelIds(item, out);
	return Array.from(new Set(out)).sort();
}

export async function fetchModelsForGateway(gw: LlmGateway): Promise<string[]> {
	if (!gw.baseUrl || !gw.apiKey) {
		new Notice('FileDrop: set the gateway URL and API key before refreshing models.');
		return [];
	}
	const issue = gatewayUrlIssue(gw.baseUrl);
	if (issue) {
		new Notice(`FileDrop: ${issue}`);
		return [];
	}
	const modelsUrl = `${gw.baseUrl.replace(/\/+$/, '')}/models`;
	try {
		const res = await requestUrl({
			url: modelsUrl,
			headers: { Authorization: `Bearer ${gw.apiKey}`, 'x-api-key': gw.apiKey },
		});
		return extractModelIds(res.json);
	} catch (err) {
		console.error('FileDrop: failed to fetch models from', modelsUrl, err);
		new Notice('FileDrop: could not fetch models from the gateway.');
		return [];
	}
}

const TAG_SUGGEST_TIMEOUT_MS = 30_000;

export type LlmOpError = 'insecure-url' | 'empty-content' | 'timeout' | 'api-error' | 'no-reply';
export type LlmResult<T> = { ok: true; value: T } | { ok: false; reason: LlmOpError; detail?: string };

// Conversion failures are written into the note body as callouts; we must not
// ask the LLM to tag an error message. Matches conversionErrorBody() in convert.ts.
export function isErrorBody(content: string): boolean {
	const head = content.trimStart();
	return head.startsWith('> [!error]') || head.startsWith('> [!warning]');
}

// Reasoning models emit chain-of-thought inline; strip it so it never pollutes
// the tag parse. Mirrors strip_thinking in python/filedrop_convert.py.
export function stripThinking(text: string): string {
	let cleaned = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
	const closers = /<\/(think|thinking|reasoning)>/gi;
	let lastEnd = -1;
	let m: RegExpExecArray | null;
	while ((m = closers.exec(cleaned)) !== null) {
		lastEnd = m.index + m[0].length;
	}
	if (lastEnd !== -1) cleaned = cleaned.slice(lastEnd);
	return cleaned.trim();
}

function parseTagReply(raw: string, maxTags: number): string[] {
	let text = stripThinking(raw).trim();
	text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

	let items: string[] = [];
	const arrMatch = text.match(/\[[\s\S]*\]/);
	if (arrMatch) {
		try {
			const parsed = JSON.parse(arrMatch[0]);
			if (Array.isArray(parsed)) items = parsed.map((x) => String(x));
		} catch {
			/* fall through to delimiter split */
		}
	}
	if (items.length === 0) {
		items = text.split(/[,\n]/);
	}

	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		const t = item
			.trim()
			.replace(/^["'\-*\s]+/, '')
			.replace(/["'\s]+$/, '')
			.replace(/^#/, '');
		if (!t) continue;
		const key = t.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(t);
		if (out.length >= maxTags) break;
	}
	return out;
}

// Ask the configured gateway to suggest tags for converted content. Prefers the
// user's preferred tags but may add new ones. Never throws — callers check result.ok.
export async function suggestTags(
	content: string,
	gateway: LlmGateway | null,
	preferred: PreferredTag[],
	options?: { maxTags?: number; maxContentChars?: number }
): Promise<LlmResult<string[]>> {
	if (!gateway || !isGatewayEnabled(gateway)) return { ok: false, reason: 'api-error', detail: 'no gateway configured' };
	if (!isGatewayUrlSecure(gateway.baseUrl)) return { ok: false, reason: 'insecure-url' };
	if (!content) return { ok: false, reason: 'empty-content', detail: 'note body is empty' };
	if (isErrorBody(content)) return { ok: false, reason: 'empty-content', detail: 'note contains a conversion error' };

	const maxTags = options?.maxTags ?? 6;
	const maxChars = options?.maxContentChars ?? 6000;
	const body = content.slice(0, maxChars);

	const preferredList = preferred.length
		? preferred.map((p) => (p.description ? `- ${p.tag}: ${p.description}` : `- ${p.tag}`)).join('\n')
		: '(none configured)';

	const system =
		'You suggest topical tags for a document. ' +
		'Strongly prefer tags from the provided preferred list when they apply. ' +
		'You may add a few new concise lowercase tags only if no preferred tag fits. ' +
		`Return at most ${maxTags} tags as a JSON array of strings, e.g. ["a","b"]. ` +
		'Return ONLY the JSON array, with no other text.';
	const user = `Preferred tags:\n${preferredList}\n\nDocument content:\n${body}`;

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
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
		}),
	});

	// requestUrl has no timeout option; race it so a stalled gateway can't block the drop.
	const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TAG_SUGGEST_TIMEOUT_MS));

	try {
		const res = await Promise.race([request, timeout]);
		if (!res) return { ok: false, reason: 'timeout' };
		if (res.status < 200 || res.status >= 300) {
			console.error('FileDrop suggestTags: HTTP', res.status, res.text);
			return { ok: false, reason: 'api-error', detail: `HTTP ${res.status}` };
		}
		const reply = res.json?.choices?.[0]?.message?.content;
		if (typeof reply !== 'string') {
			console.error('FileDrop suggestTags: unexpected response shape', res.json);
			return { ok: false, reason: 'no-reply' };
		}
		const tags = parseTagReply(reply, maxTags);
		return { ok: true, value: tags };
	} catch (e) {
		console.error('FileDrop suggestTags error:', e);
		return { ok: false, reason: 'api-error', detail: String(e) };
	}
}

const SUMMARY_TIMEOUT_MS = 180_000; // 3 minutes — reasoning models can be slow

function cleanSummaryReply(raw: string): string {
	let text = stripThinking(raw).trim();
	text = text.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, '').trim();
	// Collapse newlines/runs of whitespace so the result is a single-line YAML scalar.
	return text.replace(/\s+/g, ' ').trim();
}

// Ask the configured gateway for a concise summary of the converted content.
// Never throws — callers check result.ok for the specific failure reason.
export async function summarizeContent(
	content: string,
	gateway: LlmGateway | null,
	options?: { maxContentChars?: number }
): Promise<LlmResult<string>> {
	if (!gateway || !isGatewayEnabled(gateway)) return { ok: false, reason: 'api-error', detail: 'no gateway configured' };
	if (!isGatewayUrlSecure(gateway.baseUrl)) return { ok: false, reason: 'insecure-url' };
	if (!content) return { ok: false, reason: 'empty-content', detail: 'note body is empty' };
	if (isErrorBody(content)) return { ok: false, reason: 'empty-content', detail: 'note contains a conversion error' };

	const maxChars = options?.maxContentChars ?? 20000;
	const body = content.slice(0, maxChars);

	const system =
		'You write a concise summary of a document. ' +
		'Capture the main point in a few plain sentences. ' +
		'No markdown, no preamble, no labels — return only the summary text.';
	const user = `Document content:\n${body}`;

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
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
		}),
	});

	// requestUrl has no timeout option; race it so a stalled gateway can't hang the UI.
	const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS));

	try {
		const res = await Promise.race([request, timeout]);
		if (!res) return { ok: false, reason: 'timeout' };
		if (res.status < 200 || res.status >= 300) {
			console.error('FileDrop summarize: HTTP', res.status, res.text);
			return { ok: false, reason: 'api-error', detail: `HTTP ${res.status}` };
		}
		const reply = res.json?.choices?.[0]?.message?.content;
		if (typeof reply !== 'string') {
			console.error('FileDrop summarize: unexpected response shape', res.json);
			return { ok: false, reason: 'no-reply' };
		}
		const summary = cleanSummaryReply(reply);
		if (summary.length === 0) return { ok: false, reason: 'no-reply' };
		return { ok: true, value: summary };
	} catch (e) {
		console.error('FileDrop summarize error:', e);
		return { ok: false, reason: 'api-error', detail: String(e) };
	}
}
