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
        "failing": f"Paused after {FAILS_TO_PAUSE} failed runs: {rule['name']}",
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
            props = cfg.get("properties") or {}
            out.append({"slug": t.slug, "name": t.name, "required": cfg.get("required") or [],
                        "settings": {k: (v.get("description") or "")[:120] for k, v in props.items()},
                        "types": {k: v.get("type") or "string" for k, v in props.items()},
                        "defaults": {k: v["default"] for k, v in props.items() if v.get("default") is not None}})
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
FAILS_TO_PAUSE = 3  # consecutive failed runs before an automation pauses itself (and says so)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _apps(toolkits: list[str] | None) -> list[str] | None:
    """None = every app the teammate may use; a list = only these (upper-case Composio toolkit slugs)."""
    return None if toolkits is None else list(dict.fromkeys(str(t).upper() for t in toolkits if str(t).strip()))[:20]


def _keywords(words: list[str] | None) -> list[str]:
    return [str(w).strip()[:60] for w in words or [] if str(w).strip()][:5]


async def create(owner_id: str, teammate: dict[str, Any], project_id: str | None, *, name: str, instructions: str,
                 cron: str | None = None, tz: str = "UTC", trigger: str | None = None,
                 config: dict[str, Any] | None = None, contains: list[str] | None = None, when: str = "",
                 by: str | None = None, toolkits: list[str] | None = None) -> dict[str, Any]:
    """Set up a schedule (cron) or app-event (trigger) automation. Raises ValueError with a readable reason.
    by: who the capsule credits (the teammate, or "You" from the app). toolkits: the apps its runs may use."""
    if bool(cron) == bool(trigger):
        raise ValueError("Give either a schedule or an app event, not both.")
    if not instructions.strip():
        raise ValueError("Say what to do on each run.")
    if cron and (why := check_cron(cron)):
        raise ValueError(why)
    # active_from: slots before it never run (no catch-up for time before it existed or while it was paused)
    match: dict[str, Any] = {"when": when[:120], "active_from": _now()}
    if (apps := _apps(toolkits)) is not None:
        match["toolkits"] = apps
    if cron:
        match |= {"cron": cron, "tz": tz}
    else:
        try:
            match |= {"trigger": trigger, "config": config or {}, "trigger_id": await start_trigger(owner_id, trigger, config or {})}
        except Exception as e:
            raise ValueError(f"Couldn't start {trigger}: {str(e)[:200]}. Check the app is connected and the settings.") from e
        if contains := _keywords(contains):
            match["contains"] = contains
    rule = await db.insert("event_rules", {
        "owner_id": owner_id, "name": name.strip()[:80] or "Automation", "event_type": "schedule" if cron else "app",
        "match": match, "project_id": project_id, "teammate_id": teammate["id"], "instructions": instructions.strip()[:2000],
        "enabled": True, "max_per_hour": 20,
    })
    await note(rule, "created", by or teammate["name"])
    return rule


async def update(rule: dict[str, Any], by: str, **changes: Any) -> dict[str, Any]:
    """Change name, instructions, schedule (cron, tz), the app event (trigger + settings: the Composio trigger is
    swapped), keywords, or which apps it may use. Unchanged keys are left alone. One capsule for the lot."""
    patch: dict[str, Any] = {k: v.strip()[:80 if k == "name" else 2000] for k, v in
                             (("name", changes.get("name")), ("instructions", changes.get("instructions"))) if v and v.strip()}
    match = dict(rule.get("match") or {})
    if changes.get("cron") or changes.get("tz"):
        if rule["event_type"] != "schedule":
            raise ValueError("This automation runs on an app event, not a schedule.")
        if changes.get("cron"):
            if why := check_cron(changes["cron"]):
                raise ValueError(why)
            match["cron"] = changes["cron"]
        if changes.get("tz"):
            match["tz"] = changes["tz"]
        match["active_from"] = _now()  # a new schedule doesn't replay the old one's slots
    if changes.get("trigger") or changes.get("config") is not None:
        if rule["event_type"] != "app":
            raise ValueError("This automation runs on a schedule, not an app event.")
        trigger, config = changes.get("trigger") or match.get("trigger"), changes.get("config") if changes.get("config") is not None else match.get("config") or {}
        if trigger != match.get("trigger") or config != (match.get("config") or {}):
            try:  # start the new one first: a failed swap leaves the old trigger running
                new_id = await start_trigger(rule["owner_id"], trigger, config)
            except Exception as e:
                raise ValueError(f"Couldn't start {trigger}: {str(e)[:200]}. Check the app is connected and the settings.") from e
            await stop_trigger(match.get("trigger_id"))
            match |= {"trigger": trigger, "config": config, "trigger_id": new_id}
            if not rule["enabled"]:
                await set_trigger(new_id, False)
    if changes.get("when"):
        match["when"] = changes["when"][:120]
    if changes.get("contains") is not None and rule["event_type"] == "app":
        match["contains"] = _keywords(changes["contains"])
    if "toolkits" in changes:
        if (apps := _apps(changes["toolkits"])) is None:
            match.pop("toolkits", None)
        else:
            match["toolkits"] = apps
    for k in ("teammate_id", "project_id"):  # moved to another teammate or chat (the caller checked membership)
        if k in changes:
            patch[k] = changes[k]
    patch["match"] = match
    [row] = await db.update("event_rules", {"id": f"eq.{rule['id']}"}, patch)
    await note(row, "updated", by)
    return row


async def set_enabled(rule: dict[str, Any], on: bool, by: str, why: str = "") -> dict[str, Any]:
    match = {**(rule.get("match") or {}), **({"active_from": _now()} if on else {})}  # resuming doesn't replay the pause
    [row] = await db.update("event_rules", {"id": f"eq.{rule['id']}"}, {"enabled": on, "match": match})
    await set_trigger(match.get("trigger_id"), on)
    await note(row, "resumed" if on else "failing" if why else "paused", by)
    return row


async def after_failure(run_id: str) -> None:
    """A run of an automation failed: after FAILS_TO_PAUSE failures in a row it pauses itself, posts a capsule and
    pings the user, instead of failing silently every few hours."""
    from . import push

    ev = await db.one("events", {"run_id": f"eq.{run_id}", "select": "rule_id"})
    rule = ev and ev.get("rule_id") and await db.one("event_rules", {"id": f"eq.{ev['rule_id']}"})
    if not rule or not rule["enabled"] or rule["event_type"] not in ("schedule", "app"):
        return
    last = await db.select("events", {"rule_id": f"eq.{rule['id']}", "status": "eq.routed", "order": "created_at.desc",
                                      "limit": str(FAILS_TO_PAUSE), "select": "run_id"})
    ids = [e["run_id"] for e in last if e.get("run_id")]
    if len(ids) < FAILS_TO_PAUSE:
        return
    runs = await db.select("runs", {"id": f"in.({','.join(ids)})", "select": "status"})
    if len(runs) == FAILS_TO_PAUSE and all(r["status"] == "error" for r in runs):
        await set_enabled(rule, False, "Tubelight", why="failing")
        await push.notify(rule["owner_id"], f"{rule['name']} paused",
                          f"It failed {FAILS_TO_PAUSE} times in a row. Open it to see why, then turn it back on.",
                          thread_of(rule), kind="alert")


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


# ------------------------------------------------------------------ drafting from plain words (the app's form)
DRAFT = """You turn someone's request into an automation their AI teammate {name} ({role}) will carry out on its own.
Now: {now}, their time zone. Apps {name} can use: {apps}.
Return JSON only, with these keys:
"name": 2-4 plain words in sentence case saying what it does, not when ("Inbox brief", "New issue triage").
"instructions": what {name} does on each run, self-contained, addressed to {name} as "you": what to check, what
  counts, what to tell them. 1-4 sentences. Each run's result is {name}'s message in the chat, where they read it:
  never report by email or a draft to them. Keep their specifics (senders, projects, thresholds) and read their
  meaning, not their literal words ("what's urgent" is what needs them soon, not mails containing the word "urgent").
  Anything that would send, post or change things for them (a reply, a comment, an issue update) is prepared and
  asked about first.
"kind": "schedule" for anything time-based ("every morning", "hourly", "on Fridays at 5"); "app" for "whenever /
  as soon as something happens in an app" (a new mail, a new issue).
"cron": for a schedule, a 5-field cron in their local time, at most every 15 minutes; else null. A daily thing with
  no time given gets a sensible one (a morning brief at 8:00 AM, an end-of-day wrap at 6:00 PM).
"when": the timing in plain lowercase words ("weekdays at 9:00 AM", "every 3 hours", "when a mail from abc@x.com arrives").
"app": for kind app, which app's event starts it (one of the apps above, as written there); else null.
"event": for kind app, the event in plain words ("new email", "issue created"); else null.
"apps": the apps each run needs to do the work (from the apps above; [] if none)."""

PICK = """Pick the app event that starts this automation and fill in its settings.
Request: {text}
Events ({app}), as slug | name | required settings | settings with descriptions:
{events}
Return JSON only: {{"trigger": the slug, "settings": {{setting: value}} using only listed settings and only values the
request itself gives (never invent an ID or a name), "missing": [required settings the request doesn't give],
"keywords": [words that must appear in the event, e.g. a sender's address; [] if none]}}"""


async def _json(system: str, user: str) -> dict[str, Any]:
    from langchain_core.messages import HumanMessage, SystemMessage

    from . import brief, config, llm
    res = await llm.chat_model(config.KEEPER_MODEL, json=True).ainvoke([SystemMessage(system), HumanMessage(user)])
    data = brief._parse(res.text)
    return data if isinstance(data, dict) else {}


async def draft(text: str, teammate: dict[str, Any], apps: list[str], now: datetime) -> dict[str, Any]:
    """Fill the app's automation form from plain words ("every weekday at 9 tell me what's urgent in my inbox").
    Everything comes back editable; `missing` lists app-event settings it couldn't fill, `note` says what to check."""
    d = await _json(DRAFT.format(name=teammate["name"], role=teammate.get("role") or "teammate",
                                 now=f"{now:%A, %B %d, %Y, %I:%M %p}", apps=", ".join(apps) or "none"), text)
    out: dict[str, Any] = {"name": str(d.get("name") or "")[:80], "instructions": str(d.get("instructions") or "")[:2000],
                           "kind": "app" if d.get("kind") == "app" else "schedule", "when": str(d.get("when") or "")[:120],
                           "cron": None, "trigger": None, "settings": {}, "keywords": [], "missing": [], "note": "",
                           "apps": [a.upper() for a in d.get("apps") or [] if str(a).upper() in apps]}
    if out["kind"] == "schedule":
        cron = str(d.get("cron") or "").strip()
        if cron and not check_cron(cron):
            out["cron"] = cron
        else:
            out["note"] = "Pick when it runs: that part wasn't clear."
        return out
    app = str(d.get("app") or "").upper()
    if app not in apps:
        return {**out, "note": f"{teammate['name']} can't use that app yet: connect it or pick another teammate."}
    out["app"] = app
    try:
        events = await app_events(app)
    except Exception:
        events = []
    if not events:
        return {**out, "note": f"{app.title()} doesn't send events Tubelight can listen to. Try a schedule instead."}
    listing = "\n".join(f"{e['slug']} | {e['name']} | {', '.join(e['required']) or '-'} | "
                        + "; ".join(f"{k}: {v}" for k, v in e["settings"].items()) for e in events)
    p = await _json(PICK.format(text=text, app=app, events=listing), f"The event: {d.get('event') or text}")
    ev = next((e for e in events if e["slug"] == p.get("trigger")), None)
    if not ev:
        return {**out, "note": "Pick which event starts it."}
    settings = {k: v for k, v in (p.get("settings") or {}).items() if k in ev["settings"] and v not in (None, "")}
    return {**out, "trigger": ev["slug"], "settings": settings, "keywords": _keywords(p.get("keywords")),
            "missing": [k for k in ev["required"] if k not in settings]}


# ------------------------------------------------------------------ settings people can't be expected to type
# ID-like event settings, offered as a list of names from the user's own account (read-only lookups). A pick can fill
# more than one setting (a GitHub repo sets owner and repo).
CHOICES: dict[tuple[str, str], str] = {
    ("LINEAR", "team_id"): "LINEAR_LIST_LINEAR_TEAMS", ("LINEAR", "project_id"): "LINEAR_LIST_LINEAR_PROJECTS",
    ("GMAIL", "labelIds"): "GMAIL_LIST_LABELS",
    ("GOOGLECALENDAR", "calendarId"): "GOOGLECALENDAR_LIST_CALENDARS", ("GOOGLECALENDAR", "calendar_id"): "GOOGLECALENDAR_LIST_CALENDARS",
    ("GITHUB", "repo"): "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
    ("GITHUB", "owner"): "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
    ("SLACK", "channel_id"): "SLACK_LIST_ALL_CHANNELS",
}


def _options(data: Any, toolkit: str) -> list[dict[str, Any]]:
    """The first list of records with an id in a tool's result, as {value, label, sets}."""
    def lists(x: Any):
        if isinstance(x, list) and x and all(isinstance(i, dict) for i in x):
            yield x
        elif isinstance(x, dict):
            for v in x.values():
                yield from lists(v)
    for items in lists(data):
        if not any("id" in i or "full_name" in i for i in items):
            continue
        out = []
        for i in items[:200]:
            if toolkit == "GITHUB" and i.get("full_name"):
                owner, _, repo = i["full_name"].partition("/")
                out.append({"value": repo, "label": i["full_name"], "sets": {"owner": owner, "repo": repo}})
                continue
            label = i.get("name") or i.get("summary") or i.get("title") or i.get("id")
            if i.get("id"):
                out.append({"value": str(i["id"]), "label": str(label)})
        return out
    return []


async def choices(owner_id: str, toolkit: str, field: str) -> list[dict[str, Any]] | None:
    """Options for one event setting, or None when there's no lookup for it (the app shows a text field)."""
    slug = CHOICES.get((toolkit.upper(), field))
    if not slug:
        return None
    return _options(await connectors.execute(owner_id, slug, {}), toolkit.upper())
