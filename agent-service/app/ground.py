"""Look before answering. Small models answer questions about live data (mail, calendar, repos, files, the web)
from the chat history or from nothing, and say it confidently: Ivy summed up "the last week" from an earlier reply
without opening Gmail. Prompts alone don't stop that, so the harness decides: before a teammate's first move on a new
request, one cheap call judges whether a correct answer needs data only its tools can give. If so, that first move
must be a tool call (tool_choice=required), the turn carries a note saying what to check, and a reply that still
skips the tools is thrown away and retried once (models that ignore tool_choice)."""
import json
import logging
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from . import config, llm

log = logging.getLogger(__name__)

JUDGE = """You decide whether an AI teammate must look something up with its tools before answering a request.

Answer LOOK when a correct reply depends on information that lives in the user's apps, files, the web or the
teammate's tools and can change over time: their mail, calendar, repos, issues, documents, posts, messages, the news,
prices, a web page, their vault, their computer or phone. A summary, catch-up, status check, "anything new",
"what's on", "did X reply", a number, a list or a search: LOOK, even when the same question was answered earlier in
the chat (things change, an old answer is never enough). When they doubt or push back on an earlier answer about
such data ("are you sure?", "that seems low", "you missed one"), LOOK again instead of defending it. Doing a task with the apps (draft, schedule, post, create,
move, fix in the repo) also starts with a LOOK.

Answer TALK when the reply needs no fresh data: greetings, thanks, small talk, feelings, opinions, explanations of
general knowledge, brainstorming, rewriting text they gave, answering a question about what was just said, or a
plain yes/no to the teammate's own question. Also TALK for vague requests that need a clarifying question first.

Reply with JSON only: {"look": true|false, "what": "<what to check, in a few words, or empty>"}"""


async def judge(tm: dict[str, Any], tool_names: list[str], request: str, recent: str) -> dict[str, Any]:
    """{"look": bool, "what": str}; on any failure, look (a needless look costs one tool call, a skipped one a lie)."""
    prompt = (f"Teammate: {tm['name']}, {tm.get('role', '')}\nIts tools: {', '.join(tool_names[:60])}\n\n"
              f"Recent chat (oldest first):\n{recent[-1500:] or '(none)'}\n\nThe request now:\n{request[:2000]}")
    try:
        out = await llm.chat_model(config.ROUTER_MODEL, json=True).ainvoke([SystemMessage(JUDGE), HumanMessage(prompt)])
        text = out.text if isinstance(out.text, str) else str(out.content)
        d = json.loads(text[text.find("{"):text.rfind("}") + 1])
        return {"look": bool(d.get("look")), "what": str(d.get("what") or "")[:200]}
    except Exception as e:
        log.warning("grounding judge failed, looking anyway: %s", str(e)[:200])
        return {"look": True, "what": ""}


def note(what: str) -> HumanMessage:
    return HumanMessage(f"[Check first{': ' + what if what else ''}. Look it up with your tools now, every time, and "
                        "answer only from what they return; an earlier reply in this chat is never the answer.]",
                        name="system_note")


CHECK = """You check an AI teammate's reply against the data its tools returned for this request, before the user reads it.

Flag only what matters to the user:
- missed: something in the data that the request asked about and the user would want to know (a person waiting on
  them, a batch of applications, a deadline, a payment, a conflict), left out or brushed off as unimportant;
- wrong: a claim the data contradicts (a count, a name, a date, "nothing needs you" when something does);
- partial: the reply presents data as complete when the data says items were not shown or cut.
A claim is wrong only if the data shows otherwise; if the data simply doesn't cover it, say nothing about it.
Don't flag style, length, tone, or details the user wouldn't care about. If the reply is fair to the data, it's ok.

Reply with JSON only: {"ok": true|false, "problems": ["<one short line each>"]}"""

DATA_MIN = 1500  # tool output this small (a saved to-do, a short lookup) isn't worth a second opinion
CHECK_DATA = 120_000  # characters of data the checker reads (~30k tokens; every tool result fits several times)
# Composio's tool finder and schemas: how to call things, not data about the user. The checker never sees them.
META = {"COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MANAGE_CONNECTIONS"}


def turn_data(msgs: list[Any]) -> str:
    """The data a reply can be built on: this turn's tool results, without the tool-finding chatter."""
    from langchain_core.messages import ToolMessage
    return "\n\n".join(str(m.content) for m in msgs if isinstance(m, ToolMessage) and m.name not in META)


async def check(request: str, data: str, reply: str) -> dict[str, Any]:
    """{"ok": bool, "problems": [...]}; ok when the checker itself fails (it never blocks a reply on its own outage)."""
    clipped = len(data) > CHECK_DATA
    prompt = (f"The request:\n{request[:2000]}\n\nThe data its tools returned"
              + (f" (only the first {CHECK_DATA} of {len(data)} characters are shown here: never call a claim wrong "
                 "or made up because you can't see it)" if clipped else "")
              + f":\n{data[:CHECK_DATA]}\n\nThe reply:\n{reply[:6000]}")
    try:
        # sized, so a big week of data goes to a model that can hold all of it (Groq's free tier can't)
        model = llm.chat_model(config.ROUTER_MODEL, json=True, size=(len(prompt) + len(CHECK)) // 4)
        out = await model.ainvoke([SystemMessage(CHECK), HumanMessage(prompt)])
        text = out.text if isinstance(out.text, str) else str(out.content)
        d = json.loads(text[text.find("{"):text.rfind("}") + 1])
        problems = [str(p)[:300] for p in d.get("problems") or []][:6]
        return {"ok": bool(d.get("ok")) or not problems, "problems": problems}
    except Exception as e:
        log.warning("reply check failed, letting the reply through: %s", str(e)[:200])
        return {"ok": True, "problems": []}


def redo(problems: list[str]) -> HumanMessage:
    return HumanMessage("[Before this reached them, a check against your tools' data found: " + " ".join(f"({i + 1}) {p}"
                        for i, p in enumerate(problems)) + " Write your reply again from the data, fixing this. Don't "
                        "mention the check.]", name="system_note")
