"""The chat keeper: after every reply, one small call keeps each chat's brief and follow-ups in step.

The brief is a running summary that everyone reads (teammates, the floor director, voice), so a long day's chat
survives any message window: open loops with owners and times or conditions, decisions, what's in progress, context.

In the same call the keeper reconciles follow-ups against the brief's open loops, like a controller's reconcile loop:
- add: an agreed or promised circle-back with no follow-up yet (nobody has to remember to set one);
- met: a pending condition ("once the design tweak is done") the new messages show is now true, from any of the
  user's chats: that follow-up fires in its own chat;
- cancel: follow-ups the messages show are done already or dropped.
Mistakes get fixed by adding a case to evals/keeper.py and improving the prompt, not with code for each case.
"""
import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from langchain_core.messages import HumanMessage, SystemMessage

from . import config, db, followups, llm, memory

log = logging.getLogger(__name__)
MAX_NEW = 80  # messages folded in per pass (older ones are already in the brief)
MAX_ADDS = 3
_tasks: set[asyncio.Task] = set()

PROMPT = """You keep a chat in the Tubelight app between {user} and AI teammates ({roster}). It is now {now} for {user}.
You do two things with the new messages.

1. brief: update the running brief everyone reads to pick the conversation back up. At most 250 words, in these
sections (leave out empty ones): Open loops (what's promised, pending or to circle back to: who owes it, and when as
an absolute day and time, or on what condition), Decisions, In progress, Context. Drop what's resolved.

2. follow-ups: things someone must come back to later. Compare the open loops with the pending follow-ups listed
below (they include the user's other chats, so news here can settle a condition set elsewhere).
- add: a circle-back that was agreed, requested or promised and has no pending follow-up yet. Only concrete ones,
  never vague maybes. Either a time ("at 6pm", "tomorrow morning": give an absolute local time) or a condition
  ("once the design tweak is done": give a short, checkable `until`). owner: the handle of who should act then, or
  "group" when the whole group should pick it up. `what` is the action to take then ("ship the site"), never the
  reminder itself. For a condition also give `check_by` if a deadline was said or is clearly implied (the nudge at
  that time is automatic, so don't make it the `what`), and `poll_hours` only when the condition can be checked in
  an app (a PR merging, an email arriving) rather than someone saying it in chat. Example: "once the design is done,
  ship it; if it isn't done by Wednesday, ping me" is one follow-up: what "ship it", until "the design is done",
  check_by Wednesday.
- met: pending follow-ups with a condition ("once ...") that the new messages show is now true, with a few words of
  evidence. Only conditions: a timed follow-up that's no longer needed goes in cancel.
- cancel: pending follow-ups the new messages show are no longer needed (already done, dropped, replaced).
A progress update ("still working on it") changes nothing when a pending follow-up already covers it. Casual chat
changes nothing. Write about {user} by name, never as he or she.

Reply with JSON only:
{{"brief": "...",
 "add": [{{"what": "<what to do then, self-contained>", "owner": "<handle or group>", "at": "YYYY-MM-DDTHH:MM or null",
          "until": "<condition or null>", "check_by": "YYYY-MM-DDTHH:MM or null", "poll_hours": null}}],
 "met": [{{"id": "<id>", "evidence": "<few words>"}}],
 "cancel": ["<id>"]}}"""


def _zone(tz: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _ns(thread_id: str) -> tuple[str, ...]:
    return ("thread", thread_id)


async def get(thread_id: str) -> str:
    item = await memory.store.aget(_ns(thread_id), "brief")
    return (item.value.get("text") or "") if item else ""


async def _members(thread: dict) -> list[dict]:
    if thread["kind"] == "dm":
        return await db.select("teammates", {"id": f"eq.{thread['teammate_id']}", "select": "id,name,handle"})
    links = await db.select("project_members", {"project_id": f"eq.{thread['project_id']}", "select": "teammate_id"})
    ids = [l["teammate_id"] for l in links]
    return await db.select("teammates", {"id": f"in.({','.join(ids)})", "select": "id,name,handle"}) if ids else []


async def _chat_names(owner_id: str, thread_ids: set[str]) -> dict[str, str]:
    names = {}
    for tid in thread_ids:
        kind, _, ref = tid.partition(":")
        row = await db.one("teammates" if kind == "dm" else "projects", {"id": f"eq.{ref}", "select": "name"})
        names[tid] = (f"DM with {row['name']}" if kind == "dm" else f"group {row['name']}") if row else tid
    return names


def _parse(text: str) -> dict[str, Any]:
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(text[start:end + 1])
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
    # Not JSON: keep it as the brief if it looks like one, change no follow-ups.
    return {"brief": text.strip()} if text.strip() and not text.lstrip().startswith("{") else {}


def _local(s: Any, zone: ZoneInfo) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(s)) if s and str(s).lower() != "null" else None
    except ValueError:
        return None
    return (d if d.tzinfo else d.replace(tzinfo=zone)) if d else None


async def decide(user: str, roster: str, now: datetime, brief: str, pending: str, lines: list[str]) -> dict[str, Any]:
    """The keeper's one model call: the new brief and follow-up changes (evals/keeper.py runs this on real models)."""
    res = await llm.chat_model(config.KEEPER_MODEL, json=True).ainvoke([
        SystemMessage(PROMPT.format(user=user, now=f"{now:%A, %B %d, %Y, %I:%M %p}", roster=roster)),
        HumanMessage(f"Current brief:\n{brief or '(empty: this is the start)'}\n\n"
                     f"Pending follow-ups:\n{pending}\n\nNew messages in this chat:\n" + "\n".join(lines)),
    ])
    return _parse(res.text)


async def refresh(owner_id: str, thread_id: str, user: str, tz: str) -> dict[str, int] | None:
    """Fold new messages into the brief and reconcile follow-ups. None when there was nothing new."""
    thread = await db.one("threads", {"id": f"eq.{thread_id}", "owner_id": f"eq.{owner_id}"})
    if not thread:
        return None
    item = await memory.store.aget(_ns(thread_id), "brief")
    old = item.value if item else {}
    rows = await db.select("messages", {
        "thread_id": f"eq.{thread_id}", "kind": "in.(text,handoff)", "order": "created_at.desc", "limit": str(MAX_NEW),
        "select": "created_at,sender_type,teammate_id,text,meta",
        **({"created_at": f"gt.{old['upto']}"} if old.get("upto") else {}),
    })
    rows = [r for r in reversed(rows) if not (r.get("meta") or {}).get("voice_task")]
    if not rows:
        return None
    zone = _zone(tz)
    members = await _members(thread)
    names = {m["id"]: m["name"] for m in members}
    lines = [f"[{datetime.fromisoformat(r['created_at']).astimezone(zone):%a %b %d, %I:%M %p}] "
             f"{user if r['sender_type'] == 'user' else names.get(r['teammate_id'], 'Teammate')}: {r['text'][:600]}"
             for r in rows]
    pend = await followups.pending(owner_id)
    chats = await _chat_names(owner_id, {f["thread_id"] for f in pend})
    owners = {f["owner"] for f in pend if f["owner"] != "group"}  # follow-ups from other chats name their own owners
    who = {m["id"]: f"@{m['handle']}" for m in members}
    if owners - who.keys():
        who |= {t["id"]: f"@{t['handle']}" for t in await db.select(
            "teammates", {"id": f"in.({','.join(owners - who.keys())})", "select": "id,handle"})}
    listed = "\n".join(f"- id {f['id']} [{chats.get(f['thread_id'], 'another chat')}] "
                       f"{who.get(f['owner'], 'group' if f['owner'] == 'group' else 'a teammate')}: {followups.describe(f, tz)}"
                       for f in pend) or "(none)"
    now = datetime.now(UTC).astimezone(zone)
    plan = await decide(user, ", ".join(f"@{m['handle']} ({m['name']})" for m in members), now,
                        old.get("text") or "", listed, lines)
    done = {"add": 0, "met": 0, "cancel": 0}
    if plan.get("brief"):
        await memory.store.aput(_ns(thread_id), "brief", {"text": str(plan["brief"])[:3000], "upto": rows[-1]["created_at"],
                                                          "owner_id": owner_id}, index=False)
    ids = {f["id"]: f for f in pend}
    by_handle = {m["handle"]: m["id"] for m in members}
    for a in (plan.get("add") or [])[:MAX_ADDS]:
        at, until = _local(a.get("at"), zone), (a.get("until") or None)
        if not a.get("what") or not (at or until) or (at and not now < at < now + timedelta(days=60)):
            continue
        owner = (thread["teammate_id"] if thread["kind"] == "dm"
                 else by_handle.get(str(a.get("owner", "")).lstrip("@").lower(), "group"))
        await followups.add(owner_id, thread_id, owner, str(a["what"]), at=at, until=None if at else str(until),
                            check_by=_local(a.get("check_by"), zone), poll_hours=a.get("poll_hours") or None,
                            set_by="keeper", set_at=f"{now:%a %b %d, %I:%M %p}")
        done["add"] += 1
    for m in plan.get("met") or []:
        f = ids.get(str((m or {}).get("id")))
        if not f:
            continue
        if not f.get("until"):  # "met" on a timed one means it's already handled: nothing left to fire
            plan.setdefault("cancel", []).append(f["id"])
        elif await followups.fire(f["id"], "met", str(m.get("evidence") or "")[:200]):
            done["met"] += 1
    for k in dict.fromkeys(plan.get("cancel") or []):
        if str(k) in ids and await followups.cancel(str(k), owner_id):
            done["cancel"] += 1
    return done


def schedule(*args: Any) -> None:
    """Fire and forget after a reply: a slow or failed pass must never touch the reply itself."""
    async def run() -> None:
        try:
            changes = await refresh(*args)
            if changes and any(changes.values()):
                log.info("keeper: %s", changes)
        except Exception:
            log.exception("keeper pass failed")

    task = asyncio.create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
