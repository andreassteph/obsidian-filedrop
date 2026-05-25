# Release Notes

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
