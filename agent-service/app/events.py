"""Webhook events, rule matching, rate limits and the cron scheduler."""
import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter

from . import db, followups, runs, usage

log = logging.getLogger(__name__)
SLOT_GRACE_S = 120  # a slot this fresh is simply on time
CATCH_UP_MAX_S = 6 * 3600  # after downtime, the latest missed slot still runs (once, saying it's late) within this

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


# How an automation run works and writes: thorough (it runs unattended, so nobody can ask a follow-up question) and
# headline first (the Garage's summary card quotes that line).
CRAFT = ("\n\nDo the work fully: open every item that could matter, not just the subjects or previews. Emails with "
         "attachments (resumes, invoices, contracts, reports): read the attachments with read_attachments, all of them in "
         "one call, before you judge. When you compare or rank things, say why, with the facts that decided it.\n"
         "Start your reply with ONE short headline line that carries the result with its numbers (e.g. '3 emails need "
         "you: Priya's quote, 2 PR reviews' or '14 applications for the design role: 3 worth interviewing'), then the "
         "details, then the next step you suggest (and offer to do it).")
QUIET = ("\n\nIf the instructions ask you to post something every time (a fact, a brief, a reminder, a summary), "
         "always post it. Only when they ask you to check or watch for something and there's nothing new that matters "
         "this time, reply with exactly QUIET and nothing else: they won't see anything.")


async def _since(rule: dict[str, Any], event_id: str, tz: str) -> str:
    """When this automation last ran well, so a digest covers only what's new. A run that failed told them nothing:
    counting it made the next run look at the 4 minutes since and say QUIET over 2 hours of mail (2026-10-29)."""
    prev = await db.select("events", {"rule_id": f"eq.{rule['id']}", "status": "eq.routed", "id": f"neq.{event_id}",
                                      "order": "created_at.desc", "limit": "10", "select": "created_at,run_id"})
    ids = [e["run_id"] for e in prev if e.get("run_id")]
    done = {r["id"] for r in await db.select("runs", {"id": f"in.({','.join(ids)})", "status": "eq.done",
                                                       "select": "id"})} if ids else set()
    prev = [e for e in prev if not e.get("run_id") or e["run_id"] in done][:1]
    if not prev:
        return "This is its first run: cover what's recent (the last day at most)."
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    at = datetime.fromisoformat(prev[0]["created_at"]).astimezone(zone)
    return (f"It last ran {at:%a %b %d, %I:%M %p}: when you report on changes, cover only what's new since then; "
            "never repeat what you told them before.")


async def fire(rule: dict[str, Any], event: dict[str, Any]) -> str:
    """Start the teammate's run in the rule's thread. Returns run_id. Automations (schedule and app rules) post
    nothing up front: their reply carries the automation's name, and a QUIET reply posts nothing at all."""
    thread_id = f"proj:{rule['project_id']}" if rule.get("project_id") else f"dm:{rule['teammate_id']}"
    if rule["event_type"] in ("schedule", "app"):
        tz = (rule.get("match") or {}).get("tz") or await db.user_timezone(rule["owner_id"]) or "UTC"
        late = ""
        if (event.get("payload") or {}).get("late"):
            try:
                due = datetime.fromisoformat(event["payload"]["slot"]).astimezone(ZoneInfo(tz))
                late = f"This run is late (it was due {due:%I:%M %p}; Tubelight was offline): say so in a few words.\n"
            except (KeyError, ValueError, ZoneInfoNotFoundError):
                pass
        text = (f"[Automation: {rule['name']}, {(rule.get('match') or {}).get('when') or rule['event_type']}]\n{late}"
                f"Your standing instructions: {rule.get('instructions') or 'Tell them what matters, briefly.'}\n"
                f"{await _since(rule, event['id'], tz)}"
                + (f"\nThe event:\n```json\n{json.dumps(event['payload'], indent=1, default=str)[:6000]}\n```"
                   if rule["event_type"] == "app" else "") + CRAFT + QUIET)
        run_id = await runs.start(rule["owner_id"], thread_id, text, trigger="schedule" if rule["event_type"] == "schedule" else "event",
                                  teammate_id=rule["teammate_id"], event_type=f"automation:{rule['name']}", sender="automation",
                                  only_apps=(rule.get("match") or {}).get("toolkits"))
        await db.update("events", {"id": f"eq.{event['id']}"}, {"status": "routed", "rule_id": rule["id"], "run_id": run_id})
        await db.activity(rule["owner_id"], "event", event["type"], run_id=run_id, thread_id=thread_id,
                          teammate_id=rule["teammate_id"], input={"event_id": event["id"], "rule_id": rule["id"]})
        return run_id
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


async def receive_app(owner_id: str, trigger_id: str, trigger: str, toolkit: str, payload: dict[str, Any]) -> int:
    """A Composio app event: run every enabled automation on that trigger whose keyword filter matches."""
    from . import automations

    rules = await db.select("event_rules", {"owner_id": f"eq.{owner_id}", "event_type": "eq.app", "enabled": "eq.true",
                                            "match->>trigger_id": f"eq.{trigger_id}"})
    fired = 0
    for rule in rules:
        event = await db.insert("events", {"owner_id": owner_id, "type": trigger.lower(), "source": toolkit.lower(),
                                           "payload": payload, "rule_id": rule["id"]})
        if not automations.keywords_match(rule, payload):
            await db.update("events", {"id": f"eq.{event['id']}"}, {"status": "ignored"})
        elif await rate_limited(rule):
            await db.update("events", {"id": f"eq.{event['id']}"}, {"status": "rate_limited"})
        else:
            await fire(rule, event)
            fired += 1
    return fired


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
        try:  # automations keep their cron in the user's own time zone ("8 AM" means their 8 AM)
            zone = ZoneInfo((rule.get("match") or {}).get("tz") or "UTC")
        except (ZoneInfoNotFoundError, ValueError):
            zone = ZoneInfo("UTC")
        it = croniter(cron, now.astimezone(zone))
        slot = it.get_prev(datetime)
        # Missed while the server was down: the latest slot runs once, late, if it's still worth it (within half the
        # interval, 6 h at most: a 3-hourly check catches up for 90 min, a morning brief until early afternoon).
        # Never for time before the automation existed or while it was paused (active_from).
        interval = (slot - it.get_prev(datetime)).total_seconds()
        late = (now - slot).total_seconds()
        if late > min(max(SLOT_GRACE_S, interval / 2), CATCH_UP_MAX_S):
            continue
        active_from = (rule.get("match") or {}).get("active_from")
        if active_from and slot < datetime.fromisoformat(active_from):
            continue
        slot_iso = slot.isoformat()
        if await db.select("events", {"rule_id": f"eq.{rule['id']}", "payload->>slot": f"eq.{slot_iso}", "select": "id"}):
            continue
        event = await db.insert("events", {"owner_id": rule["owner_id"], "type": "schedule", "source": "schedule",
                                           "payload": {"slot": slot_iso, "cron": cron, **({"late": True} if late > SLOT_GRACE_S else {})},
                                           "rule_id": rule["id"]})
        if await rate_limited(rule):
            await db.update("events", {"id": f"eq.{event['id']}"}, {"status": "rate_limited"})
        else:
            await fire(rule, event)


async def schedule_loop() -> None:
    from . import repo
    n = 0
    while True:
        if n % 20 == 0:  # every 10 minutes: repos whose last check is over 6 hours old look for new commits
            try:
                await repo.tick()
            except Exception as e:
                log.warning("repo tick failed: %s", e)
        n += 1
        try:
            await tick()
        except Exception as e:
            log.warning("schedule tick failed: %s", e)
        await usage.flush()
        await asyncio.sleep(30)  # follow-ups fire within 30 s of their time
