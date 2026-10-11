"""Google Drive in the Vault: browse, open, add and remove the user's Drive files from the phone.

Drive is the user's Composio Google Drive connection; every call goes through Composio's proxy (it holds and refreshes
the sign-in). Opening a file gets a short-lived download link (Composio stores the bytes for a while), which the phone
opens like any file; Google Docs, Sheets and Slides open as PDFs. Uploads go from the phone straight to Google: the
server starts a resumable upload session (its link needs no sign-in) and the phone sends the bytes to it. "Remove"
moves a file to Drive's trash, where it can still be restored.
"""
import asyncio
import time
from typing import Any
from urllib.parse import quote, urlencode

import httpx

from . import connectors, vault

API = "https://www.googleapis.com/drive/v3"
FIELDS = "id,name,mimeType,size,modifiedTime,thumbnailLink,starred,parents"
FOLDER = "application/vnd.google-apps.folder"
GOOGLE = "application/vnd.google-apps."
EXPORT = {"document": "application/pdf", "spreadsheet": "application/pdf", "presentation": "application/pdf", "drawing": "application/pdf"}

_accounts: dict[str, tuple[float, str | None]] = {}


async def account(owner_id: str) -> str | None:
    """The user's active Google Drive connection on Composio (cached a few minutes), or None."""
    hit = _accounts.get(owner_id)
    if hit and hit[0] > time.time():
        return hit[1]
    if not connectors.enabled():
        return None

    def find() -> str | None:
        got = connectors._client().connected_accounts.list(user_ids=[owner_id], toolkit_slugs=["googledrive"])
        return next((a.id for a in got.items if a.status == "ACTIVE"), None)

    aid = await asyncio.to_thread(find)
    _accounts[owner_id] = (time.time() + (300 if aid else 30), aid)
    return aid


async def _proxy(owner_id: str, method: str, endpoint: str, body: dict[str, Any] | None = None):
    aid = await account(owner_id)
    if not aid:
        raise PermissionError("Google Drive isn't connected.")
    r = await asyncio.to_thread(lambda: connectors._client().tools.proxy(
        endpoint=endpoint, method=method, connected_account_id=aid, **({"body": body} if body is not None else {})))
    if (r.status or 0) >= 400:
        err = (r.data or {}).get("error") if isinstance(r.data, dict) else None
        raise RuntimeError((err or {}).get("message") if isinstance(err, dict) else f"Google Drive said {r.status}")
    return r


def _row(f: dict[str, Any]) -> dict[str, Any]:
    mime = f.get("mimeType", "")
    google = mime.startswith(GOOGLE) and mime != FOLDER
    return {"id": f["id"], "kind": "folder" if mime == FOLDER else "file",
            # a Google Doc opens as a PDF, so it's named and drawn as one
            "name": f["name"] + (".pdf" if google and mime.removeprefix(GOOGLE) in EXPORT else ""),
            "mime": "application/pdf" if google else mime, "size": int(f.get("size") or 0),
            "updated_at": f.get("modifiedTime") or "", "starred": bool(f.get("starred")),
            "thumb": f.get("thumbnailLink") or None, "google": google}


async def listing(owner_id: str, folder: str = "root", query: str = "", page: str = "") -> dict[str, Any]:
    if query:
        q = f"name contains '{query.replace(chr(92), '').replace(chr(39), chr(92) + chr(39))}' and trashed=false"
    elif folder == "starred":
        q = "starred=true and trashed=false"
    elif folder == "recent":
        q = "trashed=false and mimeType!='application/vnd.google-apps.folder'"
    else:
        q = f"'{folder}' in parents and trashed=false"
    params = {"q": q, "pageSize": 200, "fields": f"nextPageToken,files({FIELDS})",
              "orderBy": "modifiedTime desc" if folder == "recent" else "folder,name_natural", **({"pageToken": page} if page else {})}
    r = await _proxy(owner_id, "GET", f"{API}/files?{urlencode(params)}")
    data = r.data or {}
    return {"items": [_row(f) for f in data.get("files", [])], "next": data.get("nextPageToken")}


async def about(owner_id: str) -> dict[str, Any]:
    """Whether Drive is connected, and its storage."""
    if not await account(owner_id):
        return {"connected": False}
    r = await _proxy(owner_id, "GET", f"{API}/about?fields=user(emailAddress),storageQuota(limit,usage)")
    d = r.data or {}
    q = d.get("storageQuota") or {}
    return {"connected": True, "email": (d.get("user") or {}).get("emailAddress"), "used": int(q.get("usage") or 0), "quota": int(q.get("limit") or 0)}


async def open_link(owner_id: str, file_id: str) -> dict[str, Any]:
    """A link the phone opens without signing in (good for a while). Google's own files come as PDFs."""
    meta = (await _proxy(owner_id, "GET", f"{API}/files/{quote(file_id)}?fields={FIELDS}")).data or {}
    kind = (meta.get("mimeType") or "").removeprefix(GOOGLE)
    if (meta.get("mimeType") or "").startswith(GOOGLE):
        if kind not in EXPORT:
            raise ValueError("This kind of Google file can't be opened here.")
        r = await _proxy(owner_id, "GET", f"{API}/files/{quote(file_id)}/export?mimeType={quote(EXPORT[kind])}")
    else:
        r = await _proxy(owner_id, "GET", f"{API}/files/{quote(file_id)}?alt=media")
    if not r.binary_data or not r.binary_data.url:
        raise RuntimeError("Google Drive didn't send the file.")
    return {**_row(meta), "url": r.binary_data.url}


async def preview(owner_id: str, file_id: str) -> dict[str, Any]:
    """Word, sheets and slides drawn natively, like vault files."""
    f = await open_link(owner_id, file_id)
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as c:
        data = (await c.get(f["url"])).content
    return await asyncio.to_thread(vault.preview_of, f["name"], data)


async def trash(owner_id: str, file_id: str) -> None:
    await _proxy(owner_id, "PATCH", f"{API}/files/{quote(file_id)}", {"trashed": True})


async def star(owner_id: str, file_id: str, on: bool) -> None:
    await _proxy(owner_id, "PATCH", f"{API}/files/{quote(file_id)}", {"starred": on})


async def new_folder(owner_id: str, name: str, parent: str = "root") -> dict[str, Any]:
    r = await _proxy(owner_id, "POST", f"{API}/files?fields={FIELDS}", {"name": vault.clean_name(name), "mimeType": FOLDER, "parents": [parent]})
    return _row(r.data or {})


async def upload_session(owner_id: str, name: str, parent: str = "root", mime: str = "") -> str:
    """A resumable upload link: the phone PUTs the file's bytes to it (no sign-in needed on that link)."""
    r = await _proxy(owner_id, "POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
                     {"name": vault.clean_name(name), "parents": [parent], **({"mimeType": mime} if mime else {})})
    where = next((v for k, v in (r.headers or {}).items() if k.lower() == "location"), None)
    if not where:
        raise RuntimeError("Google Drive didn't start the upload.")
    return where


async def to_vault(owner_id: str, file_id: str, parent: str = "") -> dict[str, Any]:
    """A Drive file copied into the vault."""
    f = await open_link(owner_id, file_id)
    async with httpx.AsyncClient(timeout=600, follow_redirects=True) as c:
        data = (await c.get(f["url"])).content
    return await vault.add_bytes(owner_id, f["name"], data, parent, f["mime"])
