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


def _safe_convert(md, path):
    try:
        result = md.convert(path)
        return (result.text_content or "").strip()
    except Exception as exc:
        return f"> [!error] Conversion error: {exc}"


def convert_msg(path, env):
    md = _build_markitdown(env)
    body = _safe_convert(md, path)

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

                att_md = _safe_convert(md, att_path)
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
