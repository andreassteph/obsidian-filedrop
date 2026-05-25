import io
import types
from unittest.mock import patch

import pytest

import filedrop_convert


BASE_ENV = {
    "FILEDROP_LLM_KEY": "sk-test",
    "FILEDROP_LLM_MODEL": "gpt-4o-mini",
}


def test_openai_base_url_none_when_url_blank():
    with patch.object(filedrop_convert, "OpenAI") as openai, \
            patch.object(filedrop_convert, "MarkItDown"):
        filedrop_convert.build_converter(dict(BASE_ENV))
    openai.assert_called_once_with(api_key="sk-test", base_url=None)


def test_openai_base_url_uses_gateway_when_set():
    env = dict(BASE_ENV, FILEDROP_LLM_URL="https://gw.example/v1")
    with patch.object(filedrop_convert, "OpenAI") as openai, \
            patch.object(filedrop_convert, "MarkItDown"):
        filedrop_convert.build_converter(env)
    openai.assert_called_once_with(api_key="sk-test", base_url="https://gw.example/v1")


def test_prompt_omitted_when_blank():
    with patch.object(filedrop_convert, "OpenAI"), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown:
        filedrop_convert.build_converter(dict(BASE_ENV))
    _, kwargs = markitdown.call_args
    assert "llm_prompt" not in kwargs
    assert kwargs["llm_model"] == "gpt-4o-mini"


def test_prompt_included_when_set():
    env = dict(BASE_ENV, FILEDROP_LLM_PROMPT="Describe in detail.")
    with patch.object(filedrop_convert, "OpenAI"), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown:
        filedrop_convert.build_converter(env)
    _, kwargs = markitdown.call_args
    assert kwargs["llm_prompt"] == "Describe in detail."


def test_convert_returns_text_content():
    with patch.object(filedrop_convert, "OpenAI"), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown:
        converter = markitdown.return_value
        converter.convert.return_value.text_content = "# hello"
        result = filedrop_convert.convert("/tmp/file.png", dict(BASE_ENV))
    converter.convert.assert_called_once_with("/tmp/file.png")
    assert result == "# hello"


def test_main_writes_converted_text_to_stdout():
    with patch.object(filedrop_convert, "OpenAI"), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown:
        markitdown.return_value.convert.return_value.text_content = "# out"
        out = io.StringIO()
        with patch("sys.stdout", out):
            filedrop_convert.main(argv=["-c", "/tmp/file.png"], env=dict(BASE_ENV))
    assert out.getvalue() == "# out"


@pytest.mark.parametrize(
    "raw, expected",
    [
        # Non-thinking model: passes through (only trimmed).
        ("A red bicycle leaning on a wall.", "A red bicycle leaning on a wall."),
        # Well-formed think block before the answer.
        ("<think>let me look…</think>\nA red bicycle.", "A red bicycle."),
        # Tag variants and casing.
        ("<Thinking>reasoning</Thinking>A cat.", "A cat."),
        ("<reasoning>x</reasoning>\n\nA dog.", "A dog."),
        # Multi-line reasoning.
        ("<think>line1\nline2</think>Final.", "Final."),
        # Dangling closer (opening tag injected by the chat template).
        ("the model reasons first</think>The answer.", "The answer."),
        # Empty/None inputs are returned as-is.
        ("", ""),
        (None, None),
    ],
)
def test_strip_thinking(raw, expected):
    assert filedrop_convert.strip_thinking(raw) == expected


def _fake_response(content):
    message = types.SimpleNamespace(content=content)
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])


def test_install_thinking_filter_strips_completion_content():
    client = types.SimpleNamespace(
        chat=types.SimpleNamespace(
            completions=types.SimpleNamespace(
                create=lambda **kw: _fake_response("<think>hmm</think>A bridge at dusk.")
            )
        )
    )
    filedrop_convert._install_thinking_filter(client)
    response = client.chat.completions.create(model="m", messages=[])
    assert response.choices[0].message.content == "A bridge at dusk."


def test_install_thinking_filter_leaves_clean_content():
    client = types.SimpleNamespace(
        chat=types.SimpleNamespace(
            completions=types.SimpleNamespace(
                create=lambda **kw: _fake_response("A plain caption.")
            )
        )
    )
    filedrop_convert._install_thinking_filter(client)
    response = client.chat.completions.create(model="m", messages=[])
    assert response.choices[0].message.content == "A plain caption."
