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
  (default `false`, i.e. the result is applied — **except `createFromTemplate`
  and `restructureNote`, which both default `preview` to `true`**, since one
  creates a brand-new file and the other rewrites the note's whole header
  structure).

Each tool can also be turned off independently in Settings → "Note tools API
access" — a disabled tool still exists on `api`, but every call to it resolves
to `{ ok: false, reason: "tool-disabled" }`.

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

### `api.createTodo(options)`

Generates (or, with `raw: true`, literally normalizes) an Obsidian Tasks line
and files it into a note.

- `intent` — **required.** Plain-English follow-up request, or (with `raw: true`)
  the literal task text/line.
- `targetNote` — note the task line is written into. Defaults to the same note
  supplying context (`note`).
- `section` — section heading the task is filed under (default
  `settings.todoSection`).
- `raw` — skip the LLM: normalize `intent` directly into a task line. No
  gateway required.

Returns `{ ok, task, targetNote }`.

```js
await api.createTodo({ intent: "follow up next week" });
await api.createTodo({ intent: "- [ ] send the invoice", raw: true });
await api.createTodo({ intent: "remind me to review this", targetNote: "Tasks/Inbox.md" });
```

### `api.addReferences(options?)`

Matches the note against configured reference groups (or references explicit
`targets` directly) and inserts a reference block into each matched note;
optionally files a follow-up todo alongside it.

- `maxMatches` — cap on LLM-matched notes (default `settings.referenceMaxMatches`).
  Ignored when `targets` is given.
- `targets` — explicit target note path(s)/basename(s), bypassing LLM matching
  entirely.
- `template` / `section` — reference-block template and section header, used
  only when `targets` is given (otherwise each matched group supplies its own).
- `todo` — optional follow-up todo intent, generated and written into the first
  referenced note.

Returns `{ ok, referencedNotes, matched, todo? }`.

```js
await api.addReferences({ preview: true });
await api.addReferences({ targets: ["Projects/Website.md"], todo: "follow up in a week" });
```

### `api.fixFrontmatter(options?)`

Ranks (or, with `template`, forces) a configured template and fills/applies its
frontmatter fields onto the note — existing values are never overwritten.

- `template` — template vault path or basename among the configured template
  pairs. Omit to auto-rank.

Returns `{ ok, template, filled, added? }`.

```js
await api.fixFrontmatter({});
await api.fixFrontmatter({ template: "Meeting" });
```

### `api.createFromTemplate(options?)`

Ranks (or, with `pair`, forces) a template↔folder pair, drafts + fact-checks
the note into a **new file**, and fills its frontmatter. `preview` defaults to
`true` here.

- `pair` — template-pair id or name. Omit to auto-rank.
- `title` — new note's basename. Defaults to the source note's basename.
- `subfolder` — destination subfolder under the pair's target folder (`''` =
  folder root). Omit to let the LLM suggest one.

Returns `{ ok, notePath, template, subfolder, subfolderIsNew, body? }` (`body`
is only included while `preview` is in effect, so you can review the draft
before creating the file).

```js
const draft = await api.createFromTemplate({}); // preview by default
await api.createFromTemplate({ preview: false, subfolder: "2026" });
```

### `api.restructureNote(options?)`

Reorders/relevels/renames the note's own headers **in place** — section
content and frontmatter are never touched. `preview` defaults to `true`.

- `instruction` — optional guidance for the LLM's proposed header mapping.
- `mapping` — an explicit mapping (`{ index, level, text }[]`) to apply. Given
  alone, it's applied directly with **no LLM call**; given together with
  `instruction`, the LLM revises that mapping instead (requires a gateway).

With no `mapping` and no `instruction`, the LLM proposes a mapping (or falls
back to the note's current order if no gateway is configured).

Returns `{ ok, mapping, usedLlm }`.

```js
// Ask the LLM for a suggested reorder, without applying it
const { mapping } = await api.restructureNote({});
// Apply a (possibly hand-edited) mapping directly, no LLM call
await api.restructureNote({ mapping, preview: false });
// Ask the LLM to revise a mapping per an instruction, then apply it
await api.restructureNote({ mapping, instruction: "move conclusions last", preview: false });
```

Possible `reason` values across all tools: the LLM errors (`timeout`,
`api-error`, `no-reply`, `insecure-url`, `empty-content`) plus
`note-not-found`, `note-ambiguous`, `not-markdown`, `no-gateway`, `no-template`
(no template pairs configured, or a `template`/`pair` id wasn't found or was
ambiguous), `no-headers` (`restructureNote` on a note with fewer than two
headers), and `tool-disabled` (the tool is turned off in settings).
