"""Follow-ups: coming back to a chat later, by time or once something is true.

A follow-up is an event-condition-action rule:
- owner: the teammate who acts, or "group" (in a project chat, the floor director picks who picks it up);
- trigger: a time (`at`), or a plain-language condition (`until`, "the design tweak is done");
- for conditions: an optional deadline (`check_by`: nudge if it still isn't met) and polling (`poll_hours`: the owner
  silently checks with their apps, like an Airflow sensor, for things no one will say in chat, e.g. a PR merging).

They're set by the follow_up tool, and by the keeper (brief.py) that reconciles each chat's open loops after every
reply: it adds circle-backs nobody set, marks conditions met (from any chat), and cancels dropped ones.
The minute clock (events.tick -> tick) fires due ones. A lease makes firing safe across crashes: a follow-up is claimed,
its run started, then removed; a claim older than LEASE is retried. Firing after downtime says how late it is.
"""
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from . import db, memory

log = logging.getLogger(__name__)
NS = ("followups",)
LEASE = timedelta(minutes=5)
MIN_POLL_H, MAX_WAIT = 0.5, timedelta(days=14)  # sensors check at most every 30 min and give up after two weeks
_polls: dict[str, str] = {}  # check run id -> follow-up id


def _utc(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s) if s else None


def _iso(d: datetime | None) -> str | None:
    return d.astimezone(UTC).isoformat() if d else None


async def note(f: dict[str, Any], event: str, by: str = "") -> None:
    """A capsule in the chat for each step of a follow-up's life, so everyone sees what's pending and why."""
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        zone = ZoneInfo(await db.user_timezone(f["owner_id"]) or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    if f.get("at"):
        at = _utc(f["at"]).astimezone(zone)
        clock = f"{at:%I:%M %p}".lstrip("0")
        when = f"for {clock}" if at.date() == datetime.now(zone).date() else f"for {at:%a %b %d}, {clock}"
    else:
        when = f"for when {f['until']}"
    text = {
        "created": f"{by} set a follow-up {when}: {f['what']}",
        "noted": f"Follow-up noted {when}: {f['what']}",
        "cancelled": f"{by} cancelled a follow-up: {f['what']}",
        "dropped": f"Follow-up dropped: {f['what']}",
        "done": f"Follow-up done: {f['what']}",
        "fired": f"Follow-up: {f['what']}",
    }[event]
    await db.insert("messages", {"thread_id": f["thread_id"], "owner_id": f["owner_id"], "sender_type": "system",
                                 "kind": "event", "text": text,
                                 "meta": {"followup": event}})


async def add(owner_id: str, thread_id: str, owner: str, what: str, *, at: datetime | None = None,
              until: str | None = None, check_by: datetime | None = None, poll_hours: float | None = None,
              set_by: str = "", set_at: str = "", by: str = "") -> str:
    """owner: a teammate id, or "group". Needs `at` or `until`. `by`: who set it, for the chat's capsule
    ("Calendy set a follow-up..."); empty when the keeper picked it up from the chat ("Follow-up noted...")."""
    if not (at or until):
        raise ValueError("a follow-up needs a time or a condition")
    key = str(uuid.uuid4())
    # Not embedded (index=False): found by owner/thread/time, never by meaning.
    value = {
        "owner_id": owner_id, "thread_id": thread_id, "owner": owner, "what": what[:500], "at": _iso(at),
        "until": (until or "")[:300] or None, "check_by": _iso(check_by),
        "poll_hours": max(poll_hours, MIN_POLL_H) if poll_hours else None, "last_poll": None, "claimed": None,
        "created": _iso(datetime.now(UTC)), "set_by": set_by, "set_at": set_at,
    }
    await memory.store.aput(NS, key, value, index=False)
    await note(value, "created" if by else "noted", by)
    return key


async def pending(owner_id: str, thread_id: str | None = None) -> list[dict[str, Any]]:
    """Pending follow-ups of one user (optionally one chat), soonest first; each with its id."""
    flt = {"owner_id": owner_id, **({"thread_id": thread_id} if thread_id else {})}
    items = await memory.store.asearch(NS, filter=flt, limit=500)
    rows = [{"id": i.key, **i.value} for i in items]
    return sorted(rows, key=lambda f: f.get("at") or f.get("check_by") or "9999")


async def cancel(key: str, owner_id: str, event: str = "cancelled", by: str = "You") -> bool:
    """event: cancelled (by someone), dropped (no longer needed) or done (already handled)."""
    item = await memory.store.aget(NS, key)
    if not item or item.value.get("owner_id") != owner_id:
        return False
    await memory.store.adelete(NS, key)
    await note(item.value, event, by)
    return True


def describe(f: dict[str, Any], tz_name: str = "UTC") -> str:
    """One line for prompts: what, whose, and when or on what."""
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        zone = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    when = (f"at {_utc(f['at']).astimezone(zone):%a %b %d, %I:%M %p}" if f.get("at")
            else f"once {f['until']}" + (f", nudge by {_utc(f['check_by']).astimezone(zone):%a %I:%M %p}" if f.get("check_by") else ""))
    return f"{f['what']} ({when})"


async def fire(key: str, reason: str, evidence: str = "") -> bool:
    """Wake the owner (or the group) in the follow-up's chat. Returns False if it's gone or already being fired."""
    from . import runs  # runs -> graph -> tools -> followups: import at call time

    item = await memory.store.aget(NS, key)
    if not item:
        return False
    f = item.value
    now = datetime.now(UTC)
    if f.get("claimed") and now - _utc(f["claimed"]) < LEASE:
        return False
    await memory.store.aput(NS, key, {**f, "claimed": _iso(now)}, index=False)
    thread = await db.one("threads", {"id": f"eq.{f['thread_id']}", "owner_id": f"eq.{f['owner_id']}"})
    if not thread:  # the chat was deleted
        await memory.store.adelete(NS, key)
        return False
    due = _utc(f.get("at")) if reason == "time" else _utc(f.get("check_by")) if reason == "deadline" else None
    late = f" It was due {int((now - due).total_seconds() // 3600)} h ago (the server was off)." if due and now - due > timedelta(minutes=10) else ""
    lead = {
        "time": f"[Follow-up set {f.get('set_at') or 'earlier'}: {f['what']}] It's time now.",
        "met": f"[Follow-up set {f.get('set_at') or 'earlier'}: {f['what']}] Its condition is met: {f['until']}."
               + (f" ({evidence})" if evidence else ""),
        "deadline": f"[Follow-up set {f.get('set_at') or 'earlier'}: {f['what']}] Still waiting on: {f['until']}, and "
                    "it's past the time to check. Ask where it stands and decide what to do.",
    }[reason]
    await note(f, "fired")  # everyone sees why someone is speaking up
    # A DM's teammate picks it up. In a group it goes through the floor director like any message: the owner leads,
    # and whoever else it concerns joins (a verdict for everyone, a circle-back several members worked on).
    teammate, lead_by = (thread["teammate_id"], "") if thread["kind"] == "dm" else (None, await _lead(f))
    await runs.start(f["owner_id"], f["thread_id"], f"{lead}{lead_by}{late} Pick it up and message them here.",
                     trigger="schedule", teammate_id=teammate, sender="follow_up", event_type="follow_up",
                     lead=None if f["owner"] == "group" else f["owner"])
    await memory.store.adelete(NS, key)
    return True


async def _lead(f: dict[str, Any]) -> str:
    """Who leads a group follow-up, for the floor director: its owner, if still a member."""
    if f["owner"] == "group":
        return " It's for the whole group."
    row = await db.one("teammates", {"id": f"eq.{f['owner']}", "select": "handle"})
    return f" @{row['handle']} set it and leads; the members it concerns follow." if row else ""


async def poll(key: str, now: datetime | None = None) -> None:
    """A silent check: the owner looks with their apps; NOT_YET replies are dropped (graph), a real one is the follow-up."""
    from . import runs

    item = await memory.store.aget(NS, key)
    if not item:
        return
    f = item.value
    thread = await db.one("threads", {"id": f"eq.{f['thread_id']}"})
    if not thread:
        await memory.store.adelete(NS, key)
        return
    await memory.store.aput(NS, key, {**f, "last_poll": _iso(now or datetime.now(UTC))}, index=False)
    owner = thread.get("teammate_id") if thread["kind"] == "dm" else None if f["owner"] == "group" else f["owner"]
    if not owner:
        links = await db.select("project_members", {"project_id": f"eq.{thread['project_id']}", "order": "added_at", "limit": "1"})
        owner = links[0]["teammate_id"] if links else None
    if not owner:
        return
    run_id = await runs.start(
        f["owner_id"], f["thread_id"],
        f"[Checking a follow-up: is this done yet? \"{f['until']}\". Check with your apps. If it isn't, reply exactly "
        f"NOT_YET and nothing else. If it is, say so here and pick up: {f['what']}]",
        trigger="schedule", teammate_id=owner, sender="follow_up_check", event_type="follow_up")
    _polls[run_id] = key


async def after_run(run_id: str) -> None:
    """A check run that spoke found the condition met, and already acted: the follow-up is done."""
    key = _polls.pop(run_id, None)
    if key and await db.select("messages", {"run_id": f"eq.{run_id}", "sender_type": "eq.teammate", "select": "id"}):
        item = await memory.store.aget(NS, key)
        if item:
            await memory.store.adelete(NS, key)
            await note(item.value, "done")


async def tick(now: datetime | None = None) -> int:
    """Fire what's due: times, deadlines (and two-week expiry) of conditions, and poll checks. Returns runs started."""
    now = now or datetime.now(UTC)
    started = 0
    # ponytail: scans every pending follow-up each minute; index by time if there are ever thousands.
    for item in await memory.store.asearch(NS, limit=1000):
        f, key = item.value, item.key
        try:
            if f.get("at"):
                if _utc(f["at"]) <= now:
                    started += await fire(key, "time")
                continue
            deadline = _utc(f.get("check_by")) or _utc(f["created"]) + MAX_WAIT
            if deadline <= now:
                started += await fire(key, "deadline")
            elif f.get("poll_hours") and now - (_utc(f.get("last_poll")) or _utc(f["created"])) >= timedelta(hours=f["poll_hours"]):
                await poll(key, now)
                started += 1
        except Exception:
            log.exception("follow-up %s failed", key)
    return started
