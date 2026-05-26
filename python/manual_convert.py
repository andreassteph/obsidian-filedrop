#!/usr/bin/env python3
"""
Interactive wrapper for filedrop_convert.py.
Prompts for LLM config and file path, then runs filedrop_convert.
"""

import sys
import os
import subprocess
import getpass
import configparser
import argparse
from pathlib import Path

from openai import OpenAI, APIError, APIConnectionError, AuthenticationError


def load_config_defaults() -> dict:
    """Load defaults from manual.cfg if it exists."""
    script_dir = Path(__file__).parent
    config_file = script_dir / "manual.cfg"

    defaults = {}
    if config_file.exists():
        config = configparser.ConfigParser()
        config.read(config_file)
        if "llm" in config:
            if "api_key" in config["llm"]:
                defaults["api_key"] = config["llm"]["api_key"]
            if "model" in config["llm"]:
                defaults["model"] = config["llm"]["model"]
            if "url" in config["llm"]:
                defaults["url"] = config["llm"]["url"]
            if "prompt" in config["llm"]:
                defaults["prompt"] = config["llm"]["prompt"]

    return defaults


def check_openai_connection(llm_config: dict) -> None:
    """Verify OpenAI connection, credentials, and model availability.

    Exits with error if connection fails or model is not available.
    """
    api_key = llm_config["FILEDROP_LLM_KEY"]
    model = llm_config["FILEDROP_LLM_MODEL"]
    base_url = llm_config.get("FILEDROP_LLM_URL")

    print(f"Checking connection to {base_url or 'OpenAI'}...", file=sys.stderr)

    try:
        kwargs = {
            "api_key": api_key,
            "timeout": 10.0,
            "default_headers": {"x-api-key": api_key, "X-Api-Key": api_key},
        }
        if base_url:
            kwargs["base_url"] = base_url

        client = OpenAI(**kwargs)

        # List available models with increased timeout
        models_resp = client.models.list(timeout=10.0)
        available_models = [m.id for m in (models_resp.data or [])]

        if not available_models:
            # Gateway doesn't expose a real model list — verify via a minimal completion
            try:
                client.chat.completions.create(
                    model=model,
                    messages=[{"role": "user", "content": "Say 'ok'"}],
                    max_completion_tokens=5
                )
            except APIError as e:
                status = getattr(e, "status_code", None)
                print(f"Error: Model test failed (HTTP {status})", file=sys.stderr)
                print(f"  - Model: '{model}'", file=sys.stderr)
                if base_url:
                    print(f"  - Endpoint: {base_url}", file=sys.stderr)
                if status == 500:
                    print(f"  - 500 routing error usually means the model name is wrong", file=sys.stderr)
                    print(f"  - Check FILEDROP_LLM_MODEL in manual.cfg", file=sys.stderr)
                print(f"  - Raw error: {e}", file=sys.stderr)
                sys.exit(1)
            print(f"✓ Connection verified via test completion", file=sys.stderr)
            print(f"✓ Model '{model}' responded", file=sys.stderr)
        elif model not in available_models:
            print(f"Error: Model '{model}' not found", file=sys.stderr)
            print(f"  - Check that FILEDROP_LLM_MODEL is correct", file=sys.stderr)
            if base_url:
                print(f"  - Endpoint: {base_url}", file=sys.stderr)
            print(f"  - Available models: {', '.join(available_models[:5])}", file=sys.stderr)
            if len(available_models) > 5:
                print(f"    ({len(available_models) - 5} more...)", file=sys.stderr)
            sys.exit(1)
        else:
            print(f"✓ OpenAI connection verified", file=sys.stderr)
            print(f"✓ Model '{model}' is available", file=sys.stderr)
    except AuthenticationError as e:
        print("Error: Authentication failed", file=sys.stderr)
        print(f"  - Check that FILEDROP_LLM_KEY is correct", file=sys.stderr)
        print(f"  - API key starts with: {api_key[:7]}...", file=sys.stderr)
        sys.exit(1)
    except APIConnectionError as e:
        print("Error: Failed to connect to OpenAI endpoint", file=sys.stderr)
        if base_url:
            print(f"  - Endpoint: {base_url}", file=sys.stderr)
            print(f"  - Check that FILEDROP_LLM_URL is correct and reachable", file=sys.stderr)
        else:
            print(f"  - Using default OpenAI endpoint", file=sys.stderr)
            print(f"  - Check your internet connection", file=sys.stderr)
        print(f"  - Error: {e}", file=sys.stderr)
        # Print underlying cause if available
        if e.__cause__:
            print(f"  - Root cause: {type(e.__cause__).__name__}: {e.__cause__}", file=sys.stderr)
        sys.exit(1)
    except APIError as e:
        error_msg = e.message if hasattr(e, 'message') else str(e)
        print(f"Error: OpenAI API error: {error_msg}", file=sys.stderr)
        if base_url:
            print(f"  - Endpoint: {base_url}", file=sys.stderr)
        print(f"  - Error type: {type(e).__name__}", file=sys.stderr)
        sys.exit(1)
    except TimeoutError as e:
        print("Error: Request timed out", file=sys.stderr)
        if base_url:
            print(f"  - Endpoint: {base_url}", file=sys.stderr)
            print(f"  - Check that the endpoint is responding quickly enough", file=sys.stderr)
        print(f"  - Timeout: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: Failed to verify OpenAI connection", file=sys.stderr)
        print(f"  - Error type: {type(e).__name__}", file=sys.stderr)
        print(f"  - Error: {e}", file=sys.stderr)
        if e.__cause__:
            print(f"  - Root cause: {type(e.__cause__).__name__}: {e.__cause__}", file=sys.stderr)
        if base_url:
            print(f"  - Endpoint: {base_url}", file=sys.stderr)
            print(f"  - Tip: Try this command to debug:", file=sys.stderr)
            print(f"    curl -v {base_url.rstrip('/')}/models", file=sys.stderr)
        sys.exit(1)


def parse_args():
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Convert files using filedrop_convert with LLM config."
    )
    parser.add_argument(
        "file_path", nargs="?", help="Path to file to convert (optional if not using -Y)"
    )
    parser.add_argument(
        "-Y",
        "--yes",
        action="store_true",
        help="Use all defaults from config, skip prompts",
    )
    return parser.parse_args()


def get_llm_config(defaults: dict, use_defaults: bool = False) -> dict:
    """Prompt for LLM config variables, using defaults from config file.

    If use_defaults is True, skip all prompts and use defaults only.
    """
    config = {}

    # Required: API key
    if use_defaults:
        api_key = defaults.get("api_key")
        if not api_key:
            print("Error: LLM API Key required in config for -Y mode", file=sys.stderr)
            sys.exit(1)
    else:
        prompt_text = "LLM API Key"
        if "api_key" in defaults:
            prompt_text += f" (default in config): "
            api_key = getpass.getpass(prompt_text) or defaults["api_key"]
        else:
            prompt_text += " (required): "
            api_key = getpass.getpass(prompt_text)

        if not api_key:
            print("Error: LLM API Key is required", file=sys.stderr)
            sys.exit(1)

    config["FILEDROP_LLM_KEY"] = api_key

    # Required: model
    model_default = defaults.get("model", "gpt-4o")
    if use_defaults:
        model = model_default
    else:
        model = input(f"LLM Model (default: {model_default}): ").strip()
        if not model:
            model = model_default
    config["FILEDROP_LLM_MODEL"] = model

    # Optional: custom endpoint
    if use_defaults:
        if "url" in defaults:
            config["FILEDROP_LLM_URL"] = defaults["url"]
    else:
        url_hint = ""
        if "url" in defaults:
            url_hint = f" (default from config: {defaults['url']})"
        url = input(f"LLM Endpoint URL (optional, blank = OpenAI){url_hint}: ").strip()
        if url:
            config["FILEDROP_LLM_URL"] = url
        elif "url" in defaults:
            config["FILEDROP_LLM_URL"] = defaults["url"]

    # Optional: custom prompt
    if use_defaults:
        if "prompt" in defaults:
            config["FILEDROP_LLM_PROMPT"] = defaults["prompt"]
    else:
        prompt_hint = ""
        if "prompt" in defaults:
            prompt_hint = " (default from config)"
        prompt = input(
            f"LLM System Prompt (optional, blank = built-in){prompt_hint}: "
        ).strip()
        if prompt:
            config["FILEDROP_LLM_PROMPT"] = prompt
        elif "prompt" in defaults:
            config["FILEDROP_LLM_PROMPT"] = defaults["prompt"]

    return config


def main():
    args = parse_args()
    defaults = load_config_defaults()

    # Get file path: from arg or interactive prompt
    if args.file_path:
        file_path = args.file_path
    elif args.yes:
        print("Error: file path required when using -Y", file=sys.stderr)
        sys.exit(1)
    else:
        file_path = input("File path to convert: ").strip()
        if not file_path:
            print("Error: file path is required", file=sys.stderr)
            sys.exit(1)

    if not os.path.exists(file_path):
        print(f"Error: file not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    llm_config = get_llm_config(defaults, use_defaults=args.yes)

    # Verify OpenAI connection before proceeding
    check_openai_connection(llm_config)

    # Resolve filedrop_convert.py relative to this script
    script_dir = Path(__file__).parent
    convert_script = script_dir / "filedrop_convert.py"

    if not convert_script.exists():
        print(
            f"Error: filedrop_convert.py not found at {convert_script}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Build env: inherit current env, overlay LLM config
    env = {**os.environ, **llm_config}

    # Run filedrop_convert.py
    result = subprocess.run(
        [sys.executable, str(convert_script), file_path],
        env=env,
    )

    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
