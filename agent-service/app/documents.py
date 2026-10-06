"""Documents: read Word, Excel and PowerPoint files into text a model can use, and make PDF, Word, Excel, PowerPoint
and Markdown files from what a teammate writes.

PDF, Word and Markdown are written as Markdown (headings, lists, tables, code, quotes, links); Excel and PowerPoint
as JSON (sheets of rows; slides of a few kinds). Everything is drawn in one look: Inter, the app's sky-blue accent.
"""
import io
import json
import re
import sys
from pathlib import Path
from typing import Any

FONTS = Path(__file__).parent / "fonts"
ACCENT = (0x02, 0x84, 0xC7)  # the app's tube colour (light mode)
INK, MUTED = (0x18, 0x18, 0x1B), (0x71, 0x71, 0x7A)
KINDS = {"pdf": "pdf", "docx": "docx", "word": "docx", "xlsx": "xlsx", "excel": "xlsx", "pptx": "pptx",
         "powerpoint": "pptx", "slides": "pptx", "md": "md", "markdown": "md"}
MAX_ROWS = 300  # per sheet when reading


def _no_broken_numpy() -> None:
    """openpyxl uses numpy when it's installed. On the home server's CPU (no x86-64-v2) numpy raises RuntimeError
    instead of ImportError, which openpyxl doesn't catch: make numpy look absent there."""
    if "numpy" in sys.modules:
        return
    try:
        import numpy  # noqa: F401
    except Exception:
        sys.modules["numpy"] = None  # type: ignore[assignment]


# ------------------------------------------------------------------ reading
def read_docx(data: bytes) -> str:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(io.BytesIO(data))
    out: list[str] = []
    for el in doc.element.body.iterchildren():
        if el.tag.endswith("}p"):
            p = Paragraph(el, doc)
            text, style = p.text.strip(), (p.style.name if p.style is not None else "") or ""
            if not text:
                continue
            m = re.match(r"Heading (\d)", style)
            # Bullets and numbers typed into the text ("•\tItem", "2.\tItem") are list items too, marked once.
            mark = re.match(r"^(?:[•◦▪‣–\-*]|(\d+)[.)])\s+", text)
            if mark:
                text = f"{mark.group(1)}. {text[mark.end():]}" if mark.group(1) else f"- {text[mark.end():]}"
            out.append(f"{'#' * int(m.group(1))} {text}" if m else f"# {text}" if style == "Title"
                       else text if mark else f"- {text}" if "List" in style else text)
        elif el.tag.endswith("}tbl"):
            rows = [[c.text.strip().replace("\n", " ") for c in r.cells] for r in Table(el, doc).rows]
            out.append(_md_table(rows))
    return "\n\n".join(out)


def read_xlsx(data: bytes) -> str:
    _no_broken_numpy()
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    out = []
    for ws in wb.worksheets:
        rows = [["" if v is None else str(v) for v in r] for r in ws.iter_rows(values_only=True)]
        rows = [r for r in rows if any(r)]
        out.append(f"## Sheet: {ws.title} ({len(rows)} rows)")
        if rows:
            out.append(_md_table(rows[:MAX_ROWS]) + (f"\n[{len(rows) - MAX_ROWS} more rows]" if len(rows) > MAX_ROWS else ""))
    return "\n\n".join(out)


def read_pptx(data: bytes) -> str:
    from pptx import Presentation

    out = []
    for n, slide in enumerate(Presentation(io.BytesIO(data)).slides, 1):
        texts = [sh for sh in slide.shapes if sh.has_text_frame and sh.text_frame.text.strip()]
        head = slide.shapes.title if slide.shapes.title is not None else (texts[0] if texts else None)
        title = head.text_frame.text.strip() if head is not None else ""
        lines = [f"## Slide {n}{': ' + title if title else ''}"]
        for sh in slide.shapes:
            if sh == head:
                continue
            if sh.has_text_frame and sh.text_frame.text.strip():
                lines += [f"{'  ' * p.level}- {p.text.strip()}" for p in sh.text_frame.paragraphs if p.text.strip()]
            elif getattr(sh, "has_table", False) and sh.has_table:
                lines.append(_md_table([[c.text.strip() for c in r.cells] for r in sh.table.rows]))
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
            lines.append(f"Notes: {slide.notes_slide.notes_text_frame.text.strip()}")
        out.append("\n".join(lines))
    return "\n\n".join(out)


def _md_table(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [[c.replace("|", "\\|") for c in r] + [""] * (width - len(r)) for r in rows]
    return "\n".join(["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width] + ["| " + " | ".join(r) + " |" for r in rows[1:]])


# ------------------------------------------------------------------ Markdown, parsed once for Word and PDF
def _tree(text: str):
    from markdown_it import MarkdownIt
    from markdown_it.tree import SyntaxTreeNode

    return SyntaxTreeNode(MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"]).parse(text))


def _runs(node, bold=False, italic=False, code=False, link=None) -> list[dict[str, Any]]:
    """Inline content as styled runs: [{text, bold, italic, code, link}]."""
    out: list[dict[str, Any]] = []
    for ch in node.children or []:
        t = ch.type
        if t == "text":
            out.append({"text": ch.content, "bold": bold, "italic": italic, "code": code, "link": link})
        elif t == "code_inline":
            out.append({"text": ch.content, "bold": bold, "italic": italic, "code": True, "link": link})
        elif t in ("softbreak", "hardbreak"):
            out.append({"text": " " if t == "softbreak" else "\n", "bold": bold, "italic": italic, "code": code, "link": link})
        elif t == "strong":
            out += _runs(ch, True, italic, code, link)
        elif t in ("em", "s"):
            out += _runs(ch, bold, True, code, link)
        elif t == "link":
            out += _runs(ch, bold, italic, code, ch.attrs.get("href"))
        elif t == "image":
            out.append({"text": f"[{ch.content or 'image'}]", "bold": bold, "italic": True, "code": False, "link": None})
        else:
            out += _runs(ch, bold, italic, code, link)
    return out


def _inline(node):
    return next((c for c in node.children or [] if c.type == "inline"), node)


def _cells(row) -> list[list[dict[str, Any]]]:
    return [_runs(_inline(c)) for c in row.children]


def _rows(table) -> list[list[list[dict[str, Any]]]]:
    return [_cells(r) for part in table.children for r in part.children]


# ------------------------------------------------------------------ Word
def make_docx(title: str, markdown: str) -> bytes:
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    doc = Document()
    doc.core_properties.title = title
    normal = doc.styles["Normal"]
    normal.font.name, normal.font.size = "Calibri", Pt(11)
    for lvl in range(1, 5):
        st = doc.styles[f"Heading {lvl}"]
        st.font.name, st.font.color.rgb = "Calibri", RGBColor(*(ACCENT if lvl == 1 else INK))

    def runs(par, items):
        for r in items:
            if r["link"]:  # a real hyperlink (python-docx has no API for one)
                h = OxmlElement("w:hyperlink")
                h.set(qn("r:id"), par.part.relate_to(r["link"], "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True))
                run = par.add_run(r["text"])
                run.font.color.rgb, run.font.underline = RGBColor(*ACCENT), True
                run.bold, run.italic = r["bold"], r["italic"]
                h.append(run._r)
                par._p.append(h)
                continue
            run = par.add_run(r["text"])
            run.bold, run.italic = r["bold"], r["italic"]
            if r["code"]:
                run.font.name, run.font.size = "Consolas", Pt(10)

    def shade(par, fill: str):
        pPr = par._p.get_or_add_pPr()
        sh = OxmlElement("w:shd")
        sh.set(qn("w:val"), "clear"), sh.set(qn("w:color"), "auto"), sh.set(qn("w:fill"), fill)
        pPr.append(sh)

    def block(n, depth=0, quote=False):
        t = n.type
        if t == "heading":
            runs(doc.add_heading("", level=min(int(n.tag[1]), 4)), _runs(_inline(n)))
        elif t == "paragraph":
            par = doc.add_paragraph(style="Quote" if quote else None)
            runs(par, _runs(_inline(n)))
        elif t in ("bullet_list", "ordered_list"):
            start = int(n.attrs.get("start", 1) or 1)
            for i, item in enumerate(n.children):
                for j, ch in enumerate(item.children):
                    if ch.type == "paragraph":
                        par = doc.add_paragraph(style="List Paragraph")
                        par.paragraph_format.left_indent = Pt(18 + 18 * depth)
                        par.paragraph_format.first_line_indent = Pt(-14)
                        par.paragraph_format.space_after = Pt(2)
                        # numbers written out: Word's own numbering runs on across separate lists
                        par.add_run(("" if j else (f"{start + i}.\t" if t == "ordered_list" else "•\t")))
                        runs(par, _runs(_inline(ch)))
                    else:
                        block(ch, depth + 1, quote)
        elif t == "table":
            rows = _rows(n)
            if not rows:
                return
            width = max(len(r) for r in rows)
            tbl = doc.add_table(rows=len(rows), cols=width)
            try:
                tbl.style = doc.styles["Light Grid Accent 1"]
            except KeyError:
                tbl.style = doc.styles["Table Grid"]
            for ri, r in enumerate(rows):
                for ci in range(width):
                    par = tbl.cell(ri, ci).paragraphs[0]
                    runs(par, [{**x, "bold": x["bold"] or ri == 0} for x in (r[ci] if ci < len(r) else [])])
            doc.add_paragraph()
        elif t in ("fence", "code_block"):
            for line in n.content.rstrip("\n").split("\n"):
                par = doc.add_paragraph()
                par.paragraph_format.space_after = Pt(0)
                run = par.add_run(line or " ")
                run.font.name, run.font.size = "Consolas", Pt(9.5)
                shade(par, "F4F4F5")
            doc.add_paragraph()
        elif t == "blockquote":
            for ch in n.children:
                block(ch, depth, True)
        elif t == "hr":
            par = doc.add_paragraph()
            pBdr, bottom = OxmlElement("w:pBdr"), OxmlElement("w:bottom")
            for k, v in (("w:val", "single"), ("w:sz", "6"), ("w:space", "1"), ("w:color", "D4D4D8")):
                bottom.set(qn(k), v)
            pBdr.append(bottom)
            par._p.get_or_add_pPr().append(pBdr)

    tree = _tree(markdown)
    if not (tree.children and tree.children[0].type == "heading"):
        doc.add_heading(title, level=0)
    for n in tree.children:
        block(n)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ------------------------------------------------------------------ PDF
def make_pdf(title: str, markdown: str) -> bytes:
    from fpdf import FPDF
    from fpdf.enums import XPos, YPos
    from fpdf.fonts import FontFace

    class Doc(FPDF):
        def footer(self):
            self.set_y(-14)
            self.set_font("Inter", size=8)
            self.set_text_color(*MUTED)
            self.cell(0, 8, f"{title}  ·  {self.page_no()}", align="C")

    pdf = Doc(format="A4")
    pdf.set_margins(20, 20, 20)
    pdf.set_auto_page_break(True, margin=20)
    pdf.add_font("Inter", "", FONTS / "InterDisplay-Regular.ttf")
    pdf.add_font("Inter", "B", FONTS / "InterDisplay-SemiBold.ttf")
    pdf.add_font("Inter", "I", FONTS / "InterDisplay-Regular.ttf")  # no italic cut: upright, still readable
    pdf.add_font("Inter", "BI", FONTS / "InterDisplay-Bold.ttf")
    pdf.set_title(title)
    pdf.add_page()
    W = pdf.epw
    SIZES = {1: 22, 2: 17, 3: 14, 4: 12}

    def write(items, size=11, color=INK, lh=None):
        lh = lh or size * 0.55
        for r in items:
            style = ("B" if r["bold"] else "") + ("I" if r["italic"] else "")
            pdf.set_font("Courier" if r["code"] else "Inter", style if not r["code"] else "", size - (1 if r["code"] else 0))
            pdf.set_text_color(*(ACCENT if r["link"] else color))
            text = r["text"].encode("latin-1", "replace").decode("latin-1") if r["code"] else r["text"]
            pdf.write(lh, text, link=r["link"] or "")
        pdf.ln(lh)

    def block(n, depth=0, quote=False):
        t = n.type
        if t == "heading":
            lvl = min(int(n.tag[1]), 4)
            pdf.ln(4 if lvl > 1 else 2)
            write(_runs(_inline(n), bold=True), SIZES[lvl], ACCENT if lvl == 1 else INK)
            pdf.ln(2)
        elif t == "paragraph":
            if quote:
                y = pdf.get_y()
                pdf.set_x(pdf.l_margin + 6)
            write(_runs(_inline(n), italic=quote), 11, MUTED if quote else INK)
            if quote:
                pdf.set_draw_color(*ACCENT)
                pdf.set_line_width(0.8)
                pdf.line(pdf.l_margin + 1, y, pdf.l_margin + 1, pdf.get_y())
            pdf.ln(3)
        elif t in ("bullet_list", "ordered_list"):
            start = int(n.attrs.get("start", 1) or 1)
            for i, item in enumerate(n.children):
                for j, ch in enumerate(item.children):
                    if ch.type == "paragraph":
                        indent = pdf.l_margin + 4 + 6 * depth
                        pdf.set_x(indent)
                        pdf.set_font("Inter", "", 11)
                        pdf.set_text_color(*INK)
                        if not j:
                            pdf.cell(6, 6, f"{start + i}." if n.type == "ordered_list" else "•")
                        pdf.set_left_margin(indent + 6)
                        write(_runs(_inline(ch)))
                        pdf.set_left_margin(20)
                        pdf.ln(1)
                    else:
                        block(ch, depth + 1, quote)
            pdf.ln(2)
        elif t == "table":
            rows = _rows(n)
            if not rows:
                return
            width = max(len(r) for r in rows)
            pdf.set_font("Inter", "", 9.5)
            pdf.set_draw_color(0xE4, 0xE4, 0xE7)
            head = FontFace(emphasis="BOLD", color=(255, 255, 255), fill_color=ACCENT)
            with pdf.table(width=W, line_height=6, text_align="LEFT", headings_style=head, padding=2,
                           cell_fill_color=(0xF4, 0xF4, 0xF5), cell_fill_mode="ROWS", borders_layout="NONE") as tbl:
                for r in rows:
                    row = tbl.row()
                    for ci in range(width):
                        row.cell("".join(x["text"] for x in r[ci]) if ci < len(r) else "")
            pdf.ln(4)
        elif t in ("fence", "code_block"):
            pdf.set_font("Courier", "", 9)
            pdf.set_fill_color(0xF4, 0xF4, 0xF5)
            pdf.set_text_color(*INK)
            code = n.content.rstrip("\n").encode("latin-1", "replace").decode("latin-1")
            pdf.multi_cell(W, 4.6, code, fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT, padding=3)
            pdf.ln(3)
        elif t == "blockquote":
            for ch in n.children:
                block(ch, depth, True)
        elif t == "hr":
            pdf.ln(2)
            pdf.set_draw_color(0xD4, 0xD4, 0xD8)
            pdf.set_line_width(0.3)
            pdf.line(pdf.l_margin, pdf.get_y(), pdf.l_margin + W, pdf.get_y())
            pdf.ln(4)

    tree = _tree(markdown)
    if not (tree.children and tree.children[0].type == "heading"):
        block(_tree(f"# {title}").children[0])
    for n in tree.children:
        block(n)
    return bytes(pdf.output())


# ------------------------------------------------------------------ Excel
def make_xlsx(title: str, spec: dict[str, Any]) -> bytes:
    _no_broken_numpy()
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    wb.remove(wb.active)
    for sh in spec.get("sheets") or [spec]:
        ws = wb.create_sheet(re.sub(r"[\[\]:*?/\\]", " ", str(sh.get("name") or title))[:31] or "Sheet")
        cols = [str(c) for c in sh.get("columns") or []]
        if cols:
            ws.append(cols)
        for r in sh.get("rows") or []:
            ws.append([_cell(v) for v in (r if isinstance(r, list) else [r])])
        if cols:
            for c in ws[1]:
                c.font = Font(bold=True, color="FFFFFF")
                c.fill = PatternFill("solid", fgColor="%02X%02X%02X" % ACCENT)
                c.alignment = Alignment(vertical="center")
            ws.freeze_panes = "A2"
            ws.auto_filter.ref = ws.dimensions
        fmts = sh.get("formats") or {}
        for i, col in enumerate(cols, 1):
            if col in fmts:
                for (c,) in ws.iter_rows(min_row=2, min_col=i, max_col=i):
                    c.number_format = str(fmts[col])
        for i, col in enumerate(ws.iter_cols(values_only=True), 1):
            longest = max((len(str(v)) for v in col if v is not None and not str(v).startswith("=")), default=8)
            ws.column_dimensions[get_column_letter(i)].width = min(max(10, longest + 2), 60)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _cell(v: Any) -> Any:
    """Numbers stay numbers (so sums work); "=..." is a formula; "007" or "+91..." stays text."""
    if isinstance(v, str) and re.fullmatch(r"-?(0|[1-9]\d*)(\.\d+)?", v.replace(",", "")) and len(v) < 16:
        return float(v.replace(",", "")) if "." in v else int(v.replace(",", ""))
    return v


# ------------------------------------------------------------------ PowerPoint
def make_pptx(title: str, spec: dict[str, Any]) -> bytes:
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
    from pptx.oxml.ns import qn
    from pptx.util import Inches, Pt

    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    blank = prs.slide_layouts[6]
    accent, ink, muted = RGBColor(*ACCENT), RGBColor(*INK), RGBColor(*MUTED)

    def box(slide, x, y, w, h, text="", size=20, bold=False, color=ink, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
        tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        tf = tb.text_frame
        tf.word_wrap, tf.vertical_anchor = True, anchor
        p = tf.paragraphs[0]
        p.alignment = align
        r = p.add_run()
        r.text = str(text)
        r.font.size, r.font.bold, r.font.color.rgb, r.font.name = Pt(size), bold, color, "Inter"
        return tf

    def bullets(slide, x, y, w, h, items, heading=None):
        items = _items(items)
        size = 24 if len(items) <= 4 else 20 if len(items) <= 6 else 17 if len(items) <= 9 else 14
        tf = box(slide, x, y, w, h, heading or "", size - 2, True, accent) if heading else None
        tf = tf or slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h)).text_frame
        tf.word_wrap = True
        first = not heading
        for it in items:
            level = 1 if it.startswith(("  ", "\t")) else 0
            p = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            p.space_before = Pt(10 if level == 0 else 4)
            pPr = p._p.get_or_add_pPr()  # a real bullet (python-pptx has no API): hanging indent + glyph
            pPr.set("marL", str(int(Inches(0.35 + 0.4 * level)))), pPr.set("indent", str(int(-Inches(0.3))))
            bu = pPr.makeelement(qn("a:buChar"), {"char": "–" if level else "•"})
            pPr.append(bu)
            r = p.add_run()
            r.text = it.strip().lstrip("-•* ").strip()
            r.font.size = Pt(size - (3 if level else 0))
            r.font.color.rgb, r.font.name = (muted if level else ink), "Inter"
            p.level = level

    def header(slide, text):
        bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.6), Inches(0.62), Inches(0.09), Inches(0.62))
        bar.fill.solid()
        bar.fill.fore_color.rgb = accent
        bar.line.fill.background()
        box(slide, 0.85, 0.45, 11.8, 0.95, text, 32, True, ink, anchor=MSO_ANCHOR.MIDDLE)

    def fill(slide, color):
        bg = slide.background.fill
        bg.solid()
        bg.fore_color.rgb = color

    slides = spec.get("slides") or []
    if not slides or (slides[0].get("type") or slides[0].get("layout")) != "title":
        slides = [{"type": "title", "title": title}] + slides
    for s in slides:
        kind = s.get("type") or s.get("layout") or ("table" if s.get("rows") else "bullets")
        slide = prs.slides.add_slide(blank)
        if kind in ("title", "section"):
            if kind == "section":
                fill(slide, accent)
            c = RGBColor(0xFF, 0xFF, 0xFF) if kind == "section" else ink
            box(slide, 0.9, 2.4, 11.5, 1.6, s.get("title") or title, 48 if kind == "title" else 40, True, c, anchor=MSO_ANCHOR.BOTTOM)
            if s.get("subtitle"):
                box(slide, 0.9, 4.3, 11.5, 1.2, s["subtitle"], 22, False, RGBColor(0xE0, 0xF2, 0xFE) if kind == "section" else muted)
            if kind == "title":
                line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.92), Inches(4.0), Inches(1.4), Inches(0.07))
                line.fill.solid()
                line.fill.fore_color.rgb = accent
                line.line.fill.background()
        elif kind == "quote":
            box(slide, 1.2, 1.6, 10.9, 3.4, f"“{s.get('quote') or s.get('title') or ''}”", 34, False, ink, anchor=MSO_ANCHOR.MIDDLE)
            if s.get("by"):
                box(slide, 1.2, 5.2, 10.9, 0.6, f"— {s['by']}", 18, False, accent)
        elif kind == "stats":
            header(slide, s.get("title") or "")
            stats = (s.get("stats") or [])[:4]
            w = 11.8 / max(1, len(stats))
            for i, st in enumerate(stats):
                box(slide, 0.85 + i * w, 2.5, w - 0.3, 1.4, st.get("value", ""), 54, True, accent)
                box(slide, 0.85 + i * w, 3.7, w - 0.3, 1.2, st.get("label", ""), 20, False, muted)
        elif kind == "two_column":
            header(slide, s.get("title") or "")
            bullets(slide, 0.85, 1.7, 5.7, 5.2, s.get("left"), s.get("left_title"))
            bullets(slide, 6.85, 1.7, 5.7, 5.2, s.get("right"), s.get("right_title"))
        elif kind == "table":
            header(slide, s.get("title") or "")
            cols = [str(c) for c in s.get("columns") or []]
            rows = [[str(v) for v in r] for r in s.get("rows") or []][:14]
            width = max([len(cols)] + [len(r) for r in rows]) or 1
            data = ([cols] if cols else []) + rows
            shape = slide.shapes.add_table(len(data), width, Inches(0.85), Inches(1.75), Inches(11.6), Inches(0.45 * len(data)))
            for ri, r in enumerate(data):
                for ci in range(width):
                    cell = shape.table.cell(ri, ci)
                    cell.text = r[ci] if ci < len(r) else ""
                    for p in cell.text_frame.paragraphs:
                        for run in p.runs:
                            run.font.size, run.font.name = Pt(14 if len(data) < 9 else 12), "Inter"
                            run.font.bold = ri == 0 and bool(cols)
                            run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF) if ri == 0 and cols else ink
                    cell.fill.solid()
                    cell.fill.fore_color.rgb = accent if ri == 0 and cols else RGBColor(0xF4, 0xF4, 0xF5) if ri % 2 else RGBColor(0xFF, 0xFF, 0xFF)
        else:  # bullets
            header(slide, s.get("title") or "")
            bullets(slide, 0.85, 1.7, 11.6, 5.3, s.get("bullets") or s.get("points") or [])
        if s.get("notes"):
            slide.notes_slide.notes_text_frame.text = str(s["notes"])
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def _items(v: Any) -> list[str]:
    """Bullets however the model sends them: a list, a list written as a string ('["a", "b"]'), or lines."""
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            try:
                import ast
                v = ast.literal_eval(v)
            except (ValueError, SyntaxError):
                v = v.splitlines()
    if isinstance(v, str):
        v = [v]
    out = []
    for i in v or []:
        if isinstance(i, dict):  # {"text": .., "sub": [..]}
            out.append(str(i.get("text") or i.get("title") or ""))
            out += ["  " + x for x in _items(i.get("sub") or i.get("bullets") or [])]
        elif isinstance(i, list):
            out += ["  " + x for x in _items(i)]
        elif str(i).strip():
            out.append(str(i))
    return out


# ------------------------------------------------------------------ the tool's entry point
def make(kind: str, title: str, content: str) -> tuple[str, bytes]:
    """(file name, bytes). Raises ValueError with a message the model can act on."""
    ext = KINDS.get(kind.lower().strip(". "))
    if not ext:
        raise ValueError(f"Unknown kind {kind!r}: use pdf, docx, xlsx, pptx or md.")
    name = (re.sub(r"[^\w\- ]+", "", title).strip()[:60] or "Document") + f".{ext}"
    if ext == "md":
        return name, content.encode()
    if ext in ("xlsx", "pptx"):
        try:
            spec = json.loads(content)
        except json.JSONDecodeError as e:
            raise ValueError(f"For {ext}, content must be JSON ({e.msg} at character {e.pos}).") from e
        if not isinstance(spec, dict):
            raise ValueError(f"For {ext}, content must be a JSON object.")
        return name, (make_xlsx(title, spec) if ext == "xlsx" else make_pptx(title, spec))
    return name, (make_docx(title, content) if ext == "docx" else make_pdf(title, content))
