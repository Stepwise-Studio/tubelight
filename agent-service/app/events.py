"""Webhook events, rule matching, rate limits and the cron scheduler."""
import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from croniter import croniter

from . import db, followups, runs

log = logging.getLogger(__name__)
SLOT_GRACE_S = 120  # a schedule slot older than this (e.g. after downtime) is skipped, not replayed

EMAIL_TRIAGE = (
    "\n\nThis is an email. First rate its importance for the user from 1 (spam) to 5 (needs them today). "
    "If the score is below 4, reply with exactly 'SKIP <score>: <one-line reason>' and nothing else. "
    "Otherwise post a short heads-up: who, what they want, by when, your suggested next step, and the score."
)
SAMPLES: dict[str, dict[str, Any]] = {
    "email": {"from": "jane@acme.com", "subject": "Contract renewal needs your signature by Friday",
              "snippet": "Hi, our renewal is due this week. Can you sign the attached order form by Friday?"},
    "error": {"message": "TypeError: Cannot read properties of undefined (reading 'map')", "service": "web", "count": 12},
    "github_issue": {"title": "Focus ring missing on Button in dark mode", "repo": "stepwise/ui", "number": 142},
}


def matches(rule: dict[str, Any], event_type: str, payload: dict[str, Any]) -> bool:
    return (rule.get("enabled", True) and rule["event_type"] == event_type
            and all(payload.get(k) == v for k, v in (rule.get("match") or {}).items()))


async def rate_limited(rule: dict[str, Any]) -> bool:
    since = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    recent = await db.select("events", {"rule_id": f"eq.{rule['id']}", "status": "eq.routed",
                                        "created_at": f"gte.{since}", "select": "id"})
    return len(recent) >= rule["max_per_hour"]


def _describe(event: dict[str, Any]) -> str:
    p = event["payload"] or {}
    headline = next((str(p[k]) for k in ("subject", "title", "message", "summary", "name") if p.get(k)), "")
    return f"{event['type'].replace('_', ' ').capitalize()} event from {event['source']}" + (f": {headline}" if headline else "")


async def fire(rule: dict[str, Any], event: dict[str, Any]) -> str:
    """Post the event into the rule's thread and start the teammate's run. Returns run_id."""
    thread_id = f"proj:{rule['project_id']}" if rule.get("project_id") else f"dm:{rule['teammate_id']}"
    await db.insert("messages", {
        "thread_id": thread_id, "owner_id": rule["owner_id"], "sender_type": "system", "kind": "event",
        "text": _describe(event)[:300], "proactive": True,
        "meta": {"event_id": event["id"], "event_type": event["type"], "rule_id": rule["id"]},
    })
    text = (f"[Event] type: {event['type']}, source: {event['source']}, rule: {rule['name']}\n"
            f"Instructions: {rule.get('instructions') or 'Decide what matters here and tell the user briefly.'}\n"
            f"Payload:\n```json\n{json.dumps(event['payload'], indent=1, default=str)[:6000]}\n```")
    if event["type"] == "email":
        text += EMAIL_TRIAGE
    run_id = await runs.start(rule["owner_id"], thread_id, text, trigger="schedule" if event["type"] == "schedule" else "event",
                              teammate_id=rule["teammate_id"], event_type=event["type"], sender="event")
    await db.update("events", {"id": f"eq.{event['id']}"}, {"status": "routed", "rule_id": rule["id"], "run_id": run_id})
    await db.activity(rule["owner_id"], "event", event["type"], run_id=run_id, thread_id=thread_id,
                      teammate_id=rule["teammate_id"], input={"event_id": event["id"], "rule_id": rule["id"]})
    return run_id


async def receive(owner_id: str, type: str, source: str, payload: dict[str, Any]) -> tuple[str, bool]:
    """First matching rule under its hourly limit handles the event."""
    event = await db.insert("events", {"owner_id": owner_id, "type": type, "source": source, "payload": payload})
    rules = await db.select("event_rules", {"owner_id": f"eq.{owner_id}", "event_type": f"eq.{type}",
                                            "enabled": "eq.true", "order": "created_at"})
    matched = [r for r in rules if matches(r, type, payload)]
    for rule in matched:
        if not await rate_limited(rule):
            await fire(rule, event)
            return event["id"], True
    status = "rate_limited" if matched else "ignored"
    await db.update("events", {"id": f"eq.{event['id']}"},
                    {"status": status, "rule_id": matched[0]["id"] if matched else None})
    return event["id"], False


async def test_rule(rule: dict[str, Any]) -> str:
    match = {k: v for k, v in (rule.get("match") or {}).items() if k != "cron"}
    payload = {**SAMPLES.get(rule["event_type"], {"note": "Sample event"}), **match, "test": True}
    event = await db.insert("events", {"owner_id": rule["owner_id"], "type": rule["event_type"], "source": "test",
                                       "payload": payload, "rule_id": rule["id"]})
    await fire(rule, event)
    return event["id"]


async def tick(now: datetime | None = None) -> None:
    """Fire schedule rules whose latest cron slot (UTC) has not fired yet."""
    now = now or datetime.now(UTC)
    await followups.tick(now)
    for rule in await db.select("event_rules", {"event_type": "eq.schedule", "enabled": "eq.true"}):
        cron = (rule.get("match") or {}).get("cron")
        if not cron or not croniter.is_valid(cron):
            continue
        slot = croniter(cron, now).get_prev(datetime)
        if (now - slot).total_seconds() > SLOT_GRACE_S:
            continue
        slot_iso = slot.isoformat()
        if await db.select("events", {"rule_id": f"eq.{rule['id']}", "payload->>slot": f"eq.{slot_iso}", "select": "id"}):
            continue
        event = await db.insert("events", {"owner_id": rule["owner_id"], "type": "schedule", "source": "schedule",
                                           "payload": {"slot": slot_iso, "cron": cron}, "rule_id": rule["id"]})
        if await rate_limited(rule):
            await db.update("events", {"id": f"eq.{event['id']}"}, {"status": "rate_limited"})
        else:
            await fire(rule, event)


async def schedule_loop() -> None:
    while True:
        try:
            await tick()
        except Exception as e:
            log.warning("schedule tick failed: %s", e)
        await asyncio.sleep(30)  # follow-ups fire within 30 s of their time
