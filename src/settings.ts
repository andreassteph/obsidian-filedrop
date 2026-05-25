import { Notice, requestUrl } from 'obsidian';

export const VIEW_TYPE = 'filedrop-sidebar';
export const MAX_RECENT_FILES = 50;

export interface FileDropSettings {
	incomingDir: string;
	categories: string[];
	defaultTags: string[];
	llmGatewayUrl: string;
	llmApiKey: string;
	llmModel: string;
	llmPrompt: string;
	pythonCommand: string;
}

export interface DroppedFile {
	filename: string;
	filePath: string;   // vault-relative path to raw file
	notePath: string;   // vault-relative path to .md note
	tags: string[];
	category: string;
	droppedAt: number;
}

export interface PluginData {
	settings: FileDropSettings;
	recentFiles: DroppedFile[];
}

export const DEFAULT_SETTINGS: FileDropSettings = {
	incomingDir: 'incoming',
	categories: ['default', 'mails', 'teams'],
	defaultTags: [],
	llmGatewayUrl: '',
	llmApiKey: '',
	llmModel: '',
	llmPrompt: '',
	pythonCommand: 'python3',
};

export function isLlmEnabled(settings: FileDropSettings): boolean {
	return settings.llmApiKey.length > 0 && settings.llmModel.length > 0;
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

export async function fetchModels(settings: FileDropSettings): Promise<string[]> {
	if (!settings.llmGatewayUrl || !settings.llmApiKey) {
		new Notice('FileDrop: set the gateway URL and API key before refreshing models.');
		return [];
	}
	const issue = gatewayUrlIssue(settings.llmGatewayUrl);
	if (issue) {
		new Notice(`FileDrop: ${issue}`);
		return [];
	}
	const modelsUrl = `${settings.llmGatewayUrl.replace(/\/+$/, '')}/models`;
	try {
		const res = await requestUrl({
			url: modelsUrl,
			headers: { Authorization: `Bearer ${settings.llmApiKey}` },
		});
		const data = (res.json?.data ?? []) as { id?: string }[];
		return data
			.map((m) => m.id)
			.filter((id): id is string => typeof id === 'string')
			.sort();
	} catch (err) {
		new Notice('FileDrop: could not fetch models from the gateway.');
		return [];
	}
}
