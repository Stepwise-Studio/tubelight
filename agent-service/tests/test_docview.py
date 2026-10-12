import io

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt, RGBColor

from app import docview


def test_word_documents_keep_their_formatting():
    d = Document()
    d.add_heading("Report", 1)
    p = d.add_paragraph("plain ")
    r = p.add_run("bold red")
    r.bold, r.font.color.rgb, r.font.size = True, RGBColor(0xC0, 0, 0), Pt(16)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    d.add_paragraph("first", style="List Number")
    d.add_paragraph("second", style="List Number")
    d.add_paragraph("dot", style="List Bullet")
    t = d.add_table(rows=2, cols=3)
    t.cell(0, 0).merge(t.cell(0, 1)).text = "wide"
    t.cell(1, 2).text = "corner"
    buf = io.BytesIO()
    d.save(buf)

    out = docview.read(buf.getvalue())
    heading, para, one, two, dot, table = out["blocks"][:6]
    assert heading["h"] == 1 and heading["runs"][0]["t"] == "Report" and heading["runs"][0].get("b")
    assert para["align"] == "center" and para["runs"][1] == {**para["runs"][1], "t": "bold red", "b": True, "color": "C00000", "size": 16.0}
    assert (one["marker"], two["marker"], dot["marker"]) == ("1.", "2.", "•")
    assert table["k"] == "table" and len(table["widths"]) == 3
    first = table["rows"][0]["cells"][0]
    assert first["span"] == 2 and first["blocks"][0]["runs"][0]["t"] == "wide"
    assert table["rows"][1]["cells"][2]["blocks"][0]["runs"][0]["t"] == "corner"
