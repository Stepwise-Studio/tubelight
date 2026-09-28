"""Automation evals: does a teammate turn a plain request into the right automation (or follow-up)?

    .venv/bin/python -m evals.automations [model ...]     e.g. gemini:gemini-3.5-flash-lite groq:openai/gpt-oss-120b

Each case gives the teammate its real instructions and tools and checks its first tool call. Nothing is executed.
When a teammate sets up the wrong thing in the app, add the request here first, then improve the prompt.
"""
import asyncio
import sys
import time

from croniter import croniter
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import StructuredTool

from app import graph, llm, memory, tools as T

OWNER = "00000000-0000-0000-0000-00000000e7a1"  # no data: an empty workspace
IVY = {"id": "00000000-0000-0000-0000-00000000e7a2", "name": "Ivy", "handle": "ivy", "role": "Inbox chief of staff", "system_prompt":
       "You triage the user's email and keep them on top of it.", "allowed_toolkits": ["GMAIL"], "model": ""}
DEV = {"id": "00000000-0000-0000-0000-00000000e7a3", "name": "Dev", "handle": "dev", "role": "Developer", "system_prompt":
       "You handle engineering work: issues, code, reviews.", "allowed_toolkits": ["LINEAR", "GITHUB"], "model": ""}


def every(hours):
    """A cron that runs every `hours` hours."""
    def ok(call):
        a = call["args"]
        if call["name"] != "automate" or a.get("action") != "create" or not a.get("schedule"):
            return False
        it = croniter(a["schedule"])
        x, y = it.get_next(float), it.get_next(float)
        return abs((y - x) - hours * 3600) < 60
    return ok


def at_8(call):
    a = call["args"]
    return call["name"] == "automate" and a.get("action") == "create" and str(a.get("schedule", "")).split()[:2] == ["0", "8"]


def app_event(app):
    def ok(call):
        a = call["args"]
        return ((call["name"] == "app_events" and app in str(a.get("app", "")).lower())
                or (call["name"] == "automate" and app.upper() in str(a.get("app_event", ""))))
    return ok


# (name, teammate, request, check on the first tool call)
CASES = [
    ("3-hour mail brief", IVY, "hey, from now on can you give me a brief of the mails I receive every 3 hours", every(3)),
    ("daily 8 AM summary", IVY, "every day at 8 in the morning I expect a brief summary of the mails I've received", at_8),
    ("hourly important check", IVY, "check my mail every hour and let me know if something important has arrived", every(1)),
    ("instant ping from a sender", IVY, "immediately ping me whenever a mail from abc@acme.com arrives", app_event("gmail")),
    ("linear issue pickup", DEV, "whenever I create an issue on Linear, take it up, go through it and ask me for approval "
                                 "before doing anything", app_event("linear")),
    ("one-off is a follow-up", IVY, "remind me at 5 pm today to reply to Priya", lambda c: c["name"] == "follow_up"),
]


def _stub(name: str, description: str) -> StructuredTool:
    async def run(**kw) -> str:
        return "not run in evals"
    return StructuredTool.from_function(coroutine=run, name=name, description=description,
                                        args_schema={"type": "object", "properties": {"queries": {"type": "array", "items": {"type": "object"}}}})


# The Composio tool router a connected teammate gets (its real names), so the model sees the apps as connected.
APP_TOOLS = [_stub("COMPOSIO_SEARCH_TOOLS", "Find the right app tool for a task in the connected apps."),
             _stub(T.MULTI, "Run app tools found with COMPOSIO_SEARCH_TOOLS.")]


async def first_call(tm: dict, request: str) -> dict | None:
    ctx = graph.RunCtx(run_id="eval", owner_id=OWNER, thread_id=f"dm:{tm['id']}", members=[tm], user_name="Akhil",
                       timezone="Asia/Kolkata")
    tools = T.build(ctx, tm, APP_TOOLS)  # what a teammate with connected apps has
    msgs = [HumanMessage(request)]
    system = await graph.preamble(ctx, tm, msgs, [t.name for t in tools])
    res = await llm.chat_model(tm["model"], tools).ainvoke([SystemMessage(system), *msgs])
    return res.tool_calls[0] if res.tool_calls else None


# Second step: after app_events answers (Composio's real list), the teammate sets up the trigger.
FOLLOW_ON = [
    ("gmail trigger with a sender query", IVY, "immediately ping me whenever a mail from abc@acme.com arrives", "Gmail",
     lambda c: c["name"] == "automate" and c["args"].get("app_event") == "GMAIL_NEW_GMAIL_MESSAGE"
     and "abc@acme.com" in str(c["args"].get("event_settings", {}).get("query", "")) + str(c["args"].get("keywords", ""))),
    ("linear trigger asks for the team", DEV, "whenever I create an issue on Linear, take it up, go through it and ask me for "
                                              "approval before doing anything", "Linear",
     # team_id is required and unknown: it should look it up (an app tool) or ask, not invent one
     lambda c: c["name"] in ("COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL", "ask_user")
     or (c["name"] == "text" and "team" in c["args"]["text"].lower() and "?" in c["args"]["text"])
     or (c["name"] == "automate" and c["args"].get("app_event") == "LINEAR_ISSUE_CREATED_TRIGGER"
         and not str(c["args"].get("event_settings", {}).get("team_id", "")).startswith("<"))),
]


async def second_call(tm: dict, request: str, app: str) -> dict | None:
    from langchain_core.messages import AIMessage, ToolMessage

    ctx = graph.RunCtx(run_id="eval", owner_id=OWNER, thread_id=f"dm:{tm['id']}", members=[tm], user_name="Akhil",
                       timezone="Asia/Kolkata")
    tools = T.build(ctx, tm, APP_TOOLS)
    listing = await next(t for t in tools if t.name == "app_events").coroutine(app=app)
    msgs = [HumanMessage(request), AIMessage("", tool_calls=[{"name": "app_events", "args": {"app": app}, "id": "c1"}]),
            ToolMessage(listing, tool_call_id="c1", name="app_events")]
    system = await graph.preamble(ctx, tm, msgs, [t.name for t in tools])
    res = await llm.chat_model(tm["model"], tools).ainvoke([SystemMessage(system), *msgs])
    # Asking which team in plain words is fine too: count it as a question.
    return res.tool_calls[0] if res.tool_calls else {"name": "text", "args": {"text": res.text[:300]}}


async def run(model: str) -> int:
    passed = 0
    for name, tm, request, check in CASES:
        t = time.monotonic()
        call = await first_call({**tm, "model": model}, request)
        ok = bool(call) and check(call)
        passed += ok
        print(f"{'PASS' if ok else 'FAIL'} {time.monotonic() - t:4.1f}s  {name}: "
              + (f"{call['name']} {call['args']}" if call else "no tool call"))
        await asyncio.sleep(4)  # free tiers: stay under the per-minute limits
    for name, tm, request, app, check in FOLLOW_ON:
        t = time.monotonic()
        call = await second_call({**tm, "model": model}, request, app)
        ok = bool(call) and check(call)
        passed += ok
        print(f"{'PASS' if ok else 'FAIL'} {time.monotonic() - t:4.1f}s  {name}: "
              + (f"{call['name']} {call['args']}" if call else "no tool call"))
        await asyncio.sleep(4)
    print(f"== {model}: {passed}/{len(CASES) + len(FOLLOW_ON)}\n")
    return passed


async def main():
    await memory.init()
    for model in sys.argv[1:] or ["gemini:gemini-3.5-flash-lite"]:
        await run(model)
    await memory.close()

asyncio.run(main())
