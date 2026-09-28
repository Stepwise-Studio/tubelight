"""The chat brief: a running summary of one conversation that everyone reads.

Teammates see recent messages verbatim, but a long day's chat outgrows any window (and the small fallback models see
only a few thousand tokens). After every reply a small model folds the new messages into the brief: open loops with
owners and times, decisions, what's in progress, and context later messages rely on. Teammates, the floor director and
voice all read it, so "the thing from this morning" survives. Exact wording is one search_chat call away.
"""
import asyncio
import logging
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from langchain_core.messages import HumanMessage, SystemMessage

from . import config, db, llm, memory

log = logging.getLogger(__name__)
MAX_NEW = 80  # messages folded in per refresh (older ones are already in the brief)
_tasks: set[asyncio.Task] = set()

PROMPT = """You keep the running brief of a chat in the Tubelight app between {user} and their AI teammates. Everyone
reads it to pick the conversation back up without scrolling, so it must hold everything that still matters. It is now
{now} for {user}.

Update the brief with the new messages. At most 250 words, in these sections (leave out empty ones):
Open loops: what's promised, pending or to circle back to: who owes it, and when, as an absolute day and time.
Decisions: what was agreed.
In progress: ongoing tasks, games or discussions, and where they stand.
Context: facts about this chat's topics that later messages rely on.
Drop what's resolved or no longer matters. Write about {user} by name, never as he or she. Reply with the brief only."""


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


async def refresh(owner_id: str, thread_id: str, user: str, tz: str) -> bool:
    """Fold messages newer than the brief into it. False when there was nothing new."""
    item = await memory.store.aget(_ns(thread_id), "brief")
    old = item.value if item else {}
    rows = await db.select("messages", {
        "thread_id": f"eq.{thread_id}", "kind": "in.(text,handoff)", "order": "created_at.desc", "limit": str(MAX_NEW),
        "select": "created_at,sender_type,teammate_id,text,meta",
        **({"created_at": f"gt.{old['upto']}"} if old.get("upto") else {}),
    })
    rows = [r for r in reversed(rows) if not (r.get("meta") or {}).get("voice_task")]
    if not rows:
        return False
    zone = _zone(tz)
    ids = {r["teammate_id"] for r in rows if r["teammate_id"]}
    names = {t["id"]: t["name"] for t in await db.select("teammates", {"id": f"in.({','.join(ids)})", "select": "id,name"})} if ids else {}
    lines = [f"[{datetime.fromisoformat(r['created_at']).astimezone(zone):%a %b %d, %I:%M %p}] "
             f"{user if r['sender_type'] == 'user' else names.get(r['teammate_id'], 'Teammate')}: {r['text'][:600]}"
             for r in rows]
    now = datetime.now(UTC).astimezone(zone)
    res = await llm.chat_model(config.LEARN_MODEL).ainvoke([
        SystemMessage(PROMPT.format(user=user, now=f"{now:%A, %B %d, %Y, %I:%M %p}")),
        HumanMessage(f"Current brief:\n{old.get('text') or '(empty: this is the start)'}\n\nNew messages:\n" + "\n".join(lines)),
    ])
    text = res.text.strip()
    if text:
        # Not embedded (index=False): it's read by key, never searched.
        await memory.store.aput(_ns(thread_id), "brief", {"text": text[:3000], "upto": rows[-1]["created_at"],
                                                          "owner_id": owner_id}, index=False)
    return bool(text)


def schedule(*args: Any) -> None:
    """Fire and forget after a reply: a slow or failed refresh must never touch the reply itself."""
    async def run() -> None:
        try:
            await refresh(*args)
        except Exception:
            log.exception("brief refresh failed")

    task = asyncio.create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
