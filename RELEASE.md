# Release Notes

## 0.1.9 — Improve PDF conversion with markitdown-first strategy

### Changes

- Try markitdown with LLM support first for PDFs (handles text-layer and embedded images); fall back to PyMuPDF page-by-page OCR only for scanned/image-only PDFs

## 0.1.8 — Scanned PDF OCR, executable handling, and UX improvements

### Changes

- Add LLM-powered OCR for scanned PDFs (both dropped directly and as MSG attachments) using PyMuPDF for page rendering
- Handle unsupported file formats gracefully — show a clean error callout instead of a raw Python traceback; for executables, ask the LLM to describe the file from its name
- Add "Install Python Requirements" button in settings to install all dependencies in one click
- Add rerun button on file entries to re-run markitdown conversion on demand
- Fix MSG file detection to cover more file types and surface extract-msg errors clearly
- Replace pdf2image/poppler with PyMuPDF for cross-platform compatibility (Windows support)

## 0.1.7 — Improve MSG PDF OCR, add requirements installer, and fix Windows PDF compatibility

### Changes

- Fix Windows PDF compatibility by replacing pdf2image/poppler with PyMuPDF for OCR
- Fix LLM OCR for scanned PDF attachments embedded in MSG files
- Add "Install Python Requirements" button to settings for one-click dependency setup
- Improve MSG file detection and surface extract-msg errors more clearly

## 0.1.6 — Add MSG attachment extraction and embedding

### Changes

- Add support for .msg files: extract email body and all attachments, convert each to markdown, and embed them in a single note

## 0.1.5 — Add verified status tracking and multi-LLM gateway with per-drop model selection

### Changes

- Add verified checkbox to file entries so files can be marked as reviewed; syncs state with incoming folder
- Add incoming folder sync that picks up files dropped outside the plugin and reflects them in the sidebar
- Add multi-LLM gateway support with a per-drop model selector for choosing the LLM at conversion time

## 0.1.4 — Add multi-provider LLM support and refactor plugin internals

### Changes

- Add LLM provider selector in settings supporting Google Gemini, OpenAI, and custom endpoints for image descriptions
- Strip reasoning model "thinking" tokens from LLM image descriptions to avoid leaking raw chain-of-thought into notes
- Include the full filename with extension in generated note names
- Refactor: extract Python conversion logic into a standalone testable file and split main.ts into focused modules

## 0.1.3 — Fix file conversion on Windows for paths with spaces

### Changes

- Fix mixed path separator bug that caused "Command failed" errors on Windows when converting files with spaces in their names

## 0.1.2 — Add markitdown check button to settings

### Changes

- Add "Check markitdown" button in settings to verify the markitdown installation and display version info inline

## 0.1.1 — Add Python environment check to settings

### Changes

- Add "Check Python" button in settings to verify the configured Python interpreter, markitdown, and openai packages are all installed
- Show inline ✓/✗ results per package with error detail on failure

## 0.1.0 — Initial Release

First public release of FileDrop.

### Features

- Drag & drop any file into an Obsidian note
- Converts files to markdown via [markitdown](https://github.com/microsoft/markitdown) (Python) — supports PDF, DOCX, PPTX, XLSX, images, audio, and more
- LLM-powered image description via markitdown's image processing API
- Files stored in a configurable vault folder with automatic category subfolders
- Sidebar file list showing all dropped files
- Graceful fallback when markitdown is unavailable
- HTTP gateway support for local/LAN hosts; HTTPS enforced for remote hosts

### Installation via BRAT

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)
2. In BRAT settings, click **Add Beta Plugin**
3. Enter: `andreassteph/obsidian-filedrop`
4. Enable FileDrop in Obsidian's plugin settings
