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
from datetime import datetime, timedelta
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

from . import config, llm
from .reactions import EMOJI

log = logging.getLogger(__name__)
HISTORY_CHARS = 6000  # recent chat the director reads verbatim (~1.5k tokens); older is in the brief
QUIET_MAX = 40  # "nobody replies" is only trusted for short messages (ok, thanks, got it)

PROMPT = """You direct the floor of a group chat between {user} and their AI teammates. It is {now} for {user}. For
{user}'s latest message, decide who replies, in what order, and what each one's part is.

Members:
{roster}

How to read the message:
- Tell apart who is addressed (should reply or act) from who is only talked about. An @tag or a name can be either:
  in "everyone roast @dev" the whole group is addressed and Dev is the subject; in "@dev can you check what @tess
  wrote" only Dev is addressed. @all or @everyone addresses everyone.
- Resolve pronouns and references (him, her, you, they, "that idea", "what we discussed this morning") from the
  conversation and the brief: who said or did what.
- A request for one person or one skill: the single best member. A question, game, debate or request for the whole
  group: each member with something to add, ordered so the conversation flows. Someone who is the subject (the one
  being roasted, praised, or asked to react to the others) goes last so they can respond.
- Everyone given a task in the message is addressed, in the order the work happens ("ask @tess to test it and
  @dev to fix what she finds": Tess, then Dev).
- when: when {user} wants the thing itself to happen. "now", unless the message names a time ("at 6 pm", "at
  1:27", "tomorrow morning": give it as YYYY-MM-DDTHH:MM, their local time) or a condition ("once the design is
  done": "condition"). Nobody does the thing itself yet. If {user} addressed a specific member (tagged or named),
  that member alone confirms it and sets the follow-up (the one speaker). Otherwise list no speakers: you set it
  yourself; give `what` (the thing to do then, self-contained) and for a condition `until` (short and checkable).
- If {user} is continuing an exchange with one member, that member replies unless someone else is clearly addressed.
- A scheduled follow-up firing always appears as "Scheduled follow-up: ..."; a message from {user} is always a new
  request, even when it talks about circling back.
- The latest message may be a scheduled follow-up the chat set earlier: the group picking a topic back up, now
  (timing "now"). Its owner leads, first. Then add every member who took part in that topic or would naturally
  react: for a debate, verdict, announcement or group circle-back that's everyone; for one person's task (sending
  numbers, a deploy) just the owner, plus anyone whose work it depends on. Never nobody.
- If no reply is needed (ok, thanks, got it), choose nobody.
- If it's unclear who is meant, pick the member best placed to ask {user} one short clarifying question, and say so
  in their part.

- react: members who acknowledge {user}'s message with an emoji reaction, like in a group chat. When you set a
  follow-up yourself, everyone it concerns reacts 👍. When no reply is needed (ok, thanks), the member it was for
  reacts (👍 or ❤️). Otherwise usually none. Only 👍 ❤️ 😂 🔥 🙏 👀.

Write about {user} by name, never as he or she.

Reply with JSON only:
{{"read": "<one sentence: what is asked, who is addressed, who is talked about>",
 "when": "now, YYYY-MM-DDTHH:MM, or condition",
 "what": "<for later with no speakers: what to do then>", "until": "<for a condition: what to wait for>",
 "react": [{{"handle": "<handle>", "emoji": "👍"}}],
 "speakers": [{{"handle": "<handle>", "part": "<their part, in the second person, one short sentence>"}}]}}"""


@dataclass
class Plan:
    read: str = ""
    speakers: list[str] = field(default_factory=list)  # teammate ids, in order
    parts: dict[str, str] = field(default_factory=dict)  # teammate id -> their part
    # For later, with no one addressed: the director sets the follow-up itself (for the group).
    later: bool = False
    what: str = ""
    at: datetime | None = None
    until: str | None = None
    reacts: list[tuple[str, str]] = field(default_factory=list)  # (teammate id, emoji) on the user's message


def transcript(msgs: list[BaseMessage], members: list[dict], user: str) -> str:
    """The recent chat as the director sees it: speaker names, no tool traffic, the latest message marked."""
    names = {m["handle"]: f"{m['name']} (@{m['handle']})" for m in members}
    lines = []
    for m in msgs:
        if isinstance(m, ToolMessage) or (isinstance(m, AIMessage) and not m.text.strip()):
            continue
        if isinstance(m, HumanMessage) and m.name in ("system_note", "summary", "handoff"):
            continue
        who = (names.get(m.name or "", m.name or "Teammate") if isinstance(m, AIMessage)
               else "Scheduled follow-up" if m.name == "follow_up" else user)
        lines.append(f"{who}: {(m.text if isinstance(m, AIMessage) else str(m.content))[:300]}")
    kept, size = [], 0
    for line in reversed(lines):
        if kept and size + len(line) > HISTORY_CHARS:
            break
        kept.append(line)
        size += len(line)
    lines = kept[::-1]
    if lines:
        lines[-1] = "LATEST MESSAGE — " + lines[-1]
    return "\n".join(lines)


def later(when: Any, now: datetime | None) -> bool:
    """Whether the plan's `when` is for later: a condition, or a time past now. The model reads the time off the
    message; the comparison is done here (models slip at clock arithmetic, and copy the chat's earlier habits)."""
    w = str(when or "now").strip().lower()
    if w == "condition":
        return True
    try:
        at = datetime.fromisoformat(w.upper().rstrip("Z"))
    except ValueError:
        return False
    if not now:
        return True
    return at.replace(tzinfo=now.tzinfo) > now + timedelta(seconds=30)


def parse(text: str, members: list[dict], now: datetime | None = None) -> Plan | None:
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
    for r in data.get("react") or []:
        tid = by_handle.get(str((r or {}).get("handle", "")).lstrip("@").lower())
        if tid and str(r.get("emoji")) in EMOJI and all(t != tid for t, _ in plan.reacts):
            plan.reacts.append((tid, str(r["emoji"])))
    plan.later = later(data.get("when"), now) or str(data.get("timing", "")).lower() == "later"
    if plan.later and not plan.speakers:
        # Nobody was addressed: the director sets it for the group (graph.router), the group reacts.
        w = str(data.get("when") or "")
        plan.until = str(data.get("until") or "")[:300] or None if w.lower() == "condition" else None
        try:
            plan.at = datetime.fromisoformat(w.upper().rstrip("Z")).replace(tzinfo=now.tzinfo if now else None)
        except ValueError:
            plan.at = None
        plan.what = str(data.get("what") or plan.read)[:500]
    elif plan.later:
        # Something for later: the member addressed confirms and sets the follow-up; it fires for the group then.
        lead = plan.speakers[0]
        plan.speakers, plan.parts = [lead], {lead: (plan.parts.get(lead, "") + " This is for later: confirm it and set "
                                                    "a follow-up with follow_up (owner 'group' if everyone should pick it "
                                                    "up); don't do the thing itself yet.").strip()}
    return plan


def tagged(text: str, members: list[dict]) -> list[dict]:
    """Members @tagged in a message, in member order; @all / @everyone is the whole group."""
    handles = {h.lower() for h in re.findall(r"(?<![\w@])@([a-z0-9][a-z0-9_-]*)", text, re.I)}
    if handles & {"all", "everyone"}:
        return list(members)
    return [m for m in members if m["handle"] in handles]


async def plan(msgs: list[BaseMessage], members: list[dict], user: str, latest: str, brief: str = "",
               now: datetime | None = None) -> Plan:
    roster = "\n".join(f"- @{m['handle']}: {m['name']}, {m['role']}. {(m.get('bio') or '')[:160]}" for m in members)
    try:
        res = await llm.chat_model(config.ROUTER_MODEL, json=True).ainvoke([
            SystemMessage(PROMPT.format(user=user, roster=roster, now=f"{now:%A, %B %d, %Y, %I:%M %p}" if now else "now")),
            HumanMessage((f"Brief of the whole chat so far:\n{brief}\n\nRecent messages:\n" if brief else "")
                         + transcript(msgs, members, user)),
        ])
        got = parse(res.text, members, now)
    except Exception:
        log.exception("floor plan failed")
        got = None
    if got and (got.speakers or (got.later and (got.at or got.until)) or len(latest.strip()) <= QUIET_MAX):
        return got
    # No usable plan: the tagged members, else the first member.
    ids = [m["id"] for m in tagged(latest, members)] or [members[0]["id"]]
    return Plan(speakers=ids)
