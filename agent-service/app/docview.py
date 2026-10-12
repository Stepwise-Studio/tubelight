"""Word documents as the app draws them: blocks with their real formatting, reflowed to the phone the way Google
Docs' mobile view does (not pages).

Every paragraph and run gets its effective formatting, resolved the way Word does: document defaults → the
paragraph style and the styles it's based on → the character style → what's set on the text itself. Theme colours
and theme fonts are looked up in the document's theme. Out come:

- paragraphs: alignment, indents, spacing, heading level, list marker (numbering worked out per list and level),
  and runs (text, bold, italic, underline, strike, colour, highlight, size in points, font, super/subscript, link)
- tables: column widths (as shares of the table), rows with cells (span, vertical merges, shading, their own
  paragraphs), whether the header row repeats
- images: small ones inline as data URIs (others are noted)
- boxes: the first section's header and footer, text boxes (where they're anchored), and footnotes/endnotes
  (raised numbers in the text, their notes at the end)

Page layout (columns, positions, page numbers) is left out.
"""
import base64
import io
import re
import zipfile
from typing import Any

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"w": W, "r": R, "a": A, "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
      "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
      "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006"}
MAX_IMAGE = 600_000  # bytes an inline image may carry
HIGHLIGHT = {"yellow": "FFFF00", "green": "00FF00", "cyan": "00FFFF", "magenta": "FF00FF", "blue": "0000FF", "red": "FF0000",
             "darkBlue": "000080", "darkCyan": "008080", "darkGreen": "008000", "darkMagenta": "800080", "darkRed": "800000",
             "darkYellow": "808000", "darkGray": "808080", "lightGray": "C0C0C0", "black": "000000", "white": "FFFFFF"}
ROMAN = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]


def q(tag: str) -> str:
    p, t = tag.split(":")
    return f"{{{NS[p]}}}{t}"


def val(el, name: str = "w:val") -> str | None:
    return None if el is None else el.get(q(name))


def on(el) -> bool | None:
    """A toggle like <w:b/>: present = on unless val is 0/false."""
    if el is None:
        return None
    v = val(el)
    return v not in ("0", "false", "off")


def roman(n: int) -> str:
    out = ""
    for v, s in ROMAN:
        while n >= v:
            out, n = out + s, n - v
    return out


def alpha(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(97 + r) + s
    return s


class Doc:
    def __init__(self, data: bytes):
        self.z = zipfile.ZipFile(io.BytesIO(data))
        self.names = set(self.z.namelist())
        self.styles: dict[str, Any] = {}
        self.defaults_r = None
        self.defaults_p = None
        self.theme_colors: dict[str, str] = {}
        self.theme_fonts = {"major": "", "minor": ""}
        self.rels: dict[str, tuple[str, str]] = {}
        self.num: dict[str, dict[int, dict[str, Any]]] = {}
        self.counters: dict[tuple[str, int], int] = {}
        self.notes: list[tuple[str, str, int]] = []  # (kind, id, number) of footnotes/endnotes in the order they're referenced
        self._boxes: list[dict[str, Any]] = []  # text boxes met in the paragraph being read, placed after it
        self._load()

    def _xml(self, name: str):
        return etree.fromstring(self.z.read(name)) if name in self.names else None

    def _load(self) -> None:
        theme = self._xml("word/theme/theme1.xml")
        if theme is not None:
            for el in theme.iterfind(".//a:clrScheme/*", NS):
                c = el.find("a:srgbClr", NS)
                s = el.find("a:sysClr", NS)
                self.theme_colors[etree.QName(el).localname] = (c.get("val") if c is not None else s.get("lastClr") if s is not None else "")
            for kind in ("major", "minor"):
                f = theme.find(f".//a:{kind}Font/a:latin", NS)
                self.theme_fonts[kind] = f.get("typeface") if f is not None else ""
        st = self._xml("word/styles.xml")
        if st is not None:
            self.defaults_r = st.find("w:docDefaults/w:rPrDefault/w:rPr", NS)
            self.defaults_p = st.find("w:docDefaults/w:pPrDefault/w:pPr", NS)
            for s in st.iterfind("w:style", NS):
                self.styles[s.get(q("w:styleId"))] = s
        self.rels = self._rels("word/document.xml")
        num = self._xml("word/numbering.xml")
        if num is not None:
            abstract = {a.get(q("w:abstractNumId")): a for a in num.iterfind("w:abstractNum", NS)}
            for n in num.iterfind("w:num", NS):
                a = abstract.get(val(n.find("w:abstractNumId", NS)))
                if a is None:
                    continue
                lv = {}
                for l in a.iterfind("w:lvl", NS):
                    ind = l.find("w:pPr/w:ind", NS)
                    left = (ind.get(q("w:left")) or ind.get(q("w:start"))) if ind is not None else None
                    hang = ind.get(q("w:hanging")) if ind is not None else None
                    lv[int(l.get(q("w:ilvl")))] = {"fmt": val(l.find("w:numFmt", NS)) or "decimal", "text": val(l.find("w:lvlText", NS)) or "",
                                                   "start": int(val(l.find("w:start", NS)) or 1),
                                                   "indent": int(left) / 20 if left else None, "hang": int(hang) / 20 if hang else None}
                self.num[n.get(q("w:numId"))] = lv

    def _rels(self, part: str) -> dict[str, tuple[str, str]]:
        folder, name = part.rsplit("/", 1)
        rels = self._xml(f"{folder}/_rels/{name}.rels")
        return {r.get("Id"): (r.get("Target") or "", r.get("TargetMode") or "") for r in rels} if rels is not None else {}

    def part(self, rid: str) -> list[dict[str, Any]]:
        """A header or footer (by its relationship from the document) as blocks; its images use its own links."""
        name = "word/" + self.rels.get(rid, ("", ""))[0].lstrip("/").removeprefix("word/")
        root = self._xml(name)
        if root is None:
            return []
        keep, self.rels = self.rels, self._rels(name)
        try:
            return self.blocks(root)
        finally:
            self.rels = keep

    # ---------------------------------------------------------------- styles
    def _chain(self, sid: str | None) -> list:
        out, seen = [], set()
        while sid and sid in self.styles and sid not in seen:
            seen.add(sid)
            out.append(self.styles[sid])
            sid = val(self.styles[sid].find("w:basedOn", NS))
        return out[::-1]  # base first

    def color(self, el) -> str | None:
        if el is None:
            return None
        theme = el.get(q("w:themeColor"))
        v = el.get(q("w:val"))
        if theme and v and re.fullmatch(r"[0-9A-Fa-f]{6}", v):  # Word saves the worked-out colour too
            return v
        if theme:
            key = {"text1": "dk1", "background1": "lt1", "text2": "dk2", "background2": "lt2"}.get(theme, theme)
            base = self.theme_colors.get(key) or v
            shade, tint = el.get(q("w:themeShade")), el.get(q("w:themeTint"))
            if base and re.fullmatch(r"[0-9A-Fa-f]{6}", base) and (shade or tint):
                rgb = [int(base[i:i + 2], 16) for i in (0, 2, 4)]
                if shade:
                    rgb = [round(c * int(shade, 16) / 255) for c in rgb]
                if tint:
                    t = int(tint, 16) / 255
                    rgb = [round(c * t + 255 * (1 - t)) for c in rgb]
                return "".join(f"{c:02X}" for c in rgb)
            return base if base and base != "auto" else None
        return v if v and v != "auto" else None

    def _rpr(self, fmt: dict[str, Any], rpr) -> None:
        if rpr is None:
            return
        for tag, key in (("w:b", "b"), ("w:i", "i"), ("w:strike", "s"), ("w:caps", "caps"), ("w:smallCaps", "caps")):
            t = on(rpr.find(tag, NS))
            if t is not None:
                fmt[key] = t
        u = rpr.find("w:u", NS)
        if u is not None:
            fmt["u"] = val(u) not in (None, "none")
        c = self.color(rpr.find("w:color", NS))
        if c:
            fmt["color"] = c
        sz = val(rpr.find("w:sz", NS))
        if sz:
            fmt["size"] = int(sz) / 2
        hl = val(rpr.find("w:highlight", NS))
        if hl and hl != "none":
            fmt["hl"] = HIGHLIGHT.get(hl, "FFFF00")
        shd = rpr.find("w:shd", NS)
        if shd is not None and (shd.get(q("w:fill")) or "auto") not in ("auto", "FFFFFF"):
            fmt["hl"] = shd.get(q("w:fill"))
        va = val(rpr.find("w:vertAlign", NS))
        if va in ("superscript", "subscript"):
            fmt["va"] = "sup" if va == "superscript" else "sub"
        f = rpr.find("w:rFonts", NS)
        if f is not None:
            name = f.get(q("w:ascii")) or f.get(q("w:hAnsi"))
            theme = f.get(q("w:asciiTheme")) or f.get(q("w:hAnsiTheme"))
            if theme:
                name = self.theme_fonts["major" if theme.startswith("major") else "minor"] or name
            if name:
                fmt["font"] = name

    def _ppr(self, fmt: dict[str, Any], ppr) -> None:
        if ppr is None:
            return
        jc = val(ppr.find("w:jc", NS))
        if jc:
            fmt["align"] = {"both": "justify", "distribute": "justify", "start": "left", "end": "right"}.get(jc, jc)
        ind = ppr.find("w:ind", NS)
        if ind is not None:
            left = ind.get(q("w:left")) or ind.get(q("w:start"))
            if left:
                fmt["indent"] = int(left) / 20
            if ind.get(q("w:firstLine")):
                fmt["first"] = int(ind.get(q("w:firstLine"))) / 20
            if ind.get(q("w:hanging")):
                fmt["first"] = -int(ind.get(q("w:hanging"))) / 20
        sp = ppr.find("w:spacing", NS)
        if sp is not None:
            if sp.get(q("w:before")):
                fmt["before"] = int(sp.get(q("w:before"))) / 20
            if sp.get(q("w:after")):
                fmt["after"] = int(sp.get(q("w:after"))) / 20
            if sp.get(q("w:line")) and (sp.get(q("w:lineRule")) or "auto") == "auto":
                fmt["line"] = int(sp.get(q("w:line"))) / 240
        shd = ppr.find("w:shd", NS)
        if shd is not None and (shd.get(q("w:fill")) or "auto") not in ("auto", "FFFFFF"):
            fmt["shade"] = shd.get(q("w:fill"))
        np_ = ppr.find("w:numPr", NS)
        if np_ is not None:
            fmt["numId"] = val(np_.find("w:numId", NS))
            fmt["ilvl"] = int(val(np_.find("w:ilvl", NS)) or 0)
        ol = val(ppr.find("w:outlineLvl", NS))
        if ol is not None:
            fmt["outline"] = int(ol)

    def para_style(self, p) -> tuple[dict[str, Any], dict[str, Any], str]:
        """(paragraph format, the run format every run starts from, the style's name)."""
        pf: dict[str, Any] = {}
        rf: dict[str, Any] = {}
        self._ppr(pf, self.defaults_p)
        self._rpr(rf, self.defaults_r)
        ppr = p.find("w:pPr", NS)
        sid = val(ppr.find("w:pStyle", NS)) if ppr is not None else None
        if sid is None:
            sid = next((k for k, s in self.styles.items() if s.get(q("w:type")) == "paragraph" and s.get(q("w:default")) in ("1", "true")), None)
        name = ""
        for s in self._chain(sid):
            self._ppr(pf, s.find("w:pPr", NS))
            self._rpr(rf, s.find("w:rPr", NS))
            name = (val(s.find("w:name", NS)) or "").lower()
        self._ppr(pf, ppr)
        return pf, rf, name

    # ---------------------------------------------------------------- content
    def marker(self, num_id: str, lvl: int) -> str:
        levels = self.num.get(num_id)
        if not levels or lvl not in levels:
            return "•"
        for (n, l) in list(self.counters):  # a deeper level starts again under a new item
            if n == num_id and l > lvl:
                del self.counters[(n, l)]
        key = (num_id, lvl)
        self.counters[key] = self.counters.get(key, levels[lvl]["start"] - 1) + 1
        d = levels[lvl]
        if d["fmt"] == "bullet":
            return {"": "•", "": "▪", "o": "◦", "": "➢", "": "✓", "": "•"}.get(d["text"], d["text"] if len(d["text"]) == 1 and d["text"].isprintable() else "•")

        def fmt(i: int) -> str:
            n = self.counters.get((num_id, i), levels.get(i, {}).get("start", 1))
            f = levels.get(i, {}).get("fmt", "decimal")
            return {"lowerLetter": alpha(n), "upperLetter": alpha(n).upper(), "lowerRoman": roman(n), "upperRoman": roman(n).upper()}.get(f, str(n))

        return re.sub(r"%(\d)", lambda m: fmt(int(m.group(1)) - 1), d["text"]) or f"{fmt(lvl)}."

    def runs(self, parent, base: dict[str, Any], link: str | None = None) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for el in parent:
            tag = etree.QName(el).localname
            if tag == "r":
                f = dict(base)
                rpr = el.find("w:rPr", NS)
                rs = val(rpr.find("w:rStyle", NS)) if rpr is not None else None
                for s in self._chain(rs):
                    self._rpr(f, s.find("w:rPr", NS))
                self._rpr(f, rpr)
                text = ""
                for c in el:
                    ct = etree.QName(c).localname
                    if ct == "t":
                        text += c.text or ""
                    elif ct == "tab":
                        text += "\t"
                    elif ct in ("br", "cr"):
                        text += "\n"
                    elif ct in ("footnoteReference", "endnoteReference"):
                        kind = ct[:-9]
                        n = sum(1 for k, _, _ in self.notes if k == kind) + 1
                        self.notes.append((kind, c.get(q("w:id")), n))
                        if text:
                            out.append(self._run(text, f, link))
                            text = ""
                        out.append(self._run(str(n) if kind == "footnote" else roman(n), {**f, "va": "sup"}, link))
                    elif ct in ("drawing", "pict", "AlternateContent"):
                        if ct == "AlternateContent":  # Word's newer drawing first; the older copy (Fallback) is the same thing
                            c = c.find("mc:Choice", NS)
                            if c is None:
                                continue
                        boxes = c.findall(".//w:txbxContent", NS)
                        if boxes:  # a text box: its own paragraphs, framed, after this one
                            keep, self._boxes = self._boxes, []
                            inner = [b for tx in boxes for b in self.blocks(tx)]
                            self._boxes = keep + [{"k": "box", "role": "frame", "blocks": inner}] if inner else keep
                            continue
                        img = self.image(c)
                        if img:
                            if text:
                                out.append(self._run(text, f, link))
                                text = ""
                            out.append(img)
                if text:
                    out.append(self._run(text, f, link))
            elif tag == "hyperlink":
                rid = el.get(q("r:id"))
                target = self.rels.get(rid, ("", ""))[0] if rid else ""
                out += self.runs(el, {**base, "u": True, "color": base.get("color") or "1155CC"}, target or link)
            elif tag in ("ins", "smartTag", "fldSimple", "sdt", "sdtContent", "customXml"):
                out += self.runs(el.find("w:sdtContent", NS) if tag == "sdt" and el.find("w:sdtContent", NS) is not None else el, base, link)
        return out

    @staticmethod
    def _run(text: str, f: dict[str, Any], link: str | None) -> dict[str, Any]:
        r = {k: v for k, v in f.items() if k in ("b", "i", "u", "s", "color", "size", "hl", "va", "font", "caps") and v not in (None, False)}
        r["t"] = text.upper() if f.get("caps") else text
        r.pop("caps", None)
        if link:
            r["link"] = link
        return r

    def image(self, el) -> dict[str, Any] | None:
        blip = el.find(".//a:blip", NS)
        rid = blip.get(q("r:embed")) if blip is not None else None
        target = self.rels.get(rid, ("", ""))[0] if rid else ""
        name = "word/" + target.lstrip("/").removeprefix("word/") if target else ""
        if not name or name not in self.names:
            return None
        data = self.z.read(name)
        ext = name.rsplit(".", 1)[-1].lower()
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}.get(ext)
        ext_el = el.find(".//wp:extent", NS)
        w = int(ext_el.get("cx")) / 12700 if ext_el is not None else None  # EMU → points
        h = int(ext_el.get("cy")) / 12700 if ext_el is not None else None
        if not mime or len(data) > MAX_IMAGE:
            return {"img": None, "w": w, "h": h}
        return {"img": f"data:{mime};base64,{base64.b64encode(data).decode()}", "w": w, "h": h}

    def para(self, p) -> dict[str, Any]:
        pf, rf, name = self.para_style(p)
        block: dict[str, Any] = {"k": "p", "runs": self.runs(p, rf)}
        for key in ("align", "indent", "first", "before", "after", "line", "shade"):
            if key in pf:
                block[key] = pf[key]
        m = re.match(r"heading (\d)", name)
        if m or name == "title" or "outline" in pf:
            block["h"] = int(m.group(1)) if m else 0 if name == "title" else min(pf["outline"] + 1, 6)
        if pf.get("numId") and pf["numId"] != "0":
            block["marker"] = self.marker(pf["numId"], pf.get("ilvl", 0))
            block["level"] = pf.get("ilvl", 0)
            lvl = self.num.get(pf["numId"], {}).get(pf.get("ilvl", 0), {})
            if "indent" not in pf and lvl.get("indent"):  # a list's indents live in its numbering definition
                block["indent"] = lvl["indent"]
                if lvl.get("hang"):
                    block["first"] = -lvl["hang"]
        return block

    def table(self, t) -> dict[str, Any]:
        grid = [int(val(g, "w:w") or 0) for g in t.iterfind("w:tblGrid/w:gridCol", NS)]
        total = sum(grid) or 1
        rows = []
        for tr in t.iterfind("w:tr", NS):
            trpr = tr.find("w:trPr", NS)
            cells = []
            for tc in tr.iterfind("w:tc", NS):
                tcpr = tc.find("w:tcPr", NS)
                cell: dict[str, Any] = {"blocks": self.blocks(tc)}
                span = int(val(tcpr.find("w:gridSpan", NS)) or 1) if tcpr is not None else 1
                if span > 1:
                    cell["span"] = span
                vm = tcpr.find("w:vMerge", NS) if tcpr is not None else None
                if vm is not None:
                    cell["vmerge"] = "restart" if val(vm) == "restart" else "continue"
                shd = tcpr.find("w:shd", NS) if tcpr is not None else None
                if shd is not None and (shd.get(q("w:fill")) or "auto") not in ("auto", "FFFFFF"):
                    cell["shade"] = shd.get(q("w:fill"))
                va = val(tcpr.find("w:vAlign", NS)) if tcpr is not None else None
                if va in ("center", "bottom"):
                    cell["valign"] = va
                cells.append(cell)
            row: dict[str, Any] = {"cells": cells}
            if trpr is not None and on(trpr.find("w:tblHeader", NS)):
                row["header"] = True
            rows.append(row)
        widths = [round(g / total, 4) for g in grid] if grid else []
        return {"k": "table", "widths": widths, "width": total / 20, "rows": rows}

    def blocks(self, parent) -> list[dict[str, Any]]:
        out = []
        for el in parent:
            tag = etree.QName(el).localname
            if tag == "p":
                out.append(self.para(el))
                out += self._boxes
                self._boxes = []
            elif tag == "tbl":
                out.append(self.table(el))
            elif tag == "sdt":
                c = el.find("w:sdtContent", NS)
                if c is not None:
                    out += self.blocks(c)
        return out

    def body(self) -> list[dict[str, Any]]:
        root = self._xml("word/document.xml")
        body = root.find("w:body", NS) if root is not None else None
        if body is None:
            return []
        out = self.blocks(body)
        sect = body.find("w:sectPr", NS)
        if sect is None:
            sect = body.find(".//w:pPr/w:sectPr", NS)  # the first section's, when the document has several

        def ref(kind: str) -> str | None:
            refs = {r.get(q("w:type")) or "default": r.get(q("r:id")) for r in sect.iterfind(f"w:{kind}Reference", NS)} if sect is not None else {}
            return refs.get("default") or refs.get("first")

        head = self.part(ref("header")) if ref("header") else []
        foot = self.part(ref("footer")) if ref("footer") else []
        text = lambda bs: any(b["k"] != "p" or any((r.get("t") or "").strip() or r.get("img") is not None for r in b["runs"]) for b in bs)
        if text(head):
            out.insert(0, {"k": "box", "role": "header", "blocks": head})
        notes = []
        for kind in ("footnote", "endnote"):
            root = self._xml(f"word/{kind}s.xml")
            if root is None:
                continue
            by_id = {n.get(q("w:id")): n for n in root.iterfind(f"w:{kind}", NS)}
            for k, nid, n in self.notes:
                if k != kind or nid not in by_id:
                    continue
                bs = self.blocks(by_id[nid])
                mark = str(n) if kind == "footnote" else roman(n)
                if bs and bs[0]["k"] == "p":  # "1. " in the note's own type, before its text
                    runs = bs[0]["runs"]
                    if runs and runs[0].get("t"):
                        runs[0]["t"] = runs[0]["t"].lstrip()
                    runs.insert(0, {**{k: v for k, v in (runs[0] if runs else {}).items() if k in ("size", "font", "color")}, "t": f"{mark}. "})
                notes += bs
        if notes:
            out.append({"k": "box", "role": "notes", "blocks": notes})
        if text(foot):
            out.append({"k": "box", "role": "footer", "blocks": foot})
        return out


def read(data: bytes) -> dict[str, Any]:
    """{"type": "doc", "blocks": [...], "base": the body text's size in points}."""
    d = Doc(data)
    base: dict[str, Any] = {}
    d._rpr(base, d.defaults_r)
    normal = d.styles.get("Normal")
    if normal is not None:
        d._rpr(base, normal.find("w:rPr", NS))
    return {"type": "doc", "blocks": d.body(), "base": base.get("size", 11), "font": base.get("font", "")}


if __name__ == "__main__":
    import json
    import sys

    out = read(open(sys.argv[1], "rb").read())
    print(json.dumps(out, ensure_ascii=False)[:3000])
