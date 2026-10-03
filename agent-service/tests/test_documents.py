import io
import json

import pytest

from app import documents

MD = """# Launch plan

Intro with **bold**, *italic*, `code` and a [link](https://stepwise.studio). Unicode: ₹1,200 — “quotes” ✓.

## Steps

1. Design the **hero**
2. Build it
   - nested point
3. Ship

- one
- two

| Task | Owner | Due |
| --- | --- | --- |
| Hero | Dev | 20 Oct |
| QA | Tess | 22 Oct |

> Keep it simple.

```python
print("hi")
```

---

Done.
"""


def test_word_and_pdf_from_markdown_read_back():
    name, data = documents.make("docx", "Launch plan", MD)
    assert name == "Launch plan.docx"
    text = documents.read_docx(data)
    assert "# Launch plan" in text and "## Steps" in text and "| Hero | Dev | 20 Oct |" in text and "₹1,200" in text
    assert "1.\tDesign the hero" in text and "Keep it simple." in text

    name, data = documents.make("pdf", "Launch plan", MD)
    from pypdf import PdfReader
    pdf = "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(data)).pages)
    assert data.startswith(b"%PDF") and "Launch plan" in pdf and "Tess" in pdf and "Design the" in pdf


def test_excel_keeps_numbers_formulas_and_text():
    spec = {"sheets": [{"name": "Budget", "columns": ["Item", "Cost", "Phone"],
                        "rows": [["Rent", "15000", "+91 98480"], ["Food", 6200.5, "007"], ["Total", "=SUM(B2:B3)", ""]],
                        "formats": {"Cost": "#,##0.00"}}]}
    name, data = documents.make("xlsx", "Budget", json.dumps(spec))
    from openpyxl import load_workbook
    ws = load_workbook(io.BytesIO(data))["Budget"]
    assert ws["B2"].value == 15000 and ws["B3"].value == 6200.5 and ws["B4"].value == "=SUM(B2:B3)"
    assert ws["C3"].value == "007" and ws.freeze_panes == "A2" and ws["B2"].number_format == "#,##0.00"
    assert "## Sheet: Budget (4 rows)" in documents.read_xlsx(data)


def test_slides_of_every_kind_read_back():
    spec = {"slides": [
        {"type": "title", "title": "Q4 review", "subtitle": "Stepwise"},
        {"type": "bullets", "title": "Wins", "bullets": ["Shipped voice", "  under budget", "Hired two"], "notes": "Say thanks"},
        {"type": "two_column", "title": "Then vs now", "left": ["slow"], "right": ["fast"], "left_title": "Then", "right_title": "Now"},
        {"type": "table", "title": "Numbers", "columns": ["Metric", "Value"], "rows": [["Users", "1,200"]]},
        {"type": "stats", "title": "Growth", "stats": [{"value": "3×", "label": "signups"}]},
        {"type": "section", "title": "Next"},
        {"type": "quote", "quote": "Less, but better.", "by": "Dieter Rams"},
    ]}
    name, data = documents.make("pptx", "Q4 review", json.dumps(spec))
    text = documents.read_pptx(data)
    assert name == "Q4 review.pptx" and text.count("## Slide") == 7
    assert "Slide 2: Wins" in text and "Notes: Say thanks" in text and "| Users | 1,200 |" in text and "Less, but better." in text


def test_bad_requests_say_what_to_fix():
    with pytest.raises(ValueError, match="pdf, docx, xlsx, pptx or md"):
        documents.make("odt", "x", "y")
    with pytest.raises(ValueError, match="must be JSON"):
        documents.make("xlsx", "x", "not json")
    assert documents.make("md", "Notes", "# Hi")[1] == b"# Hi"


def test_bullets_arrive_in_any_shape():
    assert documents._items("['a', 'b']") == ["a", "b"] and documents._items('["a"]') == ["a"]
    assert documents._items("a\nb") == ["a", "b"] and documents._items([{"text": "a", "sub": ["b"]}]) == ["a", "  b"]
