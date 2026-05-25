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
import sys
import tempfile


def _build_markitdown(env):
    url = env.get("FILEDROP_LLM_URL")
    key = env.get("FILEDROP_LLM_KEY")
    model = env.get("FILEDROP_LLM_MODEL")
    if url and key and model:
        from openai import OpenAI
        from markitdown import MarkItDown
        client = OpenAI(api_key=key, base_url=url or None)
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
    try:
        import extract_msg  # type: ignore
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
    except ImportError:
        pass
    except Exception:
        pass

    return {"body": body, "attachments": attachments}


def main(argv=None, env=None):
    argv = sys.argv if argv is None else argv
    env = os.environ if env is None else env
    result = convert_msg(argv[1], env)
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
