# obsidian-filedrop

Obsidian plugin that lets users drag & drop arbitrary files into notes. Files are converted via [markitdown](https://github.com/microsoft/markitdown) and inserted as markdown content.

## Stack

- TypeScript + Obsidian Plugin API (the Electron/UI side)
- markitdown for file-to-markdown conversion, driven by Python helper scripts in `python/` that the plugin shells out to
- LLMs (OpenAI-compatible gateways) for image/PDF descriptions and for tag/summary suggestions

## Codebase map

The plugin is a TypeScript + Python hybrid. TypeScript handles the Obsidian UI
and spawns Python subprocesses; Python does the actual markitdown conversion.

### TypeScript (`main.ts` + `src/`)

- `main.ts` — plugin entry point (`onload`). `processDroppedFile()` handles a dropped file end to end; `rerunConversion()` re-converts with a different LLM gateway. Wires commands, ribbon icon, settings tab, and the drop handler.
- `src/convert.ts` — **markitdown orchestration.** `runMarkitdown()` invokes (via `execFile`) either the `markitdown` CLI or the Python conversion script; `runMsgConversion()` handles `.msg`; `checkMarkitdownCli()`, `checkPythonEnv()`, and `installPythonRequirements()` manage the Python environment.
- `src/settings.ts` — settings schema and **TS-side LLM calls.** `LlmGateway` interface, `LLM_PROVIDERS`, `suggestTags()` and `summarizeContent()` (OpenAI-compatible `/chat/completions`), `fetchModelsForGateway()`, and gateway URL-security helpers (`isGatewayUrlSecure()`).
- `src/settings-tab.ts` — settings UI panel (LLM gateway config, model dropdown).
- `src/view.ts` — sidebar drop-zone UI and per-file actions (e.g. "Add summary").
- `src/utils.ts` — shared helpers.

### Python (`python/`)

- `python/filedrop_convert.py` — **core markitdown + LLM conversion.** `build_converter()` instantiates `MarkItDown` with an optional LLM client; `convert()` runs the conversion; `_convert_pdf_pages_with_llm()` does page-by-page OCR for scanned PDFs; `describe()` guesses unsupported file types.
- `python/filedrop_msg.py` — Outlook `.msg` extraction with attachments, reusing the same markitdown + LLM PDF fallback.

## How conversion & LLM wiring works

- Drop → `main.ts:processDroppedFile()` → `src/convert.ts:runMarkitdown()` (or `runMsgConversion()` for `.msg`) → Python script → markitdown.
- markitdown is reachable two ways: the `markitdown` CLI on `PATH`, or the Python package invoked through `python/filedrop_convert.py`.
- LLMs are used in two places: **Python** (image descriptions / scanned-PDF OCR) and **TypeScript** (`suggestTags()` / `summarizeContent()` in `src/settings.ts`).
- TypeScript passes LLM config to Python via env vars: `FILEDROP_LLM_URL`, `FILEDROP_LLM_KEY`, `FILEDROP_LLM_MODEL`, `FILEDROP_LLM_PROMPT`, `FILEDROP_DESCRIBE`.

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
