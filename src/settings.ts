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

export interface FileDropSettings {
	incomingDir: string;
	categories: string[];
	defaultTags: string[];
	llmGateways: LlmGateway[];
	pythonCommand: string;
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

export interface DroppedFile {
	filename: string;
	filePath: string;   // vault-relative path to raw file
	notePath: string;   // vault-relative path to .md note
	tags: string[];
	category: string;
	droppedAt: number;
	verified?: boolean;
}

export interface PluginData {
	settings: FileDropSettings;
	recentFiles: DroppedFile[];
}

export const DEFAULT_SETTINGS: FileDropSettings = {
	incomingDir: 'incoming',
	categories: ['default', 'mails', 'teams'],
	defaultTags: [],
	llmGateways: [],
	pythonCommand: 'python3',
};

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
			headers: { Authorization: `Bearer ${gw.apiKey}` },
		});
		const data = (res.json?.data ?? []) as { id?: string }[];
		return data
			.map((m) => m.id)
			.filter((id): id is string => typeof id === 'string')
			.sort();
	} catch {
		new Notice('FileDrop: could not fetch models from the gateway.');
		return [];
	}
}
