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
"""

import base64
import json
import os
import re
import sys
import tempfile

# Strip chain-of-thought blocks that reasoning models emit before their answer.
_THINK_BLOCK = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.DOTALL | re.IGNORECASE)
_DANGLING_CLOSERS = ("</think>", "</thinking>", "</reasoning>")


def _strip_thinking(text):
    if not text:
        return text
    cleaned = _THINK_BLOCK.sub("", text)
    lowered = cleaned.lower()
    for closer in _DANGLING_CLOSERS:
        idx = lowered.rfind(closer)
        if idx != -1:
            cleaned = cleaned[idx + len(closer):]
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


def _build_markitdown(env):
    url = env.get("FILEDROP_LLM_URL")
    key = env.get("FILEDROP_LLM_KEY")
    model = env.get("FILEDROP_LLM_MODEL")
    if url and key and model:
        from openai import OpenAI
        from markitdown import MarkItDown
        client = _install_thinking_filter(OpenAI(api_key=key, base_url=url or None))
        kwargs = {"llm_client": client, "llm_model": model}
        prompt = env.get("FILEDROP_LLM_PROMPT")
        if prompt:
            kwargs["llm_prompt"] = prompt
        return MarkItDown(**kwargs)
    from markitdown import MarkItDown
    return MarkItDown()


def _convert_pdf_pages_with_llm(path, env):
    """Render every PDF page via PyMuPDF and describe each with the LLM.

    Returns the combined markdown, or None if PyMuPDF or the LLM is
    unavailable so the caller can fall back to plain markitdown.
    """
    url = env.get("FILEDROP_LLM_URL")
    key = env.get("FILEDROP_LLM_KEY")
    model = env.get("FILEDROP_LLM_MODEL")
    if not (url and key and model):
        return None

    try:
        import fitz  # pymupdf  # type: ignore
        from openai import OpenAI
    except ImportError:
        return None

    try:
        doc = fitz.open(path)
    except Exception:
        return None

    if not doc.page_count:
        return None

    client = _install_thinking_filter(OpenAI(api_key=key, base_url=url or None))
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
                model=model,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                    ],
                }],
            )
            text = (resp.choices[0].message.content or "").strip()
        except Exception as exc:
            text = f"> [!error] Page {page_num} OCR failed: {exc}"
        pages.append(f"### Page {page_num}\n\n{text}")

    return "\n\n".join(pages)


def _safe_convert(md, path, env=None):
    # Scanned PDFs: render pages via PyMuPDF → LLM instead of relying on
    # markitdown's text extraction, which returns nothing for image-only pages.
    if env is not None and path.lower().endswith(".pdf"):
        result = _convert_pdf_pages_with_llm(path, env)
        if result is not None:
            return result
    try:
        result = md.convert(path)
        return (result.text_content or "").strip()
    except Exception as exc:
        return f"> [!error] Conversion error: {exc}"


def convert_msg(path, env):
    md = _build_markitdown(env)
    body = _safe_convert(md, path, env)

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

                att_md = _safe_convert(md, att_path, env)
                attachments.append({
                    "filename": filename,
                    "data_b64": base64.b64encode(data).decode("ascii"),
                    "markdown": att_md,
                })
    except Exception as exc:
        warning = f"Attachment extraction failed: {exc}"

    return {"body": body, "attachments": attachments, "warning": warning}


def main(argv=None, env=None):
    argv = sys.argv if argv is None else argv
    env = os.environ if env is None else env
    result = convert_msg(argv[1], env)
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
