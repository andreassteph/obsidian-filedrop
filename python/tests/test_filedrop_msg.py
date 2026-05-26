import types
from unittest.mock import MagicMock, patch

import pytest

import filedrop_msg


BASE_ENV = {
    "FILEDROP_LLM_URL": "https://gw.example/v1",
    "FILEDROP_LLM_KEY": "sk-test",
    "FILEDROP_LLM_MODEL": "gpt-4o-mini",
}


def _fake_response(content):
    message = types.SimpleNamespace(content=content)
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("A red bicycle leaning on a wall.", "A red bicycle leaning on a wall."),
        ("<think>let me look…</think>\nA red bicycle.", "A red bicycle."),
        ("<Thinking>reasoning</Thinking>A cat.", "A cat."),
        ("<reasoning>x</reasoning>\n\nA dog.", "A dog."),
        ("<think>line1\nline2</think>Final.", "Final."),
        # Dangling closer in the middle → keep what follows.
        ("the model reasons first</think>The answer.", "The answer."),
        # Dangling closer at the very end → keep what precedes it (not "").
        ("The answer.</think>", "The answer."),
        ("", ""),
        (None, None),
    ],
)
def test_strip_thinking(raw, expected):
    assert filedrop_msg._strip_thinking(raw) == expected


def test_install_thinking_filter_strips_completion_content():
    client = types.SimpleNamespace(
        chat=types.SimpleNamespace(
            completions=types.SimpleNamespace(
                create=lambda **kw: _fake_response("<think>hmm</think>A bridge at dusk.")
            )
        )
    )
    filedrop_msg._install_thinking_filter(client)
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
    filedrop_msg._install_thinking_filter(client)
    response = client.chat.completions.create(model="m", messages=[])
    assert response.choices[0].message.content == "A plain caption."


def test_make_client_sends_both_header_variants():
    with patch.object(filedrop_msg, "OpenAI") as openai:
        filedrop_msg._make_client(dict(BASE_ENV))
    _, kwargs = openai.call_args
    assert kwargs["api_key"] == "sk-test"
    assert kwargs["base_url"] == "https://gw.example/v1"
    assert kwargs["default_headers"] == {"x-api-key": "sk-test", "X-Api-Key": "sk-test"}


def test_make_client_base_url_none_when_url_blank():
    env = dict(BASE_ENV, FILEDROP_LLM_URL="")
    with patch.object(filedrop_msg, "OpenAI") as openai:
        filedrop_msg._make_client(env)
    _, kwargs = openai.call_args
    assert kwargs["base_url"] is None


def test_convert_file_without_llm_uses_plain_markitdown():
    with patch.object(filedrop_msg, "MarkItDown") as markitdown:
        markitdown.return_value.convert.return_value.text_content = "# plain"
        result = filedrop_msg._convert_file("/tmp/file.docx", None, dict(BASE_ENV))
    assert result == "# plain"


def test_convert_file_pdf_uses_markitdown_when_content_returned():
    """markitdown returns content for a PDF → use it, skip PyMuPDF OCR."""
    llm_md = MagicMock()
    llm_md.convert.return_value.text_content = "# PDF text"
    with patch.object(filedrop_msg, "_convert_pdf_pages_with_llm") as pdf_llm:
        result = filedrop_msg._convert_file("/tmp/file.pdf", llm_md, dict(BASE_ENV))
    assert result == "# PDF text"
    pdf_llm.assert_not_called()


def test_convert_file_pdf_falls_back_to_pymupdf_when_markitdown_empty():
    llm_md = MagicMock()
    llm_md.convert.return_value.text_content = ""
    with patch.object(filedrop_msg, "_convert_pdf_pages_with_llm") as pdf_llm:
        pdf_llm.return_value = "### Page 1\n\nScanned text"
        result = filedrop_msg._convert_file("/tmp/file.pdf", llm_md, dict(BASE_ENV))
    assert result == "### Page 1\n\nScanned text"
    pdf_llm.assert_called_once_with("/tmp/file.pdf", dict(BASE_ENV))


def test_convert_file_pdf_falls_back_to_pymupdf_when_markitdown_raises():
    llm_md = MagicMock()
    llm_md.convert.side_effect = Exception("pdfminer error")
    with patch.object(filedrop_msg, "_convert_pdf_pages_with_llm") as pdf_llm:
        pdf_llm.return_value = "### Page 1\n\nOCR result"
        result = filedrop_msg._convert_file("/tmp/file.pdf", llm_md, dict(BASE_ENV))
    assert result == "### Page 1\n\nOCR result"
    pdf_llm.assert_called_once()


def test_convert_file_pptx_keeps_plain_markitdown_when_llm_step_raises():
    """LLM-enhanced step raises for a PPTX → keep the plain markitdown text."""
    llm_md = MagicMock()
    llm_md.convert.side_effect = Exception("llm boom")
    with patch.object(filedrop_msg, "MarkItDown") as markitdown:
        markitdown.return_value.convert.return_value.text_content = "# Slide text"
        result = filedrop_msg._convert_file("/tmp/deck.pptx", llm_md, dict(BASE_ENV))
    assert result == "# Slide text"


def test_convert_file_pptx_returns_empty_when_both_steps_fail():
    llm_md = MagicMock()
    llm_md.convert.side_effect = Exception("llm boom")
    with patch.object(filedrop_msg, "MarkItDown") as markitdown:
        markitdown.return_value.convert.side_effect = Exception("corrupt deck")
        result = filedrop_msg._convert_file("/tmp/deck.pptx", llm_md, dict(BASE_ENV))
    assert result == ""


def test_build_llm_markitdown_none_without_gateway():
    assert filedrop_msg._build_llm_markitdown({}) is None
