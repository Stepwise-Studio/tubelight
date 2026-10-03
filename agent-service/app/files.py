"""Attachments: files the user adds in the composer, turned into text any teammate model can read.

Files live in the private Supabase Storage bucket `attachments` under `<owner_id>/...`. Documents are
extracted to text; images are described once by a free vision model, since teammate models are text-only.
"""
import asyncio
import base64
import io
import logging
import re
import zipfile
from typing import Any

from . import config, db, llm

log = logging.getLogger(__name__)
MAX_CHARS = 20_000  # per file, so one big PDF can't crowd out the conversation
VISION_MODEL = "openrouter:google/gemma-4-31b-it:free"
TEXT_EXT = re.compile(r"\.(txt|md|markdown|csv|tsv|json|ya?ml|toml|xml|html?|css|jsx?|tsx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|sh|sql|log|env\.example)$", re.I)


async def _download(owner_id: str, path: str) -> bytes:
    if not path.startswith(f"{owner_id}/"):  # the service key can read every folder; only ever read the caller's
        raise PermissionError("attachment outside the user's folder")
    r = await db.client().get(f"{config.SUPABASE_URL}/storage/v1/object/attachments/{path}")
    r.raise_for_status()
    return r.content


async def upload(owner_id: str, name: str, data: bytes) -> dict[str, Any]:
    """Store a file a teammate brings (a computer's file) in the user's attachments folder, shaped like the app's."""
    import mimetypes
    import uuid

    safe = re.sub(r"[^\w.\- ()]", "_", name)[:120] or "file"
    path = f"{owner_id}/{uuid.uuid4()}/{safe}"
    mime = mimetypes.guess_type(safe)[0] or "application/octet-stream"
    r = await db.client().post(f"{config.SUPABASE_URL}/storage/v1/object/attachments/{path}", content=data,
                               headers={"Content-Type": mime, "x-upsert": "false"})
    r.raise_for_status()
    return {"path": path, "name": safe, "mime": mime, "size": len(data)}


def _pdf(data: bytes) -> str:
    from pypdf import PdfReader

    return "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(data)).pages)


def _docx(data: bytes) -> str:
    xml = zipfile.ZipFile(io.BytesIO(data)).read("word/document.xml").decode("utf-8", "ignore")
    xml = re.sub(r"</w:p>", "\n", xml)
    return re.sub(r"<[^>]+>", "", xml)


async def _image(data: bytes, mime: str, name: str) -> str:
    from langchain_core.messages import HumanMessage

    b64 = base64.b64encode(data).decode()
    model = llm.chat_model(VISION_MODEL, [])
    msg = HumanMessage(content=[
        {"type": "text", "text": "Describe this image for a teammate who cannot see it: what it shows, any text in it "
                                 "(transcribe exactly), and details that matter for work (UI, errors, data). Be concise."},
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
    ])
    out = await model.ainvoke([msg])
    return out.text or ""


async def _one(owner_id: str, a: dict[str, Any]) -> str:
    name, mime, path = str(a.get("name") or "file"), str(a.get("mime") or ""), str(a.get("path") or "")
    try:
        data = await _download(owner_id, path)
        if mime.startswith("image/"):
            body = await _image(data, mime, name)
            return f"### {name} (image)\n{body.strip() or 'No description available.'}"
        if mime == "application/pdf" or name.lower().endswith(".pdf"):
            text = await asyncio.to_thread(_pdf, data)
        elif name.lower().endswith(".docx"):
            text = await asyncio.to_thread(_docx, data)
        elif mime.startswith("text/") or TEXT_EXT.search(name):
            text = data.decode("utf-8", "replace")
        else:
            return f"### {name}\n(A {mime or 'binary'} file I can't read as text.)"
        text = text.strip()
        clipped = len(text) > MAX_CHARS
        return f"### {name}\n{text[:MAX_CHARS]}" + ("\n[truncated]" if clipped else "")
    except Exception as e:
        log.warning("attachment %s unreadable: %s", name, e)
        return f"### {name}\n(Couldn't read this file.)"


async def describe(owner_id: str, attachments: list[dict[str, Any]]) -> str:
    """Text appended to the user's message so the teammate can work with the attached files."""
    if not attachments:
        return ""
    parts = await asyncio.gather(*(_one(owner_id, a) for a in attachments[:6]))
    return "\n\nAttached files:\n\n" + "\n\n".join(parts)
