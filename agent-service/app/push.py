"""Push notifications, shaped like a good chat app's:

- kinds: `reply` (a teammate's message; automation posts too), `approval` (needs a yes/no: Approve / Reject buttons
  on the notification, Approve needs the phone unlocked), `question` (ask_user: answer by typing in the
  notification), `connect` and `alert` (an automation paused). The app registers the matching categories.
- bundling: replies in one chat wait BUNDLE_S; any that land meanwhile join the same push ("Tess, Dev and Ivy",
  the latest line, "+2 more"), and Android's `tag` makes each chat one notification that the next burst replaces.
  Approvals, questions and alerts go out at once.
- the user's choices (Profile and each chat's menu): `mode` all | needed (only what waits on them: approvals,
  questions, connects, alerts) | off, per chat or for everything; `sound` = which of the app's channels it rings on
  (each Android channel has its sound fixed at creation, so one channel per sound, ids `tl-<sound>`).
- the teammate's face shows on the notification (the app's own drawing, `app/faces`, on the teammate's colour).
Delivery: an Android phone registers its Firebase (FCM) token and gets data-only messages sent straight through FCM
(FCM_SERVICE_ACCOUNT_B64, the Firebase service account): expo-notifications draws those itself, with the buttons,
the sound channel, the per-chat tag and the face (app/patches: the face from `data.image`). Expo's push service
can't send that shape (it adds a notification part, which Android draws without the buttons), so it's only the
fallback for Expo tokens (no FCM key configured, or iOS later).
Best effort throughout: a failed push never breaks a run.
"""
import asyncio
import base64
import functools
import io
import json
import logging
import re
import time
from typing import Any
from urllib.parse import quote

import httpx

from . import config, db, genui, memory

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


# Same list and order as the app's `ui/avatar.tsx` FACES (the hash below must pick the same face).
FACES = ["bob", "hoodie", "wavy", "boy", "braid", "glasses", "ponytail", "cap", "curly", "puppy", "husky", "cat"]


def _face_key(tm: dict[str, Any]) -> tuple[str, str]:
    """(face, colour) of a teammate: the same face the app draws (older seeds map to one by a hash)."""
    shape = tm.get("avatar_shape") or ""
    seed = shape[5:] if shape.startswith("face:") else tm.get("name") or "Teammate"
    face = seed if seed in FACES else FACES[sum(map(ord, seed)) % len(FACES)]
    return face, re.sub(r"[^0-9a-fA-F]", "", tm.get("color") or "a1a1aa")[:6] or "a1a1aa"


def face(tm: dict[str, Any] | None) -> str | None:
    """The teammate's face as a PNG URL on this service (/faces)."""
    if not tm or (tm.get("avatar_shape") or "").startswith("device:"):  # a computer's chat has no face
        return None
    seed, color = _face_key(tm)
    return f"{config.PUBLIC_URL}/faces/{quote(seed, safe='')}.png?c={color}"


@functools.lru_cache(maxsize=256)
def face_png(seed: str, color: str) -> bytes:
    """The face drawn on a circle of the teammate's colour, 128 px."""
    from PIL import Image, ImageDraw
    from pathlib import Path
    face = seed if seed in FACES else _face_key({"name": seed})[0]
    ink = Image.open(Path(__file__).parent / "faces" / f"{face}.png").convert("RGBA").resize((128, 128), Image.LANCZOS)
    out = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    disc = Image.new("RGBA", (128, 128), "#" + color)
    disc.alpha_composite(ink)
    mask = Image.new("L", (128, 128), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, 127, 127), 255)
    out.paste(disc, (0, 0), mask)
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return buf.getvalue()


def plain(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[*_`#>|]+", "", text)).strip()


_fcm_token: tuple[float, str] = (0.0, "")


def _service_account() -> dict[str, Any] | None:
    raw = config.env("FCM_SERVICE_ACCOUNT_B64")
    try:
        return json.loads(base64.b64decode(raw)) if raw else None
    except ValueError:
        log.warning("FCM_SERVICE_ACCOUNT_B64 isn't a base64 service account JSON")
        return None


async def _fcm_access_token(sa: dict[str, Any]) -> str:
    """OAuth token for FCM from the service account (a signed JWT grant), cached until near expiry."""
    global _fcm_token
    if _fcm_token[1] and time.time() < _fcm_token[0]:
        return _fcm_token[1]
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    def b64(b: bytes) -> bytes:
        return base64.urlsafe_b64encode(b).rstrip(b"=")
    now = int(time.time())
    claims = {"iss": sa["client_email"], "scope": "https://www.googleapis.com/auth/firebase.messaging",
              "aud": sa["token_uri"], "iat": now, "exp": now + 3600}
    signing = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode()) + b"." + b64(json.dumps(claims).encode())
    key = serialization.load_pem_private_key(sa["private_key"].encode(), None)
    assertion = signing + b"." + b64(key.sign(signing, padding.PKCS1v15(), hashes.SHA256()))  # type: ignore[union-attr]
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(sa["token_uri"], data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                                "assertion": assertion.decode()})
    r.raise_for_status()
    d = r.json()
    _fcm_token = (time.time() + int(d.get("expires_in", 3600)) - 120, d["access_token"])
    return _fcm_token[1]


def fcm_data(message: dict[str, Any]) -> dict[str, str]:
    """The data-only FCM payload expo-notifications draws itself: title/message/channelId/categoryId/tag at the top,
    the app's own data as JSON under `body` (it becomes content.data in JS), and the face under `image`."""
    out = {"title": message["title"], "message": message["body"], "channelId": message["channelId"],
           "tag": message["tag"], "body": json.dumps(message["data"])}
    if message.get("categoryId"):
        out["categoryId"] = message["categoryId"]
    if (message.get("richContent") or {}).get("image"):
        out["image"] = message["richContent"]["image"]
    return out


async def _send_fcm(sa: dict[str, Any], tokens: list[str], message: dict[str, Any]) -> list[str]:
    """Returns the tokens FCM says are gone (uninstalled, reset)."""
    access = await _fcm_access_token(sa)
    url = f"https://fcm.googleapis.com/v1/projects/{sa['project_id']}/messages:send"
    gone = []
    async with httpx.AsyncClient(timeout=15) as c:
        for t in tokens:
            r = await c.post(url, headers={"Authorization": f"Bearer {access}"},
                             json={"message": {"token": t, "data": fcm_data(message),
                                               "android": {"priority": "HIGH", "ttl": "86400s"}}})
            if r.status_code in (400, 404) and ("UNREGISTERED" in r.text or "not-registered" in r.text):
                gone.append(t)
            elif r.status_code >= 300:
                log.warning("fcm rejected: %s %s", r.status_code, r.text[:200])
    return gone


async def _send(owner_id: str, message: dict[str, Any]) -> None:
    try:
        rows = await db.select("push_tokens", {"owner_id": f"eq.{owner_id}", "select": "token,platform"})
        if not rows:
            return
        sa = _service_account()
        fcm = [r["token"] for r in rows if r.get("platform") == "fcm"]
        if fcm and sa:
            for t in await _send_fcm(sa, fcm[:20], message):
                await db.delete("push_tokens", {"token": f"eq.{t}"})
            return
        expo = [r["token"] for r in rows if r.get("platform") != "fcm"]
        if not expo:
            return
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(EXPO_PUSH, json=[{**message, "to": t} for t in expo[:100]])
        r.raise_for_status()
        for token, ticket in zip(expo, r.json().get("data", [])):
            if (ticket.get("details") or {}).get("error") == "DeviceNotRegistered":
                await db.delete("push_tokens", {"token": f"eq.{token}"})
            elif ticket.get("status") == "error":
                log.warning("push rejected: %s", ticket.get("message"))
    except (db.DBError, httpx.HTTPError, ValueError, KeyError) as e:
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


async def clock(owner_id: str, title: str, body: str) -> None:
    """A teammate set or changed an alarm or reminder: a quiet note, and the phone's background task picks up the list
    and schedules it (the app's lib/clock.ts), so it rings even if Tubelight isn't opened before then."""
    await _send(owner_id, {"title": title[:80], "body": body[:240], "data": {"kind": "clock"}, "priority": "high",
                           "channelId": "tl-silent", "tag": "clock"})


async def notify(owner_id: str, title: str, body: str, thread_id: str, *, kind: str = "reply",
                 teammate: dict[str, Any] | None = None, approval_id: str | None = None) -> None:
    """Approvals, questions and alerts go out now; replies are bundled per chat (see the module docstring)."""
    try:
        p = await prefs(owner_id)
    except Exception:
        p = {"mode": "all", "sound": "chime", "chats": {}}
    if not wanted(p, thread_id, kind):
        return
    body = genui.plain(body)
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
