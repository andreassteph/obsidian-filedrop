import { Notice } from 'obsidian';

import convertScript from '../python/filedrop_convert.py';
import msgScript from '../python/filedrop_msg.py';
import { LlmGateway, SlideDoc, getCapabilities, isGatewayEnabled, isGatewayUrlSecure } from './settings';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile, spawn } = require('child_process') as typeof import('child_process');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path') as typeof import('path');

export type ConvertPhase = 'markitdown' | 'llm-image';
export type OnPhase = (phase: ConvertPhase) => void;
export type OnProgress = (current: number, total: number) => void;

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
	onProgress?: OnProgress,
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
			const p = line.match(/^\[filedrop:page-progress\]\s+(\d+)\/(\d+)/);
			if (p && onProgress) onProgress(Number(p[1]), Number(p[2]));
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
// Per-page/slide budget for multi-page formats (PPTX and PDF) where the LLM
// is called once per image/page sequentially.
const LLM_TIMEOUT_PER_PAGE_MS = 50_000;
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

// On a timeout the subprocess is SIGTERM'd mid-stream, so whatever it printed
// before the kill is all we get — but that "last output" is exactly what tells
// us *where* it hung (which phase, what markitdown logged, whether any markdown
// was produced). Capture and surface it instead of a bare one-liner, since long
// budgets timing out is suspicious and needs diagnosing.
function timeoutDetail(stderr: string, stdout: string, timeoutMs?: number): string {
	const lines = (stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
	// `[filedrop:phase] <phase>` is our live progress marker — the last one tells
	// us which stage the process was in when it was killed (markitdown vs
	// llm-image), the single most useful signal for a timeout.
	let lastPhase: string | null = null;
	for (const line of lines) {
		const m = line.match(/^\[filedrop:phase\]\s+(\S+)/);
		if (m) lastPhase = m[1];
	}
	const diagnostics = lines.filter((l) => l.startsWith('[filedrop]') && !l.startsWith('[filedrop:phase]') && !l.startsWith('[filedrop:page-progress]'));
	const otherLines = lines.filter((l) => !l.startsWith('[filedrop]') && !l.startsWith('[filedrop:phase]') && !l.startsWith('[filedrop:page-progress]'));

	const budget = timeoutMs ? ` after ${Math.round(timeoutMs / 1000)}s` : '';
	const parts = [`The conversion process timed out before finishing${budget}.`];
	if (lastPhase) parts.push(`Last phase reached: ${lastPhase}`);
	if (diagnostics.length) parts.push(`Diagnostics:\n${diagnostics.join('\n')}`);
	if (otherLines.length) {
		// Bound the captured tail so a runaway process can't dump megabytes into
		// the note (line cap + byte cap).
		let tail = otherLines.slice(-15).join('\n');
		if (tail.length > 4000) tail = '…' + tail.slice(-4000);
		parts.push(`Last output:\n${tail}`);
	}
	const produced = (stdout || '').trim().length;
	parts.push(produced
		? `Produced ${produced} characters of partial output before being killed.`
		: 'No output was produced before being killed.');
	return parts.join('\n\n');
}

// execFile sets error.message to "Command failed: <cmd>\n<stderr>". Because the
// plugin invokes Python as `-c <inlined source>`, <cmd> embeds the entire
// script, which is useless noise in a note. Surface the subprocess's stderr
// instead — the [filedrop] diagnostics plus the final traceback line, which is
// the real exception — and fall back to a short reason when there is no stderr
// (e.g. a missing Python interpreter), never the raw command.
function subprocessErrorDetail(
	error: SubprocessError,
	stderr: string,
	stdout = '',
	timeoutMs?: number,
): string {
	if (error.reason === 'timeout' || error.killed) {
		return timeoutDetail(stderr, stdout, timeoutMs);
	}
	if (error.reason === 'maxBuffer') {
		return 'The conversion process produced more output than the buffer could hold.';
	}

	const lines = (stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
	// `[filedrop]` is our diagnostic prefix; `[filedrop:phase]` is the live
	// progress marker for the status pill — surface the former, drop the latter.
	const diagnostics = lines.filter((l) => l.startsWith('[filedrop]') && !l.startsWith('[filedrop:phase]') && !l.startsWith('[filedrop:page-progress]'));
	const traceback = lines.filter((l) => !l.startsWith('[filedrop]') && !l.startsWith('[filedrop:phase]') && !l.startsWith('[filedrop:page-progress]'));
	const parts = [...diagnostics];
	if (traceback.length) parts.push(traceback[traceback.length - 1]);
	if (parts.length) return parts.join('\n');

	if (error.signal === 'SIGTERM') {
		// execFile timeouts surface only as SIGTERM (no error.reason) — treat them
		// the same as the runWithPhases timeout path.
		return timeoutDetail(stderr, stdout, timeoutMs);
	}
	if (error.code === 'ENOENT') {
		return 'Python could not be started — check the Python command in FileDrop settings.';
	}
	return 'The conversion process exited unexpectedly without any error output.';
}

// Quick pre-flight count for multi-page formats so we can size the subprocess
// timeout before starting the (potentially long) conversion.
function getPageCount(absolutePath: string, pythonCommand: string): Promise<number | null> {
	const ext = absolutePath.toLowerCase();
	let script: string;
	if (ext.endsWith('.pptx')) {
		script = 'from pptx import Presentation; import sys; print(len(Presentation(sys.argv[1]).slides))';
	} else if (ext.endsWith('.pdf')) {
		script = 'import fitz; import sys; print(fitz.open(sys.argv[1]).page_count)';
	} else {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		execFile(pythonCommand, ['-c', script, absolutePath], { timeout: 10_000 }, (error: Error | null, stdout: string) => {
			if (error) { resolve(null); return; }
			const n = parseInt(stdout.trim(), 10);
			resolve(isNaN(n) ? null : n);
		});
	});
}

// Count a .pptx's slides and embedded pictures up front (no blob reads) so the
// PPTX subprocess timeout can be sized by the actual LLM workload — which is one
// vision call per image, not per slide. Picture detection mirrors the extractor
// (try shape.image, recurse groups) so placeholder images are counted too.
function getPptxCounts(absolutePath: string, pythonCommand: string): Promise<{ slides: number; images: number } | null> {
	if (!absolutePath.toLowerCase().endsWith('.pptx')) return Promise.resolve(null);
	const script =
		'import sys\n' +
		'from pptx import Presentation\n' +
		'def count(shapes):\n' +
		'    n = 0\n' +
		'    for s in shapes:\n' +
		'        if getattr(s, "shape_type", None) == 6 and hasattr(s, "shapes"):\n' +
		'            n += count(s.shapes)\n' +
		'        else:\n' +
		'            try:\n' +
		'                _ = s.image; n += 1\n' +
		'            except Exception:\n' +
		'                pass\n' +
		'    return n\n' +
		'p = Presentation(sys.argv[1])\n' +
		'slides = list(p.slides)\n' +
		'print(f"{len(slides)} {sum(count(sl.shapes) for sl in slides)}")\n';
	return new Promise((resolve) => {
		execFile(pythonCommand, ['-c', script, absolutePath], { timeout: 15_000 }, (error: Error | null, stdout: string) => {
			if (error) { resolve(null); return; }
			const [s, i] = stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
			resolve(isNaN(s) ? null : { slides: s, images: isNaN(i) ? 0 : i });
		});
	});
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
					FILEDROP_LLM_TOKEN_PARAM: gateway ? getCapabilities(gateway).tokenParam : undefined,
					FILEDROP_LLM_TEMPERATURE: gateway ? (getCapabilities(gateway).temperature !== false ? '1' : '0') : undefined,
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
	onProgress?: OnProgress,
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
		const pageCount = await getPageCount(absolutePath, pythonCommand);
		const subprocessTimeout = pageCount != null
			? Math.max(LLM_TIMEOUT_MS, pageCount * LLM_TIMEOUT_PER_PAGE_MS)
			: LLM_TIMEOUT_MS;
		return new Promise((resolve) => {
			runWithPhases(
				pythonCommand,
				['-c', convertScript, absolutePath],
				{
					timeout: subprocessTimeout,
					maxBuffer: 200 * 1024 * 1024,
					env: {
						...process.env,
						PYTHONUTF8: '1',
						FILEDROP_LLM_URL: gateway.baseUrl,
						FILEDROP_LLM_KEY: gateway.apiKey,
						FILEDROP_LLM_MODEL: gateway.model,
						FILEDROP_LLM_PROMPT: gateway.prompt,
						FILEDROP_LLM_TOKEN_PARAM: getCapabilities(gateway).tokenParam,
						FILEDROP_LLM_VISION: getCapabilities(gateway).vision !== false ? '1' : '0',
						FILEDROP_LLM_TEMPERATURE: getCapabilities(gateway).temperature !== false ? '1' : '0',
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
						resolve(conversionErrorBody('LLM conversion failed', gwContext + subprocessErrorDetail(error, stderr, stdout, subprocessTimeout)));
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
				},
				onProgress,
			);
		});
	}

	return new Promise((resolve) => {
		execFile(
			'markitdown',
			[absolutePath],
			// 200 MB matches the LLM path. execFile defaults maxBuffer to 1 MB, which
			// truncates/kills large conversions (e.g. a big spreadsheet or docx) on
			// this CLI fallback path; give it the same headroom as the Python path.
			{ timeout: MARKITDOWN_TIMEOUT_MS, maxBuffer: 200 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' } },
			(error: Error | null, stdout: string, stderr: string) => {
				if (error) {
					const unsupported = unsupportedFormatDetail(error.message, path.basename(absolutePath));
					if (unsupported) {
						new Notice('FileDrop: file type not supported by markitdown.');
						resolve(conversionErrorBody('Unsupported file format', unsupported));
						return;
					}
					new Notice('FileDrop: markitdown failed — see note body for details.');
					resolve(conversionErrorBody('markitdown conversion failed', subprocessErrorDetail(error, stderr, stdout, MARKITDOWN_TIMEOUT_MS)));
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
	// Absolute path to the attachment bytes written to a temp dir by the Python
	// helper. The TS consumer reads it into the vault then deletes it. Avoids the
	// ~33% base64 inflation (and double in-memory copy) of shipping bytes on stdout.
	tempPath: string;
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
	onProgress?: OnProgress,
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
		env.FILEDROP_LLM_TOKEN_PARAM = getCapabilities(gateway).tokenParam;
		env.FILEDROP_LLM_VISION = getCapabilities(gateway).vision !== false ? '1' : '0';
		env.FILEDROP_LLM_TEMPERATURE = getCapabilities(gateway).temperature !== false ? '1' : '0';
		env.FILEDROP_LLM_TIMEOUT = String(PYTHON_LLM_TIMEOUT_S);
	}

	return new Promise((resolve) => {
		runWithPhases(
			pythonCommand,
			['-c', msgScript, absolutePath],
			// Attachment bytes now travel as temp files, not base64 on stdout, so
			// stdout only carries markdown + filenames + paths. Keep a generous cap
			// for very large emails, though it is no longer the binding constraint.
			{ timeout, env, maxBuffer: 200 * 1024 * 1024 },
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
						body: conversionErrorBody('MSG extraction failed', subprocessErrorDetail(error, stderr, stdout, timeout)),
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
						attachments: Array<{ filename: string; temp_path: string; markdown: string }>;
						warning?: string | null;
					};
					if (parsed.warning) {
						new Notice(`FileDrop MSG: ${parsed.warning}`);
					}
					resolve({
						body: parsed.body ?? '',
						attachments: (parsed.attachments ?? []).map((a) => ({
							filename: a.filename,
							tempPath: a.temp_path,
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
			},
			onProgress,
		);
	});
}

export interface PictureFile {
	filename: string;
	// Absolute path to the extracted image bytes in a temp dir created by the
	// Python helper. The TS consumer copies it into the vault then deletes the
	// dir — same temp-file handoff as MsgAttachment.
	tempPath: string;
}

export interface PptxStructuredResult {
	slides: SlideDoc[];
	pictures: PictureFile[];
}

// Extract a .pptx into structured per-slide data plus its embedded images via
// python/filedrop_convert.py (--pptx mode). Returns null when the structured
// path is unavailable (python-pptx missing, deck unreadable, or any failure) so
// the caller falls back to runMarkitdown. Image extraction runs even without a
// gateway; LLM image descriptions are added only when a secure gateway is set.
export async function convertPptx(
	absolutePath: string,
	pythonCommand: string,
	gateway: LlmGateway | null,
	onPhase?: OnPhase,
	onProgress?: OnProgress,
): Promise<PptxStructuredResult | null> {
	if (gateway && isGatewayEnabled(gateway) && !isGatewayUrlSecure(gateway.baseUrl)) {
		new Notice('FileDrop: refusing to send the API key over an insecure connection — converting PPTX without LLM.');
	}
	const useGateway = !!gateway && isGatewayEnabled(gateway) && isGatewayUrlSecure(gateway.baseUrl);

	const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1' };
	let timeout = MARKITDOWN_TIMEOUT_MS;
	if (useGateway && gateway) {
		env.FILEDROP_LLM_URL = gateway.baseUrl;
		env.FILEDROP_LLM_KEY = gateway.apiKey;
		env.FILEDROP_LLM_MODEL = gateway.model;
		env.FILEDROP_LLM_PROMPT = gateway.prompt;
		env.FILEDROP_LLM_TOKEN_PARAM = getCapabilities(gateway).tokenParam;
		env.FILEDROP_LLM_VISION = getCapabilities(gateway).vision !== false ? '1' : '0';
		env.FILEDROP_LLM_TEMPERATURE = getCapabilities(gateway).temperature !== false ? '1' : '0';
		env.FILEDROP_LLM_TIMEOUT = String(PYTHON_LLM_TIMEOUT_S);
		// LLM work is one vision call per image (4-way parallel in Python), so size
		// the budget by whichever is larger: slide count or images/4.
		const counts = await getPptxCounts(absolutePath, pythonCommand);
		const driver = counts != null ? Math.max(counts.slides, Math.ceil(counts.images / 4)) : null;
		timeout = driver != null
			? Math.max(LLM_TIMEOUT_MS, driver * LLM_TIMEOUT_PER_PAGE_MS)
			: LLM_TIMEOUT_MS;
	}

	return new Promise((resolve) => {
		runWithPhases(
			pythonCommand,
			['-c', convertScript, '--pptx', absolutePath],
			{ timeout, maxBuffer: 200 * 1024 * 1024, env },
			onPhase,
			(error, stdout, stderr) => {
				if (error) {
					console.error('FileDrop convertPptx failed:', subprocessErrorDetail(error, stderr, stdout, timeout));
					resolve(null);
					return;
				}
				// Empty stdout is the Python helper's signal to fall back to markitdown.
				if (!stdout.trim()) {
					resolve(null);
					return;
				}
				try {
					const parsed = JSON.parse(stdout) as {
						slides: SlideDoc[];
						pictures: Array<{ filename: string; path: string }>;
					};
					resolve({
						slides: parsed.slides ?? [],
						pictures: (parsed.pictures ?? []).map((p) => ({ filename: p.filename, tempPath: p.path })),
					});
				} catch (e) {
					console.error('FileDrop convertPptx: could not parse output as JSON:', e);
					resolve(null);
				}
			},
			onProgress,
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
