import { Notice } from 'obsidian';

import convertScript from '../python/filedrop_convert.py';
import msgScript from '../python/filedrop_msg.py';
import { LlmGateway, isGatewayEnabled, isGatewayUrlSecure } from './settings';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile, spawn } = require('child_process') as typeof import('child_process');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path') as typeof import('path');

export type ConvertPhase = 'markitdown' | 'llm-image';
export type OnPhase = (phase: ConvertPhase) => void;

// Run a subprocess, streaming stderr live so we can forward `[filedrop:phase]`
// markers to the caller, while still buffering the full stdout/stderr for the
// completion callback. Mirrors execFile's callback shape.
type KillReason = 'timeout' | 'maxBuffer' | undefined;
type SubprocessError = Error & {
	killed?: boolean;
	signal?: string;
	code?: string | number;
	reason?: KillReason;
};

function runWithPhases(
	cmd: string,
	args: string[],
	options: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
	onPhase: OnPhase | undefined,
	done: (error: SubprocessError | null, stdout: string, stderr: string) => void,
): void {
	let stdout = '';
	let stderr = '';
	let stderrLine = '';
	let killReason: KillReason;
	const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;

	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(cmd, args, { env: options.env });
	} catch (err) {
		done(err as SubprocessError, '', '');
		return;
	}

	const timer = options.timeout
		? setTimeout(() => {
			killReason = 'timeout';
			child.kill('SIGTERM');
		}, options.timeout)
		: null;

	child.stdout?.on('data', (chunk: Buffer) => {
		stdout += chunk.toString('utf8');
		if (stdout.length > maxBuffer) {
			killReason = killReason ?? 'maxBuffer';
			child.kill('SIGTERM');
		}
	});

	child.stderr?.on('data', (chunk: Buffer) => {
		const text = chunk.toString('utf8');
		stderr += text;
		stderrLine += text;
		let nl;
		while ((nl = stderrLine.indexOf('\n')) >= 0) {
			const line = stderrLine.slice(0, nl).trim();
			stderrLine = stderrLine.slice(nl + 1);
			const m = line.match(/^\[filedrop:phase\]\s+(\S+)/);
			if (m && onPhase) onPhase(m[1] as ConvertPhase);
		}
	});

	child.on('error', (err: Error & { code?: string }) => {
		if (timer) clearTimeout(timer);
		done(err as SubprocessError, stdout, stderr);
	});

	child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
		if (timer) clearTimeout(timer);
		if (code === 0) {
			done(null, stdout, stderr);
			return;
		}
		const err = new Error(`Command failed: ${cmd}\n${stderr}`) as SubprocessError;
		err.killed = killReason === 'timeout';
		err.reason = killReason;
		err.signal = signal ?? undefined;
		err.code = code ?? undefined;
		done(err, stdout, stderr);
	});
}

const MARKITDOWN_TIMEOUT_MS = 30_000;
// Per-LLM-request budget enforced inside Python (httpx). Keep this below the
// Node-side subprocess cap so a stuck request fails with a precise Python
// error message before Node SIGTERMs the whole subprocess.
const PYTHON_LLM_TIMEOUT_S = 150;
// Node-side subprocess caps. Add headroom over PYTHON_LLM_TIMEOUT_S so a
// single slow-but-eventually-finishing request doesn't get killed mid-flight.
const LLM_TIMEOUT_MS = (PYTHON_LLM_TIMEOUT_S + 30) * 1000;
// MSG conversion runs body + every attachment through the LLM sequentially,
// so scanned PDFs with many pages need a much larger overall budget — but
// each individual request is still bounded by PYTHON_LLM_TIMEOUT_S.
const MSG_LLM_TIMEOUT_MS = 720_000;

function conversionErrorBody(title: string, detail: string): string {
	return `> [!error] Conversion error: ${title}\n> ${detail.replace(/\n/g, '\n> ')}`;
}

// markitdown raises UnsupportedFormatException for file types it can't handle
// (e.g. .exe). Node appends the subprocess stderr to error.message, so detect
// that line and surface it instead of the full traceback.
function unsupportedFormatDetail(message: string, fileName?: string): string | null {
	if (!message.includes('UnsupportedFormatException')) return null;
	const m = message.match(/UnsupportedFormatException:\s*(.+)/);
	const detail = m ? m[1].trim() : 'This file type is not supported by markitdown.';
	return fileName ? `${fileName}: ${detail}` : detail;
}

// execFile sets error.message to "Command failed: <cmd>\n<stderr>". Because the
// plugin invokes Python as `-c <inlined source>`, <cmd> embeds the entire
// script, which is useless noise in a note. Surface the subprocess's stderr
// instead — the [filedrop] diagnostics plus the final traceback line, which is
// the real exception — and fall back to a short reason when there is no stderr
// (e.g. a timeout or a missing Python interpreter), never the raw command.
function subprocessErrorDetail(
	error: SubprocessError,
	stderr: string
): string {
	// A timeout-killed Python process produces a SIGTERM mid-stream — any
	// stderr from before the kill is partial and misleading, so report the
	// timeout directly instead of surfacing it.
	if (error.reason === 'timeout' || error.killed) {
		return 'The conversion process timed out before finishing.';
	}
	if (error.reason === 'maxBuffer') {
		return 'The conversion process produced more output than the buffer could hold.';
	}

	const lines = (stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
	// `[filedrop]` is our diagnostic prefix; `[filedrop:phase]` is the live
	// progress marker for the status pill — surface the former, drop the latter.
	const diagnostics = lines.filter((l) => l.startsWith('[filedrop]') && !l.startsWith('[filedrop:phase]'));
	const traceback = lines.filter((l) => !l.startsWith('[filedrop]') && !l.startsWith('[filedrop:phase]'));
	const parts = [...diagnostics];
	if (traceback.length) parts.push(traceback[traceback.length - 1]);
	if (parts.length) return parts.join('\n');

	if (error.signal === 'SIGTERM') {
		return 'The conversion process timed out before finishing.';
	}
	if (error.code === 'ENOENT') {
		return 'Python could not be started — check the Python command in FileDrop settings.';
	}
	return 'The conversion process exited unexpectedly without any error output.';
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
					FILEDROP_LLM_TIMEOUT: String(PYTHON_LLM_TIMEOUT_S),
				},
			},
			(error: Error | null, stdout: string, stderr: string) => {
				if (error || !stdout.trim()) {
					const fileName = path.basename(absolutePath);
					const errorDetail = stderr?.trim() || error?.message || 'Unknown error.';
					new Notice(`FileDrop: describe failed for ${fileName} — see note for details.`);
					resolve(conversionErrorBody(
						`Describe failed — ${fileName}`,
						`The LLM describe step failed for this file.\n\n${errorDetail}`
					));
					return;
				}
				resolve([
					'> [!warning] Unsupported file format — could not convert',
					"> markitdown can't convert this file type. Best guess from the filename (may be inaccurate):",
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
	gateway: LlmGateway | null,
	onPhase?: OnPhase,
	describeExtensions?: string,
): Promise<string> {
	const dotIdx = absolutePath.lastIndexOf('.');
	const fileExt = dotIdx >= 0 ? absolutePath.slice(dotIdx).toLowerCase() : '';
	const describeExts = describeExtensions
		? new Set(describeExtensions.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
		: null;
	const shouldDescribe = describeExts !== null && describeExts.has(fileExt);

	// Layer 1: skip markitdown entirely for known binary extensions.
	if (shouldDescribe) {
		return describeExecutable(absolutePath, pythonCommand, gateway);
	}

	if (gateway && isGatewayEnabled(gateway) && !isGatewayUrlSecure(gateway.baseUrl)) {
		new Notice('FileDrop: refusing to send the API key over an insecure connection — converting without LLM.');
	} else if (gateway && isGatewayEnabled(gateway)) {
		return new Promise((resolve) => {
			runWithPhases(
				pythonCommand,
				['-c', convertScript, absolutePath],
				{
					timeout: LLM_TIMEOUT_MS,
					maxBuffer: 200 * 1024 * 1024,
					env: {
						...process.env,
						PYTHONUTF8: '1',
						FILEDROP_LLM_URL: gateway.baseUrl,
						FILEDROP_LLM_KEY: gateway.apiKey,
						FILEDROP_LLM_MODEL: gateway.model,
						FILEDROP_LLM_PROMPT: gateway.prompt,
						FILEDROP_LLM_TIMEOUT: String(PYTHON_LLM_TIMEOUT_S),
						FILEDROP_DESCRIBE_EXTS: describeExtensions,
					},
				},
				onPhase,
				(error, stdout, stderr) => {
					if (error) {
						const unsupported = unsupportedFormatDetail(error.message, path.basename(absolutePath));
						if (unsupported) {
							// Layer 2: markitdown flagged the format as unsupported — try describe.
							if (shouldDescribe) {
								describeExecutable(absolutePath, pythonCommand, gateway).then(resolve);
								return;
							}
							new Notice('FileDrop: file type not supported by markitdown.');
							resolve(conversionErrorBody('Unsupported file format', unsupported));
							return;
						}
						new Notice('FileDrop: LLM conversion failed — see note body for details.');
						const gwContext = `Gateway: ${gateway.name}\nURL: ${gateway.baseUrl}\nModel: ${gateway.model}\n\n`;
						resolve(conversionErrorBody('LLM conversion failed', gwContext + subprocessErrorDetail(error, stderr)));
						return;
					}
					if (!stdout.trim()) {
						// Layer 3: markitdown ran but produced nothing (e.g. binary file) — try describe.
						if (shouldDescribe) {
							describeExecutable(absolutePath, pythonCommand, gateway).then(resolve);
							return;
						}
						const diagLines = stderr.split('\n').filter(l => l.startsWith('[filedrop]')).join('\n');
						const gwContext = `Gateway: ${gateway.name}\nURL: ${gateway.baseUrl}\nModel: ${gateway.model}\n\n`;
						const detail = diagLines
							? `markitdown exited but returned empty content.\n\nDiagnostics:\n${diagLines}`
							: 'markitdown exited successfully but returned empty content.';
						resolve(conversionErrorBody('Conversion produced no output', gwContext + detail));
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
			(error: Error | null, stdout: string, stderr: string) => {
				if (error) {
					const unsupported = unsupportedFormatDetail(error.message, path.basename(absolutePath));
					if (unsupported) {
						new Notice('FileDrop: file type not supported by markitdown.');
						resolve(conversionErrorBody('Unsupported file format', unsupported));
						return;
					}
					new Notice('FileDrop: markitdown failed — see note body for details.');
					resolve(conversionErrorBody('markitdown conversion failed', subprocessErrorDetail(error, stderr)));
					return;
				}
				if (!stdout.trim()) {
					const diagLines = stderr.split('\n').filter(l => l.startsWith('[filedrop]')).join('\n');
					const detail = diagLines
						? `markitdown exited but returned empty content.\n\nDiagnostics:\n${diagLines}`
						: 'markitdown exited successfully but returned empty content.';
					resolve(conversionErrorBody('Conversion produced no output', detail));
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
	gateway: LlmGateway | null,
	onPhase?: OnPhase,
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
		env.FILEDROP_LLM_TIMEOUT = String(PYTHON_LLM_TIMEOUT_S);
	}

	return new Promise((resolve) => {
		runWithPhases(
			pythonCommand,
			['-c', msgScript, absolutePath],
			{ timeout, env, maxBuffer: 50 * 1024 * 1024 },
			onPhase,
			(error, stdout, stderr) => {
				if (error) {
					const unsupported = unsupportedFormatDetail(error.message, path.basename(absolutePath));
					if (unsupported) {
						new Notice('FileDrop: file type not supported by markitdown.');
						resolve({
							body: conversionErrorBody('Unsupported file format', unsupported),
							attachments: [],
						});
						return;
					}
					new Notice('FileDrop: MSG extraction failed — see note body for details.');
					resolve({
						body: conversionErrorBody('MSG extraction failed', subprocessErrorDetail(error, stderr)),
						attachments: [],
					});
					return;
				}
				if (!stdout.trim()) {
					const diagLines = stderr.split('\n').filter(l => l.startsWith('[filedrop]')).join('\n');
					const detail = diagLines
						? `MSG conversion exited but produced no output.\n\nDiagnostics:\n${diagLines}`
						: 'MSG conversion exited successfully but produced no output.';
					resolve({
						body: conversionErrorBody('MSG conversion produced no output', detail),
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
						body: conversionErrorBody(
							'MSG parse error',
							`Could not parse MSG conversion output as JSON: ${e instanceof Error ? e.message : String(e)}`,
						),
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
