# LLM Integration: Design Spec & Reference Guide

This document is a comprehensive reference for how obsidian-filedrop integrates LLMs across TypeScript (Obsidian plugin UI) and Python (file conversion backend). It's designed for:

1. **LLMs/agents** building similar adaptive LLM integrations with capability detection
2. **Developers** understanding, maintaining, or extending the LLM layer
3. **Advanced users** configuring and troubleshooting their LLM setup

---

## 1. Overview & Architecture

### What This Project Does

obsidian-filedrop lets users drag & drop files into Obsidian notes. Files are converted to markdown via [markitdown](https://github.com/microsoft/markitdown), and LLMs are used for:
- **Image descriptions** (for images embedded in PDFs or dropped directly)
- **Scanned PDF OCR** (when markitdown can't read text-layer PDFs)
- **Document summarization** (user-triggered, with editing capability)
- **Tag inference** (automatic suggestions after file conversion)
- **Reference matching** (finding related notes for a dropped document)
- **Metadata extraction** (date, type, people mentioned in the document)

### Architecture: TypeScript ↔ Python with Environment Variables

The plugin has two LLM layers:

```
┌─ TypeScript Layer (src/settings.ts)
│  └─ callChat() [single, centralized client]
│     ├─ suggestTags() → LLM tag inference
│     ├─ summarizeContent() → LLM summaries
│     ├─ reviseSummary() → user-driven refinement
│     ├─ fillMetadataWithLLM() → extract metadata
│     └─ matchCandidatesWithLLM() → rank related notes
│
└─ Python Layer (python/filedrop_convert.py)
   └─ MarkItDown + OpenAI client (initialized from env vars)
      ├─ Image descriptions (markitdown's built-in vision path)
      ├─ Scanned PDF OCR (page-by-page fallback)
      └─ Unsupported file descriptions (describe())
```

**Key handoff**: TypeScript detects which LLM parameters the model supports (capability detection), then passes this info to Python via environment variables. Both layers build chat bodies the same way, ensuring consistency.

### Design Principles

**Adaptive Capability Detection** — Don't pre-configure model quirks. Instead:
- Detect capabilities on first use (`probeModel()` or auto-correct during `callChat()`)
- Cache results per model with a timestamp
- Retry requests if a parameter causes an error

**Single Chat Client** — `callChat()` is the only low-level LLM entry point. All operations (tags, summaries, references) route through it. This ensures:
- Consistent retry behavior
- Centralized timeout and auth handling
- One place to update/debug

**Graceful Degradation** — Return results wrapped in `LlmResult<T>` type instead of throwing:
```typescript
type LlmResult<T> = { ok: true; value: T } | { ok: false; reason: LlmOpError; detail?: string };
```
This lets callers decide whether to show an error, use a fallback, or skip the operation.

---

## 2. Getting Started: Configuration

### Supported Providers

Three LLM providers are supported via OpenAI-compatible `/v1/chat/completions` endpoints:

| Provider | Base URL | Auth |
|----------|----------|------|
| **OpenAI** | `https://api.openai.com/v1` | `Authorization: Bearer sk-...` |
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai/` | `Authorization: Bearer AIza...` |
| **Custom** | Any `/v1`-compatible endpoint | `Authorization: Bearer ...` or `x-api-key: ...` |

### Settings Schema

Each LLM gateway is configured via the `LlmGateway` interface:

```typescript
export interface LlmGateway {
  id: string;                                    // unique identifier
  name: string;                                  // display name (e.g., "OpenAI GPT-4")
  provider: string;                              // 'openai' | 'google' | 'custom'
  baseUrl: string;                               // https://api.openai.com/v1
  apiKey: string;                                // authentication token
  model: string;                                 // 'gpt-4o', 'gemini-2.0-flash', etc.
  prompt: string;                                // custom system prompt for image descriptions
  capabilities?: Record<string, ModelCapabilities>;  // per-model cache
}
```

### Model Capabilities: The 5 Core Parameters

Every model supports or rejects specific parameters. obsidian-filedrop tracks 5 capabilities:

```typescript
export interface ModelCapabilities {
  tokenParam: 'max_tokens' | 'max_completion_tokens' | 'none';
  systemRole: boolean;
  vision: boolean;
  temperature: boolean;
  checkedAt?: string;  // ISO timestamp of last probe
}
```

| Capability | What It Means | Default | Example Quirks |
|------------|---------------|---------|-----------------|
| **tokenParam** | Which token-limit parameter the model accepts | `'max_tokens'` | GPT-4 uses `max_tokens`; some models use `max_completion_tokens`; reasoning models reject both and use `none` |
| **systemRole** | Whether the model has a separate system role | `true` | Some models require folding system messages into user messages |
| **vision** | Whether the model accepts `image_url` content | `true` | Text-only models (like GPT-4 Turbo base) reject images |
| **temperature** | Whether the model accepts the temperature parameter | `true` | Reasoning models (o1, etc.) reject temperature |
| **checkedAt** | ISO timestamp of last auto-detection or probe | undefined | Used to skip re-probing within the same session |

### URL Security

**HTTPS is required for remote gateways.** This prevents API keys from leaking over unencrypted connections.

**Exceptions (HTTP allowed):**
- `localhost`, `127.0.0.1` (loopback)
- `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12` (RFC 1918 private ranges)
- `169.254.0.0/16` (link-local, useful for LAN gateways)
- `::1`, `fe80::/10` (IPv6 loopback and link-local)
- `*.local` (mDNS, useful for local services)

Check implementation: `isGatewayUrlSecure()` in `src/settings.ts:240-260`.

### Authentication

API keys are passed via two headers for compatibility with different gateways:

```typescript
headers: {
  'Authorization': `Bearer ${apiKey}`,
  'x-api-key': apiKey,
}
```

**Storage**: Keys are stored unencrypted in Obsidian's plugin data directory (not synced to vault). The settings UI warns about this.

### Configuration via Obsidian Settings UI

Users add/remove gateways in Obsidian Settings → FileDrop:

1. Click **Add LLM Gateway**
2. Select a provider (OpenAI, Gemini, Custom)
3. Enter API key, base URL (auto-filled for known providers), and model name
4. Click **Check** button to probe the model and detect capabilities

---

## 3. Model Capability Detection

This is the key pattern for replication. Instead of pre-configuring quirks for every model, obsidian-filedrop discovers capabilities on first use.

### Discovery Method 1: Explicit Probing (`probeModel()`)

When the user clicks **Check** in settings, `probeModel()` runs a safe test:

```typescript
export async function probeModel(gw: LlmGateway): Promise<LlmResult<ModelCapabilities>> {
  // 1. Send a trivial request: describe a simple file type (text/plain)
  // 2. For each parameter, observe:
  //    - Did it succeed? → capability is true
  //    - Did it error with "unknown parameter" or "not supported"? → false
  //    - Did it timeout? → mark as unknown, retry later
  // 3. Cache results in gw.capabilities[model] with checkedAt timestamp
  // 4. Return the detected capabilities
}
```

**Why safe?** The probe uses a short timeout (30s) and sends minimal content, so it won't block the UI or incur huge costs.

### Discovery Method 2: Auto-Correction During `callChat()`

If a cached model hasn't been checked yet, or an error suggests a parameter needs correction, `callChat()` auto-detects:

```
User calls suggestTags()
  → callChat() builds chat body using cached capabilities (or defaults)
  → Send request to LLM
  → Error: "max_tokens not supported"?
      → Detect this error via detectCapabilityFix()
      → Update capabilities[model].tokenParam = 'max_completion_tokens'
      → Persist to settings
      → Retry the request (up to 4 times)
  → Return result to caller
```

**How errors are detected** (`detectCapabilityFix()`):

```typescript
// Look for error messages indicating unsupported parameters:
if (error.includes('max_tokens') || error.includes('token')) {
  return { capability: 'tokenParam', suggested: 'max_completion_tokens' };
}
if (error.includes('system') || error.includes('system_prompt')) {
  return { capability: 'systemRole', suggested: false };
}
if (error.includes('vision') || error.includes('image')) {
  return { capability: 'vision', suggested: false };
}
// ... etc
```

### Caching & Staleness

Capabilities are cached per model in `gw.capabilities[modelId]` with a `checkedAt` timestamp:

```typescript
capabilities: {
  'gpt-4o': {
    tokenParam: 'max_tokens',
    systemRole: true,
    vision: true,
    temperature: true,
    checkedAt: '2024-12-01T10:30:00Z'
  }
}
```

A model is considered "fresh" if it was probed in the current session. Stale entries (not checked in 30+ days) can be re-probed, but within a session we trust the cache to avoid redundant probes.

### Common Capability Issues

**"Model timeout during probe"**
- The model is slow or unresponsive
- Increase the probe timeout from 30s → 60s in advanced settings
- Some models (reasoning, large) take longer

**"max_tokens not supported, trying max_completion_tokens"**
- Normal auto-correction; the model requires a different parameter name
- No action needed; settings are updated automatically

**"Vision errors: model doesn't accept images"**
- Some models (text-only, older variants) don't support image inputs
- Auto-corrected to `vision: false`; images won't be described, markitdown text will be used instead

**"Temperature not supported"**
- Reasoning models (o1, o3) reject the temperature parameter
- Auto-corrected to `temperature: false`; subsequent calls omit it
- No user-visible change; deterministic summaries still work

---

## 4. LLM Parameters & Chat Interface

### `callChat()`: The Single Centralized Client

Every LLM call in TypeScript routes through `callChat()`, the single low-level client. This ensures consistent behavior across all operations.

**Signature** (simplified):

```typescript
export async function callChat(
  gw: LlmGateway,
  messages: { role: 'system' | 'user' | 'assistant'; content: string | ContentBlock[] }[],
  options: {
    timeoutMs?: number;
    maxAttempts?: number;
    onBeforeRetry?: (attempt: number, error: string) => void;
  }
): Promise<LlmResult<string>> {
  // 1. Get cached capabilities for gw.model
  // 2. Build chat request body with buildChatBody() (applies capability-aware parameters)
  // 3. Send request with retries up to maxAttempts (default 4)
  // 4. On error, call detectCapabilityFix() to see if we can auto-correct
  // 5. If auto-correctable, update capabilities and retry
  // 6. Return LlmResult { ok: true; value: response } or { ok: false; reason: ... }
}
```

### Building Chat Bodies: `buildChatBody()`

`buildChatBody()` adapts the request to what the model actually supports:

```typescript
function buildChatBody(
  messages: Message[],
  model: string,
  capabilities: ModelCapabilities
): ChatCompletionCreateParams {
  const body: ChatCompletionCreateParams = {
    model,
    messages: messages.map(m => {
      // If systemRole is false, fold system message into user message
      if (m.role === 'system' && !capabilities.systemRole) {
        return { role: 'user', content: `[System]: ${m.content}` };
      }
      return m;
    }),
  };

  // Token limit: adapt to the model's parameter name
  if (capabilities.tokenParam === 'max_tokens') {
    body.max_tokens = 512;
  } else if (capabilities.tokenParam === 'max_completion_tokens') {
    body.max_completion_tokens = 512;
  }
  // If capabilities.tokenParam === 'none', omit the parameter entirely

  // Vision: only include image_url if the model supports it
  if (!capabilities.vision) {
    body.messages = body.messages.map(m => ({
      ...m,
      content: typeof m.content === 'string' ? m.content : m.content.filter(c => c.type !== 'image_url')
    }));
  }

  // Temperature: only include for models that support it
  if (capabilities.temperature) {
    body.temperature = 0;  // Deterministic for tag/summary extraction
  }

  return body;
}
```

### Timeout Architecture

Timeouts are layered to prevent hangs:

| Layer | Timeout | Purpose |
|-------|---------|---------|
| **Python LLM call** | 150s | Server-side timeout for image OCR, markitdown conversion |
| **Node subprocess** | 180s | Wraps the entire Python process |
| **callChat()** | 30s (default) | Each individual LLM chat completion call |
| **summarizeContent()** | 180s (3 min) | Longer timeout for user-triggered summaries |
| **Tag suggestion** | 30s | Quick async tagging |
| **probeModel()** | 30s | Capability detection shouldn't block the UI |

Timeouts are enforced with `Promise.race()` on the Node side and `httpx` timeout on the Python side.

### Error Handling & Graceful Fallbacks

All LLM operations return `LlmResult<T>` instead of throwing:

```typescript
// In suggestTags():
const result = await callChat(gw, [...messages...], { timeoutMs: 30000 });
if (!result.ok) {
  // Graceful fallback: return empty array or cached tags
  return { ok: false, reason: 'llm_timeout', tags: [] };
}
// result.value has the LLM's tag suggestions
```

This allows:
- Graceful degradation (skip LLM features if the service is down)
- Better error messages (include detail from the LLM error)
- Retry logic in the UI layer

### Thinking Model Output Filtering

Reasoning models (o1, o3) emit their chain-of-thought in the response:

```
<thinking>
Let me analyze this document...
It seems to be a contract because...
</thinking>

The key terms are: [actual answer]
```

**Filtering** happens in Python (`strip_thinking()`) and ensures only the answer is returned:

```python
def strip_thinking(text):
    """Remove <thinking>...</thinking> blocks from reasoning model output."""
    cleaned = re.sub(r"<(think|thinking|reasoning)>.*?</\1>", "", text, flags=re.DOTALL | re.IGNORECASE)
    # Handle edge case where closing tag is missing
    for closer in ("</think>", "</thinking>", "</reasoning>"):
        idx = cleaned.rfind(closer)
        if idx != -1:
            after = cleaned[idx + len(closer):]
            cleaned = after if after.strip() else cleaned[:idx]
    return cleaned.strip()
```

This is installed as a middleware on the OpenAI client in Python:

```python
client = OpenAI(api_key=..., base_url=...)
client = _install_thinking_filter(client)  # Wrap completions.create()
```

---

## 5. Using LLMs in the Plugin

### TypeScript-Side Operations (src/settings.ts)

#### `suggestTags(content: string, prompt?: string)`

Infers tags from document content using the LLM.

```typescript
export async function suggestTags(
  gw: LlmGateway,
  content: string,
  userTags: string[] = []
): Promise<LlmResult<string[]>> {
  // Build a system prompt that prefers existing tags
  const systemPrompt = `Extract 3-5 tags for this document. Prefer: ${userTags.join(', ')}. Return as JSON array.`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content }
  ];
  const result = await callChat(gw, messages, { timeoutMs: 30000 });
  if (!result.ok) return result;
  
  // Parse JSON response: ["tag1", "tag2", ...]
  try {
    return { ok: true, value: JSON.parse(result.value) };
  } catch {
    return { ok: false, reason: 'parse_error' };
  }
}
```

**Use case**: After a file is dropped, the plugin offers tag suggestions to help categorize it.

#### `summarizeContent(content: string, customPrompt?: string)`

Generates a concise summary of document content.

```typescript
export async function summarizeContent(
  gw: LlmGateway,
  content: string,
  customPrompt?: string
): Promise<LlmResult<string>> {
  const systemPrompt = customPrompt || 'Summarize this in 1-2 sentences.';
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content }
  ];
  return callChat(gw, messages, { timeoutMs: 180000 });  // Longer timeout
}
```

**Use case**: User clicks "Add Summary" button; the LLM generates a summary for the frontmatter.

#### `reviseSummary(summary: string, instruction: string, gw: LlmGateway)`

Refines an existing summary based on user feedback.

```typescript
export async function reviseSummary(
  summary: string,
  instruction: string,
  gw: LlmGateway
): Promise<LlmResult<string>> {
  // Iterative refinement: "Make it shorter", "Add the price", etc.
  const messages = [
    { role: 'user', content: `Current summary: "${summary}"` },
    { role: 'user', content: `Change: ${instruction}` }
  ];
  return callChat(gw, messages, { timeoutMs: 180000 });
}
```

**Use case**: User clicks "Change summary" dialog; refine via iteration instead of re-running full conversion.

#### `probeModel(gw: LlmGateway)`

Detects model capabilities (called by Settings "Check" button).

```typescript
export async function probeModel(gw: LlmGateway): Promise<LlmResult<ModelCapabilities>> {
  // Send a trivial request to detect capabilities
  const messages = [{ role: 'user', content: 'OK' }];
  
  // Try with vision, system role, temperature, each token param
  // Record which ones succeed/fail
  
  const detected: ModelCapabilities = {
    tokenParam: (await probeTokenParam(gw)) || 'none',
    systemRole: await probeSystemRole(gw),
    vision: await probeVision(gw),
    temperature: await probeTemperature(gw),
    checkedAt: new Date().toISOString()
  };
  
  // Cache in gw.capabilities[gw.model]
  gw.capabilities ??= {};
  gw.capabilities[gw.model] = detected;
  await saveSettings();  // Persist
  
  return { ok: true, value: detected };
}
```

### References Engine (src/references.ts)

The references feature automatically finds related notes for a dropped document.

#### `fillMetadataWithLLM(content: string, gw: LlmGateway)`

Extracts missing metadata (date, type, people) from document content.

```typescript
// Prompt: "Extract from this document: publication_date, document_type, people mentioned"
// Returns: { publication_date: "2024-11-15", document_type: "contract", people: ["Alice", "Bob"] }
```

#### `matchCandidatesWithLLM(docContent: string, candidates: Note[], gw: LlmGateway)`

Ranks which existing notes a document belongs with.

```typescript
// Prompt: "Rate how related this document is to each note (0-10):"
// For each candidate note, the LLM sees its title and first 500 chars
// Returns ranked list: note1 (score 9), note2 (score 5), ...
```

#### `generateTodoTask(document: FileMetadata, reason: string)`

Generates an Obsidian Tasks-format line for follow-up.

```typescript
// Returns: "- [ ] Follow up with contract review @type:document 📅 2025-01-15"
```

### Python-Side Operations (python/filedrop_convert.py)

#### Image Descriptions (via markitdown)

markitdown's OpenAI integration handles image-to-text:

```python
from markitdown import MarkItDown
from openai import OpenAI

# Read LLM config from env vars
client = OpenAI(
    api_key=os.environ['FILEDROP_LLM_KEY'],
    base_url=os.environ['FILEDROP_LLM_URL']
)
client = _install_thinking_filter(client)  # Wrap to strip reasoning output

converter = MarkItDown(
    llm_client=client,
    llm_model=os.environ['FILEDROP_LLM_MODEL']
)

# markitdown uses the client to describe images in documents
markdown = converter.convert(file_path)
```

#### Scanned PDF OCR (Fallback)

When a PDF has no text layer, the Python script falls back to OCR:

```python
def _convert_pdf_pages_with_llm(self, file_path, client):
    """Page-by-page OCR for scanned PDFs."""
    import fitz  # PyMuPDF
    
    doc = fitz.open(file_path)
    full_text = []
    
    for page_num, page in enumerate(doc):
        # Render page as image
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
        image_bytes = pix.tobytes(output='png')
        
        # Ask LLM to read the image
        response = client.chat.completions.create(
            model=os.environ['FILEDROP_LLM_MODEL'],
            messages=[{
                'role': 'user',
                'content': [
                    { 'type': 'text', 'text': 'Read all text from this page:' },
                    { 'type': 'image_url', 'image_url': { 'url': f'data:image/png;base64,...' } }
                ]
            }],
            max_tokens=1024
        )
        
        full_text.append(response.choices[0].message.content)
    
    return '\n---\n'.join(full_text)
```

### Passing Config from TypeScript to Python (src/convert.ts)

When launching a Python subprocess for conversion, TypeScript passes LLM config as environment variables:

```typescript
const env = {
  ...process.env,
  FILEDROP_LLM_URL: gateway.baseUrl,
  FILEDROP_LLM_KEY: gateway.apiKey,
  FILEDROP_LLM_MODEL: gateway.model,
  FILEDROP_LLM_PROMPT: gateway.prompt,
  FILEDROP_LLM_TOKEN_PARAM: capabilities.tokenParam,  // 'max_tokens' | 'max_completion_tokens' | 'none'
  FILEDROP_LLM_VISION: capabilities.vision ? '1' : '0',
  FILEDROP_LLM_TEMPERATURE: capabilities.temperature ? '1' : '0',
  FILEDROP_LLM_TIMEOUT: '150',  // seconds
  FILEDROP_DESCRIBE_EXTS: 'exe,dll,so',  // comma-separated
};

execFile('python', ['-c', CONVERT_SCRIPT], { env, timeout: 180000 });
```

Python reads these and builds its OpenAI client:

```python
client = OpenAI(
    api_key=os.environ.get('FILEDROP_LLM_KEY'),
    base_url=os.environ.get('FILEDROP_LLM_URL')
)

token_param = os.environ.get('FILEDROP_LLM_TOKEN_PARAM', 'max_tokens')
if token_param != 'none':
    body[token_param] = 1024

if os.environ.get('FILEDROP_LLM_VISION') == '0':
    # Strip image_url from messages
    pass

if os.environ.get('FILEDROP_LLM_TEMPERATURE') == '0':
    body.pop('temperature', None)
```

---

## 6. Testing & Validation

### Settings UI Testing

The Settings panel provides a **Check** button for each gateway:

1. Click **Check** next to your gateway
2. The plugin sends a trivial LLM request
3. Results show:
   - ✅ **Connected**: LLM is reachable
   - ✅ **Capabilities**: tokenParam, systemRole, vision, temperature settings
   - ✅ **Models available**: Lists models the gateway supports
   - ❌ Errors: "Invalid API key", "Gateway unreachable", "Model not found"

### Python Unit Tests

Tests are in `python/tests/test_filedrop_convert.py` and `test_filedrop_msg.py`.

**Test patterns**:

```python
import unittest
from unittest.mock import patch, MagicMock
from filedrop_convert import convert

class TestLlmIntegration(unittest.TestCase):
    @patch('filedrop_convert.MarkItDown')
    @patch('filedrop_convert.OpenAI')
    def test_token_param_max_tokens(self, mock_openai, mock_markitdown):
        """Verify token param defaults to max_tokens."""
        env = {
            'FILEDROP_LLM_KEY': 'sk-test',
            'FILEDROP_LLM_MODEL': 'gpt-4o',
            'FILEDROP_LLM_TOKEN_PARAM': 'max_tokens'
        }
        
        # Mock the client and converter
        client = MagicMock()
        mock_openai.return_value = client
        converter = MagicMock()
        mock_markitdown.return_value = converter
        
        # Run conversion
        result = convert(file_path, env)
        
        # Verify the client was called with max_tokens
        call_args = client.chat.completions.create.call_args
        assert call_args.kwargs['max_tokens'] == 1024
        assert 'max_completion_tokens' not in call_args.kwargs
    
    def test_vision_disabled(self):
        """Verify vision content is stripped when disabled."""
        env = {
            'FILEDROP_LLM_VISION': '0',  # Vision disabled
            ...
        }
        # Build chat body, verify image_url content removed
    
    def test_temperature_omitted_for_reasoning(self):
        """Verify temperature is omitted when not supported."""
        env = {
            'FILEDROP_LLM_TEMPERATURE': '0',  # Reasoning model
            ...
        }
        # Build chat body, verify temperature not in request
    
    def test_thinking_stripped(self):
        """Verify reasoning model output is cleaned."""
        response = "<thinking>Long reasoning...</thinking>The answer is X"
        cleaned = strip_thinking(response)
        assert cleaned == "The answer is X"
```

**Run tests**:

```bash
cd python
pytest tests/test_filedrop_convert.py -v
```

### Manual Testing

Use `python/manual_convert.py` for interactive testing with real models:

```bash
cd python
python manual_convert.py -Y /path/to/file.pdf
```

This:
1. Loads config from `manual.cfg` (or prompts for it)
2. Validates the OpenAI connection
3. Converts the file with real LLM calls
4. Prints timing and errors

**Sample `manual.cfg`**:

```ini
[llm]
model = gpt-4o
# api_key = sk-...  (commented out for security)
# url = https://api.openai.com/v1
```

Prompt for missing values interactively.

### Parameter Tuning

**Timeout adjustment**: If your model is slow, increase timeouts:
- Python-side: `FILEDROP_LLM_TIMEOUT` env var (seconds, default 150)
- Node-side: per-operation timeout in `callChat()` options (default 30s for tags, 180s for summaries)

**Token limits**: If summaries are truncated, increase the `max_tokens` used in `buildChatBody()`:

```typescript
if (capabilities.tokenParam === 'max_tokens') {
  body.max_tokens = 2048;  // Increase from 512
}
```

**Temperature**: Summaries use `temperature: 0` (deterministic). For more creative outputs, increase to 0.5-1.0:

```typescript
if (capabilities.temperature) {
  body.temperature = 0.5;  // More variety
}
```

---

## 7. Design Patterns for Replication

If you're building a similar LLM-integrated system, these patterns may help:

### Adaptive Capability Detection

**The pattern**: Don't hard-code model quirks; discover them on first use.

**Benefits**:
- New models are supported automatically (no code changes)
- Model parameters can change without breaking the system
- Users can use custom/experimental models

**Implementation**:
1. Define a `ModelCapabilities` interface with the parameters you care about
2. Implement a `probeModel()` function that tests each parameter safely
3. Cache results per model with a timestamp
4. In the main `callChat()`, check for auto-correctable errors and update the cache
5. On retry, use the updated capabilities

**Pitfall to avoid**: Don't wait too long between probes; stale capabilities (>30 days) can break with model updates.

### Single Client Pattern

**The pattern**: Make `callChat()` the ONLY low-level LLM client. All high-level operations route through it.

**Benefits**:
- One place to add retry logic, timeouts, auth
- Easy to swap the backend (e.g., from OpenAI to Anthropic)
- Consistent behavior across all LLM operations

**Implementation**:

```typescript
// Good: All operations route through one client
async function suggestTags(content) {
  return callChat(messages);
}
async function summarizeContent(content) {
  return callChat(messages);
}

// Bad: Multiple ad-hoc clients
async function suggestTags(content) {
  return fetch('/v1/chat/completions', { ... });  // ❌ No retry logic
}
async function summarizeContent(content) {
  return new OpenAI(...).chat.completions.create(...);  // ❌ Different client
}
```

### Result Type Pattern

**The pattern**: Return `{ ok: true; value } | { ok: false; reason; detail }` instead of throwing.

**Benefits**:
- Graceful degradation (caller can skip LLM features if service is down)
- Better error messages (include context)
- No surprise exceptions in UI code

**Implementation**:

```typescript
type LlmResult<T> = { ok: true; value: T } | { ok: false; reason: LlmOpError; detail?: string };
type LlmOpError = 'timeout' | 'api_key_invalid' | 'model_not_found' | 'rate_limited' | 'parse_error';

async function suggestTags(...): Promise<LlmResult<string[]>> {
  try {
    const value = await callChat(...);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: 'timeout', detail: e.message };
  }
}

// Caller: no try/catch needed
const result = await suggestTags(content);
if (result.ok) {
  tags = result.value;
} else {
  console.warn(`Tagging failed: ${result.reason}`);
  tags = [];  // fallback
}
```

### Capability-Aware Chat Body Building

**The pattern**: Adapt the request to the model's capabilities before sending.

**Why it matters**:
- Some models use `max_tokens`, others use `max_completion_tokens`, still others reject both
- Some models don't support system roles
- Some models reject temperature parameter
- Some models don't accept images

**Implementation**:

```typescript
function buildChatBody(messages, model, caps) {
  const body = { model, messages };
  
  // Only include parameters the model supports
  if (caps.tokenParam === 'max_tokens') body.max_tokens = 512;
  else if (caps.tokenParam === 'max_completion_tokens') body.max_completion_tokens = 512;
  // else: 'none' → omit entirely
  
  if (caps.temperature) body.temperature = 0;
  else delete body.temperature;
  
  if (!caps.vision) {
    body.messages = body.messages.map(m => ({
      ...m,
      content: stripImages(m.content)
    }));
  }
  
  if (!caps.systemRole) {
    body.messages = foldSystemMessages(body.messages);
  }
  
  return body;
}
```

---

## 8. Troubleshooting

### "Model not found" or "Invalid API key"

**Causes**:
- API key is incorrect or expired
- Model name is wrong for this provider
- Gateway URL is wrong

**Solutions**:
1. Double-check the API key in settings
2. Verify the model name matches your provider:
   - OpenAI: `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`
   - Google Gemini: `gemini-2.0-flash`, `gemini-1.5-pro`
3. Check the base URL:
   - OpenAI: `https://api.openai.com/v1`
   - Gemini: `https://generativelanguage.googleapis.com/v1beta/openai/`
4. Click **Check** button to see detailed error

### "Request timeout"

**Causes**:
- Model is slow (reasoning models, large models)
- Gateway is overloaded
- Network is slow

**Solutions**:
1. Increase timeout: In settings, find `FILEDROP_LLM_TIMEOUT` and increase from 150s to 300s
2. Use a faster model: `gpt-4o-mini` is faster than `gpt-4o`
3. Check gateway health: Is the LLM service responding to other requests?

### "max_tokens not supported"

**What's happening**: Auto-correction detected that this model uses `max_completion_tokens` instead.

**What to do**: Nothing! It's automatically fixed. Check settings → your gateway → **Check** to see the detected capabilities.

### "Vision error: image_url not supported"

**Causes**:
- Model doesn't support images (e.g., text-only variant)
- Image encoding is incorrect

**Solutions**:
1. Check settings → your gateway → **Check** button; it should show `vision: false`
2. Switch to a vision-capable model:
   - OpenAI: `gpt-4o`, `gpt-4-turbo`, `gpt-4-vision-preview`
   - Google Gemini: `gemini-2.0-flash`, `gemini-1.5-pro`
3. If vision detection is wrong, manually disable it in settings

### "Temperature not supported"

**Causes**:
- Using a reasoning model (o1, o3) that doesn't accept temperature
- Some custom fine-tunes reject it

**Solutions**:
1. Expected behavior for reasoning models; auto-corrected
2. Check **Check** button in settings; should show `temperature: false`
3. No action needed; summaries will be deterministic (which is usually desired)

### "LLM returns empty or garbled output"

**Causes**:
- Model is filtering output (e.g., safety, thinking filters)
- Prompt is unclear
- Output parsing failed (JSON parse error)

**Solutions**:
1. Test with a simpler prompt: "Summarize this in one sentence"
2. Check the model's safety policies (some models filter certain content)
3. For thinking models, verify `strip_thinking()` is working in Python
4. Increase `max_tokens` if output is truncated

### "Cannot connect to custom gateway"

**Causes**:
- Gateway URL is unreachable
- TLS/HTTPS error
- Firewall blocking

**Solutions**:
1. Test locally: `curl -H "Authorization: Bearer $KEY" https://your-gateway.com/v1/models`
2. Check HTTPS is enabled (unless it's `localhost`, `192.168.*`, etc.)
3. Check firewall: custom gateways often need port forwarding
4. Test with `python/manual_convert.py` directly for more detailed errors

---

## 9. File Reference Guide

Quick lookup table for where to find specific functionality:

| What | File | Lines |
|------|------|-------|
| **Core LLM layer** | `src/settings.ts` | 1-900 |
| `LlmGateway` interface | `src/settings.ts` | 25-36 |
| `ModelCapabilities` interface | `src/settings.ts` | 10-23 |
| `callChat()` implementation | `src/settings.ts` | 471-528 |
| `buildChatBody()` | `src/settings.ts` | 423-432 |
| `probeModel()` | `src/settings.ts` | 551-674 |
| `detectCapabilityFix()` | `src/settings.ts` | 438-456 |
| `isGatewayUrlSecure()` | `src/settings.ts` | 240-260 |
| **Settings UI** | `src/settings-tab.ts` | 1-600 |
| Gateway config form | `src/settings-tab.ts` | 100-250 |
| "Check" button handler | `src/settings-tab.ts` | 300-350 |
| Model dropdown | `src/settings-tab.ts` | 180-210 |
| **TS-side LLM operations** | `src/settings.ts` | |
| `suggestTags()` | `src/settings.ts` | 678-722 |
| `summarizeContent()` | `src/settings.ts` | 735-773 |
| `reviseSummary()` | `src/settings.ts` | 778-822 |
| **Reference matching** | `src/references.ts` | 1-400 |
| `fillMetadataWithLLM()` | `src/references.ts` | 127-183 |
| `matchCandidatesWithLLM()` | `src/references.ts` | 185-267 |
| `generateTodoTask()` | `src/references.ts` | 269-310 |
| **Python conversion** | `python/filedrop_convert.py` | 1-500 |
| `strip_thinking()` | `python/filedrop_convert.py` | 23-41 |
| `_install_thinking_filter()` | `python/filedrop_convert.py` | 44-59 |
| OpenAI client init | `python/filedrop_convert.py` | 60-100 |
| Image descriptions (markitdown) | `python/filedrop_convert.py` | 200-250 |
| Scanned PDF OCR | `python/filedrop_convert.py` | 300-400 |
| `.msg` handling | `python/filedrop_msg.py` | 1-200 |
| **Environment variable passing** | `src/convert.ts` | 162-242 |
| **Tests** | `python/tests/` | |
| Conversion tests | `python/tests/test_filedrop_convert.py` | 1-600 |
| MSG tests | `python/tests/test_filedrop_msg.py` | 1-300 |
| Mock patterns | `python/conftest.py` | 1-100 |
| **Manual testing** | `python/manual_convert.py` | 1-300 |
| Config template | `python/manual.cfg.example` | 1-20 |

---

## 10. Summary for Replication

If you're building a similar system, here's what to copy:

1. **Capability interface** (`ModelCapabilities`) — Track the parameters your models support
2. **Probe function** — Test each parameter safely on first use
3. **Auto-correction in `callChat()`** — Detect errors and update capabilities, then retry
4. **Centralized client** — Route all LLM calls through one function
5. **Result type** — Return typed results instead of throwing
6. **Chat body builder** — Adapt requests to detected capabilities

The rest (specific prompts, timeouts, filters) is application-specific.

---

## Resources

- [OpenAI API Reference](https://platform.openai.com/docs/api-reference/chat/create)
- [markitdown](https://github.com/microsoft/markitdown) — File-to-markdown conversion
- [Obsidian Plugin Docs](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin) — Plugin development
- [Project CLAUDE.md](CLAUDE.md) — Architecture and codebase overview

