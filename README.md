# obsidian-filedrop
An Obsidian Plugin that allows file Drag&amp;Drop to insert arbitrary files and use them in the obsidian vault. Leveraging markitdown to convert files and content.

## LLM image descriptions

Images can be described by an LLM during conversion. In the plugin settings, pick a
**Provider**:

- **Google Gemini** — uses Gemini's OpenAI-compatible endpoint; get an API key from
  [Google AI Studio](https://aistudio.google.com/apikey).
- **OpenAI** — uses the OpenAI API directly.
- **Custom** — any OpenAI-compatible gateway; enter the base URL yourself.

Selecting a provider prefills the base URL (editable for regional/self-hosted
endpoints). Click refresh next to **Model** to pull the available models from the
provider's API, then choose one. Leave the API key blank to convert without an LLM.

## API

FileDrop exposes its current-note tools as an in-process API (the same pattern
QuickAdd uses), reachable once the plugin has loaded via:

```js
const api = app.plugins.plugins["obsidian-filedrop"].api;
```

You can call it from Templater, `dataviewjs`, QuickAdd user scripts, or other
plugins. Every method takes a single options object and returns a plain result
(`{ ok: true, ... }` or `{ ok: false, reason, detail }`) — nothing is thrown and
no UI is shown.

Common options:

- `note` — note path or basename. **Defaults to the active note.**
- `gateway` — gateway id or name. Defaults to the sidebar's selected gateway,
  then the first enabled one.
- `preview` — when `true`, return the result without writing it to the note
  (default `false`, i.e. the result is applied).

### `api.summarize(options?)`

Generates (or revises) the note's `summary` frontmatter.

- `instruction` — when present, revise the existing summary per this instruction
  instead of regenerating it.
- `includeMetadata` — also fill `file_date` / `file_type` / `file_people` when
  generating a fresh summary (default `true`).

Returns `{ ok, summary, metadata? }`.

```js
// Preview a fresh summary without touching the note
await api.summarize({ preview: true });
// Apply, then tighten it
await api.summarize({});
await api.summarize({ instruction: "make it one sentence" });
```

### `api.suggestTags(options?)`

Suggests topical tags and writes them to the note's `tags` frontmatter.

- `maxTags` — max number of tags to request (default 6).
- `merge` — union the suggestions with existing tags (default `true`) vs. replace.

Returns `{ ok, tags, added }`.

```js
await api.suggestTags({ maxTags: 4 });
```

Possible `reason` values: the LLM errors (`timeout`, `api-error`, `no-reply`,
`insecure-url`, `empty-content`) plus `note-not-found`, `note-ambiguous`,
`not-markdown`, and `no-gateway`.
