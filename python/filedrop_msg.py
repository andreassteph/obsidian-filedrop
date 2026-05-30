"""
Extract an MSG (Outlook email) file with all its attachments, converting
each piece via markitdown.  Outputs a single JSON object to stdout:

  {
    "body":        "<markitdown output of the .msg itself>",
    "attachments": [
      { "filename": "doc.pdf", "data_b64": "<base64>", "markdown": "..." },
      ...
    ]
  }

LLM-gateway config is read from environment variables (same keys as
filedrop_convert.py).  Called as: python -c <inlined-source> <msg_path>

This script is inlined and run via `python -c`, so it cannot import
filedrop_convert; the shared markitdown/LLM helpers are duplicated here on
purpose and kept in sync with that file.
"""

import base64
import json
import os
import re
import sys
import tempfile

from markitdown import MarkItDown

try:
    from openai import OpenAI
except ImportError:  # plain .msg conversion still works without the LLM stack
    OpenAI = None

# Strip chain-of-thought blocks that reasoning models emit before their answer.
_THINK_BLOCK = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.DOTALL | re.IGNORECASE)
_DANGLING_CLOSERS = ("</think>", "</thinking>", "</reasoning>")


def _strip_thinking(text):
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
    completions = client.chat.completions
    original_create = completions.create

    def create(*args, **kwargs):
        response = original_create(*args, **kwargs)
        for choice in getattr(response, "choices", None) or []:
            message = getattr(choice, "message", None)
            content = getattr(message, "content", None)
            if message is not None and content:
                message.content = _strip_thinking(content)
        return response

    completions.create = create
    return client


def _llm_configured(env):
    return bool(
        OpenAI is not None
        and env.get("FILEDROP_LLM_URL")
        and env.get("FILEDROP_LLM_KEY")
        and env.get("FILEDROP_LLM_MODEL")
    )


def _make_client(env, **kwargs):
    # x-api-key is sent alongside the SDK's automatic Authorization: Bearer header
    # because the Siemens gateway requires it; other providers ignore it.
    key = env["FILEDROP_LLM_KEY"]
    client = OpenAI(
        api_key=key,
        base_url=env.get("FILEDROP_LLM_URL") or None,
        default_headers={"x-api-key": key, "X-Api-Key": key},
        **kwargs,
    )
    return _install_thinking_filter(client)


def _build_llm_markitdown(env):
    """MarkItDown wired to the LLM gateway, or None when no gateway is set."""
    if not _llm_configured(env):
        return None
    kwargs = {"llm_client": _make_client(env, timeout=720), "llm_model": env["FILEDROP_LLM_MODEL"]}
    prompt = env.get("FILEDROP_LLM_PROMPT")
    if prompt:
        kwargs["llm_prompt"] = prompt
    return MarkItDown(**kwargs)


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
    """Render every PDF page via PyMuPDF and describe each with the LLM.

    Returns the combined markdown, or None if PyMuPDF or the LLM is
    unavailable so the caller can fall back to plain markitdown.
    """
    if not _llm_configured(env):
        return None

    try:
        import fitz  # pymupdf  # type: ignore
    except ImportError:
        print("[filedrop] PyMuPDF not installed — cannot OCR scanned PDF pages", file=sys.stderr)
        return None

    try:
        doc = fitz.open(path)
    except Exception:
        return None

    if not doc.page_count:
        return None

    client = _make_client(env)
    prompt = (
        env.get("FILEDROP_LLM_PROMPT")
        or "Transcribe all text visible on this page exactly as it appears. "
           "For any charts, tables, or images also provide a concise description."
    )

    pages = []
    mat = fitz.Matrix(2, 2)  # 2× zoom → better OCR quality
    for page_num, page in enumerate(doc, 1):
        pix = page.get_pixmap(matrix=mat)
        img_b64 = base64.b64encode(pix.tobytes("png")).decode("ascii")
        try:
            resp = client.chat.completions.create(
                model=env["FILEDROP_LLM_MODEL"],
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                    ],
                }],
            )
            text = (resp.choices[0].message.content or "").strip()
            text = _strip_thinking(text)
        except Exception as exc:
            text = f"> [!error] Page {page_num} OCR failed: {exc}"
        pages.append(f"### Page {page_num}\n\n{text}")

    return "\n\n".join(pages)


def _emit_phase(phase):
    print(f"[filedrop:phase] {phase}", file=sys.stderr, flush=True)


def _error_callout(title, detail):
    body = (detail or "").replace("\n", "\n> ")
    return f"> [!error] Conversion error: {title}\n> {body}"


def _warning_callout(detail):
    body = (detail or "").replace("\n", "\n> ")
    return f"> [!warning] {body}"


def _unsupported_detail(exc):
    # markitdown raises UnsupportedFormatException for file types it can't read.
    # Match it by class name so we don't need to import the symbol (it lives in
    # an internal module that has moved between markitdown versions).
    if type(exc).__name__ != "UnsupportedFormatException":
        return None
    msg = str(exc).strip()
    return msg or "This file type is not supported by markitdown."


def _convert_file(path, llm_md, env):
    """Convert one file (the .msg body or an attachment) to markdown.

    Mirrors filedrop_convert.convert(): try markitdown-with-LLM first so
    text-layer PDFs and embedded images are handled cheaply, and only fall back
    to page-by-page OCR for scanned PDFs that produce nothing. On failure
    returns a `> [!error]` callout instead of an empty string so the user can
    see what went wrong in the note itself.
    """
    filename = os.path.basename(path)

    if llm_md is None:
        _emit_phase("markitdown")
        result = _convert_without_llm(path)
        if result:
            return result
        return _error_callout(
            "Conversion produced no output",
            f"markitdown returned empty content for {filename}.",
        )

    is_pdf = path.lower().endswith(".pdf")
    image_exts = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif")
    _emit_phase("llm-image" if path.lower().endswith(image_exts) else "markitdown")
    try:
        result = llm_md.convert(path).text_content
        if result and result.strip():
            return result
    except Exception as exc:
        unsupported = _unsupported_detail(exc)
        if unsupported:
            print(f"[filedrop] unsupported format for {filename}: {unsupported}", file=sys.stderr)
            return _error_callout("Unsupported file format", unsupported)
        print(f"[filedrop] markitdown LLM step failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        if not is_pdf:
            fallback = _convert_without_llm(path)
            if fallback:
                return fallback
            return _error_callout(
                "Conversion failed",
                f"{type(exc).__name__}: {exc}",
            )

    if is_pdf:
        _emit_phase("llm-image")
        result = _convert_pdf_pages_with_llm(path, env)
        if result:
            return result

    return _error_callout(
        "Conversion produced no output",
        f"markitdown returned empty content for {filename}.",
    )


def convert_msg(path, env):
    llm_md = _build_llm_markitdown(env)
    body = _convert_file(path, llm_md, env)

    attachments = []
    warning = None

    try:
        import extract_msg  # type: ignore
    except ImportError:
        warning = (
            "extract-msg is not installed — attachment extraction skipped. "
            "Run: pip install extract-msg"
        )
        return {"body": body, "attachments": attachments, "warning": warning}

    try:
        msg = extract_msg.Message(path)
        with tempfile.TemporaryDirectory() as tmpdir:
            for att in msg.attachments or []:
                filename = (
                    getattr(att, "longFilename", None)
                    or getattr(att, "shortFilename", None)
                )
                data = getattr(att, "data", None)
                if not filename or not data:
                    continue

                att_path = os.path.join(tmpdir, filename)
                with open(att_path, "wb") as fh:
                    fh.write(data)

                att_md = _convert_file(att_path, llm_md, env)
                attachments.append({
                    "filename": filename,
                    "data_b64": base64.b64encode(data).decode("ascii"),
                    "markdown": att_md,
                })
    except Exception as exc:
        warning = f"Attachment extraction failed: {type(exc).__name__}: {exc}"

    # Surface the warning inside the note too — a Notice toast disappears,
    # but the user comes back to the note later to verify it.
    if warning:
        body = f"{body}\n\n{_warning_callout(warning)}" if body else _warning_callout(warning)

    return {"body": body, "attachments": attachments, "warning": warning}


def main(argv=None, env=None):
    argv = sys.argv if argv is None else argv
    env = os.environ if env is None else env
    result = convert_msg(argv[1], env)
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
