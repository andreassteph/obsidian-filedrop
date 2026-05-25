import io
from unittest.mock import patch

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
