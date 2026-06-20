"""Convert a file to markdown via markitdown's LLM image-description path.

Runs against an OpenAI-compatible gateway. Configuration is read from the
environment; the file path is the first positional argument. The plugin invokes
this as `python -c <inlined source> <path>`, so argv[1] is the file path.
"""

import os
import re
import sys

from markitdown import MarkItDown

# Imported lazily in _make_client so the no-LLM conversion path (plain markitdown
# text extraction) doesn't pay the OpenAI SDK import cost. Tests patch this symbol,
# so it must exist at module scope; the lazy import only fills it when actually
# needed and the attribute is still absent.
OpenAI = None

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
            after = cleaned[idx + len(closer):]
            if after.strip():
                cleaned = after        # closer in middle → keep what's after
            else:
                cleaned = cleaned[:idx]  # closer at end → strip it, keep what's before
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


_DEFAULT_LLM_TIMEOUT_S = 150.0
_DEFAULT_CONNECT_TIMEOUT_S = 15.0


def _llm_timeout(env):
    """Build an httpx.Timeout from FILEDROP_LLM_TIMEOUT (seconds).

    The OpenAI SDK accepts a flat number, but that applies to *every* phase
    (connect/read/write/pool) at once — a connection that establishes but never
    delivers bytes waits the full budget on the read. Splitting connect out
    means a wedged gateway fails fast instead of hanging for minutes. Falls
    back to a flat float if httpx is unavailable (which only happens in tests
    that stub the openai package).
    """
    raw = env.get("FILEDROP_LLM_TIMEOUT")
    try:
        total = float(raw) if raw else _DEFAULT_LLM_TIMEOUT_S
    except (TypeError, ValueError):
        total = _DEFAULT_LLM_TIMEOUT_S
    try:
        import httpx
    except ImportError:
        return total
    return httpx.Timeout(total, connect=_DEFAULT_CONNECT_TIMEOUT_S)


def _make_client(env, **kwargs):
    # x-api-key is sent alongside the SDK's automatic Authorization: Bearer header
    # because the Siemens gateway requires it; other providers ignore it.
    # max_retries=0 because the SDK's default 2 retries silently triple the
    # wait when a gateway hangs — the user is better served by a fast clean
    # error and the existing TS-side error handling.
    global OpenAI
    if OpenAI is None:
        from openai import OpenAI as _OpenAI
        OpenAI = _OpenAI
    key = env["FILEDROP_LLM_KEY"]
    kwargs.setdefault("timeout", _llm_timeout(env))
    kwargs.setdefault("max_retries", 0)
    return OpenAI(
        api_key=key,
        base_url=env.get("FILEDROP_LLM_URL") or None,
        default_headers={"x-api-key": key, "X-Api-Key": key},
        **kwargs,
    )


def _token_kwargs(env, limit):
    """Build the token-limit kwarg for chat.completions.create, honoring the
    capability detected on the TS side (FILEDROP_LLM_TOKEN_PARAM). 'none' omits
    the limit entirely so models that reject both max_tokens and
    max_completion_tokens still work."""
    param = (env.get("FILEDROP_LLM_TOKEN_PARAM") or "max_tokens").strip()
    if param == "none":
        return {}
    if param not in ("max_tokens", "max_completion_tokens"):
        param = "max_tokens"
    return {param: limit}


def _vision_enabled(env):
    """Whether the configured model accepts image input. Defaults to True when
    unset; the TS settings 'Check' sets FILEDROP_LLM_VISION=0 for text-only models."""
    return (env.get("FILEDROP_LLM_VISION") or "1").strip().lower() not in ("0", "false", "no", "off")


def _temperature_kwargs(env):
    """Return {"temperature": 0} when the model supports it, or {} to omit it.
    FILEDROP_LLM_TEMPERATURE=0 means not supported (e.g. reasoning models)."""
    supported = (env.get("FILEDROP_LLM_TEMPERATURE") or "1").strip().lower() not in ("0", "false", "no", "off")
    return {"temperature": 0} if supported else {}


# Images are sent to the gateway as a base64 data URI. Raw high-resolution
# photos can exceed the gateway's request-size limit and come back as HTTP 413
# ("Request Entity Too Large"). We re-encode large images as a compressed JPEG
# to shrink the payload while keeping full resolution; only if compression alone
# is not enough do we fall back to reducing the dimensions.
_DEFAULT_IMAGE_MAX_BYTES = 4 * 1024 * 1024   # re-encode trigger + payload cap
_DEFAULT_IMAGE_JPEG_QUALITY = 85
_DEFAULT_IMAGE_MIN_DIM = 512                  # don't shrink the longest side below this


def _image_limits(env):
    """Read the image-payload limits, honoring optional env overrides."""
    def _int(name, default):
        try:
            return int(env.get(name) or default)
        except (TypeError, ValueError):
            return default
    return (
        _int("FILEDROP_IMAGE_MAX_BYTES", _DEFAULT_IMAGE_MAX_BYTES),
        _int("FILEDROP_IMAGE_JPEG_QUALITY", _DEFAULT_IMAGE_JPEG_QUALITY),
        _int("FILEDROP_IMAGE_MIN_DIM", _DEFAULT_IMAGE_MIN_DIM),
    )


def _normalize_for_jpeg(pix):
    """Return a pixmap that JPEG can encode: JPEG has no alpha channel and only
    supports gray/RGB, so drop alpha and convert CMYK / other colorspaces to RGB."""
    import fitz  # pymupdf  # type: ignore

    if pix.alpha:
        pix = fitz.Pixmap(pix, 0)  # drop alpha
    if pix.colorspace is None or pix.colorspace.n > 3:  # e.g. CMYK -> RGB
        pix = fitz.Pixmap(fitz.csRGB, pix)
    return pix


def _jpeg_bytes_under_cap(pix, quality, max_bytes, min_dim):
    """Encode a pixmap to compressed JPEG, keeping full resolution when possible.
    If the JPEG is still larger than max_bytes, progressively shrink the
    dimensions (~0.8x per step, never below min_dim on the longest side) and
    re-encode until it fits."""
    import fitz  # pymupdf  # type: ignore

    pix = _normalize_for_jpeg(pix)
    data = pix.tobytes("jpg", jpg_quality=quality)
    while len(data) > max_bytes and max(pix.width, pix.height) > min_dim:
        tw, th = int(pix.width * 0.8), int(pix.height * 0.8)
        # Clamp so the longest side never drops below min_dim.
        longest = max(tw, th)
        if longest < min_dim:
            f = min_dim / max(pix.width, pix.height)
            tw, th = int(pix.width * f), int(pix.height * f)
        pix = fitz.Pixmap(pix, max(1, tw), max(1, th), None)
        data = pix.tobytes("jpg", jpg_quality=quality)
    return data


def _compressed_image_path(path, env):
    """If `path` is a large image, write a compressed-JPEG copy to a temp file and
    return its path so the oversized raw bytes never reach the gateway (avoids
    HTTP 413). Returns None when the image is already small enough, or on any
    failure, so the caller falls back to the original file untouched."""
    max_bytes, quality, min_dim = _image_limits(env)
    try:
        if os.path.getsize(path) <= max_bytes:
            return None
        import fitz  # pymupdf  # type: ignore
        import tempfile

        data = _jpeg_bytes_under_cap(fitz.Pixmap(path), quality, max_bytes, min_dim)
        fd, tmp = tempfile.mkstemp(suffix=".jpg")
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        return tmp
    except Exception as exc:
        print(f"[filedrop] image compression skipped: {type(exc).__name__}: {exc}", file=sys.stderr)
        return None


def build_converter(env):
    client = _make_client(env)
    _install_thinking_filter(client)
    kwargs = {"llm_client": client, "llm_model": env["FILEDROP_LLM_MODEL"]}
    prompt = env.get("FILEDROP_LLM_PROMPT")
    if prompt:
        kwargs["llm_prompt"] = prompt
    return MarkItDown(**kwargs)


def _emit_phase(phase):
    print(f"[filedrop:phase] {phase}", file=sys.stderr, flush=True)


def _llm_configured(env):
    """Whether an LLM gateway is configured. The TS side only runs this script
    with these env vars set (or for the describe path), but guarding here lets
    convert() still extract a file's text via plain markitdown when they are
    absent — and skips importing the OpenAI SDK entirely on that fast path."""
    return bool(env.get("FILEDROP_LLM_KEY") and env.get("FILEDROP_LLM_MODEL"))


def convert(path, env):
    # markitdown hands the path to puremagic, which raises an uncaught
    # PureError("Not a regular file") for anything that isn't a regular file
    # (e.g. a directory), aborting the whole conversion with a cryptic message.
    # Guard up front so the failure is legible instead.
    if not os.path.isfile(path):
        kind = "a directory" if os.path.isdir(path) else "missing"
        print(f"[filedrop] input path is {kind}, not a regular file: {path}", file=sys.stderr)
        return ""

    is_pdf = path.lower().endswith(".pdf")

    # No gateway configured: plain markitdown text extraction. Keeps trivial
    # conversions fast (the OpenAI SDK is never imported) and lets convert() work
    # without an LLM at all.
    if not _llm_configured(env):
        _emit_phase("markitdown")
        return _convert_without_llm(path)

    # Try markitdown with LLM support first. build_converter passes llm_client
    # and llm_model to MarkItDown, so embedded images inside the PDF are
    # described by the LLM. Works well for text-layer PDFs. Scanned PDFs often
    # return empty here because pdfminer finds no text layer and there are no
    # discrete embedded images — we catch that and fall through.
    # Pure-image files go straight into the LLM via markitdown's image path,
    # so signal that phase up front instead of "markitdown".
    image_exts = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif")
    is_image = path.lower().endswith(image_exts)
    _emit_phase("llm-image" if is_image else "markitdown")

    # For large images, hand markitdown a compressed-JPEG copy so the oversized
    # raw bytes never reach the gateway (avoids HTTP 413). Small images and other
    # file types use the original path untouched.
    convert_path = path
    temp_image = _compressed_image_path(path, env) if is_image else None
    if temp_image:
        convert_path = temp_image
    try:
        result = build_converter(env).convert(convert_path).text_content
        if result and result.strip():
            return result
    except Exception as exc:
        url = env.get("FILEDROP_LLM_URL", "(not set)")
        model = env.get("FILEDROP_LLM_MODEL", "(not set)")
        print(f"[filedrop] markitdown LLM step failed [{model} @ {url}]: {type(exc).__name__}: {exc}", file=sys.stderr)
        if not is_pdf:
            # The LLM-enhanced step failed for a non-PDF (e.g. a PPTX markitdown
            # could not fully process). Keep the plain markitdown conversion so
            # the file's extractable text is still captured.
            return _convert_without_llm(convert_path)
    finally:
        if temp_image:
            try:
                os.remove(temp_image)
            except OSError:
                pass

    # For PDFs that produced nothing (scanned / image-only), render each page
    # via PyMuPDF and OCR with the LLM.
    if is_pdf:
        _emit_phase("llm-image")
        result = _convert_pdf_pages_with_llm(path, env)
        if result:
            return result

    return ""


def _convert_without_llm(path):
    """Re-run markitdown with no LLM client so a file's extractable text is still
    captured when the LLM-enhanced step fails. Returns the plain text, or "" if
    even this fails — never raises, so a failure here can't crash the process and
    dump the whole invocation into the note."""
    try:
        result = MarkItDown().convert(path).text_content
        if result and result.strip():
            return result
    except Exception as exc:
        print(f"[filedrop] plain markitdown fallback failed: {type(exc).__name__}: {exc}", file=sys.stderr)
    return ""


def _convert_pdf_pages_with_llm(path, env):
    """Render every PDF page via PyMuPDF and OCR with the LLM.

    Returns combined markdown, or empty string if PyMuPDF is unavailable
    so the caller falls back to plain markitdown text extraction.
    """
    import base64
    from concurrent.futures import ThreadPoolExecutor

    if not _vision_enabled(env):
        return ("> [!warning] Scanned-PDF OCR skipped — the configured model has no "
                "vision (image input) support.")

    try:
        import fitz  # pymupdf  # type: ignore
    except ImportError:
        print("[filedrop] PyMuPDF not installed — cannot OCR scanned PDF pages", file=sys.stderr)
        return ""

    client = _make_client(env)
    _install_thinking_filter(client)

    prompt = (
        env.get("FILEDROP_LLM_PROMPT")
        or "Transcribe all text visible on this page exactly as it appears. "
           "For any charts, tables, or images also provide a concise description."
    )

    try:
        doc = fitz.open(path)
    except Exception:
        return ""

    if not doc.page_count:
        return ""

    # Render every page up front: PyMuPDF documents are not safe to access from
    # multiple threads, and rendering is fast/CPU-bound. The slow part is the
    # per-page LLM request, which we then run in a small thread pool. The OpenAI
    # client (httpx under the hood) is safe to share across threads.
    # Each page is a compressed JPEG instead of raw PNG: far smaller payload
    # (avoids HTTP 413 on large/high-res pages), with a dimension fallback if
    # still big.
    max_bytes, quality, min_dim = _image_limits(env)
    mat = fitz.Matrix(2, 2)  # 2× zoom for better OCR quality
    images = [
        base64.b64encode(
            _jpeg_bytes_under_cap(page.get_pixmap(matrix=mat), quality, max_bytes, min_dim)
        ).decode("ascii")
        for page in doc
    ]

    def _ocr_page(item):
        page_num, img_b64 = item
        try:
            resp = client.chat.completions.create(
                model=env["FILEDROP_LLM_MODEL"],
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}},
                    ],
                }],
                **_token_kwargs(env, 4096),
                **_temperature_kwargs(env),
            )
            text = (resp.choices[0].message.content or "").strip()
            text = strip_thinking(text)
        except Exception as exc:
            text = f"> [!error] Page {page_num} OCR failed: {exc}"
        return f"### Page {page_num}\n\n{text}"

    items = list(enumerate(images, 1))
    max_workers = min(4, len(items))
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        # pool.map preserves input order, so pages stay in page order regardless
        # of which request finishes first.
        pages = list(pool.map(_ocr_page, items))

    return "\n\n".join(pages)


DEFAULT_DESCRIBE_PROMPT = (
    "A user saved a file named '{filename}' that cannot be converted to text. "
    "Based only on its filename, briefly explain what this file most likely is "
    "(for example, an installer for a specific application, or a system/standard "
    "library). Keep it to 1-3 sentences and make clear it is an educated guess."
)


def describe(path, env):
    """Ask the LLM what a file likely is, given only its filename."""
    client = _make_client(env)
    _install_thinking_filter(client)
    filename = os.path.basename(path)
    prompt = (env.get("FILEDROP_DESCRIBE_PROMPT") or DEFAULT_DESCRIBE_PROMPT).format(filename=filename)
    response = client.chat.completions.create(
        model=env["FILEDROP_LLM_MODEL"],
        messages=[{"role": "user", "content": prompt}],
        **_token_kwargs(env, 2048),
        **_temperature_kwargs(env),
    )
    return response.choices[0].message.content or ""


def main(argv=None, env=None):
    argv = sys.argv if argv is None else argv
    env = os.environ if env is None else env
    path = argv[1]
    if env.get("FILEDROP_DESCRIBE"):
        result = describe(path, env)
    else:
        ext = os.path.splitext(path)[1].lower()
        describe_exts = {e.strip().lower() for e in env.get("FILEDROP_DESCRIBE_EXTS", "").split(",") if e.strip()}
        if ext and ext in describe_exts:
            desc = describe(path, env)
            result = (
                "> [!warning] Unsupported file format — could not convert\n"
                "> markitdown can't convert this file type. Best guess from the filename (may be inaccurate):\n"
                "\n"
                + desc
            ) if desc else ""
        else:
            result = convert(path, env)
    sys.stdout.buffer.write(result.encode("utf-8"))


if __name__ == "__main__":
    main()
