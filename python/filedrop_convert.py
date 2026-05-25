"""Convert a file to markdown via markitdown's LLM image-description path.

Runs against an OpenAI-compatible gateway. Configuration is read from the
environment; the file path is the first positional argument. The plugin invokes
this as `python -c <inlined source> <path>`, so argv[1] is the file path.
"""

import os
import sys

from markitdown import MarkItDown
from openai import OpenAI


def build_converter(env):
    client = OpenAI(
        api_key=env["FILEDROP_LLM_KEY"],
        base_url=env.get("FILEDROP_LLM_URL") or None,
    )
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
