"""Folders on the user's computers kept in sync with their Vault (one way: computer → vault).

A synced folder is a vault folder whose meta carries `source` {computer, path}. Everything under it is a copy the
computer owns (meta `rel`, its path inside the folder, and `mtime`): the phone can open, star and share it, but
renaming, moving or deleting happens on the computer. While the computer's runner is online, each of its synced
folders is compared with the computer's listing about once a minute: new and changed files are sent by the runner
(`sync_push`, in pieces to /runner/sync/{root}), files gone from the computer go from the vault. Empty folders and
hidden files aren't copied.
"""
import asyncio
import hashlib
import logging
import posixpath
import time
from typing import Any

from . import computers, memory, vault

log = logging.getLogger(__name__)
EVERY_S = 60
BATCH = 40  # files per push job

_checked: dict[tuple[str, str], float] = {}  # (owner, computer) -> last look
_busy: set[str] = set()  # roots being synced
_dirs: dict[str, dict[str, str]] = {}  # root -> {relative dir: folder id}


def due(owner_id: str, cid: str) -> None:
    """Called on every runner poll: starts a look at that computer's synced folders about once a minute."""
    k = (owner_id, cid)
    if time.time() - _checked.get(k, 0) < EVERY_S:
        return
    _checked[k] = time.time()
    asyncio.create_task(_quiet(sync_computer(owner_id, cid)))


async def _quiet(c) -> None:
    try:
        await c
    except Exception as e:
        log.warning("sync failed: %s", e)


def roots(rows: list[dict[str, Any]], cid: str | None = None) -> list[dict[str, Any]]:
    return [r for r in rows if r["kind"] == "folder" and (r.get("meta") or {}).get("source")
            and (cid is None or r["meta"]["source"].get("computer") == cid)]


async def sync_computer(owner_id: str, cid: str) -> None:
    for root in roots(await vault.items(owner_id), cid):
        await sync_root(owner_id, root)


def _tree(rows: list[dict[str, Any]], root_id: str) -> list[dict[str, Any]]:
    """Everything under a folder."""
    kids: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        kids.setdefault(r.get("parent", ""), []).append(r)
    out, todo = [], [root_id]
    while todo:
        for r in kids.get(todo.pop(), []):
            out.append(r)
            if r["kind"] == "folder":
                todo.append(r["id"])
    return out


async def _note(owner_id: str, root: dict[str, Any], **fields: Any) -> None:
    row = await vault.get(owner_id, root["id"])
    if row:
        src = {**row["meta"]["source"], **fields}
        await memory.store.aput(vault._ns(owner_id), root["id"], {**{k: v for k, v in row.items() if k != "id"},
                                                                   "meta": {**row["meta"], "source": src}}, index=False)


async def _folder(owner_id: str, root_id: str, rel_dir: str) -> str:
    """The vault folder for a directory inside the synced folder, made when missing."""
    dirs = _dirs.setdefault(root_id, {"": root_id})
    if rel_dir in dirs:
        return dirs[rel_dir]
    parent = await _folder(owner_id, root_id, posixpath.dirname(rel_dir))
    row = await vault.add_folder(owner_id, posixpath.basename(rel_dir), parent, meta={"rel": rel_dir})
    dirs[rel_dir] = row["id"]
    return row["id"]


async def sync_root(owner_id: str, root: dict[str, Any]) -> dict[str, Any]:
    """Brings one synced folder up to date with its computer. Returns what changed."""
    if root["id"] in _busy:
        return {"busy": True}
    _busy.add(root["id"])
    src = root["meta"]["source"]
    try:
        listing = await computers.call(src["computer"], "sync_scan", {"path": src["path"]}, timeout_s=180)
        under = _tree(await vault.items(owner_id), root["id"])
        files = {r["meta"]["rel"]: r for r in under if r["kind"] == "file" and "rel" in (r.get("meta") or {})}
        folders = {r["meta"]["rel"]: r for r in under if r["kind"] == "folder" and "rel" in (r.get("meta") or {})}
        _dirs[root["id"]] = {"": root["id"], **{k: r["id"] for k, r in folders.items()}}
        there = {rel: (size, mtime) for rel, size, mtime in listing}
        wanted_dirs = {""}
        for rel in there:
            d = posixpath.dirname(rel)
            while d not in wanted_dirs:
                wanted_dirs.add(d)
                d = posixpath.dirname(d)
        # gone from the computer: files, then folders nothing is in any more
        gone = [r for rel, r in files.items() if rel not in there]
        gone += [r for rel, r in folders.items() if rel not in wanted_dirs]
        for r in gone:
            await vault.remove(owner_id, r["id"], force=True)
            _dirs[root["id"]].pop(r["meta"]["rel"], None)
        need = [rel for rel, (size, mtime) in there.items()
                if rel not in files or files[rel]["size"] != size or files[rel]["meta"].get("mtime") != mtime]
        room = (await vault.usage(owner_id))["free"] + sum(files[rel]["size"] for rel in need if rel in files)
        fits, total = [], 0
        for rel in sorted(need, key=lambda r: there[r][0]):  # small first: more of the folder arrives sooner
            if total + there[rel][0] > room:
                break
            fits.append(rel)
            total += there[rel][0]
        sent, failed = 0, []
        for i in range(0, len(fits), BATCH):
            got = await computers.call(src["computer"], "sync_push", {"path": src["path"], "sid": root["id"], "files": fits[i:i + BATCH]},
                                       timeout_s=3600)
            sent += got.get("sent", 0)
            failed += got.get("failed", [])
        error = (f"{len(need) - len(fits)} files didn't fit in your vault." if len(fits) < len(need)
                 else f"{len(failed)} files didn't copy: {failed[0]}" if failed else None)
        await _note(owner_id, root, last=time.time(), files=len(there), error=error)
        return {"added": sent, "removed": len(gone), "error": error}
    except Exception as e:
        await _note(owner_id, root, error=str(e)[:200])
        raise
    finally:
        _busy.discard(root["id"])


def _part(owner_id: str, root_id: str, rel: str):
    return vault.ROOT / owner_id / f".sync-{hashlib.sha1(f'{root_id}/{rel}'.encode()).hexdigest()}"


async def receive(owner_id: str, cid: str, root_id: str, rel: str, mtime: int, off: int, end: bool, data: bytes) -> None:
    """One piece of a file the runner is sending; the last one files it in the vault (replacing an older copy)."""
    root = await vault.get(owner_id, root_id)
    if not root or (root.get("meta") or {}).get("source", {}).get("computer") != cid:
        raise PermissionError("That folder isn't synced from this computer.")
    rel = posixpath.normpath(rel.replace("\\", "/"))
    if rel.startswith(("../", "/")) or rel in ("..", "."):
        raise PermissionError("Bad path.")
    part = _part(owner_id, root_id, rel)
    part.parent.mkdir(parents=True, exist_ok=True)

    def write() -> int:
        with part.open("r+b" if off else "wb") as f:
            f.seek(off)
            f.write(data)
            f.truncate()
        return part.stat().st_size

    size = await asyncio.to_thread(write)
    if not end:
        return
    try:
        parent = await _folder(owner_id, root_id, posixpath.dirname(rel))
        old = [r for r in await vault.items(owner_id) if r.get("parent") == parent and (r.get("meta") or {}).get("rel") == rel]
        for r in old:
            await vault.remove(owner_id, r["id"], force=True)
        await vault.add_file(owner_id, posixpath.basename(rel), part, size, parent, synced={"rel": rel, "mtime": mtime})
    finally:
        part.unlink(missing_ok=True)


async def start(owner_id: str, cid: str, path: str, parent: str = "") -> dict[str, Any]:
    """A new synced folder: the vault folder now, its files over the next minutes."""
    row = next((r for r in await computers.listing(owner_id) if r["id"] == cid), None)
    if not row:
        raise ValueError("That computer isn't linked any more.")
    name = posixpath.basename(path.rstrip("/")) or path
    folder = await vault.add_folder(owner_id, name, parent, meta={"source": {"computer": cid, "name": row["name"], "path": path}})
    asyncio.create_task(_quiet(sync_root(owner_id, folder)))
    return folder
