"""Tests for the structure-aware PPTX extraction (filedrop_convert --pptx mode).

python-pptx is a heavy dependency that isn't installed in CI, so these tests
feed in lightweight fakes that mimic the slice of the python-pptx API the
extractor touches (shape geometry, text frames, tables, pictures, groups)."""

import os
import sys
import types
from unittest.mock import patch

import pytest

import filedrop_convert


# --- python-pptx fakes ------------------------------------------------------

class _FakeRun:
    def __init__(self, text):
        self.text = text


class _FakePara:
    def __init__(self, text="", level=0, runs=None):
        self.text = text
        self.level = level
        self.runs = runs or []


class _FakeTextFrame:
    def __init__(self, paragraphs):
        self.paragraphs = paragraphs


class _FakeRow:
    def __init__(self, cells):
        self.cells = [types.SimpleNamespace(text=c) for c in cells]


class _FakeTable:
    def __init__(self, rows):
        self.rows = [_FakeRow(r) for r in rows]


class _FakeImage:
    def __init__(self, blob, content_type="image/png"):
        self.blob = blob
        self.content_type = content_type


def _fake_element(descr=""):
    cnvpr = types.SimpleNamespace(get=lambda key: descr if key == "descr" else None)
    return types.SimpleNamespace(_nvXxPr=types.SimpleNamespace(cNvPr=cnvpr))


class _FakeSeries:
    def __init__(self, name, values):
        self.name = name
        self.values = values


class _FakeChart:
    def __init__(self, title, categories, series):
        self.has_title = title is not None
        self.chart_title = types.SimpleNamespace(
            text_frame=types.SimpleNamespace(text=title or "")
        )
        self.plots = [types.SimpleNamespace(categories=categories)]
        self.series = [_FakeSeries(n, v) for n, v in series]


class _FakeShape:
    def __init__(self, name="", left=0, top=0, width=0, height=0,
                 shape_type=1, text_frame=None, table=None, image=None,
                 descr="", shapes=None, chart=None):
        self.name = name
        self.left = left
        self.top = top
        self.width = width
        self.height = height
        self.shape_type = shape_type
        self._text_frame = text_frame
        self._table = table
        self._image = image
        self._chart = chart
        self._element = _fake_element(descr)
        self.shapes = shapes  # set (to a list) only for group shapes

    @property
    def has_text_frame(self):
        return self._text_frame is not None

    @property
    def text_frame(self):
        return self._text_frame

    @property
    def has_table(self):
        return self._table is not None

    @property
    def table(self):
        return self._table

    @property
    def has_chart(self):
        return self._chart is not None

    @property
    def chart(self):
        return self._chart

    @property
    def image(self):
        if self._image is None:
            raise ValueError("shape has no image")
        return self._image


class _FakeNotesSlide:
    def __init__(self, text):
        self.notes_text_frame = types.SimpleNamespace(text=text)


class _FakeSlide:
    def __init__(self, shapes, notes=None):
        self.shapes = shapes
        self.has_notes_slide = notes is not None
        self.notes_slide = _FakeNotesSlide(notes) if notes is not None else None


def _install_fake_pptx(slides):
    module = types.ModuleType("pptx")
    module.Presentation = lambda path: types.SimpleNamespace(slides=slides)
    return patch.dict(sys.modules, {"pptx": module})


PPTX_ENV = {"FILEDROP_LLM_KEY": "sk-test", "FILEDROP_LLM_MODEL": "gpt-4o-mini"}


# --- small units ------------------------------------------------------------

def test_picture_filename_matches_markitdown_naming():
    # markitdown names pptx pictures re.sub(r"\W", "", shape.name) + ".jpg".
    shape = _FakeShape(name="Picture 19")
    assert filedrop_convert._picture_filename(shape) == "Picture19.jpg"


def test_table_markdown_renders_grid():
    md = filedrop_convert._table_markdown(_FakeTable([["A", "B"], ["1", "2"]]))
    assert md == "| A | B |\n| --- | --- |\n| 1 | 2 |"


# --- element extraction -----------------------------------------------------

def test_extract_slide_elements_classifies_and_writes_pictures(tmp_path):
    pic = _FakeShape(name="Picture 19", left=10, top=20, width=30, height=40,
                     image=_FakeImage(b"IMG-BYTES"))
    txt = _FakeShape(name="Body", left=1, top=2, width=3, height=4,
                     text_frame=_FakeTextFrame([
                         _FakePara(runs=[_FakeRun("Hello "), _FakeRun("world")]),
                         _FakePara(text="Bullet", level=1),
                     ]))
    tbl = _FakeShape(name="Grid", table=_FakeTable([["H1", "H2"], ["a", "b"]]))
    slide = _FakeSlide([pic, txt, tbl])

    elements, pending = filedrop_convert._extract_slide_elements(slide, str(tmp_path), 1, set())

    kinds = [e["type"] for e in elements]
    assert kinds == ["picture", "text", "table"]

    picture = elements[0]
    # Name is prefixed with the slide index so it stays unique across the deck.
    assert picture["filename"] == "slide1-Picture19.jpg"
    assert picture["geom"] == {"left": 10, "top": 20, "width": 30, "height": 40}
    written = tmp_path / "slide1-Picture19.jpg"
    assert written.read_bytes() == b"IMG-BYTES"
    # No author alt text => queued for an LLM description.
    assert pending == [(picture, pic._image, [])]

    text = elements[1]
    assert text["paragraphs"] == [
        {"text": "Hello world", "level": 0},
        {"text": "Bullet", "level": 1},
    ]

    assert elements[2]["markdown"].startswith("| H1 | H2 |")


def test_extract_slide_elements_recurses_groups(tmp_path):
    inner = _FakeShape(name="Inner", text_frame=_FakeTextFrame([_FakePara(text="deep")]))
    group = _FakeShape(name="Group", shape_type=6, shapes=[inner])
    elements, _ = filedrop_convert._extract_slide_elements(_FakeSlide([group]), str(tmp_path), 1, set())
    assert [e["type"] for e in elements] == ["text"]
    assert elements[0]["paragraphs"] == [{"text": "deep", "level": 0}]


def test_grouped_shapes_inherit_group_geometry(tmp_path):
    # A grouped child's own left/top are in the group's child coordinate space,
    # so we attribute the group's slide-space geometry to it instead.
    inner = _FakeShape(name="Pic", left=1, top=1, width=1, height=1, image=_FakeImage(b"x"))
    group = _FakeShape(name="Group", left=500, top=600, width=700, height=800,
                       shape_type=6, shapes=[inner])
    elements, _ = filedrop_convert._extract_slide_elements(_FakeSlide([group]), str(tmp_path), 1, set())
    assert elements[0]["geom"] == {"left": 500, "top": 600, "width": 700, "height": 800}


def test_extract_slide_elements_captures_chart(tmp_path):
    chart = _FakeChart("Revenue", ["Q1", "Q2"], [("2024", [10, 20]), ("2025", [15.0, 25.0])])
    shape = _FakeShape(name="Chart 1", chart=chart)
    elements, _ = filedrop_convert._extract_slide_elements(_FakeSlide([shape]), str(tmp_path), 1, set())
    assert elements[0]["type"] == "chart"
    assert elements[0]["title"] == "Revenue"
    md = elements[0]["markdown"]
    assert "| Category | 2024 | 2025 |" in md
    assert "| Q1 | 10 | 15 |" in md   # floats that are whole numbers render as ints
    assert "| Q2 | 20 | 25 |" in md


def test_extract_slide_elements_keeps_author_alt_text(tmp_path):
    pic = _FakeShape(name="Logo", image=_FakeImage(b"x"), descr="Company logo")
    elements, pending = filedrop_convert._extract_slide_elements(_FakeSlide([pic]), str(tmp_path), 1, set())
    assert elements[0]["description"] == "Company logo"
    assert pending == []  # author alt text => no LLM call needed


# --- full structured conversion --------------------------------------------

def test_cross_slide_picture_names_stay_unique(tmp_path):
    # Two slides reuse the same shape name ("Picture 3"); names must not collide
    # (otherwise one image overwrites the other on disk).
    slide1 = _FakeSlide([_FakeShape(name="Picture 3", image=_FakeImage(b"one"))])
    slide2 = _FakeSlide([_FakeShape(name="Picture 3", image=_FakeImage(b"two"))])
    with _install_fake_pptx([slide1, slide2]):
        result = filedrop_convert.convert_pptx_structured(str(tmp_path / "deck.pptx"), {})

    names = [p["filename"] for p in result["pictures"]]
    assert names == ["slide1-Picture3.jpg", "slide2-Picture3.jpg"]
    assert len(set(names)) == 2
    # Both blobs survive — no overwrite.
    contents = {os.path.basename(p["path"]): open(p["path"], "rb").read() for p in result["pictures"]}
    assert contents["slide1-Picture3.jpg"] == b"one"
    assert contents["slide2-Picture3.jpg"] == b"two"


def test_convert_pptx_structured_captures_notes(tmp_path):
    slide = _FakeSlide(
        [_FakeShape(name="Body", text_frame=_FakeTextFrame([_FakePara(text="Hi")]))],
        notes="Remember to mention the roadmap.",
    )
    with _install_fake_pptx([slide]):
        result = filedrop_convert.convert_pptx_structured(str(tmp_path / "deck.pptx"), {})
    assert result["slides"][0]["notes"] == "Remember to mention the roadmap."


def test_convert_pptx_structured_omits_empty_notes(tmp_path):
    slide = _FakeSlide([_FakeShape(name="Body", text_frame=_FakeTextFrame([_FakePara(text="Hi")]))])
    with _install_fake_pptx([slide]):
        result = filedrop_convert.convert_pptx_structured(str(tmp_path / "deck.pptx"), {})
    assert "notes" not in result["slides"][0]


def test_convert_pptx_structured_without_llm(tmp_path):
    pic = _FakeShape(name="Picture 1", image=_FakeImage(b"bytes"))
    slide = _FakeSlide([pic])
    env = {}  # no gateway => extraction only, no descriptions
    with _install_fake_pptx([slide]):
        result = filedrop_convert.convert_pptx_structured(str(tmp_path / "deck.pptx"), env)

    assert result is not None
    assert len(result["slides"]) == 1
    assert len(result["pictures"]) == 1
    pic_entry = result["pictures"][0]
    assert pic_entry["filename"] == "slide1-Picture1.jpg"
    assert os.path.isfile(pic_entry["path"])


def test_convert_pptx_structured_describes_images_when_vision_enabled(tmp_path):
    pic = _FakeShape(name="Cube", image=_FakeImage(b"bytes"))
    slide = _FakeSlide([pic])

    completions = types.SimpleNamespace(create=lambda **kw: types.SimpleNamespace(
        choices=[types.SimpleNamespace(message=types.SimpleNamespace(content="a rotating cube"))]
    ))
    fake_client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=completions))

    with _install_fake_pptx([slide]), \
            patch.object(filedrop_convert, "_make_client", return_value=fake_client):
        result = filedrop_convert.convert_pptx_structured(str(tmp_path / "deck.pptx"), dict(PPTX_ENV))

    picture = result["slides"][0]["elements"][0]
    assert picture["description"] == "a rotating cube"


def test_convert_pptx_structured_skips_descriptions_without_vision(tmp_path):
    pic = _FakeShape(name="Cube", image=_FakeImage(b"bytes"))
    slide = _FakeSlide([pic])
    env = dict(PPTX_ENV, FILEDROP_LLM_VISION="0")
    with _install_fake_pptx([slide]), \
            patch.object(filedrop_convert, "_make_client") as make_client:
        result = filedrop_convert.convert_pptx_structured(str(tmp_path / "deck.pptx"), env)
    make_client.assert_not_called()
    assert result["slides"][0]["elements"][0]["description"] == ""


def test_convert_pptx_structured_returns_none_without_python_pptx(tmp_path):
    # An empty module has no Presentation attr => `from pptx import Presentation`
    # raises ImportError, and the extractor signals fallback to markitdown.
    with patch.dict(sys.modules, {"pptx": types.ModuleType("pptx")}):
        result = filedrop_convert.convert_pptx_structured(str(tmp_path / "deck.pptx"), {})
    assert result is None
