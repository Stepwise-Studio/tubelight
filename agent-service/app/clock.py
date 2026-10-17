"""Tubelight's own alarms and reminders (the Tasks tab's clock), set by the user or by any teammate (tools `alarms`,
`reminders`). The phone keeps the list and schedules them itself (modules/phone Clock.kt: an alarm rings full screen
until stopped, a reminder is a notification with Done and Snooze), so they work with the server or the network down.

Alarm: time HH:MM, days 0-6 (Monday first; none = once), label, enabled; a one-off also has `at`, the moment it rings
(set whenever it's switched on), so a phone that syncs late never rings it a day off. Reminder: title, notes, `at` (an
ISO date-time with its offset), repeat (daily, weekdays, weekly, monthly, yearly), done.
"""
import re
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from . import items

DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
REPEATS = ("", "daily", "weekdays", "weekly", "monthly", "yearly")
# The ringing screen's gradients (the app's lib/clock.ts LOOKS has their colours).
LOOKS = ("aurora", "dawn", "ocean", "ember", "forest")


def _when(v: Any) -> str | None:
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("Give the time as an ISO date-time, like 2026-10-14T18:00.") from None
    if not d.tzinfo:
        raise ValueError("The time needs its UTC offset.")
    return d.isoformat()


def _clean_alarm(r: dict[str, Any]) -> dict[str, Any]:
    t = str(r.get("time") or "")
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", t):
        raise ValueError("Give the alarm time as HH:MM, 24-hour.")
    days = sorted({int(d) for d in (r.get("days") or []) if 0 <= int(d) <= 6})
    look = str(r.get("look") or "aurora")
    return {"time": t, "days": days, "label": str(r.get("label") or "").strip()[:60], "enabled": bool(r.get("enabled", True)),
            "at": None if days else _when(r.get("at")), "sound": str(r.get("sound") or "")[:500],
            "look": look if look in LOOKS else "aurora"}


def _clean_reminder(r: dict[str, Any]) -> dict[str, Any]:
    title = " ".join(str(r.get("title") or "").split())[:300]
    if not title:
        raise ValueError("A reminder needs a title.")
    if (r.get("repeat") or "") not in REPEATS:
        raise ValueError(f"Repeat is one of: {', '.join(x for x in REPEATS if x)}, or empty.")
    at = _when(r.get("at"))
    if not at:
        raise ValueError("A reminder needs a time.")
    done = bool(r.get("done"))
    return {"title": title, "notes": str(r.get("notes") or "")[:2000], "at": at, "repeat": r.get("repeat") or "",
            "done": done, "done_at": (r.get("done_at") or datetime.now(UTC).isoformat()) if done else None}


ALARMS = items.Items("alarms", _clean_alarm, {"time": "07:00", "days": [], "label": "", "enabled": True, "at": None, "sound": "",
                                              "look": "aurora"}, "time")
REMINDERS = items.Items("reminders", _clean_reminder, {"title": "", "notes": "", "at": None, "repeat": "", "done": False}, "at")


def next_at(hhmm: str, zone: ZoneInfo, now: datetime | None = None) -> str:
    """The next moment a once-only alarm at HH:MM rings, in the user's zone."""
    now = (now or datetime.now(zone)).astimezone(zone)
    h, m = map(int, hhmm.split(":"))
    at = datetime.combine(now.date(), time(h, m), zone)
    return (at if at > now else at + timedelta(days=1)).isoformat()


def is_on(a: dict[str, Any], now: datetime | None = None) -> bool:
    """A once-only alarm switches itself off by ringing."""
    if not a.get("enabled"):
        return False
    return bool(a.get("days")) or bool(a.get("at") and datetime.fromisoformat(a["at"]) > (now or datetime.now().astimezone()))


def days_text(days: list[int]) -> str:
    if not days:
        return "once"
    if days == list(range(7)):
        return "every day"
    if days == list(range(5)):
        return "weekdays"
    if days == [5, 6]:
        return "weekends"
    return ", ".join(DAYS[d] for d in days)


def parse_days(s: str) -> list[int]:
    """'weekdays', 'daily', 'weekends', 'mon,wed,fri', '' (once)."""
    s = s.strip().lower()
    if s in ("", "once", "none"):
        return []
    if s in ("daily", "every day", "everyday"):
        return list(range(7))
    if s == "weekdays":
        return list(range(5))
    if s == "weekends":
        return [5, 6]
    out = [i for part in re.split(r"[,\s]+", s) if part for i, d in enumerate(DAYS) if d.lower() == part[:3]]
    if not out:
        raise ValueError("days: weekdays, weekends, daily, or names like mon,wed,fri.")
    return out


def describe_alarm(a: dict[str, Any]) -> str:
    label = f" '{a['label']}'" if a.get("label") else ""
    return f"- [{a['id'][:8]}] {a['time']}{label} · {days_text(a.get('days') or [])} · {'on' if is_on(a) else 'off'}"


def describe_reminder(r: dict[str, Any], zone: ZoneInfo) -> str:
    at = datetime.fromisoformat(r["at"]).astimezone(zone)
    bits = [f"{at:%a %b %d %H:%M}", *([f"repeats {r['repeat']}"] if r.get("repeat") else []), *(["done"] if r.get("done") else [])]
    notes = f" — {r['notes'][:120]}" if r.get("notes") else ""
    return f"- [{r['id'][:8]}] {r['title']} · {' · '.join(bits)}{notes}"


def local(s: str, zone: ZoneInfo) -> str:
    """Their local 'YYYY-MM-DDTHH:MM' (or 'HH:MM' for today, or tomorrow if that's passed) as an ISO moment."""
    s = s.strip()
    if re.fullmatch(r"\d{1,2}:\d{2}", s):
        return next_at(s.zfill(5), zone)
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        raise ValueError("Give the time as YYYY-MM-DDTHH:MM in their local time.") from None
    if isinstance(d, date) and not isinstance(d, datetime):
        d = datetime.combine(d, time(9))
    return (d if d.tzinfo else d.replace(tzinfo=zone)).isoformat()


async def find(coll: items.Items, owner_id: str, ref: str, field: str) -> dict[str, Any] | None:
    """By id or its first characters (what the tools show), or by the exact title/label/time."""
    ref = ref.strip().strip("[]")
    rows = await coll.listing(owner_id)
    hits = [r for r in rows if r["id"].startswith(ref)] if len(ref) >= 6 else []
    hits = hits or [r for r in rows if str(r.get(field, "")).lower() == ref.lower()]
    return hits[0] if len(hits) == 1 else None
