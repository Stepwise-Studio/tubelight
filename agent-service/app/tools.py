"""Tool classification (read / draft / act), human labels, and each teammate's toolset."""
from __future__ import annotations

import re
import time
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import TYPE_CHECKING, Any, Literal

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool

from . import automations, config, connectors, db, followups, llm, memory, repo, sandbox

if TYPE_CHECKING:
    from .graph import RunCtx

ACT = {"SEND", "POST", "PUSH", "MERGE", "DELETE", "REMOVE", "PAY", "ORDER", "PUBLISH", "INVITE",
       "REPLY", "FORWARD", "TRASH", "TRANSFER", "PURCHASE", "SUBMIT", "SHARE"}
DRAFT = {"DRAFT"}
READ = {"GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "QUERY", "RETRIEVE", "VIEW"}
# Who gets a code sandbox (and, for engineers, helpers): roles are free text ("Developer", "QA engineer").
BUILDER = re.compile(r"develop|engineer|program|coder|\bqa\b|test|devops|\bsre\b|data|analyst|scien", re.I)


def builder(tm: dict) -> bool:
    return bool(BUILDER.search(tm.get("role") or ""))


INTERNAL = {
    "remember": "read", "recall": "read", "search_chat": "read", "follow_up": "read", "spawn_helper": "read",
    "automate": "read", "app_events": "read", "repo_context": "read", "repo_note": "read",
    "web_search": "read", "read_page": "read",
    "read_file": "read", "run_shell": "draft", "write_file": "draft", "git_push": "act",
    "ask_user": "read", "connect_app": "read",
}
# Tools that pause the run for the user (question card / connect card). The graph intercepts them.
PROMPTS = {"ask_user", "connect_app"}
LABELS = {
    "remember": "Saving to memory", "recall": "Searching memory", "search_chat": "Searching the chat",
    "follow_up": "Setting a follow-up", "automate": "Setting up an automation", "app_events": "Checking app events",
    "spawn_helper": "Working with a helper", "read_file": "Reading a file", "write_file": "Writing a file",
    "git_push": "Pushing commits", "ask_user": "Asking you", "connect_app": "Asking you to connect an app",
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
    if not edited:
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


def title(name: str, args: dict[str, Any]) -> str:
    """Short human sentence for an approval card, e.g. 'Send email to jane@acme.com'."""
    if name == "git_push":
        return f"Push commits to branch {args.get('branch', '?')}"
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
        content, status = sandbox.truncate(out if isinstance(out, str) else str(out)), "ok"
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
        key = await memory.add(ns, text)
        await db.activity(ctx.owner_id, "memory_write", scope, run_id=ctx.run_id, thread_id=ctx.thread_id,
                          teammate_id=tm["id"], input={"text": text, "scope": scope}, output={"key": key})
        return "Saved."

    async def recall(query: str) -> str:
        spaces = [memory.ns("teammate", tm["id"]), memory.ns("user", ctx.owner_id)]
        if ctx.project:
            spaces.append(memory.ns("project", ctx.project["id"]))
        found = [t for ns in spaces for t in await memory.search(ns, query, limit=5)]
        return "\n".join(f"- {t}" for t in found) or "Nothing relevant in memory."

    try:
        zone = ZoneInfo(ctx.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")

    async def search_chat(query: str) -> str:
        words = re.findall(r"[\w'-]{3,}", query.lower())[:5]
        if not words:
            return "Give a few keywords to look for."
        rows = await db.select("messages", {
            "thread_id": f"eq.{ctx.thread_id}", "kind": "in.(text,handoff)", "order": "created_at.desc", "limit": "40",
            "or": "(" + ",".join(f"text.ilike.*{w}*" for w in words) + ")", "select": "created_at,sender_type,teammate_id,text"})
        if not rows:
            return "Nothing in this chat matches."
        names = {m["id"]: m["name"] for m in ctx.members}
        best = sorted(rows, key=lambda r: -sum(w in r["text"].lower() for w in words))[:8]  # most words matched first
        return "\n".join(f"[{datetime.fromisoformat(r['created_at']).astimezone(zone):%a %b %d, %I:%M %p}] "
                         f"{ctx.user_name if r['sender_type'] == 'user' else names.get(r['teammate_id'], 'Teammate')}: "
                         f"{r['text'][:700]}" for r in sorted(best, key=lambda r: r["created_at"]))

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
        try:
            d = await connectors.execute(ctx.owner_id, "COMPOSIO_SEARCH_FETCH_URL_CONTENT", {"urls": [url]})
        except Exception as e:
            return f"Couldn't open {url}: {str(e)[:200]}"
        page = (d.get("results") or [{}])[0] or {}
        text = str(page.get("text") or "").strip()
        if not text:
            return f"{url} had no readable text (it may need a login or be mostly images)."
        title = page.get("title") or url
        return f"{title}\n{url}\n\n" + (text if len(text) <= 9000 else text[:9000] + f"\n[... {len(text) - 9000} more chars]")

    tools += [
        StructuredTool.from_function(
            coroutine=web_search, name="web_search",
            description="Search the web for current information (news, docs, prices, people, anything after your "
                        "training). Returns an answer with its sources. Cite the sources you use."),
        StructuredTool.from_function(
            coroutine=read_page, name="read_page",
            description="Read one web page as text (an article, docs, a link the user sent). url: the full address."),
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
            coroutine=search_chat, name="search_chat",
            description="Search this chat's full history for earlier messages (exact wording, what was said this "
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

    if ctx.docker and builder(tm):
        box = lambda: ctx.sandbox(tm)  # noqa: E731

        async def run_shell(cmd: str, timeout_s: int = 120) -> str:
            return await box().run_shell(cmd, timeout_s)

        async def read_file(path: str) -> str:
            return await box().read_file(path)

        async def write_file(path: str, content: str) -> str:
            return await box().write_file(path, content)

        async def git_push(branch: str) -> str:
            out = await box().git_push(branch)
            if ctx.project and "[exit code 0]" in out:
                repo.schedule(ctx.owner_id, ctx.project["id"])  # the repo knowledge catches up with the push
            return out

        tools += [
            StructuredTool.from_function(coroutine=run_shell, name="run_shell",
                description="Run a bash command in your sandbox: a throwaway Linux box (Node 22, Python 3, git) "
                            "with the project's repo in /workspace (cwd). It can reach the web (npm, pip) but not the "
                            "user's home network. Output is truncated to ~8k chars. git push is not allowed here."),
            StructuredTool.from_function(coroutine=read_file, name="read_file", description="Read a file under /workspace."),
            StructuredTool.from_function(coroutine=write_file, name="write_file", description="Create or overwrite a file under /workspace."),
        ]
        if not helper and config.GITHUB_TOKEN:  # pushing needs a token with write access; without one, no push
            tools.append(StructuredTool.from_function(coroutine=git_push, name="git_push",
                description="Push the current HEAD of /workspace to origin/<branch>. Needs the user's approval."))

    if not helper and builder(tm) and re.search(r"develop|engineer|program|coder", tm.get("role") or "", re.I):
        async def spawn_helper(task: str) -> str:
            return await _helper(ctx, tm, composio_tools, task)

        tools.append(StructuredTool.from_function(
            coroutine=spawn_helper, name="spawn_helper",
            description="Delegate a self-contained subtask (research, reading code, a small experiment) to a "
                        "short-lived helper with your read/draft tools. Returns its result. Give it all context it needs."))
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
