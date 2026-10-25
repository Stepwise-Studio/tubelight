"""A teammate's knowledge base: Vault files and folders the user gives it (notes, books, PDFs), read in full, cut into
passages and indexed, so "what does chapter 3 say about X" is answered from the user's own material, with the file and
page it came from.

Links: Vault ids (a folder brings everything in it, now and later). A file is (re)read when it's new or changed
(size + updated_at), in the background; the `knowledge` tool and each run's preamble search the passages (the same
embeddings as memory). Store: ("knowledge", teammate) "links" = {links} (the user's choice) and "files" = {files: {id: {name, stamp,
chunks|error}}} (the reader's progress), kept apart so a read in progress never undoes a link change;
passages in ("kb", teammate, file id). A file linked to two teammates is indexed for each (ponytail: share passages per
owner if users link big libraries to many teammates).
"""
import asyncio
import logging
import re
from typing import Any

from langgraph.store.base import PutOp

from . import files, memory, vault

log = logging.getLogger(__name__)
CHUNK = 1100  # characters per passage
OVERLAP = 150
_locks: dict[str, asyncio.Lock] = {}
_tasks: set[asyncio.Task] = set()


def _ns(teammate_id: str) -> tuple[str, ...]:
    return ("knowledge", teammate_id)


async def state(teammate_id: str) -> dict[str, Any]:
    links = await memory.store.aget(_ns(teammate_id), "links")
    got = await memory.store.aget(_ns(teammate_id), "files")
    return {"links": links.value["links"] if links else [], "files": got.value["files"] if got else {}}


async def _save(teammate_id: str, st: dict[str, Any]) -> None:
    """The reader's progress only: the links are the user's."""
    await memory.store.aput(_ns(teammate_id), "files", {"files": st["files"]}, index=False)


def _stamp(row: dict[str, Any]) -> str:
    return f"{row.get('size')}:{row.get('updated_at')}"


def wanted(rows: list[dict[str, Any]], links: list[str]) -> dict[str, dict[str, Any]]:
    """The files the links cover: linked files, and every file under a linked folder (hidden folders excepted)."""
    rows = vault.visible(rows)
    by_id = {r["id"]: r for r in rows}
    kids: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        kids.setdefault(r.get("parent") or "", []).append(r)
    out: dict[str, dict[str, Any]] = {}
    todo = [by_id[k] for k in links if k in by_id]
    while todo:
        r = todo.pop()
        if r["kind"] == "file":
            out[r["id"]] = r
        elif r["kind"] == "folder":
            todo += kids.get(r["id"], [])
    return out


def chunks(text: str) -> list[tuple[int | None, str]]:
    """Passages of about CHUNK characters with a little overlap, each with the PDF page it starts on (if any)."""
    parts = re.split(r"--- page (\d+) of \d+ ---\n", text)
    pages = [(None, parts[0])] + [(int(parts[i]), parts[i + 1]) for i in range(1, len(parts) - 1, 2)]
    out = []
    for page, body in pages:
        body = re.sub(r"[ \t]+", " ", body).strip()
        i = 0
        while i < len(body):
            end = min(len(body), i + CHUNK)
            if end < len(body):  # end on a sentence or line when there's one nearby
                cut = max(body.rfind(". ", i + CHUNK // 2, end), body.rfind("\n", i + CHUNK // 2, end))
                end = cut + 1 if cut > 0 else end
            if body[i:end].strip():
                out.append((page, body[i:end].strip()))
            if end >= len(body):
                break
            i = max(end - OVERLAP, i + 1)
    return out


async def _index(owner_id: str, teammate_id: str, row: dict[str, Any]) -> dict[str, Any]:
    ns = ("kb", teammate_id, row["id"])
    for old in await memory.store.asearch(ns, limit=10_000):
        await memory.store.adelete(ns, old.key)
    data = await asyncio.to_thread(vault.read_bytes, owner_id, row["id"])
    text = await files.text_of(row["name"], row.get("mime") or "", data, limit=None)
    text = text.split("\n", 1)[1] if text.startswith("### ") else text  # text_of's heading
    parts = chunks(text)
    if not parts or (len(parts) == 1 and parts[0][1].startswith("(")):
        return {"name": row["name"], "stamp": _stamp(row), "error": "No readable text in it (a scan or a format I can't read)."}
    for n in range(0, len(parts), 50):  # one embeddings call per 50 passages
        await memory.store.abatch([
            PutOp(ns, f"{i}", {"text": body, "file": row["id"], "name": row["name"], "page": page}, index=["text"])
            for i, (page, body) in enumerate(parts[n:n + 50], n)])
    return {"name": row["name"], "stamp": _stamp(row), "chunks": len(parts)}


async def sync(owner_id: str, teammate_id: str) -> dict[str, Any]:
    """Bring the index in line with the links: read new or changed files, drop unlinked ones. The links are read once
    the lock is held, so a sync queued behind another sees the latest choice."""
    async with _locks.setdefault(teammate_id, asyncio.Lock()):
        st = await state(teammate_id)
        want = wanted(await vault.items(owner_id), st["links"])
        for fid in [f for f in st["files"] if f not in want]:
            ns = ("kb", teammate_id, fid)
            for old in await memory.store.asearch(ns, limit=10_000):
                await memory.store.adelete(ns, old.key)
            st["files"].pop(fid)
        for fid, row in want.items():
            if st["files"].get(fid, {}).get("stamp") == _stamp(row):
                continue
            st["files"][fid] = {"name": row["name"], "stamp": "", "reading": True}
            await _save(teammate_id, st)
            try:
                st["files"][fid] = await _index(owner_id, teammate_id, row)
            except Exception as e:
                log.exception("knowledge: reading %s failed", row["name"])
                st["files"][fid] = {"name": row["name"], "stamp": _stamp(row), "error": f"Couldn't read it: {e}"[:200]}
            await _save(teammate_id, st)
        await _save(teammate_id, st)
        return st


def sync_later(owner_id: str, teammate_id: str) -> None:
    """Fire and forget (a big PDF takes a while); the app polls the state."""
    async def run() -> None:
        try:
            await sync(owner_id, teammate_id)
        except Exception:
            log.exception("knowledge sync failed")
    t = asyncio.create_task(run())
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


async def link(owner_id: str, teammate_id: str, links: list[str]) -> dict[str, Any]:
    await memory.store.aput(_ns(teammate_id), "links", {"links": list(dict.fromkeys(links))}, index=False)
    sync_later(owner_id, teammate_id)
    return await state(teammate_id)


async def stale(owner_id: str, teammate_id: str, st: dict[str, Any]) -> bool:
    want = wanted(await vault.items(owner_id), st["links"])
    return want.keys() != st["files"].keys() or any(st["files"][f].get("stamp") != _stamp(r) for f, r in want.items())


async def search(teammate_id: str, query: str, limit: int = 6, file: str = "") -> list[dict[str, Any]]:
    ns = ("kb", teammate_id, file) if file else ("kb", teammate_id)
    got = await memory.store.asearch(ns, query=query, limit=limit)
    return [{**i.value, "score": i.score} for i in got]


def under(rows: list[dict[str, Any]], folder: str, files: dict[str, Any]) -> list[str]:
    """Ids of the indexed files inside the vault folder at path `folder` (any depth, case-insensitive)."""
    by_id = {r["id"]: r for r in rows}

    def path(r: dict[str, Any]) -> str:
        parts, seen = [], set()
        while r and r["id"] not in seen:
            seen.add(r["id"])
            parts.append(r["name"])
            r = by_id.get(r.get("parent") or "")
        return "/".join(reversed(parts)).lower()
    want = folder.strip("/").lower() + "/"
    return [k for k in files if k in by_id and path(by_id[k]).startswith(want)]


def cite(hit: dict[str, Any]) -> str:
    where = f"{hit['name']}" + (f", page {hit['page']}" if hit.get("page") else "")
    return f"[{where}]\n{hit['text']}"
