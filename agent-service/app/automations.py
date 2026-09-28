"""Automations: standing instructions a teammate carries out on its own, set up by chatting with it.

An automation is an `event_rules` row (the rules engine in events.py runs it):
- schedule: `match` = {"cron": "0 */3 * * *", "tz": "Asia/Kolkata", "when": "every 3 hours"}: the cron is in the
  user's own time zone (events.tick);
- app: `match` = {"trigger": "GMAIL_NEW_GMAIL_MESSAGE", "trigger_id": "<Composio trigger>", "config": {"query":
  "from:abc"}, "contains": ["abc"], "when": "when a mail from abc arrives"}: Composio pushes the app's events to
  /composio/webhook; `contains` is an extra keyword filter checked in code.
Each run wakes the teammate in the chat it was set up in, with the instructions and what happened since the last run.
When there's nothing worth saying, the teammate replies QUIET and nothing is posted. Anything that sends, posts or
changes things still waits for the user's approval, like any other run.
"""
import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

from croniter import croniter

from . import connectors, db

log = logging.getLogger(__name__)
MIN_EVERY_S = 15 * 60  # schedules run at most every 15 minutes


def check_cron(cron: str) -> str | None:
    """None if the cron is usable, else why not."""
    if not croniter.is_valid(cron) or len(cron.split()) != 5:
        return "Give the schedule as a 5-field cron in their local time, e.g. '0 */3 * * *' (every 3 hours)."
    it = croniter(cron, datetime(2026, 1, 5, tzinfo=UTC))
    a, b = it.get_next(datetime), it.get_next(datetime)
    if (b - a).total_seconds() < MIN_EVERY_S:
        return "That's too often: at most every 15 minutes."
    return None


def thread_of(rule: dict[str, Any]) -> str:
    return f"proj:{rule['project_id']}" if rule.get("project_id") else f"dm:{rule['teammate_id']}"


def keywords_match(rule: dict[str, Any], payload: Any) -> bool:
    """The extra keyword filter: every keyword must appear somewhere in the event (case-insensitive)."""
    words = [str(w).lower() for w in (rule.get("match") or {}).get("contains") or [] if str(w).strip()]
    text = json.dumps(payload, default=str).lower()
    return all(w in text for w in words)


def describe(rule: dict[str, Any]) -> str:
    m = rule.get("match") or {}
    return m.get("when") or (f"on {m['trigger']}" if m.get("trigger") else f"cron {m.get('cron')}")


async def note(rule: dict[str, Any], event: str, by: str) -> None:
    """A capsule in the automation's chat for each change, like follow-ups."""
    text = {
        "created": f"{by} set up an automation: {rule['name']} · {describe(rule)}",
        "updated": f"{by} updated an automation: {rule['name']} · {describe(rule)}",
        "paused": f"{by} paused an automation: {rule['name']}",
        "resumed": f"{by} resumed an automation: {rule['name']} · {describe(rule)}",
        "deleted": f"{by} deleted an automation: {rule['name']}",
    }[event]
    await db.insert("messages", {"thread_id": thread_of(rule), "owner_id": rule["owner_id"], "sender_type": "system",
                                 "kind": "event", "text": text, "meta": {"automation": event, "rule_id": rule["id"]}})


# ------------------------------------------------------------------ Composio app triggers
async def app_events(toolkit: str, limit: int = 15) -> list[dict[str, Any]]:
    """The events an app can push (Composio trigger types), with their settings."""
    def fetch() -> list[dict[str, Any]]:
        r = connectors._client().triggers.list(toolkit_slugs=[toolkit.lower()], limit=limit)
        out = []
        for t in getattr(r, "items", r) or []:
            cfg = t.config or {}
            out.append({"slug": t.slug, "name": t.name, "required": cfg.get("required") or [],
                        "settings": {k: (v.get("description") or "")[:120] for k, v in (cfg.get("properties") or {}).items()}})
        return out
    return await asyncio.to_thread(fetch)


async def start_trigger(owner_id: str, slug: str, config: dict[str, Any]) -> str:
    """Create the Composio trigger on the user's connected account; returns its id."""
    def create() -> str:
        r = connectors._client().triggers.create(slug, user_id=owner_id, trigger_config=config or None)
        return getattr(r, "trigger_id", None) or getattr(r, "id", None) or r["trigger_id"]
    return await asyncio.to_thread(create)


async def set_trigger(trigger_id: str | None, on: bool) -> None:
    if not trigger_id:
        return
    t = connectors._client().triggers
    try:
        await asyncio.to_thread(t.enable if on else t.disable, trigger_id)
    except Exception:
        log.exception("could not %s trigger %s", "enable" if on else "disable", trigger_id)


async def stop_trigger(trigger_id: str | None) -> None:
    if not trigger_id:
        return
    try:
        await asyncio.to_thread(connectors._client().triggers.delete, trigger_id)
    except Exception:
        log.exception("could not delete trigger %s", trigger_id)


# ------------------------------------------------------------------ lifecycle
async def create(owner_id: str, teammate: dict[str, Any], project_id: str | None, *, name: str, instructions: str,
                 cron: str | None = None, tz: str = "UTC", trigger: str | None = None,
                 config: dict[str, Any] | None = None, contains: list[str] | None = None, when: str = "",
                 by: str | None = None) -> dict[str, Any]:
    """Set up a schedule (cron) or app-event (trigger) automation. Raises ValueError with a readable reason.
    by: who the capsule credits (the teammate, or "You" from the app)."""
    if bool(cron) == bool(trigger):
        raise ValueError("Give either a schedule or an app event, not both.")
    if cron and (why := check_cron(cron)):
        raise ValueError(why)
    match: dict[str, Any] = {"when": when[:120]}
    if cron:
        match |= {"cron": cron, "tz": tz}
    else:
        try:
            match |= {"trigger": trigger, "config": config or {}, "trigger_id": await start_trigger(owner_id, trigger, config or {})}
        except Exception as e:
            raise ValueError(f"Couldn't start {trigger}: {str(e)[:200]}. Check the app is connected and the settings.") from e
        if contains:
            match["contains"] = [str(w)[:60] for w in contains][:5]
    rule = await db.insert("event_rules", {
        "owner_id": owner_id, "name": name[:80], "event_type": "schedule" if cron else "app", "match": match,
        "project_id": project_id, "teammate_id": teammate["id"], "instructions": instructions[:2000], "enabled": True,
        "max_per_hour": 20,
    })
    await note(rule, "created", by or teammate["name"])
    return rule


async def update(rule: dict[str, Any], by: str, **changes: Any) -> dict[str, Any]:
    """Change name / instructions / schedule. (An app event is changed by deleting and creating.)"""
    patch: dict[str, Any] = {k: v for k, v in (("name", changes.get("name")), ("instructions", changes.get("instructions"))) if v}
    match = dict(rule.get("match") or {})
    if changes.get("cron"):
        if rule["event_type"] != "schedule":
            raise ValueError("This automation runs on an app event; delete it and set up a scheduled one instead.")
        if why := check_cron(changes["cron"]):
            raise ValueError(why)
        match["cron"] = changes["cron"]
    if changes.get("when"):
        match["when"] = changes["when"][:120]
    if changes.get("contains") is not None and rule["event_type"] == "app":
        match["contains"] = [str(w)[:60] for w in changes["contains"]][:5]
    patch["match"] = match
    [row] = await db.update("event_rules", {"id": f"eq.{rule['id']}"}, patch)
    await note(row, "updated", by)
    return row


async def set_enabled(rule: dict[str, Any], on: bool, by: str) -> dict[str, Any]:
    [row] = await db.update("event_rules", {"id": f"eq.{rule['id']}"}, {"enabled": on})
    await set_trigger((rule.get("match") or {}).get("trigger_id"), on)
    await note(row, "resumed" if on else "paused", by)
    return row


async def delete(rule: dict[str, Any], by: str) -> None:
    await stop_trigger((rule.get("match") or {}).get("trigger_id"))
    await db.delete("event_rules", {"id": f"eq.{rule['id']}"})
    await note(rule, "deleted", by)


async def in_thread(owner_id: str, thread_id: str) -> list[dict[str, Any]]:
    """The automations that post into one chat (schedules and app events, not raw webhook rules)."""
    kind, _, ref = thread_id.partition(":")
    scope = {"project_id": f"eq.{ref}"} if kind == "proj" else {"teammate_id": f"eq.{ref}", "project_id": "is.null"}
    rows = await db.select("event_rules", {"owner_id": f"eq.{owner_id}", "event_type": "in.(schedule,app)",
                                           "order": "created_at", **scope})
    return rows
