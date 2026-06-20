import io
import os
import sys
import types
from unittest.mock import patch

import pytest

import filedrop_convert


BASE_ENV = {
    "FILEDROP_LLM_KEY": "sk-test",
    "FILEDROP_LLM_MODEL": "gpt-4o-mini",
}


@pytest.fixture(autouse=True)
def _assume_regular_file():
    """convert() now guards on os.path.isfile before touching markitdown. These
    unit tests mock the converter and pass synthetic paths, so treat them as
    regular files; the guard itself is covered by test_convert_skips_directory."""
    with patch.object(filedrop_convert.os.path, "isfile", return_value=True):
        yield


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
    """LLM-enhanced step raises for a PPTX → error callout + plain markitdown text."""
    with patch.object(filedrop_convert, "OpenAI"), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown, \
            patch.object(filedrop_convert, "build_converter") as build_converter:
        build_converter.return_value.convert.side_effect = Exception("llm boom")
        markitdown.return_value.convert.return_value.text_content = "# Slide text"
        result = filedrop_convert.convert("/tmp/deck.pptx", dict(BASE_ENV))
    assert "[!error]" in result
    assert "# Slide text" in result


def test_convert_pptx_returns_error_callout_when_both_steps_fail():
    """LLM step and the plain fallback both raise → error callout only, never crash."""
    with patch.object(filedrop_convert, "OpenAI"), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown, \
            patch.object(filedrop_convert, "build_converter") as build_converter:
        build_converter.return_value.convert.side_effect = Exception("llm boom")
        markitdown.return_value.convert.side_effect = Exception("corrupt deck")
        result = filedrop_convert.convert("/tmp/deck.pptx", dict(BASE_ENV))
    assert "[!error]" in result
    assert "llm boom" in result


def test_convert_skips_directory():
    """A directory path (e.g. a `.group` folder) returns "" without invoking
    markitdown, so puremagic can't abort with "Not a regular file"."""
    with patch.object(filedrop_convert.os.path, "isfile", return_value=False), \
            patch.object(filedrop_convert.os.path, "isdir", return_value=True), \
            patch.object(filedrop_convert, "MarkItDown") as markitdown, \
            patch.object(filedrop_convert, "build_converter") as build_converter:
        result = filedrop_convert.convert("/tmp/some.group", dict(BASE_ENV))
    assert result == ""
    build_converter.assert_not_called()
    markitdown.return_value.convert.assert_not_called()


def test_convert_without_llm_swallows_errors():
    with patch.object(filedrop_convert, "MarkItDown") as markitdown:
        markitdown.return_value.convert.side_effect = Exception("corrupt deck")
        assert filedrop_convert._convert_without_llm("/tmp/deck.pptx") == ""


def _recording_client():
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        return _fake_response("ok")

    client = types.SimpleNamespace(
        chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))
    )
    return client, calls


@pytest.mark.parametrize(
    "param, expected",
    [
        (None, {"max_tokens": 100}),
        ("max_tokens", {"max_tokens": 100}),
        ("max_completion_tokens", {"max_completion_tokens": 100}),
        ("none", {}),
        ("bogus", {"max_tokens": 100}),  # unknown value falls back to max_tokens
    ],
)
def test_token_kwargs(param, expected):
    env = dict(BASE_ENV)
    if param is not None:
        env["FILEDROP_LLM_TOKEN_PARAM"] = param
    assert filedrop_convert._token_kwargs(env, 100) == expected


@pytest.mark.parametrize(
    "value, expected",
    [(None, True), ("1", True), ("true", True), ("0", False), ("false", False), ("off", False)],
)
def test_vision_enabled(value, expected):
    env = dict(BASE_ENV)
    if value is not None:
        env["FILEDROP_LLM_VISION"] = value
    assert filedrop_convert._vision_enabled(env) is expected


@pytest.mark.parametrize(
    "value, expected",
    [(None, {"temperature": 0}), ("1", {"temperature": 0}), ("0", {}), ("false", {}), ("off", {})],
)
def test_temperature_kwargs(value, expected):
    env = dict(BASE_ENV)
    if value is not None:
        env["FILEDROP_LLM_TEMPERATURE"] = value
    assert filedrop_convert._temperature_kwargs(env) == expected


def test_describe_uses_default_token_param():
    client, calls = _recording_client()
    with patch.object(filedrop_convert, "_make_client", return_value=client), \
            patch.object(filedrop_convert, "_install_thinking_filter"):
        filedrop_convert.describe("/tmp/foo.bin", dict(BASE_ENV))
    assert calls[0].get("max_tokens") == 2048
    assert "max_completion_tokens" not in calls[0]


def test_describe_sends_temperature_by_default():
    client, calls = _recording_client()
    with patch.object(filedrop_convert, "_make_client", return_value=client), \
            patch.object(filedrop_convert, "_install_thinking_filter"):
        filedrop_convert.describe("/tmp/foo.bin", dict(BASE_ENV))
    assert calls[0].get("temperature") == 0


def test_describe_omits_temperature_when_disabled():
    client, calls = _recording_client()
    env = dict(BASE_ENV, FILEDROP_LLM_TEMPERATURE="0")
    with patch.object(filedrop_convert, "_make_client", return_value=client), \
            patch.object(filedrop_convert, "_install_thinking_filter"):
        filedrop_convert.describe("/tmp/foo.bin", env)
    assert "temperature" not in calls[0]


def test_describe_uses_max_completion_tokens_when_configured():
    client, calls = _recording_client()
    env = dict(BASE_ENV, FILEDROP_LLM_TOKEN_PARAM="max_completion_tokens")
    with patch.object(filedrop_convert, "_make_client", return_value=client), \
            patch.object(filedrop_convert, "_install_thinking_filter"):
        filedrop_convert.describe("/tmp/foo.bin", env)
    assert calls[0].get("max_completion_tokens") == 2048
    assert "max_tokens" not in calls[0]


def test_describe_omits_token_limit_when_none():
    client, calls = _recording_client()
    env = dict(BASE_ENV, FILEDROP_LLM_TOKEN_PARAM="none")
    with patch.object(filedrop_convert, "_make_client", return_value=client), \
            patch.object(filedrop_convert, "_install_thinking_filter"):
        filedrop_convert.describe("/tmp/foo.bin", env)
    assert "max_tokens" not in calls[0]
    assert "max_completion_tokens" not in calls[0]


def test_convert_pdf_pages_skipped_when_vision_disabled():
    """No-vision model → emit a warning and never touch the LLM client."""
    env = dict(BASE_ENV, FILEDROP_LLM_VISION="0")
    with patch.object(filedrop_convert, "_make_client") as make_client:
        result = filedrop_convert._convert_pdf_pages_with_llm("/tmp/scan.pdf", env)
    make_client.assert_not_called()
    assert result.startswith("> [!warning]")
    assert "vision" in result


class _FakeDoc:
    """A minimal stand-in for a PyMuPDF Document: iterable over fake pages,
    with a `page_count`. `_jpeg_bytes_under_cap` is patched separately so the
    fake pixmap returned by `get_pixmap` never needs real encoding."""

    def __init__(self, page_count):
        self.page_count = page_count
        self._pages = [types.SimpleNamespace(get_pixmap=lambda matrix=None: object()) for _ in range(page_count)]

    def __iter__(self):
        return iter(self._pages)


def _fake_fitz_module(page_count):
    doc = _FakeDoc(page_count)
    return types.SimpleNamespace(open=lambda path: doc, Matrix=lambda *a: None)


def test_convert_pdf_pages_with_llm_emits_progress_above_threshold(capsys):
    client, _ = _recording_client()
    fake_fitz = _fake_fitz_module(5)
    with patch.dict(sys.modules, {"fitz": fake_fitz}), \
            patch.object(filedrop_convert, "_make_client", return_value=client), \
            patch.object(filedrop_convert, "_install_thinking_filter"), \
            patch.object(filedrop_convert, "_jpeg_bytes_under_cap", return_value=b"x"):
        filedrop_convert._convert_pdf_pages_with_llm("/tmp/scan.pdf", dict(BASE_ENV))
    err = capsys.readouterr().err
    progress_lines = [l for l in err.splitlines() if l.startswith("[filedrop:page-progress]")]
    assert len(progress_lines) == 5
    assert progress_lines[-1] == "[filedrop:page-progress] 5/5"


def test_convert_pdf_pages_with_llm_no_progress_below_threshold(capsys):
    client, _ = _recording_client()
    fake_fitz = _fake_fitz_module(3)
    with patch.dict(sys.modules, {"fitz": fake_fitz}), \
            patch.object(filedrop_convert, "_make_client", return_value=client), \
            patch.object(filedrop_convert, "_install_thinking_filter"), \
            patch.object(filedrop_convert, "_jpeg_bytes_under_cap", return_value=b"x"):
        filedrop_convert._convert_pdf_pages_with_llm("/tmp/scan.pdf", dict(BASE_ENV))
    err = capsys.readouterr().err
    assert "[filedrop:page-progress]" not in err


def test_pptx_slide_count_uses_python_pptx():
    pptx_stub = types.SimpleNamespace(
        Presentation=lambda path: types.SimpleNamespace(slides=[object()] * 4)
    )
    with patch.dict(sys.modules, {"pptx": pptx_stub}):
        assert filedrop_convert._pptx_slide_count("/tmp/deck.pptx") == 4


def test_pptx_slide_count_returns_none_on_failure():
    with patch.dict(sys.modules, {"pptx": None}):
        assert filedrop_convert._pptx_slide_count("/tmp/deck.pptx") is None


def test_build_converter_installs_progress_counter_above_threshold():
    client, calls = _recording_client()
    with patch.object(filedrop_convert, "_make_client", return_value=client), \
            patch.object(filedrop_convert, "_install_thinking_filter"), \
            patch.object(filedrop_convert, "MarkItDown"):
        filedrop_convert.build_converter(dict(BASE_ENV), progress_total=4)
        client.chat.completions.create(model="x")
    # The wrapped create() still forwards to the original and records the call.
    assert len(calls) == 1


def test_build_converter_skips_progress_counter_below_threshold(capsys):
    client, _ = _recording_client()
    with patch.object(filedrop_convert, "_make_client", return_value=client), \
            patch.object(filedrop_convert, "_install_thinking_filter"), \
            patch.object(filedrop_convert, "MarkItDown"):
        filedrop_convert.build_converter(dict(BASE_ENV), progress_total=2)
        client.chat.completions.create(model="x")
    err = capsys.readouterr().err
    assert "[filedrop:page-progress]" not in err


@pytest.mark.parametrize(
    "env, expected",
    [
        ({}, (filedrop_convert._DEFAULT_IMAGE_MAX_BYTES,
              filedrop_convert._DEFAULT_IMAGE_JPEG_QUALITY,
              filedrop_convert._DEFAULT_IMAGE_MIN_DIM)),
        ({"FILEDROP_IMAGE_MAX_BYTES": "1000",
          "FILEDROP_IMAGE_JPEG_QUALITY": "60",
          "FILEDROP_IMAGE_MIN_DIM": "256"}, (1000, 60, 256)),
        # Bad values fall back to the defaults rather than crashing.
        ({"FILEDROP_IMAGE_MAX_BYTES": "nope"},
         (filedrop_convert._DEFAULT_IMAGE_MAX_BYTES,
          filedrop_convert._DEFAULT_IMAGE_JPEG_QUALITY,
          filedrop_convert._DEFAULT_IMAGE_MIN_DIM)),
    ],
)
def test_image_limits(env, expected):
    assert filedrop_convert._image_limits(dict(BASE_ENV, **env)) == expected


def _solid_pixmap(fitz, w, h, value=200):
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, w, h), False)
    pix.clear_with(value)
    return pix


def _noise_pixmap(fitz, w, h):
    """A random-pixel pixmap that barely compresses, so JPEG stays large."""
    import os
    return fitz.Pixmap(fitz.csRGB, w, h, os.urandom(w * h * 3), False)


def test_jpeg_under_cap_keeps_full_resolution_when_compression_suffices():
    fitz = pytest.importorskip("fitz")
    pix = _solid_pixmap(fitz, 3000, 2000)
    data = filedrop_convert._jpeg_bytes_under_cap(pix, 85, 4 * 1024 * 1024, 512)
    decoded = fitz.Pixmap(data)
    assert (decoded.width, decoded.height) == (3000, 2000)  # dims unchanged
    assert len(data) <= 4 * 1024 * 1024


def test_jpeg_under_cap_downsizes_as_fallback_not_below_min_dim():
    fitz = pytest.importorskip("fitz")
    pix = _noise_pixmap(fitz, 1500, 1500)
    data = filedrop_convert._jpeg_bytes_under_cap(pix, 85, max_bytes=5000, min_dim=512)
    decoded = fitz.Pixmap(data)
    # Compression alone can't reach 5KB, so it shrinks — but stops at min_dim.
    assert max(decoded.width, decoded.height) == 512
    assert max(decoded.width, decoded.height) < 1500


def test_jpeg_under_cap_handles_alpha_and_cmyk():
    fitz = pytest.importorskip("fitz")
    rgba = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 64, 64), True)  # has alpha
    rgba.clear_with(120)
    cmyk = fitz.Pixmap(fitz.csCMYK, fitz.IRect(0, 0, 64, 64), False)
    cmyk.clear_with(50)
    for pix in (rgba, cmyk):
        data = filedrop_convert._jpeg_bytes_under_cap(pix, 85, 4 * 1024 * 1024, 512)
        assert fitz.Pixmap(data).width == 64  # decodable JPEG


def test_compressed_image_path_passthrough_for_small_file(tmp_path):
    fitz = pytest.importorskip("fitz")
    small = tmp_path / "small.jpg"
    small.write_bytes(_solid_pixmap(fitz, 100, 100).tobytes("jpg", jpg_quality=85))
    assert filedrop_convert._compressed_image_path(str(small), dict(BASE_ENV)) is None


def test_compressed_image_path_recompresses_large_file(tmp_path):
    fitz = pytest.importorskip("fitz")
    big = tmp_path / "big.jpg"
    big.write_bytes(_noise_pixmap(fitz, 400, 400).tobytes("jpg", jpg_quality=95))
    env = dict(BASE_ENV, FILEDROP_IMAGE_MAX_BYTES="500")
    out = filedrop_convert._compressed_image_path(str(big), env)
    try:
        assert out is not None and out != str(big)
        assert fitz.Pixmap(out).width  # produced a decodable JPEG
    finally:
        if out:
            os.remove(out)


def test_compressed_image_path_returns_none_on_failure():
    # Missing file → os.path.getsize raises → caller falls back to the original.
    assert filedrop_convert._compressed_image_path("/tmp/does-not-exist.jpg", dict(BASE_ENV)) is None


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


def _import_real_markitdown():
    """Load the *installed* markitdown package, bypassing the conftest MagicMock
    stub. Returns the real MarkItDown class, or None if it isn't installed."""
    import importlib

    stub = sys.modules.get("markitdown")
    sys.modules.pop("markitdown", None)
    try:
        module = importlib.import_module("markitdown")
        return module.MarkItDown
    except Exception:
        return None
    finally:
        # Restore the lightweight stub so the rest of the suite is unaffected.
        if stub is not None:
            sys.modules["markitdown"] = stub


def test_html_conversion_is_fast(tmp_path):
    """A tiny HTML file converts end-to-end (real markitdown, no LLM) in well
    under a second. Guards the no-gateway fast path and proves the lazy openai
    import keeps trivial conversions quick. Skips when markitdown isn't installed
    (e.g. the stubbed CI environment)."""
    import time

    real_markitdown = _import_real_markitdown()
    if real_markitdown is None:
        pytest.skip("real markitdown package not installed")

    html = tmp_path / "test.html"
    html.write_text("<html><body><h1>Drag and Drop</h1><p>A tiny HTML file.</p></body></html>")

    # Empty env → no gateway → convert() takes the plain-markitdown path and never
    # imports the OpenAI SDK.
    with patch.object(filedrop_convert, "MarkItDown", real_markitdown):
        start = time.perf_counter()
        result = filedrop_convert.convert(str(html), {})
        elapsed = time.perf_counter() - start

    assert "Drag and Drop" in result
    assert "A tiny HTML file." in result
    assert elapsed < 1.0, f"HTML conversion took {elapsed:.3f}s (expected < 1s)"
