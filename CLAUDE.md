# obsidian-filedrop

Obsidian plugin that lets users drag & drop arbitrary files into notes. Files are converted via [markitdown](https://github.com/microsoft/markitdown) and inserted as markdown content.

## Stack

- TypeScript + Obsidian Plugin API
- markitdown for file-to-markdown conversion (Python, called as a subprocess or via API)
- Standard Obsidian plugin structure: `main.ts`, `manifest.json`, `styles.css`

## Dev

```bash
npm install
npm run dev   # watch build
npm run build # production build
```

Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/obsidian-filedrop/` in a vault to test.

## Key conventions

- Keep the plugin footprint small — no unnecessary dependencies
- File conversion happens server-side or via markitdown subprocess; handle errors gracefully when markitdown is unavailable
- Inserted content should be plain markdown; avoid proprietary Obsidian syntax
