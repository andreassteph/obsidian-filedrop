import sys
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


def test_convert_file_pptx_returns_error_callout_when_both_steps_fail():
    llm_md = MagicMock()
    llm_md.convert.side_effect = Exception("llm boom")
    with patch.object(filedrop_msg, "MarkItDown") as markitdown:
        markitdown.return_value.convert.side_effect = Exception("corrupt deck")
        result = filedrop_msg._convert_file("/tmp/deck.pptx", llm_md, dict(BASE_ENV))
    assert result.startswith("> [!error] Conversion error: Conversion failed")
    assert "llm boom" in result


def test_convert_file_gif_returns_info_callout():
    llm_md = MagicMock()
    result = filedrop_msg._convert_file("/tmp/animation.gif", llm_md, dict(BASE_ENV))
    assert result.startswith("> [!info]")
    assert "animation.gif" in result
    llm_md.convert.assert_not_called()


def test_convert_file_gif_without_llm_returns_info_callout():
    result = filedrop_msg._convert_file("/tmp/animation.gif", None, {})
    assert result.startswith("> [!info]")
    assert "animation.gif" in result


def test_build_llm_markitdown_none_without_gateway():
    assert filedrop_msg._build_llm_markitdown({}) is None


@pytest.mark.parametrize(
    "param, expected",
    [
        (None, {"max_tokens": 50}),
        ("max_completion_tokens", {"max_completion_tokens": 50}),
        ("none", {}),
        ("bogus", {"max_tokens": 50}),
    ],
)
def test_token_kwargs(param, expected):
    env = dict(BASE_ENV)
    if param is not None:
        env["FILEDROP_LLM_TOKEN_PARAM"] = param
    assert filedrop_msg._token_kwargs(env, 50) == expected


@pytest.mark.parametrize(
    "value, expected",
    [(None, True), ("1", True), ("0", False), ("false", False)],
)
def test_vision_enabled(value, expected):
    env = dict(BASE_ENV)
    if value is not None:
        env["FILEDROP_LLM_VISION"] = value
    assert filedrop_msg._vision_enabled(env) is expected


@pytest.mark.parametrize(
    "value, expected",
    [(None, {"temperature": 0}), ("1", {"temperature": 0}), ("0", {}), ("false", {})],
)
def test_temperature_kwargs(value, expected):
    env = dict(BASE_ENV)
    if value is not None:
        env["FILEDROP_LLM_TEMPERATURE"] = value
    assert filedrop_msg._temperature_kwargs(env) == expected


def test_convert_msg_writes_attachment_to_temp_file(tmp_path):
    """Attachments are handed across as temp files (temp_path), not base64 bytes
    on stdout. The temp file must hold the exact attachment bytes."""
    import os
    import shutil

    msg_path = tmp_path / "mail.msg"
    msg_path.write_bytes(b"not a real msg, but a regular file")

    att = types.SimpleNamespace(longFilename="doc.txt", shortFilename=None, data=b"hello bytes")
    fake_extract_msg = types.SimpleNamespace(Message=lambda path: types.SimpleNamespace(attachments=[att]))

    with patch.object(filedrop_msg, "MarkItDown") as markitdown, \
            patch.dict(sys.modules, {"extract_msg": fake_extract_msg}):
        markitdown.return_value.convert.return_value.text_content = "# body"
        result = filedrop_msg.convert_msg(str(msg_path), {})  # empty env → no gateway

    atts = result["attachments"]
    assert len(atts) == 1
    a = atts[0]
    assert a["filename"] == "doc.txt"
    assert "data_b64" not in a
    assert os.path.isfile(a["temp_path"])
    with open(a["temp_path"], "rb") as fh:
        assert fh.read() == b"hello bytes"

    shutil.rmtree(os.path.dirname(a["temp_path"]), ignore_errors=True)


def test_convert_pdf_pages_skipped_when_vision_disabled():
    """No-vision model → emit a warning and never construct the LLM client."""
    env = dict(BASE_ENV, FILEDROP_LLM_VISION="0")
    with patch.object(filedrop_msg, "_make_client") as make_client:
        result = filedrop_msg._convert_pdf_pages_with_llm("/tmp/scan.pdf", env)
    make_client.assert_not_called()
    assert result.startswith("> [!warning]")
    assert "vision" in result
