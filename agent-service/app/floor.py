"""Who has the floor in a group chat, and why.

Before any teammate answers a group message, one small model call reads it in context and returns a plan: what's being
asked, who is addressed (should act) versus only talked about, and the ordered speakers, each with a one-line part.
Every speaker then sees the shared reading and its own part (graph.turn_note), so they act on the same understanding.

Tags and names are evidence, not commands: in "everyone roast @dev" the group is addressed and Dev is the subject.
Routing mistakes get fixed by adding a case to evals/floor.py and improving this prompt, not by adding rules in code.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

from . import config, llm

log = logging.getLogger(__name__)
HISTORY = 14  # lines of chat the director reads
QUIET_MAX = 40  # "nobody replies" is only trusted for short messages (ok, thanks, got it)

PROMPT = """You direct the floor of a group chat between {user} and their AI teammates. For {user}'s latest message,
decide who replies, in what order, and what each one's part is.

Members:
{roster}

How to read the message:
- Tell apart who is addressed (should reply or act) from who is only talked about. An @tag or a name can be either:
  in "everyone roast @dev" the whole group is addressed and Dev is the subject; in "@dev can you check what @tess
  wrote" only Dev is addressed. @all or @everyone addresses everyone.
- Resolve pronouns and references (him, her, you, they, "that idea") from the conversation: who said or did what.
- A request for one person or one skill: the single best member. A question, game, debate or request for the whole
  group: each member with something to add, ordered so the conversation flows. Someone who is the subject (the one
  being roasted, praised, or asked to react to the others) goes last so they can respond.
- Everyone given a task in the message is addressed, in the order the work happens ("ask @tess to test it and
  @dev to fix what she finds": Tess, then Dev).
- If {user} is continuing an exchange with one member, that member replies unless someone else is clearly addressed.
- If no reply is needed (ok, thanks, got it), choose nobody.
- If it's unclear who is meant, pick the member best placed to ask {user} one short clarifying question, and say so
  in their part.

Write about {user} by name, never as he or she.

Reply with JSON only:
{{"read": "<one sentence: what is asked, who is addressed, who is talked about>",
 "speakers": [{{"handle": "<handle>", "part": "<their part, in the second person, one short sentence>"}}]}}"""


@dataclass
class Plan:
    read: str = ""
    speakers: list[str] = field(default_factory=list)  # teammate ids, in order
    parts: dict[str, str] = field(default_factory=dict)  # teammate id -> their part


def transcript(msgs: list[BaseMessage], members: list[dict], user: str) -> str:
    """The recent chat as the director sees it: speaker names, no tool traffic, the latest message marked."""
    names = {m["handle"]: f"{m['name']} (@{m['handle']})" for m in members}
    lines = []
    for m in msgs:
        if isinstance(m, ToolMessage) or (isinstance(m, AIMessage) and not m.text.strip()):
            continue
        if isinstance(m, HumanMessage) and m.name in ("system_note", "summary", "handoff"):
            continue
        who = names.get(m.name or "", m.name or "Teammate") if isinstance(m, AIMessage) else user
        lines.append(f"{who}: {(m.text if isinstance(m, AIMessage) else str(m.content))[:300]}")
    lines = lines[-HISTORY:]
    if lines:
        lines[-1] = "LATEST MESSAGE — " + lines[-1]
    return "\n".join(lines)


def parse(text: str, members: list[dict]) -> Plan | None:
    """The director's JSON as a Plan; None when it isn't usable."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    by_handle = {m["handle"]: m["id"] for m in members}
    plan = Plan(read=str(data.get("read") or "")[:400])
    for s in data.get("speakers") or []:
        tid = by_handle.get(str((s or {}).get("handle", "")).lstrip("@").lower())
        if tid and tid not in plan.speakers:
            plan.speakers.append(tid)
            plan.parts[tid] = str(s.get("part") or "")[:300]
    return plan


def tagged(text: str, members: list[dict]) -> list[dict]:
    """Members @tagged in a message, in member order; @all / @everyone is the whole group."""
    handles = {h.lower() for h in re.findall(r"(?<![\w@])@([a-z0-9][a-z0-9_-]*)", text, re.I)}
    if handles & {"all", "everyone"}:
        return list(members)
    return [m for m in members if m["handle"] in handles]


async def plan(msgs: list[BaseMessage], members: list[dict], user: str, latest: str) -> Plan:
    roster = "\n".join(f"- @{m['handle']}: {m['name']}, {m['role']}. {(m.get('bio') or '')[:160]}" for m in members)
    try:
        res = await llm.chat_model(config.ROUTER_MODEL).ainvoke([
            SystemMessage(PROMPT.format(user=user, roster=roster)),
            HumanMessage(transcript(msgs, members, user)),
        ])
        got = parse(res.text, members)
    except Exception:
        log.exception("floor plan failed")
        got = None
    if got and (got.speakers or len(latest.strip()) <= QUIET_MAX):
        return got
    # No usable plan: the tagged members, else the first member.
    ids = [m["id"] for m in tagged(latest, members)] or [members[0]["id"]]
    return Plan(speakers=ids)
