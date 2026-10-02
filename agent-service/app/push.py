"""Push notifications (Expo push service -> Firebase -> the phone), shaped like a good chat app's:

- kinds: `reply` (a teammate's message; automation posts too), `approval` (needs a yes/no: Approve / Reject buttons
  on the notification, Approve needs the phone unlocked), `question` (ask_user: answer by typing in the
  notification), `connect` and `alert` (an automation paused). The app registers the matching categories.
- bundling: replies in one chat wait BUNDLE_S; any that land meanwhile join the same push ("Tess, Dev and Ivy",
  the latest line, "+2 more"), and Android's `tag` makes each chat one notification that the next burst replaces.
  Approvals, questions and alerts go out at once.
- the user's choices (Profile and each chat's menu): `mode` all | needed (only what waits on them: approvals,
  questions, connects, alerts) | off, per chat or for everything; `sound` = which of the app's channels it rings on
  (each Android channel has its sound fixed at creation, so one channel per sound, ids `tl-<sound>`).
- the teammate's face shows on the notification (DiceBear's PNG of the same seed and colour as in the app).
Best effort throughout: a failed push never breaks a run.
"""
import asyncio
import logging
import re
from typing import Any
from urllib.parse import quote

import httpx

from . import db, memory

log = logging.getLogger(__name__)
EXPO_PUSH = "https://exp.host/--/api/v2/push/send"
BUNDLE_S = 20.0
SOUNDS = ("chime", "pop", "drop", "bell", "pulse", "classic", "silent")  # app/assets/sounds/<sound>.wav; classic = phone's
NEEDS_YOU = {"approval", "question", "connect", "alert"}
PREFS = ("prefs",), "notify"

_pending: dict[tuple[str, str], list[dict[str, Any]]] = {}  # (owner, thread) -> replies waiting to go out together
_tasks: set[asyncio.Task] = set()


async def prefs(owner_id: str) -> dict[str, Any]:
    item = await memory.store.aget((PREFS[0][0], owner_id), PREFS[1]) if memory.store else None
    p = item.value if item else {}
    return {"mode": p.get("mode", "all"), "sound": p.get("sound", "chime"), "chats": p.get("chats") or {}}


async def set_prefs(owner_id: str, **changes: Any) -> dict[str, Any]:
    p = await prefs(owner_id)
    if changes.get("mode") in ("all", "needed", "off"):
        p["mode"] = changes["mode"]
    if changes.get("sound") in SOUNDS:
        p["sound"] = changes["sound"]
    for thread_id, mode in (changes.get("chats") or {}).items():
        if mode in ("all", "needed", "off"):
            p["chats"][thread_id] = mode
        elif mode is None:  # back to the overall setting
            p["chats"].pop(thread_id, None)
    await memory.store.aput((PREFS[0][0], owner_id), PREFS[1], p, index=False)
    return p


def wanted(p: dict[str, Any], thread_id: str, kind: str) -> bool:
    mode = p["chats"].get(thread_id) or p["mode"]
    return mode == "all" or (mode == "needed" and kind in NEEDS_YOU)


def face(tm: dict[str, Any] | None) -> str | None:
    """The teammate's face as a PNG URL (the app draws the same DiceBear Notionists face from the same seed)."""
    if not tm:
        return None
    shape = tm.get("avatar_shape") or ""
    seed = shape[5:] if shape.startswith("face:") else tm.get("name") or "Teammate"
    color = (tm.get("color") or "#a1a1aa").lstrip("#")
    return f"https://api.dicebear.com/9.x/notionists/png?seed={quote(seed)}&backgroundColor={color}&radius=50&size=192"


def plain(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[*_`#>|]+", "", text)).strip()


async def _send(owner_id: str, message: dict[str, Any]) -> None:
    try:
        tokens = [r["token"] for r in await db.select("push_tokens", {"owner_id": f"eq.{owner_id}", "select": "token"})]
        if not tokens:
            return
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(EXPO_PUSH, json=[{**message, "to": t} for t in tokens[:100]])
        r.raise_for_status()
        for token, ticket in zip(tokens, r.json().get("data", [])):
            if (ticket.get("details") or {}).get("error") == "DeviceNotRegistered":
                await db.delete("push_tokens", {"token": f"eq.{token}"})
            elif ticket.get("status") == "error":
                log.warning("push rejected: %s", ticket.get("message"))
    except (db.DBError, httpx.HTTPError, ValueError) as e:
        log.warning("push failed: %s", e)


def _message(p: dict[str, Any], title: str, body: str, data: dict[str, Any], kind: str, tag: str,
             image: str | None) -> dict[str, Any]:
    category = {"approval": "approval", "question": "question", "reply": "reply"}.get(kind)
    return {
        "title": title[:80], "body": body[:240], "data": {**data, "kind": kind}, "priority": "high",
        "channelId": f"tl-{p['sound']}", "tag": tag,
        **({"categoryId": category} if category else {}),
        **({"richContent": {"image": image}} if image else {}),
    }


async def notify(owner_id: str, title: str, body: str, thread_id: str, *, kind: str = "reply",
                 teammate: dict[str, Any] | None = None, approval_id: str | None = None) -> None:
    """Approvals, questions and alerts go out now; replies are bundled per chat (see the module docstring)."""
    try:
        p = await prefs(owner_id)
    except Exception:
        p = {"mode": "all", "sound": "chime", "chats": {}}
    if not wanted(p, thread_id, kind):
        return
    if kind != "reply":
        data = {"thread_id": thread_id, **({"approval_id": approval_id} if approval_id else {})}
        await _send(owner_id, _message(p, title, plain(body), data, kind, approval_id or f"{thread_id}:{kind}", face(teammate)))
        return
    key = (owner_id, thread_id)
    burst = _pending.setdefault(key, [])
    burst.append({"title": title, "body": plain(body), "name": (teammate or {}).get("name") or title, "teammate": teammate})
    if len(burst) == 1:
        task = asyncio.create_task(_flush_later(owner_id, thread_id, p))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)


async def _flush_later(owner_id: str, thread_id: str, p: dict[str, Any]) -> None:
    await asyncio.sleep(BUNDLE_S)
    burst = _pending.pop((owner_id, thread_id), [])
    if burst:
        await _send(owner_id, bundle(p, thread_id, burst))


def bundle(p: dict[str, Any], thread_id: str, burst: list[dict[str, Any]]) -> dict[str, Any]:
    """One push for a burst of replies in a chat: one reply reads as itself; several name who spoke, show the latest."""
    last = burst[-1]
    if len(burst) == 1:
        return _message(p, last["title"], last["body"], {"thread_id": thread_id}, "reply", thread_id, face(last["teammate"]))
    names = list(dict.fromkeys(b["name"] for b in burst))
    who = names[0] if len(names) == 1 else ", ".join(names[:-1]) + f" and {names[-1]}"
    where = last["title"].split(" in ", 1)[1] if " in " in last["title"] else ""
    title = f"{who}{' · ' + where if where else ''}"
    body = f"{last['name']}: {last['body']}" if len(names) > 1 else last["body"]
    more = f" (+{len(burst) - 1} more)"
    return _message(p, title, body[: 240 - len(more)] + more, {"thread_id": thread_id}, "reply", thread_id,
                    face(last["teammate"]))
