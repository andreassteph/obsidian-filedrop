import { Notice, requestUrl } from 'obsidian';

export const VIEW_TYPE = 'filedrop-sidebar';
export const MAX_RECENT_FILES = 50;

// What a specific model on a gateway accepts. Detected by probeModel() (the
// "Check" button) and also learned at runtime via callChat()'s auto-retry, then
// honored by every LLM call so e.g. reasoning models that reject `max_tokens`
// get `max_completion_tokens` (or no limit at all) without the user noticing.
export interface ModelCapabilities {
	tokenParam: 'max_tokens' | 'max_completion_tokens' | 'none'; // 'none' => omit the token-limit param entirely
	systemRole: boolean;   // false => fold the system message into the user message
	vision: boolean;       // image_url content accepted
	temperature: boolean;  // false => omit temperature (e.g. reasoning models that reject it)
	checkedAt?: string;    // ISO timestamp of the last successful probe/auto-detect
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
	tokenParam: 'max_tokens',
	systemRole: true,
	vision: true,
	temperature: true,
};

export interface LlmGateway {
	id: string;
	name: string;
	provider: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	prompt: string;
	// Per-model capability cache, keyed by model id. Optional so older configs
	// load unchanged; a missing entry means "assume defaults".
	capabilities?: Record<string, ModelCapabilities>;
}

// The capabilities for the gateway's currently selected model, or defaults.
export function getCapabilities(gw: LlmGateway): ModelCapabilities {
	return gw.capabilities?.[gw.model] ?? { ...DEFAULT_CAPABILITIES };
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

// A restructure template pairs a template note (headings + per-section guidance)
// with the main vault folder where restructured notes derived from it are filed.
export interface RestructureTemplatePair {
	id: string;
	name: string;            // user-facing label
	templatePath: string;    // vault-relative path to the template .md
	targetFolder: string;    // vault-relative main folder for created notes
}

export interface FileDropSettings {
	incomingDir: string;
	externalFolder: string;          // absolute OS path, '' = disabled
	externalGroupFileLimit: number;  // max files per top-level folder group
	categories: string[];
	defaultTags: string[];
	preferredTags: string;
	describeExtensions: string;
	groupConcurrency: number;
	largeFileWarnMb: number;
	llmGateways: LlmGateway[];
	pythonCommand: string;
	referenceGroups: ReferenceConditionGroup[];
	referenceTemplate: string;
	referenceMaxMatches: number;
	templateFolder: string;          // vault-relative folder of note templates, '' = disabled
	restructureTemplates: RestructureTemplatePair[];  // template ↔ main-folder pairs for the restructure workflow
	todoSection: string;
	todoPrompt: string;
	pptxBatchMaxSlides: number;
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
	| 'unknown'
	| 'moving'
	| 'converting'
	| 'converting-markitdown'
	| 'converting-llm-image'
	| 'converting-llm-reflow'
	| 'converting-llm-tags'
	| 'converted'
	| 'verified'
	| 'warning'
	| 'error';

export const STATUS_LABELS: Record<FileDropStatus, string> = {
	unknown: 'unknown',
	moving: 'moving',
	converting: 'converting',
	'converting-markitdown': 'converting (markitdown)',
	'converting-llm-image': 'converting (llm picture description)',
	'converting-llm-reflow': 'converting (llm slide reflow)',
	'converting-llm-tags': 'converting (llm description)',
	converted: 'converted',
	verified: 'verified',
	warning: 'warning',
	error: 'error',
};

export function isConvertingStatus(status: FileDropStatus): boolean {
	return (
		status === 'converting' ||
		status === 'converting-markitdown' ||
		status === 'converting-llm-image' ||
		status === 'converting-llm-reflow' ||
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
	// External linked-folder entries: raw file lives outside the vault.
	external?: boolean;
	sourcePath?: string;      // absolute external path (file or top-level folder)
	sourceSignature?: string; // size+mtime fingerprint for change detection
	pageProgress?: { current: number; total: number }; // live page/slide progress during conversion
}

export interface PluginData {
	settings: FileDropSettings;
	recentFiles: DroppedFile[];
}

// System prompt used to turn a plain-English follow-up request into a single
// Obsidian Tasks line. The caller prepends today's date so relative phrases
// ("in a month") resolve correctly.
export const DEFAULT_TODO_PROMPT = [
	'You convert a follow-up request about a note into ONE Obsidian Tasks line.',
	'Output format: a markdown checklist item "- [ ] <description>" followed by optional signifiers.',
	'Use these Obsidian Tasks emoji signifiers with YYYY-MM-DD dates:',
	'  📅 due date · ⏳ scheduled date · 🛫 start date · 🔁 recurrence (e.g. "🔁 every month")',
	'  priority: 🔺 highest, ⏫ high, 🔼 medium, 🔽 low, ⏬ lowest',
	'Resolve relative dates from today. A "follow up in <period>" request is a SCHEDULED date (⏳) today + that period.',
	'Keep the description short and actionable, referencing the note when helpful.',
	'Return ONLY the single task line, with no surrounding text, quotes, or code fences.',
].join('\n');

export const DEFAULT_SETTINGS: FileDropSettings = {
	incomingDir: 'incoming',
	externalFolder: '',
	externalGroupFileLimit: 10,
	categories: ['default', 'mails', 'teams'],
	defaultTags: [],
	preferredTags: '',
	describeExtensions: '.exe, .dll, .ocx, .scr, .acm, .olb, .fon, .vxd, .386, .cpl, .com, .drv, .pif, .qts, .qtx, .sys, .vbx, .ax, .bin, .so, .dylib, .o, .a, .lib, .out',
	groupConcurrency: 3,
	largeFileWarnMb: 25,
	llmGateways: [],
	pythonCommand: 'python3',
	referenceGroups: [],
	referenceTemplate: '{{date}} {{type}}: {{title}}\n{{summary}}\n\nPeople: {{people}}\n\nSource: {{note_link}}',
	referenceMaxMatches: 5,
	templateFolder: '',
	restructureTemplates: [],
	todoSection: '## Tasks',
	todoPrompt: DEFAULT_TODO_PROMPT,
	pptxBatchMaxSlides: 8,
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
		const detail = (err as any)?.status
			? gatewayErrorDetail((err as any).status, (err as any).text ?? '')
			: String(err);
		new Notice(`FileDrop: could not fetch models — ${detail}.`);
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

// Real conversion failures vs. the "best guess from filename" fallback both
// render as callouts; the file list distinguishes them as error vs. warning.
export function hasErrorCallout(content: string): boolean {
	return content.trimStart().startsWith('> [!error]');
}

export function hasWarningCallout(content: string): boolean {
	return content.trimStart().startsWith('> [!warning]');
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

// Extract a human-readable error message from a gateway HTTP error response body.
function gatewayErrorDetail(status: number, body: string): string {
	if (body) {
		try {
			const json = JSON.parse(body);
			const msg =
				json?.error?.message ??
				(typeof json?.error === 'string' ? json.error : undefined) ??
				json?.message ??
				json?.detail;
			if (typeof msg === 'string' && msg.trim()) return `HTTP ${status} — ${msg.trim()}`;
		} catch {
			// not JSON — fall through to raw text
		}
		const trimmed = body.trim().slice(0, 200);
		if (trimmed) return `HTTP ${status} — ${trimmed}`;
	}
	return `HTTP ${status}`;
}

export type ChatMessage = { role: string; content: unknown };

// Move every `system` message into the first textual `user` message (as a
// prefix) for models that reject the system role. Non-mutating.
function foldSystemRole(messages: ChatMessage[]): ChatMessage[] {
	const systemParts = messages
		.filter((m) => m.role === 'system' && typeof m.content === 'string')
		.map((m) => m.content as string);
	if (systemParts.length === 0) return messages;
	const prefix = systemParts.join('\n\n');
	const rest = messages.filter((m) => m.role !== 'system');
	const idx = rest.findIndex((m) => m.role === 'user' && typeof m.content === 'string');
	if (idx === -1) return [{ role: 'user', content: prefix }, ...rest];
	return rest.map((m, i) => (i === idx ? { role: m.role, content: `${prefix}\n\n${m.content as string}` } : m));
}

// Assemble the chat-completions JSON body honoring a model's capabilities:
// pick the token-limit param name (or omit it), and fold the system role if
// unsupported.
export function buildChatBody(
	caps: ModelCapabilities,
	opts: { model: string; messages: ChatMessage[]; maxTokens: number; temperature?: number }
): Record<string, unknown> {
	const messages = caps.systemRole ? opts.messages : foldSystemRole(opts.messages);
	const body: Record<string, unknown> = { model: opts.model, messages };
	if (caps.tokenParam !== 'none') body[caps.tokenParam] = opts.maxTokens;
	if (opts.temperature !== undefined && caps.temperature !== false) body.temperature = opts.temperature;
	return body;
}

// Given a gateway error message and the capabilities currently in effect, return
// the single capability change the error implies (or null if it's not a
// parameter-compatibility problem we know how to fix). Capability-aware so the
// token param can step max_tokens → max_completion_tokens → none.
export function detectCapabilityFix(detail: string, caps: ModelCapabilities): Partial<ModelCapabilities> | null {
	const d = detail.toLowerCase();
	if (d.includes('max_tokens') || d.includes('max_completion_tokens')) {
		if (d.includes('max_completion_tokens') && caps.tokenParam !== 'max_completion_tokens') {
			return { tokenParam: 'max_completion_tokens' };
		}
		if (caps.tokenParam !== 'none') return { tokenParam: 'none' };
	}
	if (caps.systemRole && d.includes('system') && /unsupported|not supported|does not support|invalid|developer|role/.test(d)) {
		return { systemRole: false };
	}
	if (caps.vision && /image|vision|multimodal|modalit/.test(d)) {
		return { vision: false };
	}
	if (caps.temperature !== false && d.includes('temperature') && /unsupported|not supported|does not support|invalid/.test(d)) {
		return { temperature: false };
	}
	return null;
}

export interface ChatPayload {
	label: string;
	messages: ChatMessage[];
	maxTokens: number;
	temperature?: number;
	timeoutMs: number;
}

// Low-level chat-completion call shared by suggestTags/summarizeContent and the
// reference-matching calls in references.ts. Builds the request body from the
// model's known capabilities and, on a parameter error (e.g. max_tokens
// unsupported), flips the offending capability, persists it, and retries — so an
// unchecked model self-corrects on first use.
export async function callChat(
	gw: LlmGateway,
	payload: ChatPayload,
	persist?: () => Promise<void>
): Promise<LlmResult<string>> {
	const url = `${gw.baseUrl.replace(/\/+$/, '')}/chat/completions`;
	let caps = getCapabilities(gw);
	let lastDetail: string | undefined;

	for (let attempt = 0; attempt < 4; attempt++) {
		let res: Awaited<ReturnType<typeof requestUrl>> | null;
		try {
			const request = requestUrl({
				url,
				method: 'POST',
				throw: false,
				headers: {
					Authorization: `Bearer ${gw.apiKey}`,
					'x-api-key': gw.apiKey,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(
					buildChatBody(caps, {
						model: gw.model,
						messages: payload.messages,
						maxTokens: payload.maxTokens,
						temperature: payload.temperature,
					})
				),
			});
			const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), payload.timeoutMs));
			res = await Promise.race([request, timeout]);
		} catch (e) {
			console.error(`FileDrop ${payload.label} error:`, e);
			return { ok: false, reason: 'api-error', detail: String(e) };
		}
		if (!res) return { ok: false, reason: 'timeout' };
		if (res.status >= 200 && res.status < 300) {
			const reply = res.json?.choices?.[0]?.message?.content;
			if (typeof reply !== 'string') {
				console.error(`FileDrop ${payload.label}: unexpected response shape`, res.json);
				return { ok: false, reason: 'no-reply' };
			}
			return { ok: true, value: reply };
		}
		lastDetail = gatewayErrorDetail(res.status, res.text);
		const fix = detectCapabilityFix(lastDetail, caps);
		if (!fix) {
			console.error(`FileDrop ${payload.label}: HTTP`, res.status, res.text);
			return { ok: false, reason: 'api-error', detail: lastDetail };
		}
		// Learn the corrected capability and persist it so the next call starts right.
		caps = { ...caps, ...fix, checkedAt: new Date().toISOString() };
		gw.capabilities = { ...(gw.capabilities ?? {}), [gw.model]: caps };
		await persist?.();
	}
	return { ok: false, reason: 'api-error', detail: lastDetail ?? 'exceeded capability retries' };
}

export interface ProbeStep {
	label: string;
	status: 'ok' | 'fail' | 'warn';
	detail?: string;
}

export interface ProbeResult {
	ok: boolean;
	steps: ProbeStep[];
	capabilities?: ModelCapabilities;
}

const PROBE_TIMEOUT_MS = 30_000;
// 1×1 transparent PNG, used to test image_url (vision) support.
const PROBE_PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// Probe a gateway+model: confirm it answers a chat completion and detect which
// request parameters it supports. Adaptive — flips capabilities and retries the
// same way callChat does, but reports each step for the settings UI. Never
// throws. On success, `capabilities` holds the config all LLM calls should use.
export async function probeModel(gw: LlmGateway): Promise<ProbeResult> {
	if (!gw.model) {
		return { ok: false, steps: [{ label: 'Model selected', status: 'fail', detail: 'choose a model first' }] };
	}
	if (!isGatewayEnabled(gw)) {
		return { ok: false, steps: [{ label: 'Gateway configured', status: 'fail', detail: 'set the API key and model first' }] };
	}
	const issue = gatewayUrlIssue(gw.baseUrl);
	if (issue) {
		return { ok: false, steps: [{ label: 'Gateway URL', status: 'fail', detail: issue }] };
	}

	const url = `${gw.baseUrl.replace(/\/+$/, '')}/chat/completions`;
	const send = (body: Record<string, unknown>) => {
		const request = requestUrl({
			url,
			method: 'POST',
			throw: false,
			headers: {
				Authorization: `Bearer ${gw.apiKey}`,
				'x-api-key': gw.apiKey,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});
		const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS));
		return Promise.race([request, timeout]);
	};

	const steps: ProbeStep[] = [];
	const caps: ModelCapabilities = { ...DEFAULT_CAPABILITIES };

	// Stage 1 — reachability, token-limit param, system-role, and temperature support.
	const textMessages: ChatMessage[] = [
		{ role: 'system', content: 'You are a connectivity test.' },
		{ role: 'user', content: 'Reply with the single word: ok' },
	];
	let reached = false;
	let lastDetail: string | undefined;
	for (let attempt = 0; attempt < 4 && !reached; attempt++) {
		let res: Awaited<ReturnType<typeof requestUrl>> | null;
		try {
			res = await send(buildChatBody(caps, { model: gw.model, messages: textMessages, maxTokens: 16, temperature: 0 }));
		} catch (e) {
			steps.push({ label: 'Reachable via chat completion', status: 'fail', detail: String(e) });
			return { ok: false, steps };
		}
		if (!res) {
			steps.push({ label: 'Reachable via chat completion', status: 'fail', detail: 'timed out' });
			return { ok: false, steps };
		}
		if (res.status >= 200 && res.status < 300) {
			reached = true;
			break;
		}
		lastDetail = gatewayErrorDetail(res.status, res.text);
		const fix = detectCapabilityFix(lastDetail, caps);
		if (!fix) {
			steps.push({ label: 'Reachable via chat completion', status: 'fail', detail: lastDetail });
			return { ok: false, steps };
		}
		Object.assign(caps, fix);
	}
	if (!reached) {
		steps.push({
			label: 'Reachable via chat completion',
			status: 'fail',
			detail: lastDetail
				? `no working parameter combination — last error: ${lastDetail}`
				: 'no working parameter combination',
		});
		return { ok: false, steps };
	}
	steps.push({ label: 'Reachable via chat completion', status: 'ok' });
	steps.push(
		caps.tokenParam === 'none'
			? { label: 'Token limit parameter', status: 'warn', detail: 'neither max_tokens nor max_completion_tokens accepted — calling without a limit' }
			: { label: 'Token limit parameter', status: 'ok', detail: `using ${caps.tokenParam}` }
	);
	steps.push(
		caps.systemRole
			? { label: 'System role', status: 'ok', detail: 'supported' }
			: { label: 'System role', status: 'warn', detail: 'not supported — folding into the user message' }
	);
	steps.push(
		caps.temperature !== false
			? { label: 'Temperature parameter', status: 'ok', detail: 'supported' }
			: { label: 'Temperature parameter', status: 'warn', detail: 'not supported — omitting temperature from requests' }
	);

	// Stage 2 — vision / image input.
	const visionMessages: ChatMessage[] = [
		{ role: 'system', content: 'You are a connectivity test.' },
		{
			role: 'user',
			content: [
				{ type: 'text', text: 'Reply with the single word: ok' },
				{ type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_PNG_B64}` } },
			],
		},
	];
	try {
		const res = await send(buildChatBody(caps, { model: gw.model, messages: visionMessages, maxTokens: 16 }));
		if (!res) {
			steps.push({ label: 'Image input (vision)', status: 'warn', detail: 'timed out — left as supported' });
		} else if (res.status >= 200 && res.status < 300) {
			caps.vision = true;
			steps.push({ label: 'Image input (vision)', status: 'ok', detail: 'supported' });
		} else {
			const detail = gatewayErrorDetail(res.status, res.text);
			if (/image|vision|multimodal|modalit/i.test(detail)) {
				caps.vision = false;
				steps.push({ label: 'Image input (vision)', status: 'warn', detail: 'not supported — scanned-PDF/image OCR will be skipped' });
			} else {
				steps.push({ label: 'Image input (vision)', status: 'warn', detail: `inconclusive — ${detail}` });
			}
		}
	} catch (e) {
		steps.push({ label: 'Image input (vision)', status: 'warn', detail: `inconclusive — ${String(e)}` });
	}

	caps.checkedAt = new Date().toISOString();
	return { ok: true, steps, capabilities: caps };
}

// Ask the configured gateway to suggest tags for converted content. Prefers the
// user's preferred tags but may add new ones. Never throws — callers check result.ok.
export async function suggestTags(
	content: string,
	gateway: LlmGateway | null,
	preferred: PreferredTag[],
	options?: { maxTags?: number; maxContentChars?: number },
	persist?: () => Promise<void>
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

	const result = await callChat(
		gateway,
		{
			label: 'suggestTags',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 150,
			temperature: 0,
			timeoutMs: TAG_SUGGEST_TIMEOUT_MS,
		},
		persist
	);
	if (!result.ok) return result;
	return { ok: true, value: parseTagReply(result.value, maxTags) };
}

// Ask the configured gateway for a short, descriptive filename (no extension) for
// already-converted content — used to name pasted screenshots/text. The reply is
// stripped of thinking/code-fences and reduced to its first line; the caller is
// responsible for final sanitization and any fallback. Never throws.
export async function suggestFilename(
	content: string,
	gateway: LlmGateway | null,
	options?: { maxContentChars?: number },
	persist?: () => Promise<void>
): Promise<LlmResult<string>> {
	if (!gateway || !isGatewayEnabled(gateway)) return { ok: false, reason: 'api-error', detail: 'no gateway configured' };
	if (!isGatewayUrlSecure(gateway.baseUrl)) return { ok: false, reason: 'insecure-url' };
	if (!content) return { ok: false, reason: 'empty-content', detail: 'content is empty' };
	if (isErrorBody(content)) return { ok: false, reason: 'empty-content', detail: 'content contains a conversion error' };

	const maxChars = options?.maxContentChars ?? 4000;
	const body = content.slice(0, maxChars);

	const system =
		'You name a document with a short, descriptive filename. ' +
		'Use kebab-case, lowercase, at most about six words, no file extension. ' +
		'If the content is a meeting (notes, invite, or screenshot of one), start the name with "meeting-" followed by the meeting topic or title. ' +
		'Return ONLY the filename, with no path, no extension, and no other text.';
	const user = `Document content:\n${body}`;

	const result = await callChat(
		gateway,
		{
			label: 'suggestFilename',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 40,
			temperature: 0,
			timeoutMs: TAG_SUGGEST_TIMEOUT_MS,
		},
		persist
	);
	if (!result.ok) return result;
	const reply = stripThinking(result.value)
		.replace(/^```(?:\w+)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim()
		.split('\n')[0]
		.trim();
	if (reply.length === 0) return { ok: false, reason: 'no-reply' };
	return { ok: true, value: reply };
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
	options?: { maxContentChars?: number },
	persist?: () => Promise<void>
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

	const result = await callChat(
		gateway,
		{
			label: 'summarize',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 2000,
			temperature: 0,
			timeoutMs: SUMMARY_TIMEOUT_MS,
		},
		persist
	);
	if (!result.ok) return result;
	const summary = cleanSummaryReply(result.value);
	if (summary.length === 0) return { ok: false, reason: 'no-reply' };
	return { ok: true, value: summary };
}

// Revise an existing summary according to a user instruction. The LLM gets the
// full document as context plus the current summary and the change request.
// Never throws — callers check result.ok for the specific failure reason.
export async function reviseSummary(
	content: string,
	currentSummary: string,
	instruction: string,
	gateway: LlmGateway | null,
	options?: { maxContentChars?: number },
	persist?: () => Promise<void>
): Promise<LlmResult<string>> {
	if (!gateway || !isGatewayEnabled(gateway)) return { ok: false, reason: 'api-error', detail: 'no gateway configured' };
	if (!isGatewayUrlSecure(gateway.baseUrl)) return { ok: false, reason: 'insecure-url' };
	if (!content) return { ok: false, reason: 'empty-content', detail: 'note body is empty' };
	if (isErrorBody(content)) return { ok: false, reason: 'empty-content', detail: 'note contains a conversion error' };

	const maxChars = options?.maxContentChars ?? 20000;
	const body = content.slice(0, maxChars);

	const system =
		'You revise the summary of a document. ' +
		'You are given the full document, its current summary, and an instruction on how to change it. ' +
		'Apply the instruction and return a concise summary in a few plain sentences. ' +
		'No markdown, no preamble, no labels — return only the revised summary text.';
	const user =
		`Document content:\n${body}\n\n` +
		`Current summary:\n${currentSummary}\n\n` +
		`Instruction for how to change the summary:\n${instruction}`;

	const result = await callChat(
		gateway,
		{
			label: 'revise-summary',
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 2000,
			temperature: 0,
			timeoutMs: SUMMARY_TIMEOUT_MS,
		},
		persist
	);
	if (!result.ok) return result;
	const summary = cleanSummaryReply(result.value);
	if (summary.length === 0) return { ok: false, reason: 'no-reply' };
	return { ok: true, value: summary };
}

// ---------------------------------------------------------------------------
// Structure-aware PPTX reflow
//
// python/filedrop_convert.py (--pptx mode) emits one of these per slide: each
// shape with its geometry (so we can reconstruct columns / reading order) plus
// extracted-picture references and any LLM image descriptions. The TS side here
// turns that into clean Markdown via the LLM, falling back to a deterministic
// geometry-ordered render when no gateway is available.
// ---------------------------------------------------------------------------

export interface SlideGeom {
	left: number | null;
	top: number | null;
	width: number | null;
	height: number | null;
}

export type SlideElement =
	| { type: 'text'; geom: SlideGeom; paragraphs: { text: string; level: number }[] }
	| { type: 'table'; geom: SlideGeom; markdown: string }
	| { type: 'chart'; geom: SlideGeom; title: string; markdown: string }
	| { type: 'picture'; geom: SlideGeom; filename: string; description: string }
	| { type: 'shape'; geom: SlideGeom; shape_kind: string; text: string };

export interface SlideDoc {
	index: number;
	elements: SlideElement[];
	notes?: string;
}

const PPTX_STRUCTURE_TIMEOUT_MS = 180_000; // reasoning models can be slow on big decks
const EMU_PER_INCH = 914400;
// Shapes whose tops differ by less than this are treated as the same horizontal
// band (a row of columns) so they read left-to-right rather than purely top-down.
const EMU_ROW_BAND = EMU_PER_INCH / 2;

function emuToInch(v: number | null): string {
	return v == null ? '?' : (v / EMU_PER_INCH).toFixed(2);
}

function slidesToPrompt(slides: SlideDoc[]): string {
	const parts: string[] = [];
	for (const slide of slides) {
		parts.push(`### Slide ${slide.index}`);
		for (const el of slide.elements) {
			const g = el.geom;
			const pos = `[x=${emuToInch(g.left)}in y=${emuToInch(g.top)}in w=${emuToInch(g.width)}in h=${emuToInch(g.height)}in]`;
			if (el.type === 'text') {
				const text = el.paragraphs
					.map((p) => `${'  '.repeat(Math.max(0, p.level))}${p.text}`)
					.join('\n');
				parts.push(`TEXTBOX ${pos}\n${text}`);
			} else if (el.type === 'table') {
				parts.push(`TABLE ${pos}\n${el.markdown}`);
			} else if (el.type === 'chart') {
				parts.push(`CHART ${pos}${el.title ? ` title="${el.title}"` : ''}\n${el.markdown}`);
			} else if (el.type === 'shape') {
				const txt = el.text ? ` text="${el.text}"` : '';
				parts.push(`SHAPE ${pos} kind=${el.shape_kind}${txt}`);
			} else {
				parts.push(`IMAGE ${pos} ref=${el.filename}${el.description ? ` description="${el.description}"` : ''}`);
			}
		}
		if (slide.notes) parts.push(`NOTES\n${slide.notes}`);
	}
	return parts.join('\n\n');
}

const PPTX_BATCH_MAX_SLIDES_DEFAULT = 8;
const PPTX_BATCH_MAX_CHARS = 12000;

// Split a deck into batches small enough that each reflow response stays well
// under the token cap (avoids silently truncating later slides on big decks).
function batchSlides(slides: SlideDoc[], maxSlides: number): SlideDoc[][] {
	const batches: SlideDoc[][] = [];
	let current: SlideDoc[] = [];
	let chars = 0;
	for (const slide of slides) {
		const size = slidesToPrompt([slide]).length;
		if (current.length > 0 && (current.length >= maxSlides || chars + size > PPTX_BATCH_MAX_CHARS)) {
			batches.push(current);
			current = [];
			chars = 0;
		}
		current.push(slide);
		chars += size;
	}
	if (current.length) batches.push(current);
	return batches;
}

const PPTX_REFLOW_SYSTEM =
	'You convert a PowerPoint deck into clean, readable Markdown. ' +
	"You are given each slide's shapes with their positions in inches (x/y is the top-left corner, w/h is the size). " +
	'Infer the correct reading order from the geometry: top-to-bottom, and for shapes positioned side by side, left-to-right as columns. ' +
	'Render each slide under a "## Slide N" heading (use the slide number given). ' +
	'Preserve bullet indentation, keep tables as Markdown tables, and keep the text faithful — do not summarize, drop, or invent content. ' +
	'For CHART elements, render the provided data as a Markdown table and add a one-sentence summary of the trend it shows. ' +
	"If a slide has NOTES, render them under a '### Notes' subheading after that slide's content. " +
	'Emit every image exactly as ![description](ref), using the given ref filename verbatim and unmodified — no folder and no path. ' +
	'SHAPE elements are structural drawing elements (arrows, connectors, boxes, pentagons, etc.) with their shape kind and any text they contain. ' +
	'When a slide contains SHAPE elements, describe the overall structure or flow they form (e.g. a flowchart or process diagram) rather than listing each shape individually. Omit SHAPE elements that carry no content and are purely decorative. ' +
	'Return ONLY the Markdown, with no preamble and no code fences.';

// Reflow one batch of slides via the LLM. Returns the cleaned Markdown.
async function reflowBatch(
	gateway: LlmGateway,
	slides: SlideDoc[],
	persist?: () => Promise<void>
): Promise<LlmResult<string>> {
	const result = await callChat(
		gateway,
		{
			label: 'structurePptx',
			messages: [
				{ role: 'system', content: PPTX_REFLOW_SYSTEM },
				{ role: 'user', content: slidesToPrompt(slides) },
			],
			maxTokens: 8000,
			temperature: 0,
			timeoutMs: PPTX_STRUCTURE_TIMEOUT_MS,
		},
		persist
	);
	if (!result.ok) return result;
	const body = stripThinking(result.value)
		.replace(/^```(?:\w+)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();
	if (body.length === 0) return { ok: false, reason: 'no-reply' };
	return { ok: true, value: body };
}

// Reflow extracted slide elements into clean Markdown, using shape geometry so
// multi-column layouts read in the right order. Large decks are processed in
// batches so no response truncates; a batch that fails falls back to the
// deterministic renderSlidesPlain for its slides, so content is never lost.
// Returns !ok only when there are no slides or every batch failed — the caller
// then renders the whole deck with renderSlidesPlain.
export async function structurePptxSlides(
	slides: SlideDoc[],
	gateway: LlmGateway | null,
	persist?: () => Promise<void>,
	maxSlidesPerBatch?: number
): Promise<LlmResult<string>> {
	if (!gateway || !isGatewayEnabled(gateway)) return { ok: false, reason: 'api-error', detail: 'no gateway configured' };
	if (!isGatewayUrlSecure(gateway.baseUrl)) return { ok: false, reason: 'insecure-url' };
	if (slides.length === 0) return { ok: false, reason: 'empty-content', detail: 'no slides' };

	const rendered: string[] = [];
	let anyOk = false;
	for (const batch of batchSlides(slides, maxSlidesPerBatch ?? PPTX_BATCH_MAX_SLIDES_DEFAULT)) {
		const res = await reflowBatch(gateway, batch, persist);
		if (res.ok) {
			rendered.push(res.value);
			anyOk = true;
		} else {
			rendered.push(renderSlidesPlain(batch));
		}
	}
	if (!anyOk) return { ok: false, reason: 'no-reply', detail: 'all reflow batches failed' };
	return { ok: true, value: rendered.join('\n\n') };
}

// Deterministic fallback when no gateway is configured (or the reflow call
// fails): order each slide's shapes by geometry and render them as plain
// Markdown, so the note still has all the content and working image embeds.
export function renderSlidesPlain(slides: SlideDoc[]): string {
	const out: string[] = [];
	for (const slide of slides) {
		out.push(`## Slide ${slide.index}`);
		const ordered = [...slide.elements].sort((a, b) => {
			const at = a.geom.top ?? 0;
			const bt = b.geom.top ?? 0;
			if (Math.abs(at - bt) > EMU_ROW_BAND) return at - bt;
			return (a.geom.left ?? 0) - (b.geom.left ?? 0);
		});
		for (const el of ordered) {
			if (el.type === 'text') {
				out.push(
					el.paragraphs
						.map((p) => (p.level > 0 ? `${'    '.repeat(p.level - 1)}- ${p.text}` : p.text))
						.join('\n')
				);
			} else if (el.type === 'table') {
				out.push(el.markdown);
			} else if (el.type === 'chart') {
				out.push((el.title ? `**${el.title}**\n\n` : '') + el.markdown);
			} else if (el.type === 'shape') {
				if (el.text) out.push(el.text);
			} else {
				out.push(`![${el.description}](${el.filename})`);
			}
		}
		if (slide.notes) out.push(`### Notes\n\n${slide.notes}`);
	}
	return out.join('\n\n');
}
