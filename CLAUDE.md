# obsidian-filedrop

Obsidian plugin that lets users drag & drop arbitrary files into notes. Files are converted via [markitdown](https://github.com/microsoft/markitdown) and inserted as markdown content.

## Stack

- TypeScript + Obsidian Plugin API (the Electron/UI side)
- markitdown for file-to-markdown conversion, driven by Python helper scripts in `python/` that the plugin shells out to
- LLMs (OpenAI-compatible gateways) used on both sides: **Python** for image/scanned-PDF descriptions, **TypeScript** for tags, summaries, metadata extraction, note-reference matching, and todo generation

## Codebase map

The plugin is a TypeScript + Python hybrid. TypeScript handles the Obsidian UI,
spawns Python subprocesses for conversion, and makes all chat-completion LLM
calls itself; Python does the actual markitdown conversion and the
vision/OCR LLM calls embedded in it.

### TypeScript (`main.ts` + `src/`)

- `main.ts` — plugin entry point (`onload`). `processDroppedFile()` handles a dropped file end to end; `rerunConversion()` re-converts with a different LLM gateway. `scanExternalFolder()` scans a configured **external** (outside-vault) folder: top-level files become linked notes flat under `incomingDir` (raw files left in place, referenced via a `file://` link + `external: true`/`source-path` frontmatter), top-level subfolders become group notes (recursive, capped by `externalGroupFileLimit`); re-imports only when a size+mtime signature changed. Wires commands, ribbon icon, settings tab, and the drop handler.
- `src/convert.ts` — **markitdown orchestration.** `runMarkitdown()` invokes (via `execFile`) either the `markitdown` CLI or the Python conversion script; `runMsgConversion()` handles `.msg`; `checkMarkitdownCli()`, `checkPythonEnv()`, and `installPythonRequirements()` manage the Python environment. Passes the active gateway's config + detected capabilities to Python as env vars.
- `src/settings.ts` — settings schema **and the shared TS LLM layer.** `LlmGateway`, `LLM_PROVIDERS`, `FileDropSettings` (incl. `referenceGroups`). `ModelCapabilities` + `getCapabilities()` describe per-model quirks; `callChat()` is the **single low-level chat-completions client** all TS LLM calls route through — it builds the request via `buildChatBody()`, and on a parameter error flips the offending capability (`detectCapabilityFix()`), persists it, and retries. High-level helpers: `suggestTags()`, `summarizeContent()`, `reviseSummary()`. `probeModel()` powers the settings "Check" button (detects capabilities). Plus `fetchModelsForGateway()`, `stripThinking()`, the `LlmResult<T>`/`LlmOpError` result types, and gateway URL-security helpers (`isGatewayUrlSecure()`).
- `src/references.ts` — **note-reference engine (LLM-heavy).** `findCandidateNotes()` filters vault notes by frontmatter condition groups (no LLM); `extractActivityMetadata()` parses date/type/people via regex; then three `callChat`-backed helpers — `fillMetadataWithLLM()` (fill in missing date/type/people), `matchCandidatesWithLLM()` (rank which existing notes a document belongs with), `generateTodoTask()` (produce an Obsidian Tasks line). Also the render/insert helpers (`renderReferenceBlock()`, `insertReferenceIntoNote()`, `insertTaskIntoNote()`, `normalizeTaskLine()`).
- `src/reference-modal.ts` — `ReferenceModal`, the UI that confirms matched notes and writes reference blocks / generated todos into them.
- `src/settings-tab.ts` — settings UI panel (LLM gateway config, model dropdown, "Check" probe, reference groups).
- `src/view.ts` — sidebar drop-zone UI and per-file/per-note actions ("Add summary", "Suggest tags", "Add references"). Orchestrates the reference flow: extract metadata → `fillMetadataWithLLM` → `summarizeContent` → `matchCandidatesWithLLM` → open `ReferenceModal`.
- `src/utils.ts` — shared helpers.

### Python (`python/`)

- `python/filedrop_convert.py` — **core markitdown + LLM conversion.** `build_converter()` instantiates `MarkItDown` with an optional OpenAI client; `convert()` runs the conversion; `_convert_pdf_pages_with_llm()` does page-by-page OCR for scanned PDFs; `_convert_without_llm()` is the text-only fallback; `describe()` guesses unsupported file types. Honors capability env vars (`_token_kwargs`, `_vision_enabled`, `_temperature_kwargs`, `_llm_timeout`).
- `python/filedrop_msg.py` — Outlook `.msg` extraction with attachments, reusing the same markitdown + LLM PDF fallback (helpers duplicated here so it stays self-contained).
- `python/manual_convert.py` — standalone interactive CLI wrapper around `filedrop_convert.py` (prompts for LLM config + file path); for manual testing outside Obsidian.

## How conversion & LLM wiring works

- Drop → `main.ts:processDroppedFile()` → `src/convert.ts:runMarkitdown()` (or `runMsgConversion()` for `.msg`) → Python script → markitdown.
- markitdown is reachable two ways: the `markitdown` CLI on `PATH`, or the Python package invoked through `python/filedrop_convert.py`.

### Where LLMs are called

**TypeScript (chat completions, all via `settings.ts:callChat()` → OpenAI-compatible `POST /chat/completions`):**

1. `suggestTags()` — tag suggestions (`settings.ts`)
2. `summarizeContent()` — note summaries (`settings.ts`)
3. `reviseSummary()` — revise a summary per a user instruction (`settings.ts`)
4. `probeModel()` — settings "Check" button; detects model capabilities (`settings.ts`)
5. `fillMetadataWithLLM()` — extract missing date/type/people (`references.ts`)
6. `matchCandidatesWithLLM()` — rank related notes for a dropped document (`references.ts`)
7. `generateTodoTask()` — generate an Obsidian Tasks line (`references.ts`)

   `callChat()` centralizes auth, capability-aware body building, and the
   self-correcting retry; helpers return a typed `LlmResult<T>` (callers check
   `.ok` rather than catching).

**Python (vision/OCR, via the OpenAI SDK inside markitdown):**

1. Image-file descriptions (markitdown's `llm_client` image path)
2. Scanned-PDF page OCR (`_convert_pdf_pages_with_llm`)
3. `.msg` attachment PDF fallback (`filedrop_msg.py`)
4. `describe()` — best-effort guess for unsupported file types

### TS → Python LLM config (env vars)

`runMarkitdown()` / `runMsgConversion()` / the describe path pass the active
gateway and its detected capabilities to Python:

- `FILEDROP_LLM_URL`, `FILEDROP_LLM_KEY`, `FILEDROP_LLM_MODEL`, `FILEDROP_LLM_PROMPT`
- `FILEDROP_LLM_TOKEN_PARAM` — `max_tokens` / `max_completion_tokens` / `none`
- `FILEDROP_LLM_VISION`, `FILEDROP_LLM_TEMPERATURE` — `1`/`0` capability flags
- `FILEDROP_LLM_TIMEOUT` — per-request timeout (seconds)
- `FILEDROP_DESCRIBE` / `FILEDROP_DESCRIBE_EXTS` — enable/scope the describe fallback
- `FILEDROP_IMAGE_MAX_BYTES` / `FILEDROP_IMAGE_JPEG_QUALITY` / `FILEDROP_IMAGE_MIN_DIM` — optional (Python-only, no TS plumbing) knobs for the large-image guard: big images are re-encoded as a compressed JPEG (and downscaled only as a last resort, never below `MIN_DIM`) so the payload stays under the gateway's request-size limit (avoids HTTP 413)

These mirror the TS `ModelCapabilities` so Python builds requests the same way
`callChat()` does — keep the two sides in sync when adding a capability.

## Dev

```bash
npm install
npm run dev      # watch build
npm run build    # production build (type-check + bundle)
npm run test:py  # run the Python conversion tests (pytest)
```

Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/obsidian-filedrop/` in a vault to test.

## Key conventions

- Keep the plugin footprint small — no unnecessary dependencies
- File conversion happens server-side or via markitdown subprocess; handle errors gracefully when markitdown is unavailable
- Inserted content should be plain markdown; avoid proprietary Obsidian syntax
