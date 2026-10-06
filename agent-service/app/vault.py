"""Vault: the user's own files on their own server (the app's Vault tab): photos, videos, PDFs, notes, documents.

Bytes live on this server's disk under {data}/vault/<owner>/<id> (with <id>.thumb.jpg for images and
<id>.preview.json for documents the app shows natively); each item is a row in the store (("vault", owner)): a
folder or a file, its name, parent ("" = the top), mime, size, meta (width/height, pages) and a star.

Files are served by short-lived signed links (HMAC, stable for a few hours so the app's image cache hits), so photos,
video (with seeking: Range requests) and downloads work in any player without login headers. Teammates read, list,
attach and save files through the `vault` tool.
"""
import asyncio
import hashlib
import hmac
import json
import mimetypes
import os
import re
import shutil
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import config, memory

ROOT = Path(os.environ.get("VAULT_DIR") or Path(os.environ.get("WORKSPACES_DIR", "data/workspaces")).parent / "vault")
MAX_BYTES = 100 * 1024 * 1024  # Cloudflare's tunnel takes up to 100 MB a request
WINDOW = 6 * 3600  # links stay the same for this long (cache hits), and work for one more window after
MAX_ROWS, MAX_COLS = 1000, 60  # what a sheet preview carries
TYPES = {
    ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
    ".json": "application/json", ".pdf": "application/pdf", ".heic": "image/heic", ".heif": "image/heif", ".webp": "image/webp",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".webm": "video/webm", ".3gp": "video/3gpp",
    ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".aac": "audio/aac",
    ".kt": "text/plain", ".ts": "text/plain", ".tsx": "text/plain", ".py": "text/plain", ".sh": "text/plain", ".yaml": "text/plain",
    ".yml": "text/plain", ".toml": "text/plain", ".log": "text/plain",
}


def _ns(owner_id: str) -> tuple[str, ...]:
    return ("vault", owner_id)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def mime_of(name: str) -> str:
    return TYPES.get(Path(name).suffix.lower()) or mimetypes.guess_type(name)[0] or "application/octet-stream"


def file_path(owner_id: str, key: str, suffix: str = "") -> Path:
    if not re.fullmatch(r"[0-9a-f-]{36}", owner_id) or not re.fullmatch(r"[0-9a-f-]{36}", key):
        raise ValueError("bad id")
    return ROOT / owner_id / f"{key}{suffix}"


def clean_name(name: str) -> str:
    name = re.sub(r"[\x00-\x1f/\\]", "", " ".join(str(name or "").split()))[:200].strip(". ")
    if not name:
        raise ValueError("Give it a name.")
    return name


# ------------------------------------------------------------------ links
def _secret() -> bytes:
    return hashlib.sha256(b"vault-link:" + (config.SUPABASE_SERVICE_ROLE_KEY or "dev").encode()).digest()


def _sig(owner_id: str, key: str, kind: str, exp: int) -> str:
    return hmac.new(_secret(), f"{owner_id}:{key}:{kind}:{exp}".encode(), "sha256").hexdigest()[:32]


def link(owner_id: str, key: str, kind: str = "file") -> str:
    """A path on this service that serves the file (kind "file") or its thumbnail ("thumb") without auth."""
    exp = (int(time.time()) // WINDOW + 2) * WINDOW
    return f"/vault/f/{owner_id}/{key}?k={kind}&e={exp}&s={_sig(owner_id, key, kind, exp)}"


def verify(owner_id: str, key: str, kind: str, exp: int, sig: str) -> bool:
    return exp > time.time() and hmac.compare_digest(_sig(owner_id, key, kind, exp), sig)


# ------------------------------------------------------------------ rows
async def items(owner_id: str) -> list[dict[str, Any]]:
    """Everything in the user's vault, flat (the app builds the folders)."""
    # ponytail: one flat list per load; page by folder once a vault holds tens of thousands of items.
    got = await memory.store.asearch(_ns(owner_id), limit=50_000)
    return [{"id": i.key, **i.value} for i in got]


async def get(owner_id: str, key: str) -> dict[str, Any] | None:
    item = await memory.store.aget(_ns(owner_id), key)
    return {"id": key, **item.value} if item else None


def public(owner_id: str, row: dict[str, Any]) -> dict[str, Any]:
    """A row as the app gets it: with links to the file and its thumbnail."""
    out = dict(row)
    if row["kind"] == "file":
        out["url"] = link(owner_id, row["id"])
        if (row.get("meta") or {}).get("thumb"):
            out["thumb"] = link(owner_id, row["id"], "thumb")
    return out


async def _unique(owner_id: str, parent: str, name: str, skip: str = "") -> str:
    """The name, or "name (2).ext" when the folder already has one like it."""
    taken = {r["name"].lower() for r in await items(owner_id) if r.get("parent") == parent and r["id"] != skip}
    if name.lower() not in taken:
        return name
    stem, ext = os.path.splitext(name)
    n = 2
    while f"{stem} ({n}){ext}".lower() in taken:
        n += 1
    return f"{stem} ({n}){ext}"


async def _check_parent(owner_id: str, parent: str) -> None:
    if parent:
        p = await get(owner_id, parent)
        if not p or p["kind"] != "folder":
            raise ValueError("That folder is gone.")


async def add_folder(owner_id: str, name: str, parent: str = "") -> dict[str, Any]:
    await _check_parent(owner_id, parent)
    now = _now()
    row = {"kind": "folder", "name": await _unique(owner_id, parent, clean_name(name)), "parent": parent, "mime": "",
           "size": 0, "meta": {}, "starred": False, "created_at": now, "updated_at": now}
    key = str(uuid.uuid4())
    await memory.store.aput(_ns(owner_id), key, row, index=False)
    return {"id": key, **row}


async def add_file(owner_id: str, name: str, data_path: Path, size: int, parent: str = "", mime: str = "") -> dict[str, Any]:
    """Takes a file already written to `data_path` (moved into the vault)."""
    await _check_parent(owner_id, parent)
    key = str(uuid.uuid4())
    dest = file_path(owner_id, key)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(data_path), dest)
    name = clean_name(name)
    if not mime or mime in ("application/octet-stream", "binary/octet-stream"):
        mime = mime_of(name)
    meta = await asyncio.to_thread(_inspect, owner_id, key, mime)
    now = _now()
    row = {"kind": "file", "name": await _unique(owner_id, parent, name), "parent": parent, "mime": mime, "size": size,
           "meta": meta, "starred": False, "created_at": now, "updated_at": now}
    await memory.store.aput(_ns(owner_id), key, row, index=False)
    return {"id": key, **row}


async def add_bytes(owner_id: str, name: str, data: bytes, parent: str = "", mime: str = "") -> dict[str, Any]:
    if len(data) > MAX_BYTES:
        raise ValueError("Files up to 100 MB.")
    tmp = ROOT / owner_id / f".in-{uuid.uuid4()}"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(data)
    return await add_file(owner_id, name, tmp, len(data), parent, mime)


async def update(owner_id: str, key: str, changes: dict[str, Any]) -> dict[str, Any] | None:
    row = await get(owner_id, key)
    if not row:
        return None
    new = {k: row[k] for k in row if k != "id"}
    parent = changes.get("parent", row.get("parent", ""))
    if "parent" in changes and parent != row.get("parent"):
        await _check_parent(owner_id, parent)
        if row["kind"] == "folder":  # never into itself or anything inside it
            rows = {r["id"]: r for r in await items(owner_id)}
            at = parent
            while at:
                if at == key:
                    raise ValueError("A folder can't go inside itself.")
                at = rows.get(at, {}).get("parent", "")
        new["parent"] = parent
    if "name" in changes or "parent" in changes:
        new["name"] = await _unique(owner_id, parent, clean_name(changes.get("name", row["name"])), skip=key)
    if "starred" in changes:
        new["starred"] = bool(changes["starred"])
    new["updated_at"] = _now()
    await memory.store.aput(_ns(owner_id), key, new, index=False)
    return {"id": key, **new}


async def remove(owner_id: str, key: str) -> int:
    """Deletes an item and, for a folder, everything in it. Returns how many items went."""
    rows = await items(owner_id)
    if not any(r["id"] == key for r in rows):
        return 0
    doomed, frontier = {key}, [key]
    while frontier:
        kids = [r["id"] for r in rows if r.get("parent") in frontier]
        frontier = [k for k in kids if k not in doomed]
        doomed.update(frontier)
    for k in doomed:
        await memory.store.adelete(_ns(owner_id), k)
        for suffix in ("", ".thumb.jpg", ".preview.json"):
            file_path(owner_id, k, suffix).unlink(missing_ok=True)
    return len(doomed)


async def usage(owner_id: str) -> dict[str, Any]:
    rows = await items(owner_id)
    ROOT.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(ROOT)
    return {"used": sum(r.get("size") or 0 for r in rows), "files": sum(r["kind"] == "file" for r in rows),
            "free": disk.free, "total": disk.total}


def read_bytes(owner_id: str, key: str) -> bytes:
    return file_path(owner_id, key).read_bytes()


# ------------------------------------------------------------------ what's inside
def _inspect(owner_id: str, key: str, mime: str) -> dict[str, Any]:
    """Facts the app shows (image size, PDF pages) and an image's thumbnail. Never fails the upload."""
    src = file_path(owner_id, key)
    try:
        if mime.startswith("image/") and mime not in ("image/heic", "image/heif", "image/svg+xml"):
            from PIL import Image, ImageOps

            with Image.open(src) as raw:
                w, h = raw.size
                if raw.getexif().get(0x0112) in (5, 6, 7, 8):  # stored sideways
                    w, h = h, w
                raw.draft("RGB", (960, 960))  # JPEG: decode at a fraction of the size (fast on the server's CPU)
                im = ImageOps.exif_transpose(raw).convert("RGB")
                im.thumbnail((640, 640))
                im.save(file_path(owner_id, key, ".thumb.jpg"), "JPEG", quality=82, optimize=True)
            return {"width": w, "height": h, "thumb": True}
        if mime == "application/pdf":
            from pypdf import PdfReader

            reader = PdfReader(src)
            box = reader.pages[0].mediabox if reader.pages else None
            return {"pages": len(reader.pages), **({"width": float(box.width), "height": float(box.height)} if box else {})}
    except Exception:
        pass
    return {}


def preview(owner_id: str, key: str, name: str, mime: str) -> dict[str, Any]:
    """Documents as the app draws them natively: Word as Markdown, sheets as rows, slides as titled points. Cached."""
    cache = file_path(owner_id, key, ".preview.json")
    if cache.exists():
        return json.loads(cache.read_text())
    from . import documents

    data = read_bytes(owner_id, key)
    ext = Path(name).suffix.lower()
    if ext == ".docx":
        out: dict[str, Any] = {"type": "markdown", "text": documents.read_docx(data)}
    elif ext in (".xlsx", ".xlsm"):
        out = {"type": "sheets", "sheets": _sheets(data)}
    elif ext in (".csv", ".tsv"):
        import csv
        import io

        rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig", "replace")), delimiter="\t" if ext == ".tsv" else ","))
        out = {"type": "sheets", "sheets": [{"name": name, "rows": [r[:MAX_COLS] for r in rows[:MAX_ROWS]], "total": len(rows)}]}
    elif ext == ".pptx":
        out = {"type": "slides", "slides": _slides(data)}
    else:
        return {"type": "none"}
    cache.write_text(json.dumps(out))
    return out


def _sheets(data: bytes) -> list[dict[str, Any]]:
    import io

    from .documents import _no_broken_numpy

    _no_broken_numpy()
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    out = []
    for ws in wb.worksheets:
        rows, total = [], 0
        for r in ws.iter_rows(values_only=True):
            cells = ["" if v is None else (f"{v:g}" if isinstance(v, float) else str(v)) for v in r[:MAX_COLS]]
            if not any(cells):
                continue
            total += 1
            if len(rows) < MAX_ROWS:
                rows.append(cells)
        width = max((max((i + 1 for i, c in enumerate(r) if c), default=0) for r in rows), default=0)
        out.append({"name": ws.title, "rows": [r[:width] + [""] * (width - len(r[:width])) for r in rows], "total": total})
    return out


def _slides(data: bytes) -> list[dict[str, Any]]:
    import io

    from pptx import Presentation

    out = []
    for slide in Presentation(io.BytesIO(data)).slides:
        head = slide.shapes.title
        texts = [sh for sh in slide.shapes if sh.has_text_frame and sh.text_frame.text.strip()]
        if head is None and texts:
            head = texts[0]
        s: dict[str, Any] = {"title": head.text_frame.text.strip() if head is not None else "", "items": []}
        for sh in slide.shapes:
            if sh == head:
                continue
            if sh.has_text_frame:
                s["items"] += [{"text": p.text.strip(), "level": p.level} for p in sh.text_frame.paragraphs if p.text.strip()]
            elif getattr(sh, "has_table", False) and sh.has_table and "table" not in s:
                s["table"] = [[c.text.strip() for c in r.cells] for r in sh.table.rows]
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
            s["notes"] = slide.notes_slide.notes_text_frame.text.strip()
        out.append(s)
    return out
