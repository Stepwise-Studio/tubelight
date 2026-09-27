"""The LangGraph graph for one thread.

START -> router -> tm_<handle> -> (gate -> wait* -> tools -> tm_<active>)* -> (router for queued mentions) -> END

All members share the thread's checkpoint. AI messages carry name=<handle>; each teammate sees other
teammates' words as named HumanMessages and never sees their tool traffic.
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Any, TypedDict
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import openai
from langchain_core.messages import (
    AIMessage, AnyMessage, BaseMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage,
)
from langchain_core.tools import BaseTool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import REMOVE_ALL_MESSAGES, add_messages
from langgraph.types import interrupt

from . import config, connectors, db, llm, memory, push, tools as T
from .sandbox import Sandbox

log = logging.getLogger(__name__)
KEEP_TAIL = 12
TRIM_AT, SUMMARIZE_AT = 0.65, 0.80
STUB = "[output trimmed]"
DELTA_EVERY = 0.12


class State(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    active: str | None  # teammate id whose turn it is
    queue: list[str]  # teammate ids still to answer (mentions, in order)
    handoffs: int
    pending: list[dict]  # [{approval_id, tool_call_id}] for the active AI message
    decisions: dict[str, dict]  # approval_id -> {action, args, note}


@dataclass
class RunCtx:
    run_id: str
    owner_id: str
    thread_id: str
    members: list[dict]
    project: dict | None = None
    user_name: str = "the user"
    timezone: str = "UTC"
    trigger: str = "message"
    event_type: str | None = None
    docker: bool = False
    turn_tools: dict[str, list] = field(default_factory=dict)
    apps: list[str] = field(default_factory=list)  # @mentioned in the current request (see scope)
    sandboxes: dict[str, Sandbox] = field(default_factory=dict)
    _tools: dict[str, list[BaseTool]] = field(default_factory=dict)

    @property
    def proactive(self) -> bool:
        return self.trigger in ("event", "schedule")

    def member(self, teammate_id: str | None) -> dict:
        return next((m for m in self.members if m["id"] == teammate_id), self.members[0])

    def status(self, tm: dict | None, state: str, label: str | None = None) -> dict:
        p = {"run_id": self.run_id, "teammate_id": tm["id"] if tm else None, "state": state}
        return {**p, "label": label} if label else p

    def sandbox(self, tm: dict) -> Sandbox:
        if tm["id"] not in self.sandboxes:
            self.sandboxes[tm["id"]] = Sandbox(self.run_id, tm["id"], (self.project or {}).get("repo_url"))
        return self.sandboxes[tm["id"]]

    def scope(self, msgs: list[BaseMessage]) -> None:
        """Apps the user @mentioned in the request being answered; whoever answers it gets them, on top of their own."""
        ask = next((m for m in reversed(msgs) if isinstance(m, HumanMessage) and not m.name), None)
        apps = list((ask.additional_kwargs.get("apps") if ask else None) or [])
        if apps != self.apps:
            self.apps = apps
            self._tools.clear()

    def toolkits(self, tm: dict) -> list[str]:
        return list(dict.fromkeys([*(tm.get("allowed_toolkits") or []), *self.apps]))

    async def tools_for(self, tm: dict) -> list[BaseTool]:
        if tm["id"] not in self._tools:
            composio = await connectors.tools_for(self.owner_id, self.toolkits(tm))
            self._tools[tm["id"]] = T.build(self, tm, composio)
        return self._tools[tm["id"]]


# ------------------------------------------------------------------ views
def view_for(tm: dict, msgs: list[BaseMessage], members: list[dict]) -> list[BaseMessage]:
    """What one teammate sees of the shared history."""
    who = {m["handle"]: f"{m['name']} · {m['role']}" for m in members}
    mine = [m for m in msgs if isinstance(m, AIMessage) and m.name == tm["handle"]]
    own_calls = {tc["id"] for m in mine for tc in m.tool_calls}
    answered = {m.tool_call_id for m in msgs if isinstance(m, ToolMessage)}
    out: list[BaseMessage] = []
    for m in msgs:
        if isinstance(m, AIMessage):
            if m.name == tm["handle"]:
                out.append(m)
                # a call that never got a result (cancelled, superseded approval) would break the API
                out += [ToolMessage("[No result: this action was not completed.]", tool_call_id=tc["id"])
                        for tc in m.tool_calls if tc["id"] not in answered]
            elif m.text.strip():
                out.append(HumanMessage(f"[{who.get(m.name or '', m.name or 'Teammate')}]: {m.text}"))
        elif isinstance(m, ToolMessage):
            if m.tool_call_id in own_calls:
                out.append(m)
        else:
            out.append(m)
    return out


OLD_RESULT_CHARS = 600


def shrink_old_results(msgs: list[BaseMessage]) -> list[BaseMessage]:
    """Tool results from earlier turns (a 2k-token email list from yesterday) shrink to a preview before each call;
    the current turn keeps them whole. The saved history is untouched."""
    turn = next((i for i in range(len(msgs) - 1, -1, -1) if isinstance(msgs[i], HumanMessage) and msgs[i].name != "summary"), 0)
    return [m.model_copy(update={"content": str(m.content)[:OLD_RESULT_CHARS] + " ...[earlier result shortened]"})
            if i < turn and isinstance(m, ToolMessage) and len(str(m.content)) > OLD_RESULT_CHARS else m
            for i, m in enumerate(msgs)]


def estimate_tokens(msgs: list[BaseMessage]) -> int:
    chars = sum(len(str(m.content)) + len(json.dumps(getattr(m, "tool_calls", []) or [])) for m in msgs)
    return chars // 4


def _last_human(msgs: list[BaseMessage]) -> str:
    return next((str(m.content) for m in reversed(msgs) if isinstance(m, HumanMessage)), "")


# How every teammate talks. Last in the prompt so it wins over narration habits in a role's own instructions;
# the role still sets the personality and tone (casual, formal) on top of this.
VOICE = """## How you talk (always)
- Talk like a sharp colleague messaging from their phone, not a report generator: warm, direct, first person, contractions.
- Lead with the answer or your verdict in one line ("Quiet day, nothing needs you." / "Two things need you today."). Then only the detail that earns its place.
- Judge, don't just list. Say what matters and why, and what they can ignore. Fold routine stuff into one line.
- When there's an obvious next step, offer it in one short question ("Want me to draft a reply to Priya?"). One or two offers at most, never a generic menu.
- Never narrate your process ("I'm about to scan...", "I used the search tool"): the app already shows what you're doing live. Never mention tools, slugs, IDs, raw timestamps or UTC.
- Keep it short: most replies fit on one phone screen. Markdown sparingly: bold for the few things that matter, bullets only for real lists, no headings in short replies. No emojis."""

# App playbooks: how to do the common job well with each app, added when the teammate has it.
PLAYBOOKS = {
    "GMAIL": """Working with email:
- "What did I get / summarise my inbox": fetch the messages first (sender, subject, snippet; open a full body only when it decides importance). "Today" means today in the user's time zone.
- Sort into: needs them (a real person waiting on a reply or asking them something, deadlines, bills and payments, unexpected security alerts), worth knowing, and noise (promotions, newsletters, social notifications, automated receipts).
- Reply shape: a one-line verdict; then each needs-them item as who, what they want, and what you suggest; then one line for worth-knowing; then one line counting the noise ("plus 5 promos and newsletters").
- Spot follow-ups: threads where they were asked something and haven't replied, or promised something. Offer to draft the reply.
- Security alerts caused by their own recent actions (like connecting an app to Tubelight) are expected: mention them briefly and say so.""",
    "GOOGLECALENDAR": """Working with the calendar: lead with what's next and anything that clashes or needs prep; times in the user's local time; offer to move, decline or block time when it would help.""",
    "MICROSOFT_TEAMS": """Working with Microsoft Teams: Teams can't list someone's scheduled meetings (its meeting API only
fetches one by link or ID). Scheduled Teams meetings live in the Outlook calendar: list today's events there (events
with an online meeting are the Teams calls). If Outlook isn't connected, call connect_app for Outlook and say why in
one line. Never tell the user it can't be done.""",
    "OUTLOOK": """Working with Outlook: for "what meetings do I have", list calendar events for the day in the user's time zone
(Teams calls are the events with an online meeting link); lead with the next one and anything that clashes.""",
    "GITHUB": """Working with GitHub: lead with what needs them (reviews requested, failing checks, mentions); name PRs and issues by title and number; offer the next concrete step.""",
}


def local_now(ctx: RunCtx) -> datetime:
    try:
        return datetime.now(ZoneInfo(ctx.timezone))
    except (ZoneInfoNotFoundError, ValueError):
        return datetime.now(UTC)


async def preamble(ctx: RunCtx, tm: dict, msgs: list[BaseMessage], tool_names: list[str]) -> str:
    query = _last_human(msgs)[:500]
    shelf = memory.ns("user", ctx.owner_id)
    owed = await memory.listing(shelf, limit=10, kind="commitment", done=False)
    prefs = await memory.listing(shelf, limit=12, kind="preference")
    seen = {r["key"] for r in owed + prefs}
    profile = [r for r in await memory.search_rows(shelf, query, limit=8) if r["key"] not in seen]
    own = await memory.search(memory.ns("teammate", tm["id"]), query)
    proj = await memory.search(memory.ns("project", ctx.project["id"]), query) if ctx.project else []

    now = local_now(ctx)
    lines = [
        f"You are {tm['name']} (@{tm['handle']}), the team's {tm['role']}. You work for {ctx.user_name} as a teammate, "
        f"not as a generic assistant. It is {now:%A, %B %d, %Y, %I:%M %p} where the user is ({now.tzname()}). "
        "Give times in their local time and relative words (this morning, yesterday), never UTC.",
    ]
    if ctx.project:
        p = ctx.project
        lines.append(f'You are in the project group "{p["name"]}".' + (f" About: {p['description']}" if p.get("description") else "")
                     + (f" Repo: {p['repo_url']}" if p.get("repo_url") else ""))
        lines.append("Group members:\n" + "\n".join(
            f"- {m['name']} (@{m['handle']}, {m['role']}){' - that is you' if m['id'] == tm['id'] else ''}" for m in ctx.members))
        lines.append("Other members' messages appear as '[Name · role]: text'; only your own earlier replies are yours. Never "
                     "take credit or blame for what another member said, and never prefix your own replies that way. "
                     "This is a group chat. To ask another member something, @mention their handle (e.g. @dev) and they reply "
                     "after you. Only @mention someone when you need an answer from them or you're answering what they "
                     "actually said above; never address someone as if they had spoken when they haven't.")
    else:
        lines.append(f"This is a direct message between you and {ctx.user_name}.")
    lines.append("Your tools: " + (", ".join(tool_names) or "none") + ". Use tools instead of guessing; never invent results.")
    if T.MULTI in tool_names:
        lines.append(f"Connected apps ({', '.join(ctx.toolkits(tm))}): find the right app tool with "
                     "COMPOSIO_SEARCH_TOOLS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL using the exact slug and "
                     "arguments. Never invent slugs.")
    lines.append("If a request needs an app that is not connected (any of about 1,500: Google Calendar, Slack, Notion, "
                 "Jira...), call connect_app with its name instead of telling the user to go somewhere or that it is "
                 "unavailable. When the next step depends on the user's preference, "
                 "call ask_user with 2 to 4 short options rather than listing questions in prose.")
    if tm["role"] in ("developer", "tester") and "run_shell" not in tool_names:
        lines.append("You have no code sandbox right now (Docker is not available), so you cannot run code or tests. "
                     "Say so when it matters and reason from what you can read.")
    lines.append(
        "Approval rules: tools that send, post, publish, push, merge, delete, pay or otherwise change things outside "
        "this chat pause for the user's approval. Call them directly with complete, final arguments; the user sees an "
        "approval card and may edit or reject it. Do not ask for permission in chat first. If an action is rejected, "
        "acknowledge it briefly and adjust.")
    lines.append("Use remember for durable facts (preferences, decisions, names, deadlines) and recall to look them up.")
    if ctx.apps:
        lines.append(f"{ctx.user_name} @mentioned {', '.join(connectors.name_of(a) for a in ctx.apps)} in this request: "
                     "use those apps for it.")
    guides = [PLAYBOOKS[t] for t in ctx.toolkits(tm) if t in PLAYBOOKS]
    if guides:
        lines.append("\n\n".join(guides))
    if prefs:
        lines.append("How the user likes things (follow these):\n" + "\n".join(f"- {r['text']}" for r in prefs))
    if owed:
        lines.append("Open commitments (bring them up when relevant, e.g. near a due date or when the person writes again):\n"
                     + "\n".join(f"- {r['text']}" + (f" (due {r['due']})" if r.get("due") else "") for r in owed))
    if profile:
        lines.append("What you know that may be relevant:\n" + "\n".join(f"- {r['text']}" for r in profile))
    if own:
        lines.append("Your relevant memories:\n" + "\n".join(f"- {t}" for t in own))
    if proj:
        lines.append("Project memories:\n" + "\n".join(f"- {t}" for t in proj))
    return "\n\n".join(lines) + "\n\n## Your role\n" + tm["system_prompt"] + "\n\n" + VOICE


# ------------------------------------------------------------------ compaction
def _transcript(msgs: list[BaseMessage]) -> str:
    out = []
    for m in msgs:
        who = "Tool result" if isinstance(m, ToolMessage) else (m.name or "Assistant") if isinstance(m, AIMessage) else "User"
        text = m.text if isinstance(m, AIMessage) else str(m.content)
        if isinstance(m, AIMessage) and m.tool_calls:
            text += " " + " ".join(f"[called {tc['name']}]" for tc in m.tool_calls)
        out.append(f"{who}: {text[:4000]}")
    return "\n".join(out)


async def compact(ctx: RunCtx, tm: dict, msgs: list[BaseMessage]) -> tuple[list, list[BaseMessage]]:
    """Returns (state updates, compacted messages). Updates really shrink the checkpoint."""
    window = await llm.context_window(tm["model"])
    before = estimate_tokens(msgs)
    if before < TRIM_AT * window or len(msgs) <= KEEP_TAIL:
        return [], msgs
    head, tail = msgs[:-KEEP_TAIL], msgs[-KEEP_TAIL:]
    updates = [m.model_copy(update={"content": STUB}) for m in head if isinstance(m, ToolMessage) and m.content != STUB]
    trimmed = {m.id: m for m in updates}
    msgs = [trimmed.get(m.id, m) for m in head] + tail
    stage = "trim"
    if estimate_tokens(msgs) >= SUMMARIZE_AT * window:
        cut = len(msgs) - KEEP_TAIL
        while cut < len(msgs) and isinstance(msgs[cut], ToolMessage):
            cut += 1  # never keep a tool result without its call
        old, keep = msgs[:cut], msgs[cut:]
        try:
            res = await llm.chat_model(tm["model"]).ainvoke([
                SystemMessage("Summarize this conversation so the team can continue it without the original. Keep "
                              "decisions, open tasks, names, numbers and commitments. Then write a line 'FACTS:' followed "
                              "by durable facts worth remembering long-term, one per line starting with '- '. "
                              "Write 'FACTS:' with nothing after it if there are none."),
                HumanMessage(_transcript(old)),
            ])
            summary, _, facts = res.text.partition("FACTS:")
            for f in (l.strip("- ").strip() for l in facts.splitlines()):
                if f:
                    await memory.add(memory.ns("teammate", tm["id"]), f)
            note = HumanMessage(f"[Summary of the earlier conversation]\n{summary.strip()}", name="summary")
            updates = [RemoveMessage(id=REMOVE_ALL_MESSAGES), note, *keep]
            msgs, stage = [note, *keep], "summarize"
        except Exception as e:  # keep the trimmed history if the summary call fails
            await db.activity(ctx.owner_id, "error", "compaction", run_id=ctx.run_id, thread_id=ctx.thread_id,
                              teammate_id=tm["id"], output={"error": str(e)[:500]}, status="error")
    if not updates:
        return [], msgs
    await db.activity(ctx.owner_id, "compaction", stage, run_id=ctx.run_id, thread_id=ctx.thread_id, teammate_id=tm["id"],
                      input={"tokens_before": before, "window": window},
                      output={"tokens_after": estimate_tokens(msgs), "messages": len(msgs)})
    return updates, msgs


# ------------------------------------------------------------------ nodes
async def _stream(ctx: RunCtx, tm: dict, model, messages: list[BaseMessage], stream_id: str) -> AIMessage:
    acc, sent, last = None, "", 0.0
    async for chunk in model.astream(messages):
        acc = chunk if acc is None else acc + chunk
        text = acc.text
        if text and not sent:
            await db.broadcast(ctx.thread_id, "status", ctx.status(tm, "writing"))
        if text != sent and time.monotonic() - last >= DELTA_EVERY:
            await db.broadcast(ctx.thread_id, "delta", {**_ids(ctx, tm), "stream_id": stream_id, "text": text})
            sent, last = text, time.monotonic()
    if acc is None:
        return AIMessage("")
    if acc.text and acc.text != sent:
        await db.broadcast(ctx.thread_id, "delta", {**_ids(ctx, tm), "stream_id": stream_id, "text": acc.text})
    return AIMessage(content=acc.content, tool_calls=acc.tool_calls, id=acc.id or str(uuid.uuid4()),
                     response_metadata=acc.response_metadata, usage_metadata=acc.usage_metadata)


def _ids(ctx: RunCtx, tm: dict) -> dict:
    return {"run_id": ctx.run_id, "teammate_id": tm["id"]}


def make_teammate(ctx: RunCtx, tm: dict):
    async def node(state: State) -> dict:
        ctx.scope(state["messages"])
        updates, msgs = await compact(ctx, tm, state["messages"])
        tools = await ctx.tools_for(tm)
        system = await preamble(ctx, tm, msgs, [t.name for t in tools]) + turn_note(ctx, tm, state)
        view = shrink_old_results(view_for(tm, msgs, ctx.members))
        size = (len(system) + sum(len(t.description) + len(json.dumps(t.tool_call_schema if isinstance(t.tool_call_schema, dict)
                else t.tool_call_schema.model_json_schema())) for t in tools)) // 4 + estimate_tokens(view)
        model = llm.chat_model(tm["model"], tools, size=size)
        stream_id = str(uuid.uuid4())
        if ctx.project:  # the run row names who is working, for the header and avatars
            await db.update("runs", {"id": f"eq.{ctx.run_id}"}, {"teammate_id": tm["id"]})
        await db.broadcast(ctx.thread_id, "status", ctx.status(tm, "thinking"))
        convo = [SystemMessage(system), *view]
        for attempt in range(3):
            try:
                ai = await _stream(ctx, tm, model, convo, stream_id)
                break
            except openai.APIError as e:
                # Groq rejects a call to a tool that isn't bound, or with arguments off-schema; a nudge and a
                # second draw almost always fixes it.
                if attempt == 2 or "tool call validation failed" not in str(e).lower():
                    raise
                log.warning("retrying after a rejected tool call: %s", str(e)[:200])
                convo = [*convo, HumanMessage(
                    "[Note: your last reply called a tool that does not exist or with invalid arguments. Use only the "
                    f"tools you have ({', '.join(t.name for t in tools) or 'none'}) with exactly their parameters, "
                    "or answer in text.]", name="system_note")]
        ai.name = tm["handle"]
        text = ai.text.strip()
        done = {**_ids(ctx, tm), "stream_id": stream_id}
        if ai.tool_calls or not text:
            if text or not ai.tool_calls:  # streamed tool-call chatter or an empty reply: no DB row follows
                await db.broadcast(ctx.thread_id, "done", {**done, "discarded": True})
        elif ctx.event_type == "email" and text.upper().startswith("SKIP"):
            await db.broadcast(ctx.thread_id, "done", {**done, "discarded": True})
            await db.activity(ctx.owner_id, "event", "email_ignored", run_id=ctx.run_id, thread_id=ctx.thread_id,
                              teammate_id=tm["id"], output={"reason": text[:500]})
        else:
            await db.broadcast(ctx.thread_id, "done", done)
            await db.insert("messages", {
                "thread_id": ctx.thread_id, "owner_id": ctx.owner_id, "sender_type": "teammate", "teammate_id": tm["id"],
                "text": text, "kind": "text", "proactive": ctx.proactive, "run_id": ctx.run_id,
                "meta": {"stream_id": stream_id, "tool_calls": ctx.turn_tools.pop(tm["id"], [])},
            })
            if ctx.proactive:
                await push.notify(ctx.owner_id, tm["name"], text, ctx.thread_id)
            asked = [m["id"] for m in mentioned(text, ctx.members) if m["id"] != tm["id"]]
            if asked:
                return {"messages": [*updates, ai], **_ask(state, asked)}
        return {"messages": [*updates, ai]}

    return node


async def _route_with_model(ctx: RunCtx, msgs: list[BaseMessage]) -> list[str]:
    roster = "\n".join(f"- {m['handle']}: {m['name']}, {m['role']}. {m.get('bio', '')}" for m in ctx.members)
    # Enough of the chat to resolve "apologise to him" or "you were right" to the member who did the thing.
    said = [m for m in msgs if not isinstance(m, ToolMessage) and not (isinstance(m, AIMessage) and not m.text.strip())]
    recent = "\n".join(line[:300] for line in _transcript(said[-12:]).split("\n"))
    try:
        res = await llm.chat_model(config.ROUTER_MODEL).ainvoke([
            SystemMessage(f"You route messages in a team chat. Members:\n{roster}\n\nPick who should answer the latest "
                          "message: usually the one member it fits best; everyone when it speaks to the whole group "
                          "(everyone, all of you, a debate or game with the team). Work out who 'him', 'her', 'you' or "
                          "'they' mean from what was said: 'apologise to him' goes to whoever did the thing, not to "
                          'the one it was done to. Reply with JSON only, like {"handles": ["dev"]}.'),
            HumanMessage(recent),
        ])
        handles = re.findall(r'"@?([a-z0-9_-]+)"', res.text.split(":", 1)[-1]) or [res.text.strip().lstrip("@").lower()]
    except Exception:
        handles = []
    picked = [t["id"] for h in dict.fromkeys(handles) for t in ctx.members if t["handle"] == h]
    return picked or [ctx.members[0]["id"]]


def make_router(ctx: RunCtx):
    async def router(state: State) -> dict:
        queue = [q for q in state.get("queue") or [] if any(m["id"] == q for m in ctx.members)]
        if queue:
            return {"active": queue[0], "queue": queue[1:]}
        if len(ctx.members) == 1:
            return {"active": ctx.members[0]["id"], "queue": []}
        last = _last_human(state["messages"])
        picked = [m["id"] for m in mentioned(last, ctx.members)] or await _route_with_model(ctx, state["messages"])
        return {"active": picked[0], "queue": picked[1:]}

    return router


def make_gate(ctx: RunCtx):
    """Side effects for approvals live here, before the interrupt node, so a resume never repeats them."""

    async def gate(state: State) -> dict:
        ctx.scope(state["messages"])
        tm = ctx.member(state.get("active"))
        ai = state["messages"][-1]
        known = {t.name for t in await ctx.tools_for(tm)}
        pending = []
        connected: set[str] | None = None
        for tc in ai.tool_calls:
            if tc["name"] in T.PROMPTS:
                if tc["name"] == "connect_app":
                    if connected is None:
                        connected = await connectors.ready(ctx.owner_id)
                    slug = await connectors.resolve(str(tc["args"].get("toolkit", "")))
                    if slug is None or slug in connected:
                        continue  # nothing to wait for: the tools node says it's connected, or that no such app exists
                pending.append(await _prompt(ctx, tm, tc))
                continue
            if T.classify_call(tc["name"], tc["args"]) != "act" or tc["name"] not in known:
                continue
            tool_name, title, draft = T.approval_view(tc["name"], tc["args"])
            approval = await db.insert("approvals", {
                "owner_id": ctx.owner_id, "thread_id": ctx.thread_id, "teammate_id": tm["id"], "run_id": ctx.run_id,
                "tool_name": tool_name, "toolkit": tool_name.split("_")[0] if tool_name.isupper() else None,
                "title": title, "draft": draft,
            })
            msg = await db.insert("messages", {
                "thread_id": ctx.thread_id, "owner_id": ctx.owner_id, "sender_type": "teammate", "teammate_id": tm["id"],
                "text": f"{tm['name']} needs your approval: {title}", "kind": "approval", "proactive": ctx.proactive,
                "run_id": ctx.run_id, "meta": {"approval_id": approval["id"], "tool_name": tool_name},
            })
            await db.update("approvals", {"id": f"eq.{approval['id']}"}, {"message_id": msg["id"]})
            await db.activity(ctx.owner_id, "approval_request", tool_name, run_id=ctx.run_id, thread_id=ctx.thread_id,
                              teammate_id=tm["id"], input=draft, output={"approval_id": approval["id"]}, status="pending")
            pending.append({"approval_id": approval["id"], "tool_call_id": tc["id"], "title": title, "kind": "approval"})
        if pending:
            first = pending[0]
            label = {"question": "Waiting for your answer", "connect": "Waiting for you to connect"}.get(first["kind"], "Waiting for your approval")
            await db.broadcast(ctx.thread_id, "status", ctx.status(tm, "waiting", label))
            heading = f"{tm['name']} needs your approval" if first["kind"] == "approval" else f"{tm['name']} asked you"
            await push.notify(ctx.owner_id, heading, first["title"], ctx.thread_id)
        return {"pending": pending, "decisions": {}}

    return gate


async def _prompt(ctx: RunCtx, tm: dict, tc: dict) -> dict:
    """A question-with-options or connect-an-app card: an approvals row of that kind plus its chat message."""
    args = tc["args"]
    if tc["name"] == "ask_user":
        kind = "question"
        options = [str(o).strip() for o in (args.get("options") or []) if str(o).strip()][:4]
        title = str(args.get("question") or "Which way should I go?").strip()
        draft = {"question": title, "options": options, "allow_other": bool(args.get("allow_other", True))}
    else:
        kind = "connect"
        toolkit = await connectors.resolve(str(args.get("toolkit", ""))) or str(args.get("toolkit", "")).upper()
        name = connectors.name_of(toolkit)
        title = f"Connect {name}"
        draft = {"toolkit": toolkit, "name": name, "reason": str(args.get("reason") or "")}
    row = await db.insert("approvals", {
        "owner_id": ctx.owner_id, "thread_id": ctx.thread_id, "teammate_id": tm["id"], "run_id": ctx.run_id,
        "tool_name": tc["name"], "kind": kind, "title": title, "draft": draft,
    })
    msg = await db.insert("messages", {
        "thread_id": ctx.thread_id, "owner_id": ctx.owner_id, "sender_type": "teammate", "teammate_id": tm["id"],
        "text": title, "kind": kind, "proactive": ctx.proactive, "run_id": ctx.run_id,
        "meta": {"approval_id": row["id"], **draft},
    })
    await db.update("approvals", {"id": f"eq.{row['id']}"}, {"message_id": msg["id"]})
    return {"approval_id": row["id"], "tool_call_id": tc["id"], "title": title, "kind": kind}


def wait(state: State) -> dict:
    decisions = dict(state.get("decisions") or {})
    todo = [p for p in state["pending"] if p["approval_id"] not in decisions]
    decision = interrupt({"approval_id": todo[0]["approval_id"]})
    if any(p["approval_id"] == decision.get("approval_id") for p in state["pending"]):
        decisions[decision["approval_id"]] = decision
    return {"decisions": decisions}


def _undecided(state: State) -> bool:
    return any(p["approval_id"] not in (state.get("decisions") or {}) for p in state.get("pending") or [])


def make_tools(ctx: RunCtx):
    async def tools_node(state: State) -> dict:
        ctx.scope(state["messages"])
        tm = ctx.member(state.get("active"))
        ai = state["messages"][-1]
        by_name = {t.name: t for t in await ctx.tools_for(tm)}
        approval_of = {p["tool_call_id"]: p["approval_id"] for p in state.get("pending") or []}
        decisions = state.get("decisions") or {}
        out: list[BaseMessage] = []
        for tc in ai.tool_calls:
            name, args = tc["name"], tc["args"]
            if name in T.PROMPTS:
                d = decisions.get(approval_of.get(tc["id"], "")) or {}
                out.append(ToolMessage(await _prompt_result(ctx, tm, name, args, d), tool_call_id=tc["id"], name=name))
                continue
            if tc["id"] in approval_of:
                d = decisions.get(approval_of[tc["id"]]) or {"action": "reject"}
                if d.get("action") != "approve":
                    note = f" Their note: {d['note']}" if d.get("note") else ""
                    out.append(ToolMessage(f"The user rejected this action, so it was not done.{note} Acknowledge it "
                                           "briefly and do not retry unless they ask.", tool_call_id=tc["id"], name=name, status="error"))
                    ctx.turn_tools.setdefault(tm["id"], []).append({"name": name, "status": "rejected"})
                    continue
                args = T.apply_edit(name, args, d.get("args"))
            content, status = await T.run_tool(ctx, tm, by_name.get(name), name, args)
            out.append(ToolMessage(content, tool_call_id=tc["id"], name=name, status="error" if status == "error" else "success"))
        return {"messages": out, "pending": [], "decisions": {}}

    return tools_node


async def _prompt_result(ctx: RunCtx, tm: dict, name: str, args: dict, d: dict) -> str:
    if name == "ask_user":
        if d.get("action") == "answer" and d.get("answer"):
            return f"The user answered: {d['answer']}"
        return "The user dismissed the question. Continue with your best judgement or ask in plain text."
    asked = str(args.get("toolkit", ""))
    toolkit = await connectors.resolve(asked)
    if toolkit is None:
        close = await connectors.similar(asked)
        return (f"There is no app called {asked}." + (f" Did you mean {', '.join(close)}?" if close else "")
                + " Call connect_app again with the app's name.")
    if d and d.get("action") != "connected":
        return f"The user chose not to connect {toolkit} for now. Tell them what you can do without it."
    # Connected now, or already (the gate skipped the pause): either way this teammate gets the app's tools.
    if toolkit not in (tm.get("allowed_toolkits") or []):
        tm["allowed_toolkits"] = [*(tm.get("allowed_toolkits") or []), toolkit]
        await db.update("teammates", {"id": f"eq.{tm['id']}"}, {"allowed_toolkits": tm["allowed_toolkits"]})
    ctx._tools.pop(tm["id"], None)  # rebuild with the new app's tools on the next model call
    if not d:
        return f"{toolkit} is already connected. Its tools are available now; continue the task."
    return f"The user connected {toolkit}. Its tools are available now; continue the task."


def turn_note(ctx: RunCtx, tm: dict, state: State) -> str:
    """In a group round, who has answered and who still will: without it, models invent replies from members who
    haven't spoken yet, or answer for them."""
    if not ctx.project:
        return ""
    msgs = state["messages"]
    start = next((i for i in range(len(msgs) - 1, -1, -1) if isinstance(msgs[i], HumanMessage) and not msgs[i].name), 0)
    spoke = list(dict.fromkeys(m.name for m in msgs[start:] if isinstance(m, AIMessage) and m.text.strip() and m.name != tm["handle"]))
    later = [ctx.member(i)["name"] for i in state.get("queue") or [] if i != tm["id"]]
    if not spoke and not later:
        return ""
    names = {m["handle"]: m["name"] for m in ctx.members}
    lines = ["\n\n## This turn"]
    if spoke:
        lines.append("Already replied to the latest message: " + ", ".join(names.get(h, h) for h in spoke)
                     + ". Build on or push back on what they said; don't repeat their points or wording.")
    if later:
        lines.append("Replying after you: " + ", ".join(later) + ". Leave them their own say: don't answer for them, "
                     "and don't @mention them just to hand over the turn.")
    tag = re.compile(rf"(?<![\w@])@{re.escape(tm['handle'])}\b", re.I)
    callers = list(dict.fromkeys(m.name for m in msgs[start:] if isinstance(m, AIMessage) and m.name != tm["handle"]
                                 and tag.search(m.text)))
    if callers:
        lines.append(", ".join(names.get(h, h) for h in callers) + " @mentioned you: answer what they said to you.")
    lines.append("Give your own answer now, in your own voice.")
    return "\n".join(lines)


def mentioned(text: str, members: list[dict]) -> list[dict]:
    """Members @mentioned in a message, in member order; @all / @everyone means the whole group."""
    handles = {h.lower() for h in re.findall(r"(?<![\w@])@([a-z0-9][a-z0-9_-]*)", text, re.I)}
    if handles & {"all", "everyone"}:
        return list(members)
    return [m for m in members if m["handle"] in handles]


def _ask(state: State, ids: list[str]) -> dict:
    """Queue members a teammate asked for, up to MAX_HANDOFFS such turns per run (two teammates can't ping-pong forever)."""
    queue = list(state.get("queue") or [])
    turns = state.get("handoffs") or 0
    for i in ids:
        if i not in queue and turns < config.MAX_HANDOFFS:
            queue.append(i)
            turns += 1
    return {"queue": queue, "handoffs": turns}


# ------------------------------------------------------------------ graph
def build(ctx: RunCtx, checkpointer):
    g = StateGraph(State)
    node_of = {m["id"]: f"tm_{m['handle']}" for m in ctx.members}
    g.add_node("router", make_router(ctx))
    for m in ctx.members:
        g.add_node(node_of[m["id"]], make_teammate(ctx, m))
    g.add_node("gate", make_gate(ctx))
    g.add_node("wait", wait)
    g.add_node("tools", make_tools(ctx))
    targets = list(node_of.values())

    def to_active(state: State) -> str:
        return node_of.get(state.get("active") or "", targets[0])

    def after_teammate(state: State) -> str:
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return "gate"
        return "router" if state.get("queue") else END

    g.add_edge(START, "router")
    g.add_conditional_edges("router", to_active, targets)
    for n in targets:
        g.add_conditional_edges(n, after_teammate, ["gate", "router", END])
    g.add_conditional_edges("gate", lambda s: "wait" if _undecided(s) else "tools", ["wait", "tools"])
    g.add_conditional_edges("wait", lambda s: "wait" if _undecided(s) else "tools", ["wait", "tools"])
    g.add_conditional_edges("tools", to_active, targets)
    return g.compile(checkpointer=checkpointer, store=memory.store)
