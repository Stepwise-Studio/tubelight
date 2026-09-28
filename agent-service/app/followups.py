"""Follow-ups: a teammate comes back to a chat at a set time ("circle back at 7", "remind me tomorrow morning").

The follow_up tool stores {when, what, who, where}; the server's minute clock (events.tick) wakes that teammate in that
chat when it's due, as a proactive run, so the message and push notification reach the user on their own.
"""
import logging
import uuid
from datetime import UTC, datetime

from . import memory

log = logging.getLogger(__name__)
NS = ("followups",)


async def add(owner_id: str, thread_id: str, teammate_id: str, at: datetime, what: str, set_at: str) -> None:
    # Not embedded (index=False): due ones are found by time, never searched.
    await memory.store.aput(NS, str(uuid.uuid4()), {
        "owner_id": owner_id, "thread_id": thread_id, "teammate_id": teammate_id, "at": at.astimezone(UTC).isoformat(),
        "what": what[:500], "set_at": set_at,
    }, index=False)


async def fire_due(now: datetime | None = None) -> int:
    """Start a run for every follow-up whose time has come. Each fires once: it's removed before its run starts."""
    from . import runs  # runs -> graph -> tools -> followups: import at call time

    now = now or datetime.now(UTC)
    fired = 0
    # ponytail: scans every pending follow-up each minute; index by time if there are ever thousands.
    for item in await memory.store.asearch(NS, limit=1000):
        f = item.value
        if datetime.fromisoformat(f["at"]) > now:
            continue
        await memory.store.adelete(NS, item.key)
        try:
            await runs.start(f["owner_id"], f["thread_id"],
                             f"[Follow-up you set {f['set_at']}: {f['what']}] It's time now: do it and message them here.",
                             trigger="schedule", teammate_id=f["teammate_id"], sender="follow_up")
            fired += 1
        except Exception:
            log.exception("follow-up %s failed to start", item.key)
    return fired
