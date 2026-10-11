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
QUOTA = int(float(os.environ.get("VAULT_QUOTA_GB", "30")) * 1e9)  # per user; the user's choice, raise it here
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


async def add_folder(owner_id: str, name: str, parent: str = "", meta: dict[str, Any] | None = None) -> dict[str, Any]:
    await _check_parent(owner_id, parent)
    now = _now()
    row = {"kind": "folder", "name": await _unique(owner_id, parent, clean_name(name)), "parent": parent, "mime": "",
           "size": 0, "meta": meta or {}, "starred": False, "created_at": now, "updated_at": now}
    key = str(uuid.uuid4())
    await memory.store.aput(_ns(owner_id), key, row, index=False)
    return {"id": key, **row}


async def add_file(owner_id: str, name: str, data_path: Path, size: int, parent: str = "", mime: str = "",
                   synced: dict[str, Any] | None = None) -> dict[str, Any]:
    """Takes a file already written to `data_path` (moved into the vault). `synced`: a file from a computer's synced
    folder ({rel, mtime}); its name is already unique there and the sync checked the room it needs."""
    if not synced:
        await _check_parent(owner_id, parent)
    if not synced and (await usage(owner_id))["free"] < size:
        raise ValueError(f"Your vault is full ({QUOTA / 1e9:g} GB). Delete something to make room.")
    key = str(uuid.uuid4())
    dest = file_path(owner_id, key)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(data_path), dest)
    name = clean_name(name)
    if not mime or mime in ("application/octet-stream", "binary/octet-stream"):
        mime = mime_of(name)
    meta = {**await asyncio.to_thread(_inspect, owner_id, key, mime), **(synced or {})}
    now = _now()
    row = {"kind": "file", "name": name if synced else await _unique(owner_id, parent, name), "parent": parent, "mime": mime, "size": size,
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


LOOK_KEYS = {"color", "icon"}


def synced_copy(row: dict[str, Any]) -> bool:
    """A file or folder inside a folder synced from a computer (the folder itself isn't): the computer owns it."""
    return "rel" in (row.get("meta") or {})


async def update(owner_id: str, key: str, changes: dict[str, Any]) -> dict[str, Any] | None:
    row = await get(owner_id, key)
    if not row:
        return None
    if synced_copy(row) and ({"name", "parent"} & changes.keys()):
        raise ValueError("This comes from your computer: rename or move it there and it changes here too.")
    new = {k: row[k] for k in row if k != "id"}
    if isinstance(changes.get("look"), dict) and row["kind"] == "folder":  # the folder's colour and icon
        look = {k: str(v)[:40] for k, v in changes["look"].items() if k in LOOK_KEYS and v}
        new["meta"] = {**(row.get("meta") or {}), "look": look}
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


async def remove(owner_id: str, key: str, force: bool = False) -> int:
    """Deletes an item and, for a folder, everything in it. Returns how many items went."""
    rows = await items(owner_id)
    row = next((r for r in rows if r["id"] == key), None)
    if not row:
        return 0
    if synced_copy(row) and not force:
        raise ValueError("This comes from your computer: delete it there and it goes from here too.")
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
    used = sum(r.get("size") or 0 for r in rows)
    return {"used": used, "files": sum(r["kind"] == "file" for r in rows), "quota": QUOTA,
            "free": max(0, min(QUOTA - used, disk.free)), "total": disk.total}


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
        if mime.startswith("video/") and shutil.which("ffmpeg"):
            return _video(src, file_path(owner_id, key, ".thumb.jpg"))
        if mime == "application/pdf":
            from pypdf import PdfReader

            reader = PdfReader(src)
            box = reader.pages[0].mediabox if reader.pages else None
            return {"pages": len(reader.pages), **({"width": float(box.width), "height": float(box.height)} if box else {})}
    except Exception:
        pass
    return {}


def _video(src: Path, thumb: Path) -> dict[str, Any]:
    """Length and size (ffprobe) and a frame a second in (ffmpeg) as the thumbnail."""
    import subprocess

    meta: dict[str, Any] = {}
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
                            "-of", "json", str(src)], capture_output=True, text=True, timeout=30)
    if probe.returncode == 0:
        info = json.loads(probe.stdout)
        st = (info.get("streams") or [{}])[0]
        meta = {k: v for k, v in {"width": st.get("width"), "height": st.get("height"),
                                  "duration": round(float((info.get("format") or {}).get("duration") or 0), 1)}.items() if v}
    at = "1" if meta.get("duration", 2) >= 2 else "0"
    made = subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", at, "-i", str(src), "-frames:v", "1",
                           "-vf", "scale='min(640,iw)':-2", "-q:v", "4", str(thumb)], capture_output=True, timeout=60)
    if made.returncode == 0 and thumb.exists():
        meta["thumb"] = True
    return meta


def preview(owner_id: str, key: str, name: str, mime: str) -> dict[str, Any]:
    """A vault file as the app draws it natively (see preview_of). Cached next to the file."""
    cache = file_path(owner_id, key, ".preview.json")
    if cache.exists():
        return json.loads(cache.read_text())
    out = preview_of(name, read_bytes(owner_id, key))
    if out["type"] != "none":
        cache.write_text(json.dumps(out))
    return out


def preview_of(name: str, data: bytes) -> dict[str, Any]:
    """Documents as the app draws them natively: Word as Markdown, sheets as rows, slides as titled points."""
    from . import documents

    ext = Path(name).suffix.lower()
    if ext == ".docx":
        return {"type": "markdown", "text": documents.read_docx(data)}
    if ext in (".xlsx", ".xlsm"):
        return {"type": "sheets", "sheets": _sheets(data)}
    if ext in (".csv", ".tsv"):
        import csv
        import io

        rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig", "replace")), delimiter="\t" if ext == ".tsv" else ","))
        return {"type": "sheets", "sheets": [{"name": name, "rows": [r[:MAX_COLS] for r in rows[:MAX_ROWS]], "total": len(rows)}]}
    if ext == ".pptx":
        return {"type": "slides", "slides": _slides(data)}
    if ext in (".md", ".markdown", ".txt"):  # for tile covers; the viewer reads these files itself
        return {"type": "markdown", "text": data[:20000].decode("utf-8", "replace")}
    return {"type": "none"}


def _sheets(data: bytes) -> list[dict[str, Any]]:
    import io

    from .documents import _no_broken_numpy

    _no_broken_numpy()
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    raw = load_workbook(io.BytesIO(data), read_only=True)  # formulas, for cells saved without their results
    out = []
    for ws, wf in zip(wb.worksheets, raw.worksheets):
        rows, total = [], 0
        for r, f in zip(ws.iter_rows(values_only=True), wf.iter_rows(values_only=True)):
            r = [v if v is not None else (fv if isinstance(fv, str) and fv.startswith("=") else None) for v, fv in zip(r, f)]
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
            if sh.is_placeholder and sh.placeholder_format.type == 4 and sh.has_text_frame and sh.text_frame.text.strip():  # SUBTITLE
                s["subtitle"] = sh.text_frame.text.strip()
            elif sh.has_text_frame:
                s["items"] += [{"text": p.text.strip(), "level": p.level} for p in sh.text_frame.paragraphs if p.text.strip()]
            elif getattr(sh, "has_table", False) and sh.has_table and "table" not in s:
                s["table"] = [[c.text.strip() for c in r.cells] for r in sh.table.rows]
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
            s["notes"] = slide.notes_slide.notes_text_frame.text.strip()
        if not out and "subtitle" not in s and len(s["items"]) == 1 and "table" not in s:  # a title slide's one line
            s["subtitle"] = s.pop("items")[0]["text"]
            s["items"] = []
        out.append(s)
    return out
