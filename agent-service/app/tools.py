"""Tool classification (read / draft / act), human labels, and each teammate's toolset."""
from __future__ import annotations

import asyncio
import fnmatch
import base64
import re
import time
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import TYPE_CHECKING, Any, Literal

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool

from . import computer_use as cu
from . import automations, brief, browser, mail, results, clock, computers, config, connectors, db, documents, files, followups, knowledge, images, llm, mem, memory, mind, phone, push, repo, sandbox, todos, usage, vault

if TYPE_CHECKING:
    from .graph import RunCtx

ACT = {"SEND", "POST", "PUSH", "MERGE", "DELETE", "REMOVE", "PAY", "ORDER", "PUBLISH", "INVITE",
       "REPLY", "FORWARD", "TRASH", "TRANSFER", "PURCHASE", "SUBMIT", "SHARE"}
DRAFT = {"DRAFT"}
READ = {"GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "QUERY", "RETRIEVE", "VIEW"}
# Who gets a code sandbox (and, for engineers, helpers): roles are free text ("Developer", "QA engineer").
BUILDER = re.compile(r"develop|engineer|program|coder|\bqa\b|test|devops|\bsre\b|data|analyst|scien", re.I)


def conversation_stats(rows: list[dict[str, Any]], user_name: str, members: list[dict], zone: Any) -> str:
    """Counts over a chat's messages (oldest first): per sender, who answered whom (the next message by someone
    else), who @mentioned whom, and per day."""
    if not rows:
        return "No messages in this chat yet."
    names = {m["id"]: m["name"] for m in members}
    handles = {m["handle"].lower(): m["name"] for m in members}
    who = lambda r: user_name if r["sender_type"] == "user" else names.get(r["teammate_id"], "Former teammate")  # noqa: E731
    per: dict[str, int] = {}
    answered: dict[tuple[str, str], int] = {}
    mentioned: dict[tuple[str, str], int] = {}
    days: dict[str, int] = {}
    prev = None
    for r in rows:
        w = who(r)
        per[w] = per.get(w, 0) + 1
        if prev and prev != w:
            answered[(prev, w)] = answered.get((prev, w), 0) + 1
        for h in re.findall(r"@([\w-]+)", r["text"] or ""):
            if h.lower() in handles and handles[h.lower()] != w:
                k = (w, handles[h.lower()])
                mentioned[k] = mentioned.get(k, 0) + 1
        d = f"{datetime.fromisoformat(r['created_at']).astimezone(zone):%b %d}"
        days[d] = days.get(d, 0) + 1
        prev = w
    top = lambda d, n: sorted(d.items(), key=lambda kv: -kv[1])[:n]  # noqa: E731
    first = datetime.fromisoformat(rows[0]["created_at"]).astimezone(zone)
    return "\n".join([
        f"{len(rows)} messages since {first:%b %d}.",
        "Messages per person: " + ", ".join(f"{k} {v}" for k, v in top(per, 12)),
        "Who answered whom (A -> B: B spoke right after A): " + ", ".join(f"{a} -> {b} {v}" for (a, b), v in top(answered, 15)),
        "Who @mentioned whom: " + (", ".join(f"{a} -> {b} {v}" for (a, b), v in top(mentioned, 12)) or "none"),
        "Messages per day (last 14 days with messages): " + ", ".join(f"{k} {v}" for k, v in list(days.items())[-14:]),
    ])


ATTACH_MAX = 40
DELEGATE_WAIT_S = 240  # how long ask_teammate waits for the answer before leaving it to the other chat
ATTACH_BUDGET = 120_000  # characters across one call's files (Gemini reads it all; long files are cut per file)


async def attachment_bytes(owner_id: str, message_id: str, attachment_id: str, name: str) -> tuple[bytes, str]:
    """One Gmail attachment's bytes and mime: Composio hands back a download link (or a local path from its SDK)."""
    import httpx
    from pathlib import Path
    d = await connectors.execute(owner_id, "GMAIL_GET_ATTACHMENT",
                                 {"message_id": message_id, "attachment_id": attachment_id, "file_name": name})
    f = d.get("file") or d
    url, mime = str(f.get("s3url") or f.get("uri") or ""), str(f.get("mimetype") or f.get("mimeType") or "")
    if url.startswith("http"):
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as c:
            r = await c.get(url)
            r.raise_for_status()
            data = r.content
    elif url and Path(url).is_file():
        data = Path(url).read_bytes()
    else:
        raise RuntimeError("Gmail returned no file")
    return data, mime


async def attachment_text(owner_id: str, message_id: str, attachment_id: str, name: str, limit: int) -> str:
    data, mime = await attachment_bytes(owner_id, message_id, attachment_id, name)
    return await files.text_of(name, mime, data, limit=limit)


def builder(tm: dict) -> bool:
    return bool(BUILDER.search(tm.get("role") or ""))


INTERNAL = {
    "remember": "read", "recall": "read", "search_chat": "read", "chat_stats": "read", "model_usage": "read", "follow_up": "read", "spawn_helper": "read",
    "automate": "read", "app_events": "read", "repo_context": "read", "repo_note": "read",
    "web_search": "read", "read_page": "read", "read_attachments": "read", "save_attachments": "read", "inbox": "read",
    "browser_signin": "read", "browser_use": "act", "schedule_post": "act", "browser_commit": "act", "browser_look": "read", "browser_act": "read", "browser_keys": "read", "browser_subtask": "read",
    "read_file": "read", "open_repo": "read", "run_shell": "draft", "write_file": "draft", "git_push": "act",
    "ask_user": "read", "connect_app": "read", "ask_teammate": "read", "new_chat": "read",
    "memory_search": "read", "memory_why": "read", "memory_confirm": "read", "memory_dismiss": "read",
    "memory_correct": "read", "memory_merge": "read",
    "computer_list": "read", "computer_read": "read", "computer_write": "act", "computer_run": "act",
    "computer_send_file": "read", "computer_receive": "read", "computer_screenshot": "read", "computer_apps": "read", "computer_close_app": "act", "computer_to_drive": "act", "computer_use": "act", "computer_look": "read", "computer_act": "read", "computer_keys": "read", "computer_subtask": "read", "computer_start_job": "act", "generate_image": "read", "make_document": "read", "phone_action": "read", "phone_send": "act", "phone_use_app": "act", "phone_notifications": "read", "ask_phone": "read", "phone_status": "read",
    "todos": "read", "vault": "read", "knowledge": "read", "alarms": "read", "reminders": "read",
}
# Tools that pause the run for the user (question card / connect card). The graph intercepts them.
PROMPTS = {"ask_user", "connect_app", "browser_signin"}
LABELS = {
    "browser_use": "Asking to use the browser", "browser_look": "Looking at a web page", "browser_act": "Using a web page",
    "browser_keys": "Pressing keys on a web page", "browser_subtask": "Working on a web page", "browser_commit": "Pressing the button",
    "remember": "Saving to memory", "recall": "Searching memory", "search_chat": "Searching the chat",
    "follow_up": "Setting a follow-up", "automate": "Setting up an automation", "app_events": "Checking app events",
    "spawn_helper": "Working with a helper", "read_file": "Reading a file", "write_file": "Writing a file",
    "git_push": "Pushing commits", "todos": "Checking your to-dos", "alarms": "Setting your alarms", "reminders": "Setting your reminders", "vault": "Looking in your vault", "knowledge": "Looking in its notes", "generate_image": "Drawing an image", "make_document": "Writing a document", "phone_action": "Doing it on your phone", "phone_send": "Sending from your phone", "phone_use_app": "Using an app on your phone", "phone_notifications": "Reading your notifications", "ask_phone": "Asking your phone", "phone_status": "Checking your phone", "computer_screenshot": "Looking at your screen", "computer_apps": "Checking running apps", "computer_close_app": "Closing an app", "computer_use": "Asking to use an app", "computer_look": "Looking at an app", "computer_act": "Using an app", "computer_keys": "Pressing keys", "computer_subtask": "Working in an app", "computer_to_drive": "Uploading to Google Drive", "computer_list": "Looking in your folders", "computer_read": "Reading your file",
    "computer_write": "Writing your file", "computer_run": "Running a command on your computer", "ask_user": "Asking you", "connect_app": "Asking you to connect an app",
}
HELPER_STEPS = 6


def classify(name: str) -> Literal["read", "draft", "act"]:
    if name in INTERNAL:
        return INTERNAL[name]  # type: ignore[return-value]
    words = set(name.upper().split("_"))
    if words & ACT:
        return "act"
    if words & DRAFT:
        return "draft"
    if words & READ:
        return "read"
    return "act"  # unknown verbs (create, update, ...) change the outside world: ask first


MULTI = "COMPOSIO_MULTI_EXECUTE_TOOL"
NEEDS_JS = re.compile(r"enable javascript|javascript is (disabled|required)|something went wrong, but don.t fret|"
                      r"checking your browser|verify you are human|access denied", re.I)


def inner(name: str, args: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """The real tool calls behind a call: Composio's multi-execute wraps several app tools."""
    if name != MULTI:
        return [(name, args)]
    return [(str(t.get("tool_slug", "")), t.get("arguments") or {}) for t in args.get("tools") or [] if isinstance(t, dict)]


def classify_call(name: str, args: dict[str, Any]) -> Literal["read", "draft", "act"]:
    classes = {classify(slug) for slug, _ in inner(name, args)}
    return "act" if "act" in classes else "draft" if "draft" in classes else "read"


def approval_view(name: str, args: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    """(tool_name, title, editable draft) for an approval card."""
    calls = inner(name, args)
    if len(calls) == 1:
        slug, a = calls[0]
        return slug, title(slug, a), a
    return ", ".join(s for s, _ in calls), "; ".join(title(s, a) for s, a in calls)[:140], {"tools": args.get("tools", [])}


def apply_edit(name: str, args: dict[str, Any], edited: dict[str, Any] | None) -> dict[str, Any]:
    """Put the user's edited draft back into the original call shape."""
    if not edited or name == "browser_commit":  # a commit is exactly what they saw; the card has nothing to edit
        return args
    if name != MULTI:
        return edited
    items = args.get("tools") or []
    if len(items) == 1:
        return {**args, "tools": [{**items[0], "arguments": edited}]}
    return {**args, "tools": edited.get("tools", items)}


_ING = {"get": "getting", "set": "setting", "put": "putting", "run": "running", "list": "listing", "send": "sending",
        "fetch": "fetching", "search": "searching", "find": "finding", "read": "reading", "create": "creating",
        "update": "updating", "delete": "deleting", "move": "moving", "add": "adding", "remove": "removing",
        "reply": "replying to", "draft": "drafting", "patch": "patching", "modify": "changing", "check": "checking",
        "schedule": "scheduling", "insert": "adding", "upload": "uploading", "download": "downloading", "star": "starring",
        "archive": "archiving", "forward": "forwarding", "invite": "inviting", "accept": "accepting", "decline": "declining"}


def _ing(action: str) -> str | None:
    """'fetch emails' -> 'Fetching emails', for the live status line; None when the action doesn't start with a verb
    we know ('events list' must not become 'Eventsing list')."""
    verb, _, rest = action.partition(" ")
    word = _ING.get(verb)
    return f"{word} {rest}".strip().capitalize() if word else None


def _phrase(name: str) -> tuple[str, str]:
    toolkit, _, rest = name.partition("_")
    return toolkit.title(), rest.replace("_", " ").lower()


def label(name: str, args: dict[str, Any]) -> str:
    if name == "run_shell":
        return f"Running {str(args.get('cmd', ''))[:40]}"
    if name in LABELS:
        return LABELS[name]
    if name == "COMPOSIO_SEARCH_TOOLS":
        return "Finding the right tool"
    if name == MULTI and inner(name, args):
        name = inner(name, args)[0][0]
    toolkit, action = _phrase(name)
    app = connectors.name_of(toolkit.upper())
    return (f"{_ing(action)} in {app}" if _ing(action) else f"Working in {app}") if action else name


def _drive_id(data: Any) -> str:
    """The first Drive file/folder id in a Composio Drive result ({"files": [{"id"}]}, {"id"}, nested)."""
    if isinstance(data, dict):
        if isinstance(data.get("id"), str):
            return data["id"]
        data = list(data.values())
    if isinstance(data, list):
        for v in data:
            if found := _drive_id(v):
                return found
    return ""


def title(name: str, args: dict[str, Any]) -> str:
    """Short human sentence for an approval card, e.g. 'Send email to jane@acme.com'."""
    if name == "git_push":
        return f"Push commits to branch {args.get('branch', '?')}"
    if name == "schedule_post":
        return f"Post on {args.get('site', '?')} at {str(args.get('when', '?')).replace('T', ' ')}"[:80]
    if name == "computer_run":  # the command itself shows below the title on the card
        what = str(args.get("title") or "").strip().rstrip(".") or "Run a command"
        return f"{what[:1].upper()}{what[1:]}{' (admin)' if args.get('sudo') else ''}"[:80]
    if name == "computer_start_job":
        return f"Start: {str(args.get('title') or 'a long job').strip().rstrip('.')}"[:80]
    if name == "phone_action":
        a, k = args, str(args.get("action", ""))
        what = {"alarm": f"Set an alarm for {a.get('when')}", "timer": f"Start a {a.get('seconds')} s timer",
                "call": f"Call {a.get('number')}", "text": f"Text {a.get('number')}", "whatsapp": f"WhatsApp {a.get('number')}",
                "email": f"Email {a.get('to')}", "navigate": f"Directions to {a.get('place')}",
                "calendar": f"Add {a.get('title') or 'an event'} to the calendar", "open_app": f"Open {a.get('app')}",
                "open_url": "Open a link", "search": f"Search {a.get('text')}"}.get(k, f"Phone: {k}")
        return f"On your phone: {what}"[:80]
    if name == "phone_notifications":
        return "Look through your phone's notifications"
    if name == "phone_send":
        who = args.get("name") or args.get("number") or "the chat"
        return (f"Reply: “{str(args.get('text', ''))[:50]}”" if args.get("kind") == "reply"
                else f"SMS {who}: “{str(args.get('text', ''))[:40]}”")[:80]
    if name == "phone_use_app":
        return f"Use {str(args.get('app') or 'an app')} on your phone: {str(args.get('task') or '')}"[:80]
    if name == "computer_to_drive":
        where = f" (folder {args.get('folder')})" if args.get("folder") else ""
        return f"Upload {str(args.get('path', '?')).rstrip('/').rsplit('/', 1)[-1]} to Google Drive{where}"[:80]
    if name == "computer_close_app":
        return f"Close {str(args.get('name') or 'an app')}"[:80]
    if name == "browser_use":
        return f"Use the browser on {args.get('site') or 'a site'}: {str(args.get('task') or '')}"[:80]
    if name == "computer_use":
        return f"Use {str(args.get('app') or 'an app')}: {str(args.get('task') or '')}"[:80]
    if name == "computer_write":
        return f"Write {str(args.get('path', '?')).rstrip('/').rsplit('/', 1)[-1]}"[:80]
    _, action = _phrase(name)
    s = (action or name).capitalize()
    to = args.get("recipient_email") or args.get("to") or args.get("recipient")
    if to:
        s += f" to {', '.join(to) if isinstance(to, list) else to}"
    elif args.get("owner") and args.get("repo"):
        s += f" in {args['owner']}/{args['repo']}"
    subject = args.get("subject") or args.get("title")
    if subject:
        s += f": {subject}"
    return s[:140]


async def run_tool(ctx: RunCtx, tm: dict, tool: BaseTool | None, name: str, args: dict[str, Any]) -> tuple[str, str]:
    """Execute one tool, log it, return (content, status)."""
    if tool is None:
        return f"There is no tool called {name}. Use one of the tools you were given.", "error"
    await db.broadcast(ctx.thread_id, "status", ctx.status(tm, "tool", label(name, args)))
    t0 = time.monotonic()
    try:
        out = await tool.ainvoke(args)
        content, status = results.fit(out), "ok"  # never a silent cut: see results.py
    except Exception as e:
        content, status = f"The tool failed: {e}", "error"
    await db.activity(
        ctx.owner_id, "sandbox" if name in ("run_shell", "read_file", "write_file", "git_push") else "tool_call",
        name, run_id=ctx.run_id, thread_id=ctx.thread_id, teammate_id=tm["id"], input=args,
        output={"result": content[:4000]}, status=status, duration_ms=int((time.monotonic() - t0) * 1000),
    )
    ctx.turn_tools.setdefault(tm["id"], []).append({"name": name, "status": status})
    return content, status


def build(ctx: RunCtx, tm: dict, composio_tools: list[BaseTool], helper: bool = False) -> list[BaseTool]:
    tools: list[BaseTool] = list(composio_tools)

    async def remember(text: str, scope: Literal["self", "project", "user"] = "self") -> str:
        if scope == "project" and not ctx.project:
            return "You are not in a project here. Use scope 'self' or 'user'."
        ns = {"self": memory.ns("teammate", tm["id"]), "user": memory.ns("user", ctx.owner_id)}.get(scope) \
            or memory.ns("project", ctx.project["id"])
        if scope == "user" and mem.ready():  # facts about the user's world go through v2's checks like anything said
            await mem.log_episode(ctx.owner_id, "note", text, trust=1, ref=ctx.thread_id, speaker=tm["name"])
            key = "episode"
        else:
            key = await memory.add(ns, text)
        await db.activity(ctx.owner_id, "memory_write", scope, run_id=ctx.run_id, thread_id=ctx.thread_id,
                          teammate_id=tm["id"], input={"text": text, "scope": scope}, output={"key": key})
        return "Saved."

    async def recall(query: str) -> str:
        spaces = [memory.ns("teammate", tm["id"]), memory.ns("user", ctx.owner_id)]
        if ctx.project:
            spaces.append(memory.ns("project", ctx.project["id"]))
        if mem.ready():
            spaces.remove(memory.ns("user", ctx.owner_id))
        found = [t for ns in spaces for t in await memory.search(ns, query, limit=5)]
        world = await mem.recall(ctx.owner_id, query, used=True) if mem.ready() else ""
        return "\n".join([world, *(f"- {t}" for t in found)]).strip() or "Nothing relevant in memory."

    try:
        zone = ZoneInfo(ctx.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")

    async def search_chat(query: str) -> str:
        words = re.findall(r"[\w'-]{3,}", query.lower())[:5]
        if not words:
            return "Give a few keywords to look for."
        # In a DM: every chat this teammate is in (its DMs and its groups), labelled by chat.
        dm = f"dm:{ctx.members[0]['id']}" if ctx.thread_id.startswith("dm:") and not ctx.project else None
        scope = [r["id"] for r in await brief.teammate_chats(ctx.owner_id, ctx.members[0]["id"])] if dm else []
        rows = await db.select("messages", {
            "thread_id": f"in.({','.join(dict.fromkeys([ctx.thread_id, *scope]))})", "owner_id": f"eq.{ctx.owner_id}",
            "kind": "in.(text,handoff)", "order": "created_at.desc", "limit": "40",
            "or": "(" + ",".join(f"text.ilike.*{w}*" for w in words) + ")",
            "select": "created_at,sender_type,teammate_id,text,thread_id"})
        if not rows:
            return "Nothing in this chat matches."
        names = {m["id"]: m["name"] for m in ctx.members}
        best = sorted(rows, key=lambda r: -sum(w in r["text"].lower() for w in words))[:8]  # most words matched first
        others = {r["thread_id"] for r in best} - {ctx.thread_id}
        titles = {t["id"]: t.get("title") or ("main chat" if t["id"] == dm else "untitled chat") for t in await db.select(
            "threads", {"id": f"in.({','.join(others)})", "select": "id,title,project_id"}) if not t.get("project_id")} if others else {}
        if any(t.startswith("proj:") for t in others):
            titles |= {f"proj:{p['id']}": f"group {p['name']}" for p in await db.select("projects", {
                "id": f"in.({','.join(t[5:] for t in others if t.startswith('proj:'))})", "select": "id,name"})}
        return "\n".join(f"[{datetime.fromisoformat(r['created_at']).astimezone(zone):%a %b %d, %I:%M %p}] "
                         + (f"(in the other chat \"{titles.get(r['thread_id'], 'another chat')}\") " if r["thread_id"] != ctx.thread_id else "") +
                         f"{ctx.user_name if r['sender_type'] == 'user' else names.get(r['teammate_id'], 'Teammate')}: "
                         f"{r['text'][:700]}" for r in sorted(best, key=lambda r: r["created_at"]))

    async def chat_stats(days: int = 0) -> str:
        params = {"thread_id": f"eq.{ctx.thread_id}", "kind": "in.(text,handoff)", "order": "created_at.desc",
                  "limit": "2000", "select": "created_at,sender_type,teammate_id,text"}
        if days > 0:
            params["created_at"] = f"gte.{(datetime.now(UTC) - timedelta(days=days)).isoformat()}"
        rows = list(reversed(await db.select("messages", params)))
        return conversation_stats(rows, ctx.user_name, ctx.members, zone)

    async def model_usage(days: int = 14) -> str:
        days = max(1, min(days, 60))
        hist = await usage.history(days)
        if not hist:
            return "No model requests counted in that time."
        total: dict[str, int] = {}
        for row in hist.values():
            for m, n in row.items():
                total[m] = total.get(m, 0) + n
        top = sorted(total.items(), key=lambda kv: -kv[1])
        return "\n".join([
            f"Chat requests per model, last {days} days (counted by Tubelight; every teammate reply, router and "
            "keeper call is one request; cloudflare:flux-1-schnell counts images generated): " + ", ".join(f"{m} {n}" for m, n in top),
            "Per day: " + "; ".join(f"{d}: " + ", ".join(f"{m} {n}" for m, n in sorted(r.items(), key=lambda kv: -kv[1]))
                                    for d, r in hist.items()),
        ])

    def _when(s: str | None) -> datetime | None:
        # Their wall-clock time: an offset the model tacks on ("Z") is dropped, not honoured.
        d = datetime.fromisoformat(s.strip().rstrip("Z")) if s else None
        return d.replace(tzinfo=zone) if d else None

    async def follow_up(what: str, when: str | None = None, until: str | None = None, owner: str | None = None,
                        check_by: str | None = None, poll_hours: float | None = None) -> str:
        try:
            at, by = _when(when), _when(check_by)
        except ValueError:
            return "Give times as their local date and time, like 2026-09-28T19:00."
        if not (at or until):
            return "Give either `when` (a time) or `until` (a condition to wait for)."
        now = datetime.now(UTC)
        if at and not now < at < now + timedelta(days=60):
            return "Pick a time in the future, within the next 60 days."
        who = tm["id"]
        if ctx.project and owner:
            handle = owner.lstrip("@").lower()
            who = "group" if handle == "group" else next((m["id"] for m in ctx.members if m["handle"] == handle), None)
            if not who:
                return f"No member @{handle} here. Use a member's handle, or 'group'."
        stamp = f"{now.astimezone(zone):%a %b %d, %I:%M %p}"
        await followups.add(ctx.owner_id, ctx.thread_id, who, what, at=at, until=None if at else until, check_by=by,
                            poll_hours=poll_hours, set_by=f"teammate:{tm['id']}", set_at=stamp, by=tm["name"], tz=ctx.timezone)
        return (f"Follow-up set for {at.astimezone(zone):%a %b %d, %I:%M %p}." if at
                else f"Follow-up set for once {until}." + (" I'll check on it with the apps." if poll_hours else "")
                + " It shows in the chat's follow-ups and fires here on its own.")

    async def app_events(app: str) -> str:
        toolkit = await connectors.resolve(app)
        if not toolkit:
            return f"There's no app called {app}."
        try:
            found = await automations.app_events(toolkit)
        except Exception as e:
            return f"Couldn't list {app}'s events: {str(e)[:200]}"
        if not found:
            return f"{connectors.name_of(toolkit)} can't push events; use a schedule instead."
        return "\n".join(f"- {e['slug']}: {e['name']}. Settings: " + (", ".join(
            f"{k}{' (required)' if k in e['required'] else ''}: {d}" for k, d in e["settings"].items()) or "none") for e in found)

    async def automate(action: str, name: str = "", instructions: str = "", schedule: str = "", app_event: str = "",
                       event_settings: dict | None = None, keywords: list[str] | None = None, when: str = "",
                       automation_id: str = "", apps: list[str] | None = None) -> str:
        mine = await automations.in_thread(ctx.owner_id, ctx.thread_id)
        if action == "list":
            return "\n".join(f"- [{r['id'][:8]}] {r['name']} · {automations.describe(r)}" + ("" if r["enabled"] else " (paused)")
                             for r in mine) or "No automations in this chat yet."
        if action == "create":
            try:
                rule = await automations.create(ctx.owner_id, tm, (ctx.project or {}).get("id"), name=name or "Automation",
                                                instructions=instructions, cron=schedule or None, tz=ctx.timezone,
                                                trigger=app_event or None, config=event_settings, contains=keywords, when=when,
                                                toolkits=apps or None)
            except ValueError as e:
                return str(e)
            return (f"Set up {rule['name']} · {automations.describe(rule)}. The chat already shows a capsule for it: "
                    "confirm in a few words, no ids, and don't repeat its details.")
        rule = next((r for r in mine if automation_id and r["id"].startswith(automation_id.strip("[]"))), None)
        if not rule:
            return "Which one? Give its id from action 'list'."
        try:
            if action == "update":
                await automations.update(rule, tm["name"], name=name, instructions=instructions, cron=schedule,
                                         when=when, contains=keywords, **({"toolkits": apps} if apps else {}))
            elif action in ("pause", "resume"):
                await automations.set_enabled(rule, action == "resume", tm["name"])
            elif action == "delete":
                await automations.delete(rule, tm["name"])
            else:
                return "action is one of: create, update, pause, resume, delete, list."
        except ValueError as e:
            return str(e)
        return f"Done: {action}d {rule['name']}." if action != "resume" else f"Resumed {rule['name']}."

    # The web, read-only, for every teammate: Composio's own search (no sign-in, ordinary tool calls on the free plan).
    async def web_search(query: str) -> str:
        try:
            d = await connectors.execute(ctx.owner_id, "COMPOSIO_SEARCH_WEB", {"query": query[:300]})
        except Exception as e:
            return f"Search failed: {str(e)[:200]}"
        answer = str(d.get("answer") or "").strip()
        sources = d.get("citations") or d.get("results") or d.get("sources") or []
        links = "\n".join(f"- {s.get('title') or ''} {s.get('url') or s.get('link') or s.get('id') or ''}".strip()
                          for s in sources[:8] if isinstance(s, dict))
        return (answer[:4000] + (f"\n\nSources:\n{links}" if links else "")) or "No results."

    async def read_page(url: str) -> str:
        if not re.match(r"https?://", url):
            return "Give a full web address starting with http:// or https://."
        title, text, why = url, "", ""
        try:
            d = await connectors.execute(ctx.owner_id, "COMPOSIO_SEARCH_FETCH_URL_CONTENT", {"urls": [url]})
            page = (d.get("results") or [{}])[0] or {}
            title, text = page.get("title") or url, str(page.get("text") or "").strip()
        except Exception as e:
            why = str(e)[:200]
        if browser.ready and (len(text) < 400 or NEEDS_JS.search(text[:2000])):
            # A page that needs scripts, or turns fetchers away: the server browser reads it (incognito, no sign-ins).
            try:
                t, got = await browser.read(ctx.owner_id, url)
                if len(got.strip()) > len(text):
                    title, text = t or title, got.strip()
            except Exception as e:
                why = why or str(e)[:200]
        if not text:
            return f"Couldn't open {url}: {why}" if why else f"{url} had no readable text (it may need a login or be mostly images)."
        return f"{title}\n{url}\n\n" + (text if len(text) <= 9000 else text[:9000] + f"\n[... {len(text) - 9000} more chars]")

    # Email attachments (resumes, invoices, decks) as text, many in one call: one model turn reads a whole batch.
    async def read_attachments(files: list[dict[str, str]]) -> str:
        """files: [{message_id, attachment_id, file_name}] from the attachmentList of fetched emails."""
        if ctx.only is not None and "gmail" not in ctx.only:
            return "This automation isn't allowed to use Gmail."
        files = [f for f in files if isinstance(f, dict) and f.get("message_id") and f.get("attachment_id")][:ATTACH_MAX]
        if not files:
            return "Give message_id, attachment_id and file_name for each attachment (from the email's attachmentList)."
        per = max(1500, ATTACH_BUDGET // len(files))
        gate = asyncio.Semaphore(4)

        async def one(f: dict[str, str]) -> str:
            name = f.get("file_name") or "attachment"
            async with gate:
                try:
                    return await attachment_text(ctx.owner_id, f["message_id"], f["attachment_id"], name, per)
                except Exception as e:
                    return f"### {name}\n(Couldn't read it: {str(e)[:160]})"
        return "\n\n".join(await asyncio.gather(*(one(f) for f in files)))

    async def save_attachments(files: list[dict[str, str]], folder: str = "") -> str:
        """Gmail attachments → files in their vault (folder made if missing)."""
        if ctx.only is not None and "gmail" not in ctx.only:
            return "This automation isn't allowed to use Gmail."
        files = [f for f in files if isinstance(f, dict) and f.get("message_id") and f.get("attachment_id")][:ATTACH_MAX]
        if not files:
            return "Give message_id, attachment_id and file_name for each attachment (from the email's attachmentList)."
        parent = await vault.ensure_folder(ctx.owner_id, folder)
        gate, done, failed = asyncio.Semaphore(4), [], []

        async def one(f: dict[str, str]) -> None:
            name = f.get("file_name") or "attachment"
            async with gate:
                try:
                    data, mime = await attachment_bytes(ctx.owner_id, f["message_id"], f["attachment_id"], name)
                    done.append((await vault.add_bytes(ctx.owner_id, name, data, parent, mime))["name"])
                except Exception as e:
                    failed.append(f"{name} ({str(e)[:100]})")
        await asyncio.gather(*(one(f) for f in files))
        where = folder.strip("/") or "the top of their vault"
        return (f"Saved {len(done)} file(s) to {where}: {', '.join(done)}." if done else "Saved nothing.") + \
            (f" Couldn't save: {'; '.join(failed)}." if failed else "")

    if "GMAIL" in ctx.toolkits(tm):
        async def inbox(days: float = 1, query: str = "") -> str:
            q = " ".join(filter(None, [f"newer_than:{max(1, round(days * 24))}h" if days else "", query.strip()]))
            try:
                mails = await mail.fetch(ctx.owner_id, q or "in:inbox")
            except Exception as e:
                return f"Couldn't read Gmail: {str(e)[:200]}"
            period = f"in the last {days:g} day{'s' if days != 1 else ''}" if days else "matching the search"
            return mail.digest(mails, ctx.timezone, period + (f" ({query.strip()})" if query.strip() else ""))

        tools.append(StructuredTool.from_function(
            coroutine=inbox, name="inbox",
            description="Their whole Gmail inbox for a period in one call: every email (up to 500), mail that may need "
                        "them one per line (time, sender, subject, preview, unread/important, attachments, ids), "
                        "promotions/social/updates folded into counts per sender. Use it FIRST for any summary, catch-up "
                        "or 'anything I need to see' (days: 1 for today, 7 for a week; query: extra Gmail search, like "
                        "'from:college' or 'is:unread'). Open single emails for detail only when a line isn't enough."))

    tools += [
        StructuredTool.from_function(
            coroutine=save_attachments, name="save_attachments",
            description="Save Gmail attachments as files in their vault (the Vault tab), up to 40 in one call. files: "
                        "[{message_id, attachment_id, file_name}] from each email's attachmentList; folder: a folder "
                        "path like 'Hiring/Resumes Oct' (made if it doesn't exist), empty for the top."),
        StructuredTool.from_function(
            coroutine=read_attachments, name="read_attachments",
            description="Read Gmail attachments (PDF, Word, Excel, PowerPoint, text, images) as text, up to 40 in one "
                        "call: resumes, invoices, reports. files: [{message_id, attachment_id, file_name}] taken from "
                        "each fetched email's attachmentList. Read them all in one call, not one by one."),
        StructuredTool.from_function(
            coroutine=web_search, name="web_search",
            description="Search the web for current information (news, docs, prices, people, anything after your "
                        "training). Returns an answer with its sources. Cite the sources you use."),
        StructuredTool.from_function(
            coroutine=read_page, name="read_page",
            description="Read one web page as text (an article, docs, a link the user sent). url: the full address."),
    ]

    if browser.ready:
        owner, tab = ctx.owner_id, tm["id"]  # each teammate works in its own tab; sign-ins are shared

        async def _b(work) -> str:
            try:
                got = await work
            except (browser.Busy, browser.NeedsOK, PermissionError, LookupError, ValueError, RuntimeError) as e:
                return str(e)
            return got if isinstance(got, str) else (cu.head(got) + "\n" + browser.text(got)).strip()

        async def browser_use(site: str, task: str) -> str:
            sites = browser.grant(owner, *re.split(r"[,\s]+", site))
            if not sites:
                return "site: the website's address, like x.com."
            got = await _b(browser.look(owner, sites[0], tab=tab, label=tm["name"]))
            return (f"They OK'd the browser on {', '.join(sites)} for: {task} (20 minutes). Work through it with "
                    "browser_act (browser_subtask for a run of simple steps). A ⚑ button (post, send, buy...) goes "
                    "through browser_commit, which shows them the screen first.\n" + got)

        async def browser_look(url: str = "") -> str:
            return await _b(browser.look(owner, url, tab=tab, label=tm["name"]))

        async def browser_act(snapshot: str, element: str, action: str, value: str = "") -> str:
            return await _b(browser.act(owner, snapshot, element, action, value, tab=tab))

        async def browser_keys(keys: list[str]) -> str:
            return await _b(browser.keys(owner, keys, tab=tab))

        async def browser_subtask(goal: str, inputs: list[str] | None = None, done_when: str = "", max_steps: int = 12) -> str:
            if not browser.granted(owner):
                return "Ask first: call browser_use with the site and the task; they OK it once."

            async def call(op: str, args: dict[str, Any], _timeout: float) -> dict[str, Any]:
                try:
                    if op == "ui_look":
                        got = await browser.look(owner, tab=tab, label=tm["name"])
                    elif op == "ui_act":
                        got = await browser.act(owner, args["snapshot"], args["element"], args["action"], args.get("value", ""), tab=tab)
                    else:
                        got = await browser.keys(owner, args["keys"], tab=tab)
                except browser.NeedsOK as e:
                    return {"status": "needs_ok", "why": str(e)}
                return {**got, "text": browser.text(got)}

            return await cu.subtask("", "browser", goal, inputs or [], done_when, max_steps, call=call, kind=cu.BROWSER)

        async def browser_signin(site: str, reason: str = "", url: str = "") -> str:
            return "handled by the graph"

        async def browser_commit(snapshot: str, element: str, what: str) -> str:
            return await _b(browser.commit(owner, snapshot, element, tab=tab))

        async def schedule_post(site: str, text: str, when: str) -> str:
            try:
                at = _when(when)
            except ValueError:
                return "Give the time as their local date and time, like 2026-10-28T09:30."
            if not at or not datetime.now(UTC) < at < datetime.now(UTC) + timedelta(days=60):
                return "Pick a time in the future, within the next 60 days."
            host = browser.site_of(site)
            await browser.preapprove(owner, tab, host, text, at)
            await followups.add(ctx.owner_id, ctx.thread_id, tm["id"],
                                f"Publish this on {host} now, word for word; {ctx.user_name} already approved it, so "
                                f"browser_use and browser_commit go through without asking:\n\n{text}",
                                at=at, set_by=f"teammate:{tm['id']}", by=tm["name"], tz=ctx.timezone)
            return f"Scheduled for {at.astimezone(zone):%a %b %d, %I:%M %p} on {host}; it posts then without asking again."

        tools += [
            StructuredTool.from_function(coroutine=schedule_post, name="schedule_post",
                description="Schedule a post (a tweet, a LinkedIn post, a reply) to go out later through the browser. They "
                            "approve the exact text now; at `when` (their local time, like 2026-10-28T09:30) you publish "
                            "it without asking again, as long as the text is unchanged. site: like x.com. text: the whole "
                            "post, final."),
            StructuredTool.from_function(coroutine=browser_use, name="browser_use",
                description="Ask to use Tubelight's web browser on a site for a task (post, reply, fill a form, change a "
                            "setting): once per task, they OK it, then you can act on that site for 20 minutes. Its sign-ins "
                            "are theirs (they sign in themselves). site: the address, like x.com (several: comma-separated). "
                            "task: what you'll do, in a line they read before saying yes. Answers with the page."),
            StructuredTool.from_function(coroutine=browser_look, name="browser_look",
                description="Read the browser's page: every link, button, field and text, each with an id ([e12]). url: go "
                            "there first (only sites they allowed)."),
            StructuredTool.from_function(coroutine=browser_act, name="browser_act",
                description="Do one thing to one element of a snapshot: CLICK, TYPE (value: the field's new text) or READ "
                            "(its full text). If the page changed since, nothing happens and you get the new page. ⚑ "
                            "buttons (post, send, buy, delete...) are refused here: use browser_commit."),
            StructuredTool.from_function(coroutine=browser_keys, name="browser_keys",
                description="Press keys on the page: \"page_down\", \"page_up\", \"escape\", \"tab\", \"backspace\"."),
            StructuredTool.from_function(coroutine=browser_subtask, name="browser_subtask",
                description="Hand a run of simple steps on the page (open the composer and type the post, fill a form) to a "
                            "fast helper. It stops with DONE, BLOCKED, NEEDS_INPUT or NEEDS_OK (a ⚑ button is next: call "
                            "browser_commit with that snapshot and element). goal: one outcome. inputs: every text it may "
                            "type, exactly. done_when: what the page shows when it's done."),
            StructuredTool.from_function(coroutine=browser_signin, name="browser_signin",
                description="When a site needs them signed in (a sign-in page, or they ask you to log in): this gives "
                            "them a Sign in card that opens the site's sign-in page in Tubelight's browser, where they "
                            "sign in themselves. NEVER ask for a password, code or username in chat, and never type one. "
                            "site: like x.com. reason: one line on why. url: the sign-in page, if you know it."),
            StructuredTool.from_function(coroutine=browser_commit, name="browser_commit",
                description="Press a ⚑ button (Post, Send, Buy, Delete...) after they approve: they see the screen and the "
                            "text first. snapshot, element: from the latest look. what: what pressing it does, in a line "
                            "('posts the tweet'). If the page changes after they approve, nothing is pressed."),
        ]

    if ctx.project and repo.parse(ctx.project.get("repo_url")):
        pid = ctx.project["id"]

        async def repo_context(query: str = "", path: str = "") -> str:
            if path:
                text = repo.read(pid, path)
                if text is None:
                    return f"No file {path} in the repo (paths are relative to its root; search first)."
                return f"{path}:\n{text}"
            stored = await repo.get(pid)
            q = query.lower()
            if any(w in q for w in ("change", "commit", "recent", "latest", "new")):
                entries = (stored.get("log") or {}).get("entries") or []
                if entries:
                    return "Recent changes:\n" + "\n".join(
                        f"{e['from']}..{e['to']} ({e['at'][:10]}): " + "; ".join(f"{c['message']} ({c['author']})" for c in e["commits"][:10])
                        for e in entries[:5])
            areas = (stored.get("areas") or {}).get("areas") or {}
            hits = [f"## {a}\n{v['summary']}" for a, v in areas.items() if any(w in (a + v["summary"]).lower() for w in q.split())][:4]
            found = repo.search(pid, query) if query else ""
            if not hits and not found:
                return "Nothing in the repo matches that. Try other words, or ask for a path."
            return "\n\n".join([*hits, *(["Matching files:\n" + found] if found else [])])[:9000]

        async def repo_note(note: str) -> str:
            await repo.add_note(pid, note, tm["name"])
            return "Added to the repo notes every teammate here reads."

        tools += [
            StructuredTool.from_function(
                coroutine=repo_context, name="repo_context",
                description="Look into this project's code repo (its brief is in your instructions). query: words to "
                            "search the code, area summaries and recent changes ('recent changes' lists the latest "
                            "commits); path: read one file (path from the repo root). Read-only."),
            StructuredTool.from_function(
                coroutine=repo_note, name="repo_note",
                description="Add one short, lasting fact about the repo to its brief for every teammate (a gotcha, a "
                            "convention, where something lives). Not for chat or task status."),
        ]

    if not helper and mind.is_memory(tm):  # the memory agent edits memory itself (app/mind.py)
        tools += mind.build(ctx.owner_id)

    if not helper and phone.is_phone(tm):  # only the phone's own teammate touches the phone
        async def phone_action(action: str, when: str = "", end: str = "", seconds: int = 0, title: str = "",
                               text: str = "", number: str = "", name: str = "", to: str = "", place: str = "", url: str = "",
                               app: str = "", level: int | None = None) -> str:
            a = phone.action(action, _when(when) if "T" in when or "-" in when else None, _when(end) if end else None,
                             when, seconds=seconds, title=title, text=text, number=number, name=name, to=to, place=place,
                             url=url, app=app, level=level)
            if isinstance(a, str):
                return f"Not done: {a}"
            ctx.phone_actions.setdefault(tm["id"], []).append(a)
            return ("It happens on their phone as your reply arrives (alarms and timers silently; calls, texts, "
                    "emails and calendar events open ready for them to confirm). Confirm in a few words.")

        tools.append(StructuredTool.from_function(
            coroutine=phone_action, name="phone_action",
            description=(
                "Do something on their phone right now (alarms and reminders: use the alarms / reminders tools): timer (seconds), "
                "timers, timer_off (no app can cancel a running timer: this opens their timers to stop it, say so), "
                "call / text / whatsapp (name from their contacts, or number; text), email (to, title, text), "
                "navigate (place), calendar (title, when + end as date-times, place), open_app (app), open_url (url), "
                "search (text), flashlight (text: on/off), volume (level 0-100, text: media/ring/alarm/notification), "
                "dnd (text: on/off), brightness (level 0-100), media (text: play/pause/next/previous/stop), play (text: what, "
                "app: Spotify/YouTube Music/Apple Music/JioSaavn), photo (opens the camera), panel (text: wifi/internet/bluetooth/"
                "airplane/battery saver/location/volume: apps can't switch these, so their panel opens), settings (text: "
                "storage, battery, wifi, bluetooth, display, apps, sound, location). For a reminder use the reminders tool.")))
        async def phone_status() -> str:
            return await phone.status_text(ctx.owner_id, zone)

        async def phone_send(kind: str, text: str, key: str = "", name: str = "", number: str = "") -> str:
            kind = kind.strip().lower()
            if kind not in phone.SENDS:
                return "kind is reply (key from phone_notifications) or sms (name or number)."
            if not text.strip() or (kind == "reply" and not key) or (kind == "sms" and not (name or number)):
                return "Give the text, and the notification's reply key (reply) or who (sms)."
            ctx.phone_actions.setdefault(tm["id"], []).append({"action": kind, "text": text, **{k: v for k, v in
                                                                (("key", key), ("name", name), ("number", number)) if v}})
            return "It goes out from their phone as your reply arrives. Say it's sent, in a few words."

        tools.append(StructuredTool.from_function(
            coroutine=phone_send, name="phone_send",
            description="Send something from their phone, after their OK: kind reply = answer a message from its "
                        "notification (key: the [reply key] phone_notifications shows; works in WhatsApp, Telegram, "
                        "Messages, Slack…); kind sms = an SMS (name from their contacts, or number). text: exactly what "
                        "to send."))

        async def phone_use_app(app: str, task: str, inputs: list[str] | None = None, done_when: str = "") -> str:
            ctx.phone_actions.setdefault(tm["id"], []).append({"action": "use_app", "app": app, "goal": task,
                                                                 "inputs": inputs or [], "done_when": done_when})
            return ("The phone works through it in the app as your reply arrives and posts how it went in this chat. "
                    "Say you're on it, in a few words.")

        tools.append(StructuredTool.from_function(
            coroutine=phone_use_app, name="phone_use_app",
            description="Do a task inside an app on their phone for them, after their OK (when no action above does "
                        "it: ordering, booking, changing an app's setting, finding something in an app). app: its name; "
                        "task: one clear goal; inputs: every text it may type (it types nothing else); done_when: what "
                        "the screen shows when it's done. The phone opens the app and works through it."))

        tools.append(StructuredTool.from_function(
            coroutine=phone_status, name="phone_status",
            description="This phone as it last reported (whenever they open Tubelight or the assistant): storage, battery, "
                        "network, the next alarm, the calendar till tomorrow night, recent calls, what's playing, and "
                        "which permissions are still off."))
        if ctx.phone_notes:
            async def phone_notifications(query: str = "", app: str = "", hours: int = 12) -> str:
                return await phone.notes(ctx.owner_id, query, app, hours, zone)

            tools.append(StructuredTool.from_function(
                coroutine=phone_notifications, name="phone_notifications",
                description="Notifications that arrived on their phone in the last hours (they turned this on): "
                            "query: words to match; app: e.g. WhatsApp, Gmail; hours: up to 24."))
    elif not helper and ctx.phone_mate:  # everyone else goes through the phone, and the user OKs it there
        pm = ctx.phone_mate

        async def ask_phone(request: str) -> str:
            from . import runs
            thread = f"dm:{pm['id']}"
            await db.insert("messages", {"thread_id": thread, "owner_id": ctx.owner_id, "sender_type": "teammate",
                                         "teammate_id": tm["id"], "text": request[:2000], "kind": "text",
                                         "meta": {"phone_request": True}})
            await runs.start(ctx.owner_id, thread, f"{tm['name']} (a teammate, not {ctx.user_name}) asks: {request[:2000]}",
                             trigger="event", teammate_id=pm["id"], event_type="phone_request")
            return (f"Asked {pm['name']}, their phone. Nothing happens on the phone until {ctx.user_name} OKs it in "
                    f"{pm['name']}'s chat: say so.")

        tools.append(StructuredTool.from_function(
            coroutine=ask_phone, name="ask_phone",
            description=f"Ask {pm['name']} (their phone, the only one who can use it) to do something on the phone: an "
                        "timer, open an app, get a call/text/WhatsApp/email ready, directions, a calendar "
                        "entry, look through its notifications. Say exactly what and why; they OK it before it happens."))

    if not helper and ctx.thread_id.startswith("dm:"):
        async def new_chat(title: str, first_message: str = "") -> str:
            title = " ".join(title.split())[:60]
            if not title:
                return "Give the chat a name."
            mine = await db.select("threads", {"owner_id": f"eq.{ctx.owner_id}", "teammate_id": f"eq.{tm['id']}",
                                               "kind": "eq.dm", "select": "id,title"})
            if any((t.get("title") or "").lower() == title.lower() for t in mine):
                return f"There's already a chat called {title}."
            t = await db.insert("threads", {"id": f"dm:{tm['id']}:{uuid.uuid4().hex[:8]}", "owner_id": ctx.owner_id,
                                            "kind": "dm", "teammate_id": tm["id"], "title": title})
            if first_message.strip():
                await db.insert("messages", {"thread_id": t["id"], "owner_id": ctx.owner_id, "sender_type": "teammate",
                                             "teammate_id": tm["id"], "text": first_message.strip()[:4000], "kind": "text"})
            return f"Made the chat {title}; it's in their chat list with you (tap the chats icon in your header)."

        tools.append(StructuredTool.from_function(
            coroutine=new_chat, name="new_chat",
            description="Start a new chat with them, beside this one, for its own topic (a subject, a project, a "
                        "repo). title: its name, 2 to 5 words. first_message: optional opening line you post there "
                        "(what the chat is for, what you know so far)."))

    others = [m for m in ctx.crew if m["id"] != tm["id"]]
    if not helper and others and ctx.event_type != "delegate":  # one level: a delegated run can't delegate again
        async def ask_teammate(handle: str, request: str) -> str:
            from . import runs
            mate = next((m for m in others if m["handle"] == handle.lstrip("@").lower()), None)
            if not mate:
                return "No teammate @" + handle.lstrip("@") + ". Pick one of: " + ", ".join("@" + m["handle"] for m in others)
            thread = f"dm:{mate['id']}"
            asked = await db.insert("messages", {"thread_id": thread, "owner_id": ctx.owner_id, "sender_type": "teammate",
                                                 "teammate_id": tm["id"], "text": request[:4000], "kind": "text",
                                                 "meta": {"delegated": True}})
            run_id = await runs.start(ctx.owner_id, thread, f"{tm['name']} (your teammate, working for {ctx.user_name}, "
                                      f"not {ctx.user_name}) asks: {request[:4000]}", trigger="event",
                                      teammate_id=mate["id"], event_type="delegate", sender=tm["handle"])
            # ponytail: polls the run row; an event per run would beat a 2 s poll if delegations get frequent
            for _ in range(DELEGATE_WAIT_S // 2):
                await asyncio.sleep(2)
                run = await db.one("runs", {"id": f"eq.{run_id}", "select": "status"})
                if (run or {}).get("status") != "running":
                    break
            status = (run or {}).get("status")
            if status == "waiting_approval":
                return (f"{mate['name']} needs {ctx.user_name}'s OK in {mate['name']}'s chat before going on: tell them "
                        "to look there.")
            if status == "running":
                return f"{mate['name']} is still working on it and will answer in their own chat: say so."
            replies = await db.select("messages", {"thread_id": f"eq.{thread}", "teammate_id": f"eq.{mate['id']}",
                                                   "created_at": f"gt.{asked['created_at']}", "select": "text",
                                                   "order": "created_at"})
            text = "\n\n".join(r["text"] for r in replies if r.get("text"))
            return f"{mate['name']} answered:\n{text[:6000]}" if text else f"{mate['name']} finished without a reply ({status})."

        tools.append(StructuredTool.from_function(
            coroutine=ask_teammate, name="ask_teammate",
            description="Hand a request to another teammate; it works on it in its own chat (with its own apps and "
                        f"files) and you get its answer back. Teammates: {'; '.join('@' + m['handle'] + ' ' + m['name'] + ' (' + m['role'] + ')' for m in others)}. "
                        "Use it when the work is theirs; give the whole request and context, as you would to a colleague. "
                        "Ask several in turn when a task spans them, then put their answers together."))

    if not helper:
        async def make_document(kind: str, title: str, content: str) -> str:
            try:
                name, data = await asyncio.to_thread(documents.make, kind, title, content)
            except ValueError as e:
                return f"Not made: {e} Fix it and call make_document again."
            ctx.outgoing.setdefault(tm["id"], []).append(await files.upload(ctx.owner_id, name, data))
            return f"{name} ({len(data) / 1e3:.0f} KB) is attached to your reply. Say a line about what's in it; don't paste it."

        tools.append(StructuredTool.from_function(
            coroutine=make_document, name="make_document",
            description=(
                "Make a file and attach it to your reply: a report, letter, plan or notes (pdf, docx, md), a "
                "spreadsheet (xlsx) or a slide deck (pptx). Write the whole document, polished, not an outline. "
                "kind: pdf | docx | md | xlsx | pptx. title: the document's title (also its file name). "
                "content for pdf/docx/md: Markdown (# headings, **bold**, lists, | tables |, > quotes, ``` code). "
                "content for xlsx: JSON {\"sheets\": [{\"name\", \"columns\": [..], \"rows\": [[..]], "
                "\"formats\": {\"<column>\": \"#,##0.00\" | \"0%\" | \"dd-mmm-yyyy\"}}]}; numbers as numbers, "
                "formulas as \"=SUM(B2:B9)\". content for pptx: JSON {\"slides\": [{\"type\": \"title\"|\"section\"|"
                "\"bullets\"|\"two_column\"|\"table\"|\"stats\"|\"quote\", \"title\", \"subtitle\", \"bullets\": [..] "
                "(indent a sub-point with two spaces), \"left\"/\"right\" + \"left_title\"/\"right_title\", \"columns\"+\"rows\", "
                "\"stats\": [{\"value\", \"label\"}], \"quote\"+\"by\", \"notes\"}]}: 6 short bullets at most per "
                "slide, one idea per slide, speaker notes for the detail. Never invent figures, stats or quotes: use "
                "numbers they gave or a tool found, else a clear placeholder like [X%]. To change a file they attached, read it "
                "(it's in their message) and make the new version.")))

    if not helper:
        async def todo_list(action: str, todo: str = "", title: str = "", notes: str | None = None, status: str = "",
                            priority: int | None = None, due: str | None = None, labels: str | None = None) -> str:
            mates = await db.select("teammates", {"owner_id": f"eq.{ctx.owner_id}", "select": "id,name"})
            names = {m["id"]: m["name"] for m in mates} | {lb["id"]: lb["name"] for lb in await todos.LABELS.listing(ctx.owner_id)}
            if action == "list":
                rows = todos.open_and_recent(await todos.listing(ctx.owner_id))
                return "\n".join(todos.describe(t, names) for t in rows) or "Their to-do list is empty."
            fields = {k: v for k, v in {"notes": notes, "status": status or None, "priority": priority, "due": due}.items()
                      if v is not None}
            try:
                if labels is not None:
                    fields["labels"] = await todos.label_ids(ctx.owner_id, labels)
                    names |= {lb["id"]: lb["name"] for lb in await todos.LABELS.listing(ctx.owner_id)}
                if action == "add":
                    t = await todos.add(ctx.owner_id, title, added_by=tm["id"], thread_id=ctx.thread_id, **fields)
                    await todos.note(ctx.owner_id, ctx.thread_id, f"{tm['name']} added a to-do: {t['title']}", "added")
                    return f"Added to their to-dos (the Orbit tab): {todos.describe(t, names)}"
                t = await todos.find(ctx.owner_id, todo) if action in ("update", "delete") else None
                if action in ("update", "delete") and not t:
                    return "No single to-do matches that: list them and pass its [id]."
                if action == "delete":
                    await todos.remove(ctx.owner_id, t["id"])
                    await todos.note(ctx.owner_id, ctx.thread_id, f"{tm['name']} removed a to-do: {t['title']}", "removed")
                    return f"Removed: {t['title']}"
                if action == "update":
                    new = await todos.update(ctx.owner_id, t["id"], {**fields, **({"title": title} if title else {})})
                    if new["status"] == "done" and t["status"] != "done":
                        await todos.note(ctx.owner_id, ctx.thread_id, f"{tm['name']} completed a to-do: {new['title']}", "done")
                    return f"Updated: {todos.describe(new, names)}"
            except ValueError as e:
                return str(e)
            return "action is list, add, update or delete."

        async def alarm_list(action: str, alarm: str = "", time: str = "", days: str | None = None, label: str | None = None,
                             enabled: bool | None = None) -> str:
            if action == "list":
                rows = await clock.ALARMS.listing(ctx.owner_id)
                return "\n".join(clock.describe_alarm(a) for a in rows) or "No alarms set."
            try:
                fields: dict[str, Any] = {k: v for k, v in {"label": label, "enabled": enabled}.items() if v is not None}
                if time:
                    hm = phone._clock(time)
                    if not hm:
                        return "Give the time as HH:MM."
                    fields["time"] = f"{hm[0]:02d}:{hm[1]:02d}"
                if days is not None:
                    fields["days"] = clock.parse_days(days)
                if action == "add":
                    if "time" not in fields:
                        return "Give the alarm's time."
                    a = {"enabled": True, **fields}
                    if not a.get("days"):
                        a["at"] = clock.next_at(a["time"], zone)
                    a = await clock.ALARMS.add(ctx.owner_id, a)
                    await push.clock(ctx.owner_id, f"Alarm set · {a['time']}", f"{a['label'] or tm['name']} · {clock.days_text(a['days'])}")
                    return f"Set (it rings on their phone; it's in Orbit → Clock): {clock.describe_alarm(a)}"
                a = None
                if action in ("update", "delete"):
                    a = await clock.find(clock.ALARMS, ctx.owner_id, alarm, "label") or await clock.find(clock.ALARMS, ctx.owner_id, alarm, "time")
                    if not a:
                        return "No single alarm matches that: list them and pass its [id]."
                if action == "delete":
                    await clock.ALARMS.remove(ctx.owner_id, a["id"])
                    await push.clock(ctx.owner_id, f"Alarm removed · {a['time']}", a["label"] or tm["name"])
                    return f"Removed: {clock.describe_alarm(a)}"
                if action == "update":
                    merged = {**a, **fields}
                    if merged["enabled"] and not merged.get("days"):
                        fields["at"] = clock.next_at(merged["time"], zone)
                    a = await clock.ALARMS.update(ctx.owner_id, a["id"], fields)
                    await push.clock(ctx.owner_id, f"Alarm {'on' if clock.is_on(a) else 'off'} · {a['time']}", a["label"] or tm["name"])
                    return f"Updated: {clock.describe_alarm(a)}"
            except ValueError as e:
                return str(e)
            return "action is list, add, update or delete."

        async def reminder_list(action: str, reminder: str = "", title: str = "", when: str = "", repeat: str | None = None,
                                notes: str | None = None, done: bool | None = None) -> str:
            if action == "list":
                rows = [r for r in await clock.REMINDERS.listing(ctx.owner_id) if not r.get("done")]
                return "\n".join(clock.describe_reminder(r, zone) for r in rows) or "No reminders waiting."
            try:
                fields: dict[str, Any] = {k: v for k, v in {"title": title or None, "repeat": repeat, "notes": notes, "done": done}.items()
                                          if v is not None}
                if when:
                    fields["at"] = clock.local(when, zone)
                if action == "add":
                    r = await clock.REMINDERS.add(ctx.owner_id, fields)
                    at = datetime.fromisoformat(r["at"]).astimezone(zone)
                    await push.clock(ctx.owner_id, f"Reminder set · {at:%a %H:%M}", r["title"])
                    return f"Set (their phone reminds them then; it's in Orbit → Clock): {clock.describe_reminder(r, zone)}"
                r = None
                if action in ("update", "delete"):
                    r = await clock.find(clock.REMINDERS, ctx.owner_id, reminder, "title")
                    if not r:
                        return "No single reminder matches that: list them and pass its [id]."
                if action == "delete":
                    await clock.REMINDERS.remove(ctx.owner_id, r["id"])
                    await push.clock(ctx.owner_id, "Reminder removed", r["title"])
                    return f"Removed: {r['title']}"
                if action == "update":
                    r = await clock.REMINDERS.update(ctx.owner_id, r["id"], fields)
                    await push.clock(ctx.owner_id, "Reminder updated", r["title"])
                    return f"Updated: {clock.describe_reminder(r, zone)}"
            except ValueError as e:
                return str(e)
            return "action is list, add, update or delete."

        async def knowledge_search(query: str, file: str = "", folder: str = "") -> str:
            st = await knowledge.state(tm["id"])
            fid = next((k for k, f in st["files"].items() if file and f["name"].lower() == file.lower()), "")
            if file and not fid:
                return f"No file named {file} in your knowledge base. It has: " + ", ".join(f["name"] for f in st["files"].values())
            if folder.strip("/") and not fid:
                ids = knowledge.under(await vault.items(ctx.owner_id), folder, st["files"])
                if not ids:
                    return f"Nothing in your knowledge base is in a folder {folder}."
                per = await asyncio.gather(*(knowledge.search(tm["id"], query, limit=6, file=i) for i in ids[:40]))
                hits = sorted((h for p in per for h in p), key=lambda h: -(h.get("score") or 0))[:6]
            else:
                hits = await knowledge.search(tm["id"], query, limit=6, file=fid)
            reading = [f["name"] for f in st["files"].values() if f.get("reading")]
            note = f"\n(Still reading: {', '.join(reading)}; its passages aren't searchable yet.)" if reading else ""
            return ("\n\n".join(knowledge.cite(h) for h in hits) or "Nothing in your knowledge base matches.") + note

        async def vault_files(action: str, path: str = "", query: str = "", folder: str = "", content: str = "") -> str:
            rows = vault.visible(await vault.items(ctx.owner_id))  # folders they hid from teammates stay out
            by_id = {r["id"]: r for r in rows}

            def full(r: dict) -> str:
                parts, at = [], r
                while at:
                    parts.append(at["name"])
                    at = by_id.get(at.get("parent") or "")
                return "/".join(reversed(parts))

            paths = {full(r).lower(): r for r in rows}

            def line(r: dict) -> str:
                return f"- {full(r)}/" if r["kind"] == "folder" else f"- {full(r)} ({r['size'] / 1e6:.1f} MB, {r['mime']})"

            if action == "list":
                at = paths.get(folder.strip("/").lower()) if folder.strip("/") else None
                if folder.strip("/") and (not at or at["kind"] != "folder"):
                    return f"No folder {folder} in the vault."
                kids = sorted((r for r in rows if (r.get("parent") or "") == (at["id"] if at else "")), key=lambda r: (r["kind"] != "folder", r["name"].lower()))
                return "\n".join(line(r) for r in kids[:80]) or "Nothing there."
            if action == "search":
                q = query.lower().strip()
                hits = [r for p, r in paths.items() if q and q in p]
                return "\n".join(line(r) for r in hits[:30]) or f"Nothing in the vault matches {query}."
            if action == "learn":
                r = paths.get((path or folder).strip("/").lower())
                if not r:
                    return f"No file or folder {path or folder} in the vault."
                st = await knowledge.state(tm["id"])
                await knowledge.link(ctx.owner_id, tm["id"], [*st["links"], r["id"]])
                return (f"Added {full(r)} to your knowledge base; reading it now (a big PDF takes a few minutes). "
                        "Files added to that folder later are learned too.")
            if action == "folder":
                await vault.ensure_folder(ctx.owner_id, folder or path)
                return f"Folder {(folder or path).strip('/')} is ready."
            if action == "write":
                if not path.strip("/") or not content:
                    return "write needs path (like 'IITM/Rules.md') and content."
                *dirs, name = path.strip("/").split("/")
                row = await vault.add_bytes(ctx.owner_id, name, content.encode(), await vault.ensure_folder(ctx.owner_id, "/".join(dirs)))
                knowledge.sync_later(ctx.owner_id, tm["id"])  # a note written into a folder it learns from
                return f"Wrote {'/'.join([*dirs, row['name']])} to their vault."
            if action == "save":
                parent = await vault.ensure_folder(ctx.owner_id, folder)
                want = path.lower().strip()
                mine = list(ctx.outgoing.get(tm["id"], []))
                recent = await db.select("messages", {"thread_id": f"eq.{ctx.thread_id}", "owner_id": f"eq.{ctx.owner_id}",
                                                      "select": "meta", "order": "created_at.desc", "limit": "60"})
                atts = mine + [a for m in recent for a in ((m.get("meta") or {}).get("attachments") or [])]
                hit = next((a for a in atts if want and want in str(a.get("name", "")).lower()), None)
                if not hit:
                    return "No file by that name in this chat to save."
                data = await files._download(ctx.owner_id, hit["path"])
                row = await vault.add_bytes(ctx.owner_id, hit["name"], data, parent, hit.get("mime") or "")
                return f"Saved to their vault as {full(row) if row['parent'] else row['name']}."
            r = paths.get(path.strip("/").lower())
            if not r or r["kind"] != "file":
                return f"No file {path} in the vault; search for it first."
            if action == "read":
                return await files.text_of(r["name"], r["mime"], await asyncio.to_thread(vault.read_bytes, ctx.owner_id, r["id"]))
            if action == "attach":
                if r["size"] > 25e6:
                    return "That file is over 25 MB; tell them it's in their vault instead."
                data = await asyncio.to_thread(vault.read_bytes, ctx.owner_id, r["id"])
                ctx.outgoing.setdefault(tm["id"], []).append(await files.upload(ctx.owner_id, r["name"], data))
                return f"{r['name']} is attached to your reply."
            return "action is list, search, read, attach, save, write, folder or learn."

        tools += [
            StructuredTool.from_function(
                coroutine=todo_list, name="todos",
                description="Their own to-do list (the app's Orbit tab, Linear-style). action: list (open ones and the "
                            "last week's done) | add (title; optional notes, priority 1 urgent..4 low, due YYYY-MM-DD, "
                            "status backlog|todo|doing|done) | update (todo: its [id]; any of title, notes, status, "
                            "priority, due; due '' clears it) | delete. Add one when they ask you to note a task for "
                            "them; a follow-up is for when YOU will come back. labels: comma-separated names (new "
                            "ones are made), replacing its labels; '' clears them."),
            StructuredTool.from_function(
                coroutine=alarm_list, name="alarms",
                description="Their alarms, Tubelight's own (they ring full screen on their phone; Orbit → Clock). "
                            "action: list | add (time HH:MM; days: weekdays, weekends, daily, mon,wed,fri or '' for once; "
                            "label) | update (alarm: its [id], label or time; any of time, days, label, enabled) | "
                            "delete. Use it whenever they ask for an alarm or to wake them."),
            StructuredTool.from_function(
                coroutine=reminder_list, name="reminders",
                description="Their reminders, Tubelight's own (a notification on their phone at the time, with Done "
                            "and Snooze; Orbit → Clock). action: list | add (title, when: their local "
                            "YYYY-MM-DDTHH:MM; repeat: daily, weekdays, weekly, monthly, yearly; notes) | update (reminder: "
                            "its [id] or title; any of title, when, repeat, notes, done) | delete. Use it when they ask to "
                            "be reminded of something; follow_up is for when YOU come back to this chat."),
            *([StructuredTool.from_function(
                coroutine=knowledge_search, name="knowledge",
                description=f"Search your knowledge base: the files {ctx.user_name} gave you to know (notes, books, "
                            "PDFs), read in full. Returns the passages that best match, each with its file and page. "
                            "Use it for anything those files may cover, search again with other words if the first "
                            "passages miss, answer from them and say where (file, page). file: limit to one file's "
                            "name; folder: limit to a vault folder (like 'IITM/Maths 2'); both optional.")] if tm["id"] in ctx.kb else []),
            StructuredTool.from_function(
                coroutine=vault_files, name="vault",
                description="Their vault: their own files (photos, PDFs, notes, documents) on their server. action: list "
                            "(folder: a folder path, or empty for the top) | search (query: part of a name) | read (path: "
                            "a file's path, gives its text: documents as Markdown, sheets as tables with formulas worked "
                            "out, slides as points, images described; work out totals, trends and answers from it) | attach (path: send them the file in your reply) | save (path: "
                            "the name of a file attached in this chat or one you just made; folder: where, made if missing) | write "
                            "(path: like 'Notes/Plan.md', content: the text; a Markdown/text file, folders made if missing) | "
                            "folder (folder: a path to create, like 'Hiring/Resumes') | learn (path: a file or folder to add to "
                            "your knowledge base, read in full and searchable from then on; a folder keeps learning new files)."),
        ]

    if images.available() and not helper:
        async def generate_image(prompt: str) -> str:
            att = await images.generate(ctx.owner_id, prompt)
            ctx.outgoing.setdefault(tm["id"], []).append({**att, "name": "Generated image.jpg"})
            return "The image is attached to your reply; they see it in the chat. Say a line about it, don't describe it at length."

        tools.append(StructuredTool.from_function(
            coroutine=generate_image, name="generate_image",
            description="Make a picture from a description (illustrations, mockups, posters, photos of things that "
                        "don't exist). prompt: a detailed visual description in English: subject, style, composition, "
                        "colours, mood. One image per call; it shows in your reply."))

    tools += [
        StructuredTool.from_function(
            coroutine=automate, name="automate",
            description="Standing instructions you carry out on your own: on a schedule (every 3 hours, weekdays at 8 "
                        "AM) or whenever something happens in an app (a new mail from abc, a new Linear issue). "
                        "action: create | update | pause | resume | delete | list. For create: name (2-4 words, what it does, not "
                        "when: 'Pizza fact', 'Mail brief'), "
                        "instructions (what to do each run, self-contained: what to check, what counts, how to "
                        "report), when (plain words, e.g. 'every 3 hours'), and either schedule (a 5-field cron in "
                        "their local time: '0 */3 * * *', '0 8 * * 1-5') or app_event (a slug from app_events) with "
                        "event_settings (e.g. Gmail {\"query\": \"from:abc@x.com\"}) and optional keywords (all must "
                        "appear in the event), and optional apps (only the apps each run needs, e.g. [\"GMAIL\"]; leave it out for all "
                        "yours). Others need automation_id from list."),
        StructuredTool.from_function(
            coroutine=app_events, name="app_events",
            description="The events an app can push to you (for automate's app_event), with their settings. app: "
                        "the app's name, e.g. 'Gmail' or 'Linear'."),
        StructuredTool.from_function(
            coroutine=chat_stats, name="chat_stats",
            description="Real numbers about this chat: messages per person, who answered whom, who @mentioned whom, "
                        "messages per day. days: only the last N days (0 = all). Use it to chart the conversation."),
        StructuredTool.from_function(
            coroutine=model_usage, name="model_usage",
            description="Real numbers on which AI models the user's teammates have been using: requests per model, "
                        "in total and per day, for the last N days (default 14). Use it for any question or chart "
                        "about their model or AI usage."),
        StructuredTool.from_function(
            coroutine=search_chat, name="search_chat",
            description="Search this chat's full history (in a DM, your other chats with the user too) for earlier messages (exact wording, what was said this "
                        "morning or days ago), by keywords. The brief summarises; this finds the words."),
        StructuredTool.from_function(
            coroutine=follow_up, name="follow_up",
            description="Come back to this chat later: when the user asks you to circle back, remind them or check on "
                        "something, or you promise to get back to them. Either `when` (their local time, "
                        "YYYY-MM-DDTHH:MM) or `until` (a condition to wait for, e.g. 'the design tweak is done'; it "
                        "fires when the chat shows it's true). what: what to do then, self-contained. In a group, "
                        "owner: the handle who should act then, or 'group'. For a condition: check_by (a deadline to "
                        "nudge if it still isn't done) and poll_hours (only if you can check it with an app)."),
        StructuredTool.from_function(
            coroutine=remember, name="remember",
            description="Save a durable fact to long-term memory. scope: 'self' = your own notes, "
                        "'project' = shared with this project group, 'user' = the user's profile "
                        "(preferences, facts about them). Keep each fact short and self-contained."),
        StructuredTool.from_function(
            coroutine=recall, name="recall", description="Search long-term memory (yours, the project's and the user's profile)."),
    ]

    if not helper:
        async def ask_user(question: str, options: list[str], allow_other: bool = True) -> str:
            return "handled by the graph"

        async def connect_app(toolkit: str, reason: str = "") -> str:
            return "handled by the graph"

        tools += [
            StructuredTool.from_function(
                coroutine=ask_user, name="ask_user",
                description="Ask the user to choose before you continue, when the right next step depends on their "
                            "preference. Give 2 to 4 short, distinct options (a few words each); they can also type "
                            "their own answer. Use it for real forks, not for yes/no confirmations of approved actions."),
            StructuredTool.from_function(
                coroutine=connect_app, name="connect_app",
                description="Ask the user to connect an app you need when it is not connected yet, by its name "
                            "(e.g. 'Google Calendar', 'Slack', 'GitHub'). They get a Connect button in the chat; after "
                            "they connect, continue the task."),
        ]

    c = ctx.computer
    # Full access to a computer: in its own chat (the teammate is the computer), or for every teammate in a project the
    # user lent it to (project settings → Computers).
    dev = computers.device_of(tm) or (ctx.project_computer or {}).get("id")
    if dev and not helper:
        async def computer_list(path: str = "~") -> str:
            return await computers.call(dev, "fs_list", {"path": path, "full": True})

        async def computer_read(path: str) -> str:
            return await computers.call(dev, "fs_read", {"path": path, "full": True})

        async def computer_write(path: str, content: str) -> str:
            return await computers.call(dev, "fs_write", {"path": path, "content": content, "full": True})

        async def computer_run(cmd: str, title: str = "", sudo: bool = False, cwd: str = "~", timeout_s: int = 120) -> str:
            t = max(1, min(timeout_s, 600))
            job = {"cmd": cmd, "cwd": cwd, "timeout": t, "full": True}
            if sudo:
                password = computers.take_password(ctx.owner_id, cmd)
                if not password:
                    return ("Not run: this admin command needs the user's password, typed on its approval card in the "
                            "app (approving from a notification can't carry it). Ask them to approve it there.")
                job |= {"sudo": True, "password": password}
            return await computers.call(dev, "shell", job, t + 30)

        async def computer_to_drive(path: str, folder: str = "", pattern: str = "*") -> str:
            # A file, or a folder's files matching `pattern`, from this computer into Google Drive: each goes
            # computer -> our storage -> a 10-minute link Drive fetches (no 5 MB cap), then the copy is deleted.
            listing = await computers.call(dev, "fs_list", {"path": path, "full": True}, 60)
            if listing.startswith("Not a folder"):
                picked = [path]
            else:
                base, _, rows = listing.partition(":\n")
                names = [r.split("  (", 1)[0] for r in rows.splitlines() if "  (" in r]
                picked = [f"{base.rstrip('/')}/{n}" for n in names if fnmatch.fnmatch(n.lower(), (pattern or "*").lower())]
            if not picked:
                return f"No files matching {pattern!r} in {path}."
            parent = ""
            if folder:
                if re.fullmatch(r"[\w-]{20,}", folder):
                    parent = folder
                else:
                    found = await connectors.execute(ctx.owner_id, "GOOGLEDRIVE_FIND_FOLDER", {"name_exact": folder, "page_size": 1})
                    parent = _drive_id(found) or _drive_id(await connectors.execute(ctx.owner_id, "GOOGLEDRIVE_CREATE_FOLDER", {"name": folder}))
            done, failed = [], []
            for p in picked[:40]:
                try:
                    got = await computers.call(dev, "fs_get", {"path": p, "full": True}, 180)
                    att = await files.upload(ctx.owner_id, got["name"], base64.b64decode(got["b64"]))
                    try:
                        await connectors.execute(ctx.owner_id, "GOOGLEDRIVE_UPLOAD_FROM_URL", {
                            "source_url": await files.signed(ctx.owner_id, att["path"]), "name": got["name"],
                            "mime_type": att["mime"], **({"parent_folder_id": parent} if parent else {})})
                    finally:
                        await files.remove(ctx.owner_id, att["path"])
                    done.append(got["name"])
                except Exception as e:
                    failed.append(f"{p.rsplit('/', 1)[-1]} ({str(e)[:140]})")
            where = f"the Drive folder {folder!r}" if folder else "their Drive (top level)"
            more = f" Only the first 40 of {len(picked)} went; ask before the rest." if len(picked) > 40 else ""
            return (f"Uploaded {len(done)} of {min(len(picked), 40)} to {where}: {', '.join(done) or 'none'}."
                    + (f" Failed: {'; '.join(failed)}." if failed else "") + more)

        async def computer_send_file(path: str) -> str:
            got = await computers.call(dev, "fs_get", {"path": path, "full": True}, 180)
            att = await files.upload(ctx.owner_id, got["name"], base64.b64decode(got["b64"]))
            ctx.outgoing.setdefault(tm["id"], []).append(att)
            return f"Attached {got['name']} ({got['size'] / 1e6:.1f} MB) to your reply; it shows in the chat on their phone."

        async def computer_screenshot(monitor: str = "") -> str:
            got = await computers.call(dev, "screenshot", {"full": True, **({"monitor": monitor} if monitor else {})}, 60)
            ctx.outgoing.setdefault(tm["id"], []).append(
                await files.upload(ctx.owner_id, got["name"], base64.b64decode(got["b64"])))
            screens = f" Its screens: {', '.join(got['monitors'])}." if len(got.get("monitors") or []) > 1 else ""
            return f"{got['name']} is attached to your reply.{screens} Say one short line; don't describe it unless asked."

        async def computer_apps() -> str:
            got = await computers.call(dev, "live", {}, 15)
            return "Apps running now (memory, CPU; closable = safe to close): " + "; ".join(
                f"{a['name']} {a['mem'] / 1e9:.1f} GB CPU {a['cpu']:.0f}%{' closable' if a.get('closable') else ''}"
                for a in got["apps"])

        def _snap(got: dict) -> str:
            if got.get("snapshot"):
                ctx.ui_snaps[got["snapshot"]] = got.get("app") or ""
            return got.get("text", "")

        async def computer_use(app: str, task: str) -> str:
            got = await computers.call(dev, "ui_launch", {"app": app, "full": True}, 45)
            computer_use_grant(app, got.get("app") or "")
            return (f"They OK'd using {got.get('app') or app} for: {task} (for 20 minutes). {cu.head(got)} Work "
                    "through it with computer_act (computer_subtask for a run of simple steps), then tell them what you did.\n"
                    + _snap(got))

        def computer_use_grant(*apps: str) -> None:
            cu.grant(ctx.owner_id, dev, *apps)

        async def computer_look(app: str = "", window: str = "") -> str:
            if not app:
                return "Open apps and windows (▶ in front): " + cu.apps_line(await computers.call(dev, "ui_apps", {"full": True}, 20))
            return _snap(await computers.call(dev, "ui_look", {"app": app, "window": window, "full": True}, 30))

        async def computer_act(snapshot: str, element: str, action: str, value: str = "") -> str:
            app = ctx.ui_snaps.get(snapshot)
            if app is None:
                return "Look at the app first (computer_look) and act on that snapshot's ids."
            if action.upper() != "READ" and not cu.granted(ctx.owner_id, dev, app):
                return f"Ask first: call computer_use with app {app!r} and the task; they OK it once."
            got = await computers.call(dev, "ui_act", {"snapshot": snapshot, "element": element, "action": action,
                                                       "value": value, "full": True}, 40)
            return cu.head(got) + "\n" + _snap(got)

        async def computer_keys(keys: list[str], app: str = "") -> str:
            if not cu.any_granted(ctx.owner_id, dev):
                return "Ask first: call computer_use with the app and the task; they OK it once."
            got = await computers.call(dev, "ui_keys", {"keys": keys[:12], "app": app, "full": True}, 30)
            return f"{cu.head(got)} (in front: {got.get('front') or 'unknown'})\n" + _snap(got)

        async def computer_subtask(app: str, goal: str, inputs: list[str] | None = None, done_when: str = "", max_steps: int = 12) -> str:
            if not cu.granted(ctx.owner_id, dev, app):
                return f"Ask first: call computer_use with app {app!r} and the task; they OK it once."
            return await cu.subtask(dev, app, goal, inputs or [], done_when, max_steps)

        async def computer_close_app(name: str, force: bool = False) -> str:
            return await computers.call(dev, "quit_app", {"name": name, "force": force, "full": True}, 30)

        async def computer_receive(folder: str = "~/Downloads/Tubelight") -> str:
            rows = await db.select("messages", {"thread_id": f"eq.{ctx.thread_id}", "sender_type": "eq.user",
                                                "order": "created_at.desc", "limit": "5", "select": "meta"})
            atts = next(((r.get("meta") or {}).get("attachments") for r in rows if (r.get("meta") or {}).get("attachments")), None)
            if not atts:
                return "No attached files in their recent messages. Ask them to attach it with the + in the chat."
            saved = []
            for a in atts[:6]:
                data = await files._download(ctx.owner_id, a["path"])
                saved.append(await computers.call(dev, "fs_put", {"name": a["name"], "folder": folder, "full": True,
                                                                  "b64": base64.b64encode(data).decode()}, 180))
            return "Saved on the computer: " + ", ".join(saved)

        async def computer_start_job(cmd: str, title: str, cwd: str = "~") -> str:
            got = await computers.call(dev, "job_start", {"cmd": cmd, "title": title, "cwd": cwd, "full": True})
            return (f"Started in the background (job {got['id']}). Its output goes to {got['log']}; when it ends, the "
                    "result is posted in this chat and they get a notification. Tell them that, and stop here.")

        tools += [
            StructuredTool.from_function(coroutine=computer_start_job, name="computer_start_job",
                description="Start a long command (a big download, a build, a backup, anything over a few minutes) in the "
                            "background on this computer. It keeps running past the 10-minute command limit and reports "
                            "back in this chat when it finishes. title: 2-6 words. To check on it, tail its log."),
            StructuredTool.from_function(coroutine=computer_send_file, name="computer_send_file",
                description="Send a file from this computer to the chat, so they can open it on their phone (up to 25 MB)."),
            StructuredTool.from_function(coroutine=computer_to_drive, name="computer_to_drive",
                description="Upload a file or a folder's files from this computer to their Google Drive (Google Drive "
                            "must be connected; up to 25 MB a file, 40 files a go). path: on this computer; folder: a "
                            "Drive folder name (found or created) or ID, empty = top level; pattern: e.g. *.pdf. Use "
                            "this, never scripts or the Drive API by hand."),
            StructuredTool.from_function(coroutine=computer_screenshot, name="computer_screenshot",
                description="Capture this computer's screen and attach it to your reply (what's open, an error on screen). "
                            "monitor: one screen only, by number (1 = leftmost) or name; empty = all screens in one image. "
                            "For each monitor separately, call it once per monitor."),
            StructuredTool.from_function(coroutine=computer_apps, name="computer_apps",
                description="The apps running now with their memory and CPU, and which are safe to close."),
            StructuredTool.from_function(coroutine=computer_use, name="computer_use",
                description="Ask to use an app on this computer for a task (click, type, fill in, go through menus): once per "
                            "task, they OK it on their phone, then you can act in that app for 20 minutes. Opens the app if "
                            "it isn't open. app: its name (Firefox, Files, Settings, Calculator...). task: what you'll do, "
                            "in a line they'll read before saying yes. Answers with the app's screen."),
            StructuredTool.from_function(coroutine=computer_look, name="computer_look",
                description="Read an app's window on this computer: every button, field, item and text on screen, each with "
                            "an id ([e12]) and what can be done to it. app empty: lists the open apps and windows. "
                            "window: part of a window's title, when it has several."),
            StructuredTool.from_function(coroutine=computer_act, name="computer_act",
                description="Do one thing to one element of a snapshot from computer_look/computer_act: action CLICK, "
                            "TYPE (value: a field's new text; in a document it's written at the cursor), REPLACE (a document's whole text: "
                            "only when they asked for that), SET_VALUE (sliders, spin boxes), FOCUS, READ (its full "
                            "text), SCROLL_TO. If the app changed since the snapshot nothing happens and you get the new "
                            "screen to decide again. Answers with the app's screen after it settles."),
            StructuredTool.from_function(coroutine=computer_keys, name="computer_keys",
                description="Press keys in the window in front: chords like \"enter\", \"ctrl+s\", \"ctrl+l\", "
                            "\"page_down\", \"alt+left\", or \"text:words to type\". Use after FOCUS on a field when "
                            "a field has no TYPE, or for shortcuts. app: whose screen to answer with."),
            StructuredTool.from_function(coroutine=computer_subtask, name="computer_subtask",
                description="Hand a run of simple steps in an app (fill a form, go through settings, find and open an "
                            "item) to a fast helper that clicks through it and reports DONE, BLOCKED or NEEDS_INPUT with "
                            "the steps it took. goal: one clear outcome. inputs: every piece of text it may type, exactly. "
                            "done_when: what the screen shows when it's done. Saves your own steps on long, simple runs."),
            StructuredTool.from_function(coroutine=computer_close_app, name="computer_close_app",
                description="Close a running app by its name exactly as computer_apps lists it (all its windows and "
                            "processes; unsaved work may be lost). force: kill it at once if it hung."),
            StructuredTool.from_function(coroutine=computer_receive, name="computer_receive",
                description="Save the files they attached in this chat onto the computer (default ~/Downloads/Tubelight). "
                            "Use it when they attach something and want it on the laptop."),
            StructuredTool.from_function(coroutine=computer_list, name="computer_list",
                description="List a folder on this computer (any path; ~ is home)."),
            StructuredTool.from_function(coroutine=computer_read, name="computer_read",
                description="Read a text file on this computer (any path)."),
            StructuredTool.from_function(coroutine=computer_write, name="computer_write",
                description="Create or overwrite a file on this computer (any path)."),
            StructuredTool.from_function(coroutine=computer_run, name="computer_run",
                description="Run a bash command on this computer as the user (cwd default ~). title: what it does in "
                            "2-6 words, shown on the approval card ('Remove old installers'). For admin commands (apt, "
                            "system files, services) set sudo=true and leave 'sudo' out of cmd: the user types their "
                            "password on the card. Output is trimmed to ~8k chars; do several steps in one command."),
        ]
    elif c and c["cowork"] and c["folders"] and not helper:
        cid = c["id"]

        async def computer_list(path: str = "") -> str:
            return await computers.call(cid, "fs_list", {"path": path})

        async def computer_read(path: str) -> str:
            return await computers.call(cid, "fs_read", {"path": path})

        async def computer_write(path: str, content: str) -> str:
            return await computers.call(cid, "fs_write", {"path": path, "content": content})

        async def computer_run(cmd: str, cwd: str = "", timeout_s: int = 120) -> str:
            t = max(1, min(timeout_s, 600))
            return await computers.call(cid, "shell", {"cmd": cmd, "cwd": cwd, "timeout": t}, t + 30)

        where = f"the user's own computer '{c['name']}' (their real files, not your sandbox)"
        tools += [
            StructuredTool.from_function(coroutine=computer_list, name="computer_list",
                description=f"List a folder on {where} (only its shared folders; no path = the shared folders)."),
            StructuredTool.from_function(coroutine=computer_read, name="computer_read",
                description=f"Read a text file on {where}, inside its shared folders."),
            StructuredTool.from_function(coroutine=computer_write, name="computer_write",
                description=f"Create or overwrite a file on {where}, inside its shared folders. The user approves it first."),
            *([StructuredTool.from_function(coroutine=computer_run, name="computer_run",
                description=f"Run a bash command on {where} with cwd in a shared folder (default: the first). The rest "
                            "of the disk is read-only and the home folder hidden; it has the web. The user approves "
                            "each command first, so do several steps in one command.")] if c["shell"] else []),
        ]

    if (ctx.docker or ctx.box_on_computer) and builder(tm):
        box = lambda: ctx.sandbox(tm)  # noqa: E731

        async def run_shell(cmd: str, timeout_s: int = 120) -> str:
            return await box().run_shell(cmd, timeout_s)

        async def read_file(path: str) -> str:
            return await box().read_file(path)

        async def write_file(path: str, content: str) -> str:
            return await box().write_file(path, content)

        async def git_push(branch: str, path: str = "") -> str:
            out = await box().git_push(branch, path)
            if ctx.project and "[exit code 0]" in out:
                repo.schedule(ctx.owner_id, ctx.project["id"])  # the repo knowledge catches up with the push
            return out

        tools += [
            StructuredTool.from_function(coroutine=run_shell, name="run_shell",
                description="Run a bash command in your sandbox: a throwaway Linux box (Node 22, Python 3, git; not the "
                            "user's own computer, which only the computer_* tools reach) "
                            f"{'on the user' + chr(39) + 's computer ' if ctx.box_on_computer else ''}"
                            "with the project's repo in /workspace (cwd). It can reach the web (npm, pip) but not the "
                            "user's home network. Output is truncated to ~8k chars. git push is not allowed here."),
            StructuredTool.from_function(coroutine=read_file, name="read_file", description="Read a file under /workspace."),
            StructuredTool.from_function(coroutine=write_file, name="write_file", description="Create or overwrite a file under /workspace."),
        ]
        if config.GITHUB_TOKEN and isinstance(box(), sandbox.Sandbox):
            async def open_repo(repo_name: str) -> str:
                target = repo.parse(repo_name)
                if not target:
                    return "Give the repo as owner/name (list their repos with the GitHub tools if unsure)."
                try:
                    out = await box().clone(*target, await sandbox.github_identity())
                except Exception as e:
                    return f"Couldn't open {repo_name}: {str(e)[:200]}"
                return f"{out}\nThe repo is at /workspace/{target[1]} (a real clone; commits are theirs). cd there first."

            tools.append(StructuredTool.from_function(coroutine=open_repo, name="open_repo",
                description="Clone one of their GitHub repos (owner/name, private ones too) into your sandbox at "
                            "/workspace/<name>, ready to read, change, run, commit and push. Opening it again fetches "
                            "the latest. Work on a new branch unless they asked otherwise."))
        if not helper and config.GITHUB_TOKEN:  # pushing needs a token with write access; without one, no push
            tools.append(StructuredTool.from_function(coroutine=git_push, name="git_push",
                description="Push the current HEAD to origin/<branch>. path: the repo's folder (like /workspace/<name> "
                            "from open_repo), empty for /workspace. Needs the user's approval. After pushing a branch, "
                            "open a pull request with the GitHub tools unless they said to push straight to it."))

    if not helper and builder(tm) and re.search(r"develop|engineer|program|coder", tm.get("role") or "", re.I):
        async def spawn_helper(task: str) -> str:
            return await _helper(ctx, tm, composio_tools, task)

        tools.append(StructuredTool.from_function(
            coroutine=spawn_helper, name="spawn_helper",
            description="Delegate a self-contained subtask (research, reading code, a small experiment) to a "
                        "short-lived helper with your read/draft tools. Returns its result. Give it all context it needs."))
    if mind.is_memory(tm):  # not `remember`: the user's own words there are the evidence; paraphrases add duplicates
        tools = [t for t in tools if t.name != "remember"]
    return tools


async def _helper(ctx: RunCtx, tm: dict, composio_tools: list[BaseTool], task: str) -> str:
    """One level down: no spawning, no act tools, at most HELPER_STEPS model calls."""
    # helpers get read/draft tools only; multi-execute calls are checked per call below
    tools = [t for t in build(ctx, tm, composio_tools, helper=True) if t.name == MULTI or classify(t.name) != "act"]
    by_name = {t.name: t for t in tools}
    model = llm.chat_model(tm["model"], tools)
    thread = f"helper:{uuid.uuid4()}"
    msgs: list = [
        SystemMessage(f"You are a helper working for {tm['name']} ({tm['role']}). Do only the task below, use tools "
                      f"when needed, and finish with a concise, factual result. You have at most {HELPER_STEPS} steps."),
        HumanMessage(task),
    ]
    result = "The helper ran out of steps without a final answer."
    for _ in range(HELPER_STEPS):
        ai = await model.ainvoke(msgs)
        msgs.append(ai)
        if not ai.tool_calls:
            result = ai.text or result
            break
        for tc in ai.tool_calls:
            if classify_call(tc["name"], tc["args"]) == "act":
                content = "Helpers cannot take actions that need approval. Report what should be done instead."
            else:
                content, _ = await run_tool(ctx, tm, by_name.get(tc["name"]), tc["name"], tc["args"])
            msgs.append(ToolMessage(content, tool_call_id=tc["id"], name=tc["name"]))
    await db.activity(ctx.owner_id, "subagent", "spawn_helper", run_id=ctx.run_id, thread_id=ctx.thread_id,
                      teammate_id=tm["id"], input={"task": task, "thread": thread}, output={"result": result[:4000]})
    return result
