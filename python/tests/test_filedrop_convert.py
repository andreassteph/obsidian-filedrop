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
    _, kwargs = openai.call_args
    assert kwargs["api_key"] == "sk-test"
    assert kwargs["base_url"] is None
    assert kwargs["default_headers"] == {"x-api-key": "sk-test", "X-Api-Key": "sk-test"}
    assert kwargs["max_retries"] == 0
    assert kwargs["timeout"] is not None


def test_openai_base_url_uses_gateway_when_set():
    env = dict(BASE_ENV, FILEDROP_LLM_URL="https://gw.example/v1")
    with patch.object(filedrop_convert, "OpenAI") as openai, \
            patch.object(filedrop_convert, "MarkItDown"):
        filedrop_convert.build_converter(env)
    _, kwargs = openai.call_args
    assert kwargs["base_url"] == "https://gw.example/v1"
    assert kwargs["max_retries"] == 0


def test_llm_timeout_uses_env_override():
    env = dict(BASE_ENV, FILEDROP_LLM_TIMEOUT="42")
    timeout = filedrop_convert._llm_timeout(env)
    # In tests httpx is unavailable, so the helper falls back to a flat float.
    # In production it returns httpx.Timeout(total, connect=...); accept either.
    total = float(getattr(timeout, "read", timeout))
    assert total == 42.0


def test_llm_timeout_falls_back_to_default():
    timeout = filedrop_convert._llm_timeout(dict(BASE_ENV))
    total = float(getattr(timeout, "read", timeout))
    assert total == filedrop_convert._DEFAULT_LLM_TIMEOUT_S


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
        buffer = io.BytesIO()
        fake_stdout = types.SimpleNamespace(buffer=buffer)
        with patch("sys.stdout", fake_stdout):
            filedrop_convert.main(argv=["-c", "/tmp/file.png"], env=dict(BASE_ENV))
    assert buffer.getvalue() == b"# out"


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


def test_convert_pdf_uses_markitdown_when_content_returned():
    """markitdown returns content for a PDF → use it, skip PyMuPDF."""
    with patch.object(filedrop_convert, "OpenAI"), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown, \
            patch.object(filedrop_convert, "_convert_pdf_pages_with_llm") as pdf_llm:
        markitdown.return_value.convert.return_value.text_content = "# PDF text"
        result = filedrop_convert.convert("/tmp/file.pdf", dict(BASE_ENV))
    assert result == "# PDF text"
    pdf_llm.assert_not_called()


def test_convert_pdf_falls_back_to_pymupdf_when_markitdown_empty():
    """markitdown returns empty for a PDF → fall back to PyMuPDF image path."""
    with patch.object(filedrop_convert, "OpenAI"), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown, \
            patch.object(filedrop_convert, "_convert_pdf_pages_with_llm") as pdf_llm:
        markitdown.return_value.convert.return_value.text_content = ""
        pdf_llm.return_value = "### Page 1\n\nScanned text"
        result = filedrop_convert.convert("/tmp/file.pdf", dict(BASE_ENV))
    assert result == "### Page 1\n\nScanned text"
    pdf_llm.assert_called_once_with("/tmp/file.pdf", dict(BASE_ENV))


def test_convert_pdf_falls_back_to_pymupdf_when_markitdown_raises():
    """markitdown raises for a PDF → fall back to PyMuPDF image path."""
    with patch.object(filedrop_convert, "OpenAI"), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown, \
            patch.object(filedrop_convert, "_convert_pdf_pages_with_llm") as pdf_llm:
        markitdown.return_value.convert.side_effect = Exception("pdfminer error")
        pdf_llm.return_value = "### Page 1\n\nOCR result"
        result = filedrop_convert.convert("/tmp/file.pdf", dict(BASE_ENV))
    assert result == "### Page 1\n\nOCR result"
    pdf_llm.assert_called_once()


def test_convert_pptx_keeps_plain_markitdown_when_llm_step_raises():
    """LLM-enhanced step raises for a PPTX → keep the plain markitdown text."""
    with patch.object(filedrop_convert, "OpenAI"), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown, \
            patch.object(filedrop_convert, "build_converter") as build_converter:
        build_converter.return_value.convert.side_effect = Exception("llm boom")
        markitdown.return_value.convert.return_value.text_content = "# Slide text"
        result = filedrop_convert.convert("/tmp/deck.pptx", dict(BASE_ENV))
    assert result == "# Slide text"


def test_convert_pptx_returns_empty_when_both_steps_fail():
    """LLM step and the plain fallback both raise → return "" (never crash)."""
    with patch.object(filedrop_convert, "OpenAI"), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown, \
            patch.object(filedrop_convert, "build_converter") as build_converter:
        build_converter.return_value.convert.side_effect = Exception("llm boom")
        markitdown.return_value.convert.side_effect = Exception("corrupt deck")
        result = filedrop_convert.convert("/tmp/deck.pptx", dict(BASE_ENV))
    assert result == ""


def test_convert_without_llm_swallows_errors():
    with patch.object(filedrop_convert, "MarkItDown") as markitdown:
        markitdown.return_value.convert.side_effect = Exception("corrupt deck")
        assert filedrop_convert._convert_without_llm("/tmp/deck.pptx") == ""


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
