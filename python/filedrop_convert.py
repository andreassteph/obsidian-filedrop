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
            cleaned = cleaned[idx + len(closer):]
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


def build_converter(env):
    client = OpenAI(
        api_key=env["FILEDROP_LLM_KEY"],
        base_url=env.get("FILEDROP_LLM_URL") or None,
    )
    _install_thinking_filter(client)
    kwargs = {"llm_client": client, "llm_model": env["FILEDROP_LLM_MODEL"]}
    prompt = env.get("FILEDROP_LLM_PROMPT")
    if prompt:
        kwargs["llm_prompt"] = prompt
    return MarkItDown(**kwargs)


def convert(path, env):
    return build_converter(env).convert(path).text_content


def main(argv=None, env=None):
    argv = sys.argv if argv is None else argv
    env = os.environ if env is None else env
    sys.stdout.write(convert(argv[1], env))


if __name__ == "__main__":
    main()
