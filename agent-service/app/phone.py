"""The user's phone, as its own teammate (avatar_shape "phone", one per user, its own chat; the phone's assistant panel
talks to it). It's the only one with the phone: other teammates ask it (`ask_phone`), and what they ask waits for the
user's OK in the phone's chat.

Actions its reply carries out there (the app does them as the reply lands: alarms and
timers silently, calls/texts/emails opened ready to send), and the notifications the phone shares (opt-in, the
last day, synced by the app when it opens) for a teammate to look through."""
import re
import time
from datetime import datetime, timedelta
from typing import Any

from . import config, memory

DAY = 24 * 3600
KINDS = ("alarm", "timer", "call", "text", "whatsapp", "email", "navigate", "calendar", "open_app", "open_url", "search")


def _clock(s: str) -> tuple[int, int] | None:
    """'6:30', '06:30', '6.30 pm', '18:30', or an ISO date-time -> (hour, minute)."""
    m = re.search(r"(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b", s.strip(), re.I)
    if "T" in s:
        try:
            d = datetime.fromisoformat(s.strip().rstrip("Z"))
            return d.hour, d.minute
        except ValueError:
            pass
    if not m or (not m.group(2) and not m.group(3)):
        return None
    h, mi = int(m.group(1)), int(m.group(2) or 0)
    if m.group(3):
        h = h % 12 + (12 if m.group(3).lower() == "pm" else 0)
    return (h, mi) if h < 24 and mi < 60 else None


def action(kind: str, when: datetime | None, end: datetime | None, raw_when: str, **f: Any) -> dict[str, Any] | str:
    """The action for the app, or a message saying what's missing."""
    kind = kind.strip().lower()
    if kind not in KINDS:
        return f"Unknown action {kind!r}: use one of {', '.join(KINDS)}."
    a: dict[str, Any] = {"action": kind, **{k: v for k, v in f.items() if v}}
    if kind == "alarm":
        hm = _clock(raw_when)
        if not hm:
            return "Give the alarm time in `when`, like 06:30."
        a |= {"hour": hm[0], "minute": hm[1]}
    elif kind == "timer" and not f.get("seconds"):
        return "Give the timer length in `seconds`."
    elif kind == "calendar":
        if not when:
            return "Give the start in `when` as a date-time, like 2026-10-05T15:00."
        a |= {"start": int(when.timestamp() * 1000), "end": int((end or when + timedelta(hours=1)).timestamp() * 1000)}
    elif kind in ("call", "text", "whatsapp") and not f.get("number"):
        return "I need their phone number (I can't see the phone's contacts): ask for it, or look it up in a connected app."
    elif kind == "navigate" and not f.get("place"):
        return "Say where to in `place`."
    elif kind == "open_app" and not f.get("app"):
        return "Say which app in `app`."
    elif kind == "open_url" and not str(f.get("url", "")).startswith(("http://", "https://")):
        return "Give a full https:// link in `url`."
    return a


# ------------------------------------------------------------------ the phone's own teammate
PROMPT = """You are {name}, {owner}'s phone, talking with them in Tubelight (and when they hold the side key: your
panel opens over whatever they're doing, and you see what was on screen). You are the only one who can do things on
this phone: set alarms and timers, open apps, get calls, texts, WhatsApp messages and emails ready to send, start
directions, put events in the calendar and, if they shared them, look through their notifications. For a reminder at a
later time, set a follow-up. Other teammates ask you for things on the phone: say what they asked and why, and
remember that anything you do for them waits for {owner}'s OK.
Keep replies to a line or two: they're usually glancing at the phone."""


def is_phone(tm: dict[str, Any]) -> bool:
    return tm.get("avatar_shape") == "phone"


async def mate(owner_id: str) -> dict[str, Any] | None:
    """The user's phone teammate, if their phone has registered one."""
    from . import db
    return await db.one("teammates", {"owner_id": f"eq.{owner_id}", "avatar_shape": "eq.phone"})


async def ensure(owner_id: str, name: str) -> dict[str, Any]:
    """The phone's teammate, made the first time the app runs on a phone that can do phone actions."""
    from . import db
    if have := await mate(owner_id):
        return have
    name = re.sub(r"\s+", " ", name).strip()[:40] or "Phone"
    taken = {t["handle"] for t in await db.select("teammates", {"owner_id": f"eq.{owner_id}", "select": "handle"})}
    base = re.sub(r"[^a-z0-9_-]", "", name.lower().replace(" ", "-"))[:20] or "phone"
    handle = next(h for h in [base, *(f"{base[:18]}-{i}" for i in range(2, 99))] if h not in taken)
    profile = await db.one("profiles", {"id": f"eq.{owner_id}"})
    owner = (profile or {}).get("display_name") or "the user"
    return await db.insert("teammates", {
        "owner_id": owner_id, "name": name, "handle": handle, "role": "Your phone",
        "bio": "Your phone's assistant. Hold the side key to talk to it over any app; other teammates go through it for anything on the phone.",
        "system_prompt": PROMPT.format(name=name, owner=owner), "model": config.DEFAULT_MODEL,
        "allowed_toolkits": [], "avatar_shape": "phone", "color": "#64748b",
    })


# ------------------------------------------------------------------ notifications
def _ns(owner_id: str) -> tuple[str, ...]:
    return ("phone", owner_id)


async def save_notes(owner_id: str, items: list[dict[str, Any]]) -> int:
    """Merge what the phone sent (deduped by key), keeping the last day, newest 300."""
    item = await memory.store.aget(_ns(owner_id), "notifications")
    have = {n["key"]: n for n in (item.value.get("items") if item else [])}
    for n in items:
        if n.get("key"):
            have[str(n["key"])] = {k: n.get(k) for k in ("key", "app", "title", "text", "at")}
    cutoff = (time.time() - DAY) * 1000
    keep = sorted((n for n in have.values() if (n.get("at") or 0) > cutoff), key=lambda n: n["at"])[-300:]
    await memory.store.aput(_ns(owner_id), "notifications", {"items": keep, "synced": time.time()}, index=False)
    return len(keep)


async def has_notes(owner_id: str) -> bool:
    try:
        item = await memory.store.aget(_ns(owner_id), "notifications")
    except Exception:
        return False
    return bool(item and item.value.get("items") and time.time() - item.value.get("synced", 0) < DAY)


async def notes(owner_id: str, query: str, app: str, hours: int, zone) -> str:
    item = await memory.store.aget(_ns(owner_id), "notifications")
    if not item or not item.value.get("items"):
        return "Their phone hasn't shared notifications (Profile → Phone → Notifications)."
    since = (time.time() - max(1, min(hours, 24)) * 3600) * 1000
    words = [w for w in query.lower().split() if w]
    rows = [n for n in item.value["items"] if n["at"] > since and (not app or app.lower() in str(n.get("app", "")).lower())
            and all(w in f"{n.get('app')} {n.get('title')} {n.get('text')}".lower() for w in words)]
    synced = datetime.fromtimestamp(item.value.get("synced", 0), zone).strftime("%H:%M")
    if not rows:
        return f"No notifications match (phone last synced at {synced})."
    lines = [f"{datetime.fromtimestamp(n['at'] / 1000, zone).strftime('%a %H:%M')} · {n.get('app')} · {n.get('title')}: {n.get('text')}"
             for n in rows[-60:]]
    return f"Notifications on their phone (synced {synced}, oldest first):\n" + "\n".join(lines)
