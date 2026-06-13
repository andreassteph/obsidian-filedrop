# Release Notes

## 0.5.1 — Fix file-group re-run conversion

### Changes

- Fix re-running conversion on a file group failing with "Conversion produced no output / Not a regular file" — each group member is now converted individually instead of handing markitdown the group folder
- Ensure describe-only files (e.g. .exe) inside a group use the filename-based description path and never hit file-type sniffing
- Add a clearer diagnostic when a non-regular-file path is passed to the Python converter, instead of a cryptic error

## 0.5.0 — Add clipboard paste and UI improvements

### Changes

- Add paste-from-clipboard button to drop area for easier file insertion
- Add hide button to cancel conversions and remove entries from memory
- Add LLM configuration documentation
- Improve conversion controls UI

## 0.4.2 — Reorganize drop controls and update documentation

### Changes

- Move group button and category dropdown into a dedicated controls row for better UI organization
- Update CLAUDE.md documentation for references engine and shared LLM layer

## 0.4.1 — Add current note sidebar panel and LLM temperature auto-adjustment

### Changes

- Add current note panel to sidebar for quick reference to the active note
- Add temperature capability detection and auto-adjustment for LLM calls based on gateway capabilities

## 0.4.0 — Add change summary dialog and follow-up todos for references

### Changes

- Add "Change summary" dialog for notes with existing summaries, allowing updates without re-running full conversion
- Make "Change summary" a two-step preview/iterate workflow for reviewing and refining summaries
- Add follow-up todo feature to references confirmation modal

## 0.3.3 — Make reference matching capability-aware and improve check diagnostics

### Changes

- Reference matching now respects gateway capability config, skipping unsupported models
- Improve diagnostics output for gateway compatibility checks

## 0.3.2 — Add per-model gateway compatibility checks and improve LLM error context

### Changes

- Add per-model gateway compatibility check and capability config in settings
- Include gateway URL and model name in LLM conversion error messages
- Change reference modal defaults: pre-select top LLM pick only, nothing pre-selected in fallback

## 0.3.1 — Improve LLM error messages with gateway context

### Changes

- Recover and surface the gateway URL in LLM failure notices for easier debugging

## 0.3.0 — Add file grouping mode and configurable binary file descriptions

### Changes

- Add file grouping mode to batch-drop multiple files into a single note
- Add configurable `describe-extensions` setting to control which binary file types get LLM descriptions
- Fix `.group/` folders creating one note per file instead of one note per group
- Improve error messages for unsupported formats and surface describe failures

## 0.2.2 — Add note references and performance improvements

### Changes

- Add note references — automatically link converted notes to related vault notes
- Improve reference matching with frontmatter context and activity metadata caching
- Performance: parallelize reference LLM calls, add max_tokens caps, extend summary timeout
- Fix wiki link references to use full markdown note paths

## 0.2.1 — Sidebar layout optimizations and smarter filelist refresh

### Changes

- Move category dropdown inline in drop area header (saves vertical space)
- Expand file list to full height when drop area is collapsed
- Refresh verified and processed flags from frontmatter on filelist update
- Auto-hide files marked as `processed: true`
- Auto-surface files that lost their verified flag

## 0.2.0 — Sidebar redesign and improved file actions

### Changes

- Reorder sidebar layout: model selector moved to top, category + drop zone now collapsible
- Add "Show verified" toggle to include verified files in the list
- Compact file items: remove tag chips, combine Add summary / Suggest tags / add-tag input into one row
- Enhance delete action with confirmation dialog to prevent accidental file deletion
- Add non-destructive hide action to temporarily remove files from the list until next update

## 0.1.21 — Split conversion status and fix LLM timeout issues

### Changes

- Split converting status into separate markitdown and LLM phases for better feedback
- Fix spurious LLM timeouts on trivial inputs
- Improve MSG conversion error messaging consistency

## 0.1.20 — Improve error handling and messages

### Changes

- Set entry status to 'error' on conversion failure
- Show specific reason when summary or tag suggestion fails

## 0.1.19 — Show file status during conversion

### Changes

- Show files immediately on drop with moving/converting/converted status indicators
- Improve UI feedback during file processing

## 0.1.18 — Add sidebar refresh button and improve .msg conversion

### Changes

- Add "Update Filelist" button to sidebar for manual refresh
- Fix .msg file conversion to match main conversion logic
- Mark plugin as desktop-only in manifest

## 0.1.17 — Fix YAML frontmatter corruption and improve PowerPoint error handling

### Changes

- Fix frontmatter tags corruption when rewriting YAML block lists
- Keep markitdown text as fallback when LLM conversion fails for PowerPoint files
- Improve error message cleanup to prevent dumped errors in logs

## 0.1.16 — Fix file naming, add tag suggestions button, and improve error handling

### Changes

- Fix double-extension note names and deduplicate drops by content hash
- Add on-demand "Suggest tags" button to file entries for flexible tagging
- Improve error handling: surface silent PDF conversion failures and add fallback for LLM conversion errors
- Increase subprocess buffer to 200 MB for large file conversions

## 0.1.15 — Fix API header capitalization for LLM requests

### Changes

- Fix X-API header capitalization in model detection requests
- Improve manual conversion script for better local testing

## 0.1.14 — Support varied LLM model response shapes and add manual fallback

### Changes

- Support varied /v1/models API response shapes from different LLM providers
- Add manual model selection fallback in settings for additional control
- Improve LLM provider compatibility and robustness

## 0.1.13 — Add per-file LLM summaries and tag suggestions

### Changes

- Add per-file "Add summary" button that writes LLM-generated summaries to frontmatter
- Add automatic tag suggestions via LLM after file conversion
- Add manual conversion script for easier local testing

## 0.1.12 — Increase LLM timeouts to 12 minutes

### Changes

- Increase per-request OpenAI client timeout from 120s to 720s (12 minutes)
- Increase MSG subprocess timeout from 10 to 12 minutes for generous headroom

## 0.1.11 — Fix LLM call timeouts for email attachments

### Changes

- Add per-request timeout (120s) to OpenAI client calls to prevent indefinite hangs
- Increase subprocess timeout for LLM conversions from 120s to 180s to prevent race conditions

## 0.1.10 — Fix UTF-8 encoding for Windows compatibility

### Changes

- Force UTF-8 output on all Python subprocesses to prevent encoding errors on Windows
- Fix ASCII encoding errors in message conversion

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
