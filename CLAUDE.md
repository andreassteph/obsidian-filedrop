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

- `main.ts` — plugin entry point (`onload`). `processDroppedFile()` handles a dropped file end to end; `rerunConversion()` re-converts with a different LLM gateway. `convertPptxNote()` is the shared `.pptx` path used by every conversion flow: it extracts embedded images into a sibling `<note>_pictures/` folder (`writeBinaryFromTemp` from the Python temp dir), reflows the slides via `structurePptxSlides()`, then `rewriteImageLinks()` points the body's `![](…)` links at that folder. `scanExternalFolder()` scans a configured **external** (outside-vault) folder: top-level files become linked notes flat under `incomingDir` (raw files left in place, referenced via a `file://` link + `external: true`/`source-path` frontmatter), top-level subfolders become group notes (recursive, capped by `externalGroupFileLimit`); re-imports only when a size+mtime signature changed. Wires commands, ribbon icon, settings tab, and the drop handler.
- `src/convert.ts` — **markitdown orchestration.** `runMarkitdown()` invokes (via `execFile`) either the `markitdown` CLI or the Python conversion script; `runMsgConversion()` handles `.msg`; `convertPptx()` runs the Python `--pptx` structure-aware extractor (returns per-slide `SlideDoc[]` + extracted `PictureFile[]`, or `null` to fall back to `runMarkitdown`); `checkMarkitdownCli()`, `checkPythonEnv()`, and `installPythonRequirements()` manage the Python environment. Passes the active gateway's config + detected capabilities to Python as env vars.
- `src/settings.ts` — settings schema **and the shared TS LLM layer.** `LlmGateway`, `LLM_PROVIDERS`, `FileDropSettings` (incl. `referenceGroups`). `ModelCapabilities` + `getCapabilities()` describe per-model quirks; `callChat()` is the **single low-level chat-completions client** all TS LLM calls route through — it builds the request via `buildChatBody()`, and on a parameter error flips the offending capability (`detectCapabilityFix()`), persists it, and retries. High-level helpers: `suggestTags()`, `summarizeContent()`, `reviseSummary()`, `structurePptxSlides()` (reflow extracted PPTX slides into reading-ordered markdown using shape geometry; `renderSlidesPlain()` is the no-LLM fallback). `probeModel()` powers the settings "Check" button (detects capabilities). Plus `fetchModelsForGateway()`, `stripThinking()`, the `LlmResult<T>`/`LlmOpError` result types, the `SlideDoc`/`SlideElement` types, and gateway URL-security helpers (`isGatewayUrlSecure()`).
- `src/references.ts` — **note-reference engine (LLM-heavy).** `findCandidateNotes()` filters vault notes by frontmatter condition groups (no LLM); `extractActivityMetadata()` parses date/type/people via regex; then three `callChat`-backed helpers — `fillMetadataWithLLM()` (fill in missing date/type/people), `matchCandidatesWithLLM()` (rank which existing notes a document belongs with), `generateTodoTask()` (produce an Obsidian Tasks line). Also the render/insert helpers (`renderReferenceBlock()`, `insertReferenceIntoNote()`, `insertTaskIntoNote()`, `normalizeTaskLine()`).
- `src/reference-modal.ts` — `ReferenceModal`, the UI that confirms matched notes and writes reference blocks / generated todos into them.
- `src/templates.ts` — **note-template engine.** `loadTemplatesFromPaths()` loads the configured template notes (the `templatePath` of each template pair in `settings.templatePairs`; frontmatter + body excerpt, no LLM); `rankTemplates()` picks the best-fitting template for a note — short-circuiting via a deterministic `type`/basename match when the note already declares its kind, otherwise ranking with `callChat` over title + frontmatter + content (mirrors the reference matcher); `fillTemplateFrontmatter()` asks the LLM to fill the chosen template's frontmatter fields for the note (keeping fixed identifier fields, deriving descriptive ones), coercing each value to its template field's type; `applyTemplateFrontmatter()` merges those fields into the note via `app.fileManager.processFrontMatter` — adding only missing fields, keeping all existing frontmatter and the body unchanged.
- `src/template-modal.ts` — `TemplateModal`, the UI that confirms the matched template (or lets the user pick another) and applies its filled frontmatter to the current note.
- `src/create-from-template.ts` — **create-note-from-template engine.** Creates a NEW note from the current note + a configured **template ↔ main-folder pair** (`settings.templatePairs` — the same pairs whose templates back the "Fix frontmatter" action). `loadTemplatePairs()` resolves each pair's template (frontmatter + full body, no LLM); `rankTemplatePairs()` LLM-ranks pairs for a note, leaning on its frontmatter (mirrors `rankTemplates`); `suggestSubfolder()` picks the best existing subfolder under the pair's target folder or proposes a new one; `draftNoteFromTemplate()` reflows the source into the template's headings, filling each section per its **per-section guidance line** (summary/list/verbatim/etc.) using source-only content and stripping the guidance; `factCheckNoteBody()` is a second LLM pass that validates every number/key fact against the source, correcting and re-running (capped) until clean. Frontmatter is filled by reusing `fillTemplateFrontmatter()`/`applyTemplateFrontmatter()`.
- `src/create-from-template-modal.ts` — `CreateFromTemplateModal`, the UI that confirms the matched pair, suggests/edits the target subfolder (re-suggested when the pair changes), then creates the drafted + fact-checked note (with a `source` back-link to the original) and opens it.
- `src/header-restructure.ts` — **header-reorg engine (self-restructure, in place).** Independent of `create-from-template.ts`'s template pairs — reorganizes a note's own headers rather than fitting it to an external template. `parseHeaderSections()` splits a note body into a flat, fenced-code-aware list of `HeaderSection` (level + text + untouched `bodyLines`) plus any preamble before the first header; `suggestHeaderMapping()` asks the LLM for a strict 1:1 reorder/relevel/rename of those headers (never merge/split/drop — content is never touched by the LLM, only relocated) and silently falls back to the identity mapping when no gateway is available or the call fails; `reviseHeaderMapping()` is the explicit-result variant used by the modal's Revise button, re-running the suggestion with a user instruction; `reassembleHeaderBody()` is the pure, deterministic function that reorders/rewrites header lines per a validated mapping while moving each section's body byte-for-byte.
- `src/header-restructure-modal.ts` — `HeaderRestructureModal`, the UI that shows the proposed old→new header mapping (level/text, reorderable via ↑/↓), lets the user edit it inline or type an instruction and click Revise to re-ask the LLM, then applies it by rewriting the current note in place.
- `src/settings-tab.ts` — settings UI panel (LLM gateway config, model dropdown, "Check" probe, reference groups, template pairs, and the "Note tools API access" per-tool toggles).
- `src/view.ts` — sidebar drop-zone UI and per-file/per-note actions ("Add summary", "Suggest tags", "Add references", "Fix frontmatter", "Create note from template", "Restructure headers"). Orchestrates the reference flow: extract metadata → `fillMetadataWithLLM` → `summarizeContent` → `matchCandidatesWithLLM` → open `ReferenceModal`; the template flow: `loadTemplatesFromPaths` → `rankTemplates` → open `TemplateModal` (→ `fillTemplateFrontmatter` → `applyTemplateFrontmatter`); the create-from-template flow: `loadTemplatePairs` → `rankTemplatePairs` → open `CreateFromTemplateModal` (→ `suggestSubfolder` → `draftNoteFromTemplate` → `factCheckNoteBody` → create note); and the header-restructure flow: `parseHeaderSections` → `suggestHeaderMapping` → open `HeaderRestructureModal` (→ `reviseHeaderMapping` → `reassembleHeaderBody` → rewrite the note in place).
- `src/note-tools.ts` — **headless current-note tools + in-process API.** `NoteTools(app, plugin)` exposes the per-note actions without any UI (no `Notice`/`Modal`): each method takes a typed options object — `note` (path/basename, **defaults to the active note**), `gateway` (id/name), `preview` — and returns a serializable `{ ok, … } | { ok: false, reason, detail }`, reusing the same LLM helpers the view does. `resolveNote()`/`resolveGateway()` map the params to a `TFile`/gateway. `buildFileDropApi()` builds the `FileDropApi` object assigned to `plugin.api` in `main.ts` (reachable at `app.plugins.plugins["obsidian-filedrop"].api`, QuickAdd-style — see `## API`). Also home to the shared frontmatter/task writers `writeNoteSummary()`/`writeNoteSummaryAndMetadata()`/`rewriteNoteTags()`/`writeTaskToNote()` (lifted out of `view.ts`, which now delegates to them — one write path for both sidebar and API).
- `src/utils.ts` — shared helpers.

### Python (`python/`)

- `python/filedrop_convert.py` — **core markitdown + LLM conversion.** `build_converter()` instantiates `MarkItDown` with an optional OpenAI client; `convert()` runs the conversion; `_convert_pdf_pages_with_llm()` does page-by-page OCR for scanned PDFs; `_convert_without_llm()` is the text-only fallback; `describe()` guesses unsupported file types. `convert_pptx_structured()` (the `--pptx` mode) bypasses markitdown for `.pptx`: it reads the deck with `python-pptx`, emits per-slide JSON of shapes-with-geometry, writes each embedded picture's bytes to a temp dir under markitdown's `re.sub(r"\W","",shape.name)+".jpg"` name, and (when vision is enabled) describes each image via the LLM (`_describe_image`, reusing the PDF-page 413 guard). Honors capability env vars (`_token_kwargs`, `_vision_enabled`, `_temperature_kwargs`, `_llm_timeout`).
- `python/filedrop_msg.py` — Outlook `.msg` extraction with attachments, reusing the same markitdown + LLM PDF fallback (helpers duplicated here so it stays self-contained). Each attachment is converted via `_convert_file()` **except `.pptx`**, which is left unconverted (empty `markdown`) so the TS side can run it through the structured PPTX path instead (`main.ts:convertMsgAttachmentBody()` → `convertPptxNote()`, reading the bytes back via the attachment's `temp_path`).
- `python/manual_convert.py` — standalone interactive CLI wrapper around `filedrop_convert.py` (prompts for LLM config + file path); for manual testing outside Obsidian.

## How conversion & LLM wiring works

- Drop → `main.ts:processDroppedFile()` → `src/convert.ts:runMarkitdown()` (or `runMsgConversion()` for `.msg`, or `main.ts:convertPptxNote()` → `convertPptx()` for `.pptx`) → Python script → markitdown.
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
8. `structurePptxSlides()` — reflow extracted PPTX slides (shape geometry + text + image refs) into reading-ordered markdown (`settings.ts`)
9. `rankTemplates()` — pick the best-fitting note template by title/frontmatter/content (`templates.ts`)
10. `fillTemplateFrontmatter()` — fill a chosen template's frontmatter fields for a note (`templates.ts`)
11. `rankTemplatePairs()` — pick the best template↔folder pair for the create-from-template workflow (`create-from-template.ts`)
12. `suggestSubfolder()` — pick/propose the target subfolder for a drafted note (`create-from-template.ts`)
13. `draftNoteFromTemplate()` — reflow a note into a template's headings per per-section guidance (`create-from-template.ts`)
14. `factCheckNoteBody()` — verify/correct numbers & key facts in a drafted note against the source (`create-from-template.ts`)
15. `suggestHeaderMapping()` — propose a 1:1 reorder/relevel/rename of a note's own headers (`header-restructure.ts`)
16. `reviseHeaderMapping()` — re-run the header mapping per a user instruction (`header-restructure.ts`)

   `callChat()` centralizes auth, capability-aware body building, and the
   self-correcting retry; helpers return a typed `LlmResult<T>` (callers check
   `.ok` rather than catching).

**Python (vision/OCR, via the OpenAI SDK inside markitdown):**

1. Image-file descriptions (markitdown's `llm_client` image path)
2. Scanned-PDF page OCR (`_convert_pdf_pages_with_llm`)
3. `.msg` attachment PDF fallback (`filedrop_msg.py`)
4. `describe()` — best-effort guess for unsupported file types
5. PPTX embedded-image descriptions (`_describe_image`, via `convert_pptx_structured`)

### TS → Python LLM config (env vars)

`runMarkitdown()` / `runMsgConversion()` / `convertPptx()` / the describe path
pass the active gateway and its detected capabilities to Python:

- `FILEDROP_LLM_URL`, `FILEDROP_LLM_KEY`, `FILEDROP_LLM_MODEL`, `FILEDROP_LLM_PROMPT`
- `FILEDROP_LLM_TOKEN_PARAM` — `max_tokens` / `max_completion_tokens` / `none`
- `FILEDROP_LLM_VISION`, `FILEDROP_LLM_TEMPERATURE` — `1`/`0` capability flags
- `FILEDROP_LLM_TIMEOUT` — per-request timeout (seconds)
- `FILEDROP_DESCRIBE` / `FILEDROP_DESCRIBE_EXTS` — enable/scope the describe fallback
- `FILEDROP_IMAGE_MAX_BYTES` / `FILEDROP_IMAGE_JPEG_QUALITY` / `FILEDROP_IMAGE_MIN_DIM` — optional (Python-only, no TS plumbing) knobs for the large-image guard: big images are re-encoded as a compressed JPEG (and downscaled only as a last resort, never below `MIN_DIM`) so the payload stays under the gateway's request-size limit (avoids HTTP 413)

These mirror the TS `ModelCapabilities` so Python builds requests the same way
`callChat()` does — keep the two sides in sync when adding a capability.

## API (current-note tools)

The current-note tools are exposed as an **in-process JavaScript API** (the
QuickAdd model — **no HTTP server, port, or token**; the trust boundary is code
already running in the vault). It lives in `src/note-tools.ts` and is assigned to
`plugin.api` in `main.ts:onload()`, reachable from Templater / `dataviewjs` /
QuickAdd scripts / other plugins via:

```js
app.plugins.plugins["obsidian-filedrop"].api
```

Every method takes one options object and returns `{ ok, … } | { ok: false, reason, detail }`.
Common options: `note` (path/basename, **defaults to the active note**), `gateway`
(id/name; defaults to the sidebar's selected gateway, then the first enabled one),
and `preview` (when `true`, return the result without writing it — default is apply,
**except `createFromTemplate` and `restructureNote`, which both default `preview`
to `true`**, since one creates a brand-new file and the other rewrites the whole
note's header structure). `reason` is an `LlmOpError` or one of
`note-not-found` / `note-ambiguous` / `not-markdown` / `no-gateway` /
`no-template` (no template pairs configured, or a `template`/`pair` id
wasn't found or was ambiguous) / `no-headers` (the note has fewer than two
headers) / `tool-disabled` (see below).

All seven tools are implemented:

- `summarize({ instruction?, includeMetadata? })` — fresh summary (+ `file_date`/`file_type`/`file_people` metadata when `includeMetadata`, default true), or revise the existing summary when `instruction` is given.
- `suggestTags({ maxTags?, merge? })` — suggest tags and write `tags` (union with existing by default; `merge: false` replaces).
- `createTodo({ intent, targetNote?, section?, raw? })` — generate (or, with `raw: true`, literally normalize) a Tasks line and file it under `section` (default `settings.todoSection`) in `targetNote` (default: the same note supplying context).
- `addReferences({ maxMatches?, targets?, template?, section?, todo? })` — LLM-match reference-group candidates (or, with `targets`, reference those notes directly) and insert a reference block into each; optionally also files a follow-up todo into the first referenced note.
- `fixFrontmatter({ template? })` — rank (or, with `template`, force) a configured template and fill/apply its frontmatter fields.
- `createFromTemplate({ pair?, title?, subfolder? })` — rank (or, with `pair`, force) a template pair, draft + fact-check the note into a new file under `subfolder` (LLM-suggested if omitted), and fill its frontmatter. `preview` defaults to `true` here.
- `restructureNote({ instruction?, mapping? })` — reorder/relevel/rename the note's own headers in place. With no `mapping`, asks the LLM for a suggestion (optionally steered by `instruction`, or falls back to the identity mapping without a gateway); with an explicit `mapping` and no `instruction`, applies it directly with no LLM call; with both, asks the LLM to revise the given mapping per `instruction` (requires a gateway). `preview` defaults to `true` here too.

The `*Options` interfaces in `src/note-tools.ts` are the source of truth for
each tool's full parameter list and semantics.

Each tool's exposure on the API can be toggled independently in Settings →
"Note tools API access" (`settings.noteToolsApi`, a `NoteToolName → boolean`
map, all enabled by default) — this only affects `plugin.api`, not the
sidebar buttons. `buildFileDropApi()` reads the toggle live on every call; a
disabled tool resolves to `{ ok: false, reason: 'tool-disabled' }` rather than
being removed from the API object.

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
