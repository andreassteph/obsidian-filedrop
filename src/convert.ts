import { Notice } from 'obsidian';

import convertScript from '../python/filedrop_convert.py';
import msgScript from '../python/filedrop_msg.py';
import { LlmGateway, isGatewayEnabled, isGatewayUrlSecure } from './settings';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile, spawn } = require('child_process') as typeof import('child_process');

const MARKITDOWN_TIMEOUT_MS = 30_000;
const LLM_TIMEOUT_MS = 180_000;
// MSG conversion runs body + every attachment through the LLM sequentially,
// so scanned PDFs with many pages need a much larger budget.
const MSG_LLM_TIMEOUT_MS = 720_000;

// The binary/executable family markitdown reports as unsupported.
const EXECUTABLE_EXTS = new Set([
	'.exe', '.ocx', '.scr', '.acm', '.olb', '.fon', '.vxd', '.386',
	'.cpl', '.com', '.dll', '.drv', '.pif', '.qts', '.qtx', '.sys',
	'.vbx', '.ax',
]);

function isExecutableFile(path: string): boolean {
	const i = path.lastIndexOf('.');
	return i >= 0 && EXECUTABLE_EXTS.has(path.slice(i).toLowerCase());
}

function conversionErrorBody(title: string, detail: string): string {
	return `> [!error] Conversion error: ${title}\n> ${detail.replace(/\n/g, '\n> ')}`;
}

// markitdown raises UnsupportedFormatException for file types it can't handle
// (e.g. .exe). Node appends the subprocess stderr to error.message, so detect
// that line and surface it instead of the full traceback.
function unsupportedFormatDetail(message: string): string | null {
	if (!message.includes('UnsupportedFormatException')) return null;
	const m = message.match(/UnsupportedFormatException:\s*(.+)/);
	return m ? m[1].trim() : 'This file type is not supported by markitdown.';
}

// Executables carry no extractable text, so ask the LLM what the file most
// likely is from its name. The reply is an educated guess, flagged as such.
function describeExecutable(absolutePath: string, pythonCommand: string, gateway: LlmGateway | null): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			pythonCommand,
			['-c', convertScript, absolutePath],
			{
				timeout: LLM_TIMEOUT_MS,
				env: {
					...process.env,
					PYTHONUTF8: '1',
					FILEDROP_DESCRIBE: '1',
					FILEDROP_LLM_URL: gateway?.baseUrl,
					FILEDROP_LLM_KEY: gateway?.apiKey,
					FILEDROP_LLM_MODEL: gateway?.model,
				},
			},
			(error: Error | null, stdout: string) => {
				if (error || !stdout.trim()) {
					new Notice('FileDrop: unsupported file type — see note for details.');
					resolve(conversionErrorBody('Unsupported file format', 'markitdown cannot convert executable files.'));
					return;
				}
				resolve([
					'> [!warning] Unsupported file format — could not convert',
					"> markitdown can't read executable files. Best guess from the filename (may be inaccurate):",
					'',
					stdout.trim(),
				].join('\n'));
			}
		);
	});
}

export async function runMarkitdown(
	absolutePath: string,
	pythonCommand: string,
	gateway: LlmGateway | null
): Promise<string> {
	if (gateway && isGatewayEnabled(gateway) && !isGatewayUrlSecure(gateway.baseUrl)) {
		new Notice('FileDrop: refusing to send the API key over an insecure connection — converting without LLM.');
	} else if (gateway && isGatewayEnabled(gateway)) {
		return new Promise((resolve) => {
			execFile(
				pythonCommand,
				['-c', convertScript, absolutePath],
				{
					timeout: LLM_TIMEOUT_MS,
					env: {
						...process.env,
						PYTHONUTF8: '1',
						FILEDROP_LLM_URL: gateway.baseUrl,
						FILEDROP_LLM_KEY: gateway.apiKey,
						FILEDROP_LLM_MODEL: gateway.model,
						FILEDROP_LLM_PROMPT: gateway.prompt,
					},
				},
				(error: Error | null, stdout: string) => {
					if (error) {
						const unsupported = unsupportedFormatDetail(error.message);
						if (unsupported) {
							if (isExecutableFile(absolutePath)) {
								describeExecutable(absolutePath, pythonCommand, gateway).then(resolve);
								return;
							}
							new Notice('FileDrop: file type not supported by markitdown.');
							resolve(conversionErrorBody('Unsupported file format', unsupported));
							return;
						}
						new Notice('FileDrop: LLM conversion failed — see note body for details.');
						resolve(conversionErrorBody('LLM conversion failed', error.message));
						return;
					}
					if (!stdout.trim()) {
						resolve(conversionErrorBody('Conversion produced no output', 'markitdown exited successfully but returned empty content.'));
						return;
					}
					resolve(stdout.trim());
				}
			);
		});
	}

	return new Promise((resolve) => {
		execFile(
			'markitdown',
			[absolutePath],
			{ timeout: MARKITDOWN_TIMEOUT_MS, env: { ...process.env, PYTHONUTF8: '1' } },
			(error: Error | null, stdout: string) => {
				if (error) {
					const unsupported = unsupportedFormatDetail(error.message);
					if (unsupported) {
						new Notice('FileDrop: file type not supported by markitdown.');
						resolve(conversionErrorBody('Unsupported file format', unsupported));
						return;
					}
					new Notice('FileDrop: markitdown failed — see note body for details.');
					resolve(conversionErrorBody('markitdown conversion failed', error.message));
					return;
				}
				if (!stdout.trim()) {
					resolve(conversionErrorBody('Conversion produced no output', 'markitdown exited successfully but returned empty content.'));
					return;
				}
				resolve(stdout.trim());
			}
		);
	});
}

export interface PythonCheckResult {
	label: string;
	ok: boolean;
	detail?: string;
}

function runPythonCheck(cmd: string, args: string[]): Promise<PythonCheckResult & { stdout: string }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 10_000 }, (error: Error | null, stdout: string, stderr: string) => {
			resolve({ label: '', ok: !error, stdout: stdout.trim(), detail: error ? (stderr.trim() || error.message).split('\n')[0] : undefined });
		});
	});
}

export async function checkMarkitdownCli(): Promise<PythonCheckResult> {
	const result = await runPythonCheck('markitdown', ['--version']);
	return {
		label: 'markitdown CLI',
		ok: result.ok,
		detail: result.ok ? result.stdout : result.detail,
	};
}

export interface MsgAttachment {
	filename: string;
	dataB64: string;
	markdown: string;
}

export interface MsgConversionResult {
	body: string;
	attachments: MsgAttachment[];
}

export async function runMsgConversion(
	absolutePath: string,
	pythonCommand: string,
	gateway: LlmGateway | null
): Promise<MsgConversionResult> {
	if (gateway && isGatewayEnabled(gateway) && !isGatewayUrlSecure(gateway.baseUrl)) {
		new Notice('FileDrop: refusing to send the API key over an insecure connection — converting MSG without LLM.');
	}
	const useGateway = gateway && isGatewayEnabled(gateway) && isGatewayUrlSecure(gateway.baseUrl);
	const timeout = useGateway ? MSG_LLM_TIMEOUT_MS : MARKITDOWN_TIMEOUT_MS;
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (useGateway && gateway) {
		env.FILEDROP_LLM_URL = gateway.baseUrl;
		env.FILEDROP_LLM_KEY = gateway.apiKey;
		env.FILEDROP_LLM_MODEL = gateway.model;
		env.FILEDROP_LLM_PROMPT = gateway.prompt;
	}

	return new Promise((resolve) => {
		execFile(
			pythonCommand,
			['-c', msgScript, absolutePath],
			{ timeout, env, maxBuffer: 50 * 1024 * 1024 },
			(error: Error | null, stdout: string) => {
				if (error) {
					new Notice('FileDrop: MSG extraction failed — see note body for details.');
					resolve({
						body: conversionErrorBody('MSG extraction failed', error.message),
						attachments: [],
					});
					return;
				}
				try {
					const parsed = JSON.parse(stdout) as {
						body: string;
						attachments: Array<{ filename: string; data_b64: string; markdown: string }>;
						warning?: string | null;
					};
					if (parsed.warning) {
						new Notice(`FileDrop MSG: ${parsed.warning}`);
					}
					resolve({
						body: parsed.body ?? '',
						attachments: (parsed.attachments ?? []).map((a) => ({
							filename: a.filename,
							dataB64: a.data_b64,
							markdown: a.markdown,
						})),
					});
				} catch (e) {
					resolve({
						body: conversionErrorBody('MSG parse error', String(e)),
						attachments: [],
					});
				}
			}
		);
	});
}

export const PYTHON_REQUIREMENTS = ['markitdown', 'openai', 'extract-msg', 'pymupdf'];

export function installPythonRequirements(
	pythonCommand: string,
	onData: (chunk: string) => void,
	onDone: (ok: boolean) => void
): void {
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(pythonCommand, ['-m', 'pip', 'install', ...PYTHON_REQUIREMENTS]);
	} catch (err) {
		onData(String(err));
		onDone(false);
		return;
	}
	child.stdout?.on('data', (data: Buffer) => onData(data.toString()));
	child.stderr?.on('data', (data: Buffer) => onData(data.toString()));
	child.on('close', (code: number | null) => onDone(code === 0));
	child.on('error', (err: Error) => { onData(err.message + '\n'); onDone(false); });
}

export async function checkPythonEnv(pythonCmd: string): Promise<PythonCheckResult[]> {
	const results: PythonCheckResult[] = [];

	const versionCheck = await runPythonCheck(pythonCmd, ['--version']);
	results.push({
		label: `Python (${pythonCmd})`,
		ok: versionCheck.ok,
		detail: versionCheck.ok ? versionCheck.stdout : versionCheck.detail,
	});

	if (!versionCheck.ok) return results;

	const markitdownCheck = await runPythonCheck(pythonCmd, ['-c', 'import markitdown; print("ok")']);
	results.push({ label: 'markitdown package', ok: markitdownCheck.ok, detail: markitdownCheck.ok ? undefined : markitdownCheck.detail });

	const openaiCheck = await runPythonCheck(pythonCmd, ['-c', 'import openai; print("ok")']);
	results.push({ label: 'openai package', ok: openaiCheck.ok, detail: openaiCheck.ok ? undefined : openaiCheck.detail });

	const extractMsgCheck = await runPythonCheck(pythonCmd, ['-c', 'import extract_msg; print("ok")']);
	results.push({ label: 'extract-msg package', ok: extractMsgCheck.ok, detail: extractMsgCheck.ok ? undefined : extractMsgCheck.detail });

	const pymupdfCheck = await runPythonCheck(pythonCmd, ['-c', 'import fitz; print("ok")']);
	results.push({ label: 'pymupdf package', ok: pymupdfCheck.ok, detail: pymupdfCheck.ok ? undefined : pymupdfCheck.detail });

	return results;
}
