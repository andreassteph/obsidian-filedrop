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
