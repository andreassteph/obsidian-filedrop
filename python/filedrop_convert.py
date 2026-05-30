"""Convert a file to markdown via markitdown's LLM image-description path.

Runs against an OpenAI-compatible gateway. Configuration is read from the
environment; the file path is the first positional argument. The plugin invokes
this as `python -c <inlined source> <path>`, so argv[1] is the file path.
"""

import os
import re
import sys

from markitdown import MarkItDown
from openai import OpenAI

# Reasoning ("thinking") models emit their chain-of-thought inline in the
# assistant message before the real answer. We strip it so image descriptions
# stay clean; for non-thinking models these patterns never match and the
# content passes through untouched.
_THINK_BLOCK = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.DOTALL | re.IGNORECASE)
_DANGLING_CLOSERS = ("</think>", "</thinking>", "</reasoning>")


def strip_thinking(text):
    """Remove reasoning content from an LLM reply, leaving only the answer."""
    if not text:
        return text
    cleaned = _THINK_BLOCK.sub("", text)
    # Some gateways inject the opening tag via the chat template, so the content
    # starts mid-reasoning and only the closing tag survives. Keep what follows
    # the last closer in that case.
    lowered = cleaned.lower()
    for closer in _DANGLING_CLOSERS:
        idx = lowered.rfind(closer)
        if idx != -1:
            after = cleaned[idx + len(closer):]
            if after.strip():
                cleaned = after        # closer in middle → keep what's after
            else:
                cleaned = cleaned[:idx]  # closer at end → strip it, keep what's before
            break
    return cleaned.strip()


def _install_thinking_filter(client):
    """Wrap the client so chat completions have thinking stripped in place."""
    completions = client.chat.completions
    original_create = completions.create

    def create(*args, **kwargs):
        response = original_create(*args, **kwargs)
        for choice in getattr(response, "choices", None) or []:
            message = getattr(choice, "message", None)
            content = getattr(message, "content", None)
            if message is not None and content:
                message.content = strip_thinking(content)
        return response

    completions.create = create
    return client


_DEFAULT_LLM_TIMEOUT_S = 150.0
_DEFAULT_CONNECT_TIMEOUT_S = 15.0


def _llm_timeout(env):
    """Build an httpx.Timeout from FILEDROP_LLM_TIMEOUT (seconds).

    The OpenAI SDK accepts a flat number, but that applies to *every* phase
    (connect/read/write/pool) at once — a connection that establishes but never
    delivers bytes waits the full budget on the read. Splitting connect out
    means a wedged gateway fails fast instead of hanging for minutes. Falls
    back to a flat float if httpx is unavailable (which only happens in tests
    that stub the openai package).
    """
    raw = env.get("FILEDROP_LLM_TIMEOUT")
    try:
        total = float(raw) if raw else _DEFAULT_LLM_TIMEOUT_S
    except (TypeError, ValueError):
        total = _DEFAULT_LLM_TIMEOUT_S
    try:
        import httpx
    except ImportError:
        return total
    return httpx.Timeout(total, connect=_DEFAULT_CONNECT_TIMEOUT_S)


def _make_client(env, **kwargs):
    # x-api-key is sent alongside the SDK's automatic Authorization: Bearer header
    # because the Siemens gateway requires it; other providers ignore it.
    # max_retries=0 because the SDK's default 2 retries silently triple the
    # wait when a gateway hangs — the user is better served by a fast clean
    # error and the existing TS-side error handling.
    key = env["FILEDROP_LLM_KEY"]
    kwargs.setdefault("timeout", _llm_timeout(env))
    kwargs.setdefault("max_retries", 0)
    return OpenAI(
        api_key=key,
        base_url=env.get("FILEDROP_LLM_URL") or None,
        default_headers={"x-api-key": key, "X-Api-Key": key},
        **kwargs,
    )


def build_converter(env):
    client = _make_client(env)
    _install_thinking_filter(client)
    kwargs = {"llm_client": client, "llm_model": env["FILEDROP_LLM_MODEL"]}
    prompt = env.get("FILEDROP_LLM_PROMPT")
    if prompt:
        kwargs["llm_prompt"] = prompt
    return MarkItDown(**kwargs)


def _emit_phase(phase):
    print(f"[filedrop:phase] {phase}", file=sys.stderr, flush=True)


def convert(path, env):
    is_pdf = path.lower().endswith(".pdf")

    # Try markitdown with LLM support first. build_converter passes llm_client
    # and llm_model to MarkItDown, so embedded images inside the PDF are
    # described by the LLM. Works well for text-layer PDFs. Scanned PDFs often
    # return empty here because pdfminer finds no text layer and there are no
    # discrete embedded images — we catch that and fall through.
    # Pure-image files go straight into the LLM via markitdown's image path,
    # so signal that phase up front instead of "markitdown".
    image_exts = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif")
    _emit_phase("llm-image" if path.lower().endswith(image_exts) else "markitdown")
    try:
        result = build_converter(env).convert(path).text_content
        if result and result.strip():
            return result
    except Exception as exc:
        print(f"[filedrop] markitdown LLM step failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        if not is_pdf:
            # The LLM-enhanced step failed for a non-PDF (e.g. a PPTX markitdown
            # could not fully process). Keep the plain markitdown conversion so
            # the file's extractable text is still captured.
            return _convert_without_llm(path)

    # For PDFs that produced nothing (scanned / image-only), render each page
    # via PyMuPDF and OCR with the LLM.
    if is_pdf:
        _emit_phase("llm-image")
        result = _convert_pdf_pages_with_llm(path, env)
        if result:
            return result

    return ""


def _convert_without_llm(path):
    """Re-run markitdown with no LLM client so a file's extractable text is still
    captured when the LLM-enhanced step fails. Returns the plain text, or "" if
    even this fails — never raises, so a failure here can't crash the process and
    dump the whole invocation into the note."""
    try:
        result = MarkItDown().convert(path).text_content
        if result and result.strip():
            return result
    except Exception as exc:
        print(f"[filedrop] plain markitdown fallback failed: {type(exc).__name__}: {exc}", file=sys.stderr)
    return ""


def _convert_pdf_pages_with_llm(path, env):
    """Render every PDF page via PyMuPDF and OCR with the LLM.

    Returns combined markdown, or empty string if PyMuPDF is unavailable
    so the caller falls back to plain markitdown text extraction.
    """
    import base64

    try:
        import fitz  # pymupdf  # type: ignore
    except ImportError:
        print("[filedrop] PyMuPDF not installed — cannot OCR scanned PDF pages", file=sys.stderr)
        return ""

    client = _make_client(env)
    _install_thinking_filter(client)

    prompt = (
        env.get("FILEDROP_LLM_PROMPT")
        or "Transcribe all text visible on this page exactly as it appears. "
           "For any charts, tables, or images also provide a concise description."
    )

    try:
        doc = fitz.open(path)
    except Exception:
        return ""

    if not doc.page_count:
        return ""

    pages = []
    mat = fitz.Matrix(2, 2)  # 2× zoom for better OCR quality
    for page_num, page in enumerate(doc, 1):
        pix = page.get_pixmap(matrix=mat)
        img_b64 = base64.b64encode(pix.tobytes("png")).decode("ascii")
        try:
            resp = client.chat.completions.create(
                model=env["FILEDROP_LLM_MODEL"],
                max_tokens=2048,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                    ],
                }],
            )
            text = (resp.choices[0].message.content or "").strip()
            text = strip_thinking(text)
        except Exception as exc:
            text = f"> [!error] Page {page_num} OCR failed: {exc}"
        pages.append(f"### Page {page_num}\n\n{text}")

    return "\n\n".join(pages)


DEFAULT_DESCRIBE_PROMPT = (
    "A user saved a file named '{filename}' that cannot be converted to text. "
    "Based only on its filename, briefly explain what this file most likely is "
    "(for example, an installer for a specific application, or a system/standard "
    "library). Keep it to 1-3 sentences and make clear it is an educated guess."
)


def describe(path, env):
    """Ask the LLM what a file likely is, given only its filename."""
    client = _make_client(env)
    _install_thinking_filter(client)
    filename = os.path.basename(path)
    prompt = (env.get("FILEDROP_DESCRIBE_PROMPT") or DEFAULT_DESCRIBE_PROMPT).format(filename=filename)
    response = client.chat.completions.create(
        model=env["FILEDROP_LLM_MODEL"],
        max_tokens=200,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.choices[0].message.content or ""


def main(argv=None, env=None):
    argv = sys.argv if argv is None else argv
    env = os.environ if env is None else env
    action = describe if env.get("FILEDROP_DESCRIBE") else convert
    sys.stdout.buffer.write(action(argv[1], env).encode("utf-8"))


if __name__ == "__main__":
    main()
