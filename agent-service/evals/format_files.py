"""Stress files for the Vault's viewers: one of each format carrying everything that format can hold, including the
awkward cases (merged cells, nested lists, unicode, empty bits, errors, very wide and very long content), so rendering
gaps show up here and not in someone's real file.

    .venv/bin/python -m evals.format_files <dir>      # writes the files there
"""
import csv
import io
import math
import struct
import sys
import zlib
from datetime import date, datetime, time
from pathlib import Path

LOREM = ("Tubelight keeps your files, notes and decisions in one place, and your teammates can read them when you ask. "
         "This paragraph is long on purpose, so wrapping, justification and line height can be checked across a whole block of text.")


def png(w: int, h: int, seed: int = 0) -> bytes:
    """A small gradient image (no Pillow needed)."""
    raw = b"".join(b"\x00" + bytes(v for x in range(w) for v in ((x * 255 // w + seed) % 256, (y * 255 // h) % 256, 180)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


# ------------------------------------------------------------------ Word
def docx(path: Path) -> None:
    from docx import Document
    from docx.enum.section import WD_ORIENT  # noqa: F401
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_COLOR_INDEX
    from docx.oxml import OxmlElement
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls, qn
    from docx.shared import Inches, Pt, RGBColor

    d = Document()
    d.sections[0].header.paragraphs[0].text = "Header text: Tubelight format test"
    d.sections[0].footer.paragraphs[0].text = "Footer text: page footer"
    d.add_heading("Format test: Word", 0)
    d.add_paragraph("Every kind of formatting a Word file commonly carries, one section each.")
    for lvl in (1, 2, 3, 4):
        d.add_heading(f"Heading level {lvl}", lvl)

    d.add_heading("Text styles", 1)
    p = d.add_paragraph()
    for text, kw in [("Bold ", {"bold": True}), ("italic ", {"italic": True}), ("bold italic ", {"bold": True, "italic": True}),
                     ("underlined ", {"underline": True}), ("struck ", {"strike": True}), ("normal.", {})]:
        r = p.add_run(text)
        for k, v in kw.items():
            if k == "strike":
                r.font.strike = v
            else:
                setattr(r, k, v)
    p = d.add_paragraph()
    for text, color in [("Red ", "C00000"), ("green ", "00B050"), ("blue ", "0070C0"), ("orange ", "ED7D31"), ("light grey (hard on white) ", "D9D9D9"), ("black.", "000000")]:
        p.add_run(text).font.color.rgb = RGBColor.from_string(color)
    p = d.add_paragraph()
    for text, hl in [("Yellow highlight ", WD_COLOR_INDEX.YELLOW), ("green highlight ", WD_COLOR_INDEX.BRIGHT_GREEN), ("turquoise highlight", WD_COLOR_INDEX.TURQUOISE)]:
        p.add_run(text).font.highlight_color = hl
    p = d.add_paragraph()
    for size in (8, 10, 12, 16, 20, 28):
        p.add_run(f"{size}pt ").font.size = Pt(size)
    p = d.add_paragraph("Water is H")
    p.add_run("2").font.subscript = True
    p.add_run("O and E = mc")
    p.add_run("2").font.superscript = True
    p.add_run(" (subscript and superscript).")
    for font in ("Times New Roman", "Georgia", "Cambria", "Calibri", "Arial", "Courier New"):
        r = d.add_paragraph().add_run(f"This line is set in {font}: The quick brown fox jumps over the lazy dog 0123456789.")
        r.font.name = font
    r = d.add_paragraph().add_run("ALL CAPS via the caps setting")
    r.font.all_caps = True

    d.add_heading("Alignment and spacing", 1)
    for align, name in [(WD_ALIGN_PARAGRAPH.LEFT, "Left"), (WD_ALIGN_PARAGRAPH.CENTER, "Centred"), (WD_ALIGN_PARAGRAPH.RIGHT, "Right"), (WD_ALIGN_PARAGRAPH.JUSTIFY, "Justified")]:
        p = d.add_paragraph(f"{name}: {LOREM}")
        p.alignment = align
    p = d.add_paragraph(f"Indented 1 inch, with a first-line indent: {LOREM}")
    p.paragraph_format.left_indent = Inches(1)
    p.paragraph_format.first_line_indent = Inches(0.4)
    p = d.add_paragraph(f"Hanging indent: {LOREM}")
    p.paragraph_format.left_indent = Inches(0.5)
    p.paragraph_format.first_line_indent = Inches(-0.5)
    p = d.add_paragraph("Double line spacing. " + LOREM)
    p.paragraph_format.line_spacing = 2
    d.add_paragraph("")  # an empty paragraph
    d.add_paragraph("Quote style: the best interface is the one you don't notice.", style="Quote")
    d.add_paragraph("Intense quote style.", style="Intense Quote")

    d.add_heading("Lists", 1)
    for i in range(3):
        d.add_paragraph(f"Bullet item {i + 1}", style="List Bullet")
        if i == 1:
            d.add_paragraph("Nested bullet (level 2)", style="List Bullet 2")
            d.add_paragraph("Nested again (level 3)", style="List Bullet 3")
    for i in range(4):
        d.add_paragraph(f"Numbered step {i + 1}", style="List Number")
        if i == 1:
            d.add_paragraph("Sub-step a", style="List Number 2")
            d.add_paragraph("Sub-step b", style="List Number 2")
    d.add_paragraph("A paragraph between lists.")
    d.add_paragraph("A second numbered list starts again", style="List Number")

    d.add_heading("Links", 1)
    p = d.add_paragraph("Visit ")
    rid = d.part.relate_to("https://ui.stepwise.studio", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), rid)
    run = OxmlElement("w:r")
    t = OxmlElement("w:t")
    t.text = "Stepwise UI"
    run.append(t)
    link.append(run)
    p._p.append(link)
    p.add_run(" (a tappable link).")

    d.add_heading("Images", 1)
    img = io.BytesIO(png(320, 160))
    d.add_picture(img, width=Inches(3))
    d.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    d.add_paragraph("A centred image above (3 inches wide).")

    d.add_heading("Tables", 1)
    t = d.add_table(rows=1, cols=4)
    t.style = "Table Grid"
    for c, h in zip(t.rows[0].cells, ["Name", "Role", "Started", "Score"]):
        c.text = h
    for row in [("Akhil", "Founder", "Jan 2025", "98"), ("Sol", "Engineer", "Mar 2025", "91"), ("Tess", "Designer", "Jun 2025", "87")]:
        for c, v in zip(t.add_row().cells, row):
            c.text = v
    d.add_paragraph("A simple table with a header row.")

    t = d.add_table(rows=4, cols=4)
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.cell(0, 0).merge(t.cell(0, 3)).text = "Merged across all four columns"
    t.cell(1, 0).merge(t.cell(3, 0)).text = "Merged down three rows"
    for r in range(1, 4):
        for c in range(1, 4):
            t.cell(r, c).text = f"r{r}c{c}"
    shade = OxmlElement("w:shd")
    shade.set(qn("w:fill"), "FFF2CC")
    t.cell(2, 2)._tc.get_or_add_tcPr().append(shade)
    cell = t.cell(3, 3)
    cell.text = "Two paragraphs"
    cell.add_paragraph("in one cell, the second ").add_run("bold").bold = True
    d.add_paragraph("Merged cells, a shaded cell, two paragraphs in a cell.")

    wide = d.add_table(rows=1, cols=9)
    wide.style = "Table Grid"
    for i, c in enumerate(wide.rows[0].cells):
        c.text = f"Column {i + 1}"
    for r in range(4):
        for i, c in enumerate(wide.add_row().cells):
            c.text = f"A longer value in row {r + 1}" if i == 1 else str((r + 1) * (i + 1))
    d.add_paragraph("A nine-column table, wider than a phone.")

    d.add_heading("Notes and boxes", 1)
    para = d.add_paragraph("A sentence with a footnote")
    para._p.append(parse_xml(f'<w:r {nsdecls("w")}><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>'))
    para.add_run(" and another one")
    para._p.append(parse_xml(f'<w:r {nsdecls("w")}><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="2"/></w:r>'))
    para.add_run(", both listed at the end.")
    box = d.add_paragraph("A text box is anchored to this paragraph:")
    box._p.append(parse_xml(f'<w:r {nsdecls("w")} xmlns:v="urn:schemas-microsoft-com:vml"><w:pict><v:shape style="width:200pt;height:60pt">'
                            '<v:textbox><w:txbxContent><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Text in a box</w:t></w:r></w:p>'
                            '<w:p><w:r><w:t>Its second line.</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r>'))

    d.add_heading("Unicode", 1)
    d.add_paragraph("Hindi: नमस्ते दुनिया · Telugu: నమస్కారం · Tamil: வணக்கம் · Arabic (right to left): مرحبا بالعالم")
    d.add_paragraph("Chinese: 你好世界 · Japanese: こんにちは · Emoji: 🚀 📁 ✅ · Symbols: ₹ € £ © ™ ± ≤ ≥ → ✓")
    d.add_paragraph("A very long word: " + "Pneumonoultramicroscopicsilicovolcanoconiosis" * 2)

    d.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    d.add_heading("After a page break", 1)
    for i in range(12):
        d.add_paragraph(f"Paragraph {i + 1}. {LOREM}")
    d.save(path)
    _footnotes(path, ["The first footnote's text.", "The second footnote, with a longer note that wraps onto a second line on a phone."])


def _footnotes(path: Path, notes: list[str]) -> None:
    """python-docx can't write footnotes: add word/footnotes.xml, its link and content type to the saved file."""
    import zipfile
    w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    body = "".join(f'<w:footnote w:id="{i}"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> {t}</w:t></w:r></w:p></w:footnote>'
                   for i, t in enumerate(notes, 1))
    parts = {n: z for z in [zipfile.ZipFile(path)] for n in z.namelist()}
    files = {n: z.read(n) for n, z in parts.items()}
    files["word/footnotes.xml"] = f'<?xml version="1.0" encoding="UTF-8"?><w:footnotes {w}>{body}</w:footnotes>'.encode()
    files["word/_rels/document.xml.rels"] = files["word/_rels/document.xml.rels"].replace(b"</Relationships>",
        b'<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>')
    files["[Content_Types].xml"] = files["[Content_Types].xml"].replace(b"</Types>",
        b'<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, data in files.items():
            z.writestr(n, data)


# ------------------------------------------------------------------ Excel
def xlsx(path: Path) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

    wb = Workbook()
    ws = wb.active
    ws.title = "Formats"
    ws.append(["Kind", "Value", "Shown as"])
    rows = [
        ("Whole number", 1234567, "#,##0"), ("Decimal", 3.14159265, "0.00"), ("Negative", -42.5, "0.0"),
        ("Percent", 0.256, "0.0%"), ("Rupees", 125000, '"₹"#,##0'), ("Dollars", 1999.99, '"$"#,##0.00'),
        ("Date", date(2026, 10, 12), "dd mmm yyyy"), ("Date and time", datetime(2026, 10, 12, 14, 30), "yyyy-mm-dd hh:mm"),
        ("Time", time(9, 45), "h:mm AM/PM"), ("Scientific", 6.022e23, "0.00E+00"), ("True/false", True, None),
        ("Text that is long enough to need wrapping in a narrow column, to see how it is cut or wrapped", "text", None),
        ("Unicode", "नमस्ते · 你好 · 🚀", None), ("Empty value", None, None), ("Zero", 0, "0"),
    ]
    for kind, value, fmt in rows:
        ws.append([kind, value, fmt or "General"])
        if fmt:
            ws.cell(ws.max_row, 2).number_format = fmt
    head = Font(bold=True, color="FFFFFF")
    for c in ws[1]:
        c.font = head
        c.fill = PatternFill("solid", fgColor="1F4E79")
    ws["A3"].font = Font(italic=True)
    ws["A4"].font = Font(color="C00000")
    ws["B5"].fill = PatternFill("solid", fgColor="FFF2CC")
    ws["A13"].alignment = Alignment(wrap_text=True)  # the long text row
    thin = Side(style="thin", color="999999")
    ws["B6"].border = Border(left=thin, right=thin, top=thin, bottom=thin)
    ws.column_dimensions["A"].width = 28
    ws.column_dimensions["B"].width = 18
    ws.merge_cells("E1:G1")
    ws["E1"] = "Merged across three columns"
    ws.merge_cells("E3:E6")
    ws["E3"] = "Merged down"
    ws.merge_cells("F3:F6")
    ws["F3"] = 1234.5
    ws["F3"].number_format = "#,##0.00"
    ws.freeze_panes = "B2"  # the header row and the first column stay put

    f = wb.create_sheet("Formulas")
    f.append(["Item", "Qty", "Price", "Total", "Note"])
    for i, (item, q, p) in enumerate([("Pens", 12, 10), ("Notebooks", 5, 45.5), ("Bags", 2, 899), ("Tape", 0, 30)], start=2):
        f.append([item, q, p, f"=B{i}*C{i}", f'=IF(B{i}=0,"none ordered","ok")'])
    f.append(["Total", "=SUM(B2:B5)", "", "=SUM(D2:D5)", ""])
    f.append(["Average price", "", "=AVERAGE(C2:C5)", "", ""])
    f.append(["Max / min", "", "=MAX(C2:C5)", "=MIN(C2:C5)", ""])
    f.append(["Rounded", "", "=ROUND(C3/3,2)", "", ""])
    f.append(["Text join", "", "", "", '="Items: "&COUNTA(A2:A5)'])
    f.append(["From another sheet", "", "", "=Formats!B2*2", ""])
    f.append(["Division by zero", "", "", "=10/B5", ""])
    f.append(["Unknown function", "", "", "=VLOOKUP(A2,A2:B5,2,FALSE)", ""])
    f.append(["Bad reference", "", "", "=Nowhere!A1", ""])

    w = wb.create_sheet("Wide")
    w.append([f"Col {i + 1}" for i in range(30)])
    for r in range(20):
        w.append([r * 30 + i for i in range(30)])

    big = wb.create_sheet("Big")
    big.append(["#", "Roll", "Name", "Marks", "Grade"])
    for i in range(1, 1501):
        big.append([i, f"23B81A{i:04d}", f"Student {i}", (i * 37) % 101, "=IF(D{0}>=90,\"A\",IF(D{0}>=60,\"B\",\"C\"))".format(i + 1)])

    gaps = wb.create_sheet("Gaps")
    gaps["A1"] = "Top left"
    gaps["D4"] = "Middle"
    gaps["H12"] = "Far corner"
    wb.create_sheet("Empty sheet")
    wb.save(path)


# ------------------------------------------------------------------ CSV
def csv_file(path: Path) -> None:
    rows = [
        ["id", "name", "city", "amount", "note", "joined"],
        [1, "Akhil", "Hyderabad", 125000.5, "plain", "2025-01-06"],
        [2, "Sol, Jr.", "Bengaluru", -42, 'has a comma and "quotes"', "2025-03-17"],
        [3, "Tess", "Mumbai", 0, "line one\nline two (a newline inside a cell)", "2025-06-02"],
        [4, "", "", "", "", ""],
        [5, "नमस्ते", "చెన్నై", 3.14159, "unicode and emoji 🚀", "2026-02-09"],
        [6, "Very long", "x" * 80, 1e9, "a long cell " * 10, "2026-10-12"],
    ]
    rows += [[i, f"Person {i}", ["Pune", "Delhi", "Kolkata"][i % 3], i * 101.25, "", f"2026-{(i % 12) + 1:02d}-01"] for i in range(7, 260)]
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        csv.writer(f).writerows(rows)


# ------------------------------------------------------------------ Markdown
MARKDOWN = """# Format test: Markdown

Everything Markdown can carry, one section each.

## Text

Plain text with **bold**, *italic*, ***bold italic***, ~~strikethrough~~, `inline code` and a [link to Stepwise](https://ui.stepwise.studio).
A line that ends with two spaces
breaks here. Unicode: नमस्ते · 你好 · مرحبا · 🚀 ✅ · ₹ € £ → ≤ ≥.

### Heading level 3
#### Heading level 4
##### Heading level 5
###### Heading level 6

## Lists

- First bullet
- Second bullet with a long line that wraps across the width of the screen to check the hanging indent of wrapped bullet text
  - Nested bullet
    - Nested twice
- Third bullet

1. First step
2. Second step
   1. Sub-step one
   2. Sub-step two
3. Third step

- [x] A finished task
- [ ] An open task

## Quotes

> A quote.
>
> > A quote inside a quote.

## Code

```python
def greet(name: str) -> str:
    # a comment
    return f"Hello, {name}!"  # a very long line that should scroll sideways rather than wrap, because code keeps its shape
```

```json
{"name": "Tubelight", "files": [1, 2, 3], "ok": true}
```

## Tables

| Left | Centre | Right |
|:-----|:------:|------:|
| a | b | 1 |
| a longer cell that wraps | **bold** cell | 1,234.50 |
| `code` | [link](https://example.com) | -3 |

| A | B | C | D | E | F | G | H | I |
|---|---|---|---|---|---|---|---|---|
| a wide table | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |

## Image

![A remote image](https://picsum.photos/600/300)

## Rule

---

## HTML and footnotes

<b>Inline HTML</b> is shown as text or ignored.

Footnote reference[^1].

[^1]: The footnote text.

## Long text

""" + "\n\n".join(LOREM for _ in range(8)) + "\n"


# ------------------------------------------------------------------ code
CODE = '''// Format test: a TypeScript file. Long lines, tabs, unicode, nesting, strings and comments.
import { useEffect, useState } from 'react'

type Item = { id: string; name: string; size: number; tags?: string[] }

/** A very long line on purpose: code keeps its shape, so this must scroll sideways instead of wrapping in the viewer. */
export const LONG_CONSTANT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

export function useItems(url: string) {
\tconst [items, setItems] = useState<Item[]>([]) // a tab-indented line
\tuseEffect(() => {
\t\tfetch(url).then((r) => r.json()).then((d: { items: Item[] }) => setItems(d.items))
\t}, [url])
\treturn items
}

const greeting = `नमस्ते, ${'world'} 🚀` // unicode in a template string
const regex = /^[\\w.-]+@[\\w-]+\\.[a-z]{2,}$/i

function deep(n: number): number {
  if (n <= 0) return 0
  else {
    for (let i = 0; i < n; i++) {
      if (i % 2) {
        while (false) {
          // deeply nested
        }
      }
    }
  }
  return deep(n - 1) + 1
}
'''


# ------------------------------------------------------------------ PDF
def pdf(path: Path, locked: Path) -> None:
    from fpdf import FPDF

    def doc() -> FPDF:
        d = FPDF()
        d.set_auto_page_break(True, 18)
        return d

    d = doc()
    d.set_title("Format test: PDF")
    d.add_page()
    d.set_font("Helvetica", "B", 24)
    d.cell(0, 14, "Format test: PDF", new_x="LMARGIN", new_y="NEXT")
    d.set_font("Helvetica", size=11)
    d.multi_cell(0, 6, "Pages of different sizes and orientations, fonts, colours, a table, an image, links and plenty of text to search (search for the word Tubelight).")
    for fam, style in [("Helvetica", ""), ("Helvetica", "B"), ("Helvetica", "I"), ("Times", ""), ("Times", "B"), ("Courier", "")]:
        d.set_font(fam, style, 12)
        d.cell(0, 8, f"{fam} {style or 'regular'}: The quick brown fox jumps over the lazy dog.", new_x="LMARGIN", new_y="NEXT")
    for rgb in [(192, 0, 0), (0, 112, 192), (0, 176, 80)]:
        d.set_text_color(*rgb)
        d.cell(0, 8, f"Coloured text {rgb}", new_x="LMARGIN", new_y="NEXT")
    d.set_text_color(0, 0, 0)
    d.set_font("Helvetica", size=10)
    d.ln(4)
    for row in [("Name", "Role", "Score")] + [(f"Person {i}", "Engineer", str(80 + i)) for i in range(8)]:
        for cell in row:
            d.cell(55, 8, cell, border=1)
        d.ln()
    d.ln(4)
    img = io.BytesIO(png(300, 150, 60))
    d.image(img, w=90)
    d.set_text_color(17, 85, 204)
    d.cell(0, 8, "A link to Stepwise UI", link="https://ui.stepwise.studio", new_x="LMARGIN", new_y="NEXT")
    d.set_text_color(0, 0, 0)
    d.add_page(orientation="L")
    d.set_font("Helvetica", "B", 18)
    d.cell(0, 12, "A landscape page", new_x="LMARGIN", new_y="NEXT")
    d.set_font("Helvetica", size=11)
    d.multi_cell(0, 6, ("Tubelight " + LOREM + " ") * 3)
    d.add_page(format="Letter")
    d.set_font("Times", size=12)
    d.multi_cell(0, 6, "A US Letter page among A4 ones. " + LOREM)
    d.add_page(format=(100, 150))
    d.set_font("Helvetica", size=9)
    d.multi_cell(0, 5, "A small page (100 × 150 mm), like a receipt or a ticket.")
    for i in range(45):  # 50 pages in all: enough to scrub past a screen of bars
        d.add_page()
        d.set_font("Helvetica", "B", 16)
        d.cell(0, 10, f"Text page {i + 1}", new_x="LMARGIN", new_y="NEXT")
        d.set_font("Helvetica", size=11)
        for _ in range(6):
            d.multi_cell(0, 6, LOREM + (" Tubelight." if i % 3 == 0 else ""))
            d.ln(2)
    d.add_page()  # an empty last page
    d.output(path)

    e = doc()
    e.add_page()
    e.set_font("Helvetica", size=14)
    e.multi_cell(0, 8, "This PDF is locked. Its password is: tubelight")
    e.set_encryption(owner_password="owner-secret", user_password="tubelight")
    e.output(locked)


def write_all(out: Path) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    files = {
        "Word test.docx": docx, "Excel test.xlsx": xlsx, "CSV test.csv": csv_file,
    }
    made = []
    for name, fn in files.items():
        fn(out / name)
        made.append(out / name)
    (out / "Markdown test.md").write_text(MARKDOWN, encoding="utf-8")
    (out / "Code test.ts").write_text(CODE, encoding="utf-8")
    pdf(out / "PDF test.pdf", out / "PDF locked (password tubelight).pdf")
    made += [out / "Markdown test.md", out / "Code test.ts", out / "PDF test.pdf", out / "PDF locked (password tubelight).pdf"]
    return made


if __name__ == "__main__":
    for p in write_all(Path(sys.argv[1] if len(sys.argv) > 1 else "format-tests")):
        print(f"{p.name}: {p.stat().st_size:,} bytes")
