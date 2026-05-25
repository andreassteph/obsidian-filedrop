import { Notice } from 'obsidian';

import convertScript from '../python/filedrop_convert.py';
import { FileDropSettings, isGatewayUrlSecure, isLlmEnabled } from './settings';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile } = require('child_process') as typeof import('child_process');

const MARKITDOWN_TIMEOUT_MS = 30_000;
const LLM_TIMEOUT_MS = 120_000;

function conversionErrorBody(title: string, detail: string): string {
	return `> [!error] Conversion error: ${title}\n> ${detail.replace(/\n/g, '\n> ')}`;
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
