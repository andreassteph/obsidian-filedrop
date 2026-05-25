import { Notice } from 'obsidian';

import convertScript from '../python/filedrop_convert.py';
import { FileDropSettings, isGatewayUrlSecure, isLlmEnabled } from './settings';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile } = require('child_process') as typeof import('child_process');

const MARKITDOWN_TIMEOUT_MS = 30_000;
const LLM_TIMEOUT_MS = 120_000;

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
function describeExecutable(absolutePath: string, settings: FileDropSettings): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			settings.pythonCommand,
			['-c', convertScript, absolutePath],
			{
				timeout: LLM_TIMEOUT_MS,
				env: {
					...process.env,
					FILEDROP_DESCRIBE: '1',
					FILEDROP_LLM_URL: settings.llmGatewayUrl,
					FILEDROP_LLM_KEY: settings.llmApiKey,
					FILEDROP_LLM_MODEL: settings.llmModel,
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

export async function runMarkitdown(absolutePath: string, settings: FileDropSettings): Promise<string> {
	if (isLlmEnabled(settings) && !isGatewayUrlSecure(settings.llmGatewayUrl)) {
		new Notice('FileDrop: refusing to send the API key over an insecure connection — converting without LLM.');
	} else if (isLlmEnabled(settings)) {
		return new Promise((resolve) => {
			execFile(
				settings.pythonCommand,
				['-c', convertScript, absolutePath],
				{
					timeout: LLM_TIMEOUT_MS,
					env: {
						...process.env,
						FILEDROP_LLM_URL: settings.llmGatewayUrl,
						FILEDROP_LLM_KEY: settings.llmApiKey,
						FILEDROP_LLM_MODEL: settings.llmModel,
						FILEDROP_LLM_PROMPT: settings.llmPrompt,
					},
				},
				(error: Error | null, stdout: string) => {
					if (error) {
						const unsupported = unsupportedFormatDetail(error.message);
						if (unsupported) {
							if (isExecutableFile(absolutePath)) {
								describeExecutable(absolutePath, settings).then(resolve);
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
			{ timeout: MARKITDOWN_TIMEOUT_MS },
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

	return results;
}
