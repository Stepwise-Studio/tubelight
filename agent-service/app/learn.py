"""Learning after every reply: a quick background pass turns what just happened into lasting memory.

The teammate never has to remember to save anything. After a run, a small model reads the exchange (the user's
message, what the tools returned, the reply, and how the user treated any approval drafts) next to the memories
it may touch, and returns a few changes: add, update, delete, or mark a commitment done. People and preferences
go to the user's shelf (every teammate sees them); how-to lessons go to the teammate's own shelf.
"""
import asyncio
import json
import logging
import re
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

from . import db, llm, memory

log = logging.getLogger(__name__)
MAX_CHANGES = 6
SAME = 0.9  # cosine similarity above which a new memory just restates an existing one
_tasks: set[asyncio.Task] = set()

PROMPT = """You maintain the long-term memory of {name}, an AI teammate working for {user}. Read the latest exchange
and decide what is worth remembering for future conversations. Today is {today}.

Keep only durable, useful knowledge:
- person: who someone is to the user (role, company, relationship, what they're working on together).
- commitment: something the user owes or was asked for, or someone owes the user, with a due date if known (YYYY-MM-DD).
- preference: how the user likes things done, what they care about or want ignored (learn from corrections,
  rejections and edits to drafts too).
- lesson: a concrete how-to for {name} next time: which app action and arguments worked, or a pitfall hit. Only
  when this exchange taught one; never generic advice. Lessons go on the teammate shelf.
- fact: other stable facts about the user's work, projects or accounts.

Rules:
- Nothing from promotions, newsletters or one-off noise. No secrets: passwords, codes, card or account numbers.
- One self-contained sentence per memory, with names in full ("Priya Raman (Northwind) asked for...").
- Never add what an existing memory already says, even in other words: update it instead (e.g. turn a fact
  about a request into the commitment, or add the due date). Delete memories the exchange shows are wrong.
  Mark a commitment done when the exchange shows it was handled.
- At most {max} changes. If nothing is worth keeping, return empty lists. Most small talk needs nothing.

Existing memories (key | shelf | kind | text):
{existing}

Reply with JSON only:
{{"add": [{{"text": "...", "kind": "person|commitment|preference|lesson|fact", "about": ["people, companies, products or projects by name"],
  "shelf": "user|teammate|project", "due": "YYYY-MM-DD or null"}}],
 "update": [{{"key": "...", "text": "..."}}], "delete": ["key"], "done": ["key"]}}"""


def exchange(msgs: list[BaseMessage], limit: int = 9000) -> str:
    """The latest turn: from the user's last message to the end, tool output clipped."""
    start = next((i for i in range(len(msgs) - 1, -1, -1)
                  if isinstance(msgs[i], HumanMessage) and msgs[i].name != "summary"), 0)
    out = []
    for m in msgs[start:]:
        if isinstance(m, HumanMessage):
            out.append(f"User: {m.content}")
        elif isinstance(m, ToolMessage):
            out.append(f"Tool result: {str(m.content)[:2500]}")
        elif isinstance(m, AIMessage) and m.text.strip():
            out.append(f"{m.name or 'Teammate'}: {m.text}")
    return "\n".join(out)[-limit:]


async def _signals(run_id: str) -> str:
    """How the user treated this run's approval drafts: edits and rejections teach taste."""
    lines = []
    for a in await db.select("approvals", {"run_id": f"eq.{run_id}", "status": "in.(approved,rejected)"}):
        if a["status"] == "rejected":
            lines.append(f"The user rejected: {a['title']}" + (f" (note: {a['note']})" if a.get("note") else ""))
        elif a.get("final_args") and a["final_args"] != a.get("draft"):
            lines.append(f"The user edited the draft for {a['title']} before approving.\n"
                         f"Draft: {json.dumps(a.get('draft'))[:1500]}\nWhat they sent: {json.dumps(a['final_args'])[:1500]}")
    return "\n".join(lines)


def _parse(text: str) -> dict[str, Any]:
    m = re.search(r"\{.*\}", text, re.S)
    try:
        out = json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        return {}
    return out if isinstance(out, dict) else {}


async def learn(owner_id: str, user_name: str, tm: dict, project_id: str | None, run_id: str,
                msgs: list[BaseMessage], today: str) -> dict[str, int]:
    turn = exchange(msgs)
    signals = await _signals(run_id)
    if signals:
        turn += "\n\n" + signals
    if len(turn) < 40:
        return {}
    shelves = {"user": memory.ns("user", owner_id), "teammate": memory.ns("teammate", tm["id"])}
    if project_id:
        shelves["project"] = memory.ns("project", project_id)
    known: dict[str, tuple[str, dict]] = {}
    for shelf, ns in shelves.items():
        rows = await memory.search_rows(ns, turn[-2000:], limit=10 if shelf == "user" else 5)
        rows += await memory.listing(ns, limit=10, kind="commitment", done=False) if shelf == "user" else []
        for r in rows:
            known[r["key"]] = (shelf, r)
    existing = "\n".join(f"{k} | {s} | {r['kind']} | {r['text']}" for k, (s, r) in known.items()) or "(none yet)"
    prompt = PROMPT.format(name=tm["name"], user=user_name, today=today, max=MAX_CHANGES, existing=existing)
    # The stronger default model: this runs in the background, and a weak one duplicates and invents lessons.
    res = await llm.chat_model().ainvoke([SystemMessage(prompt), HumanMessage(turn)])
    plan = _parse(res.text if isinstance(res, AIMessage) else str(res.content))

    done = {"add": 0, "update": 0, "delete": 0, "done": 0}
    budget = MAX_CHANGES
    for a in (plan.get("add") or [])[:budget]:
        text = str(a.get("text") or "").strip()
        shelf = a.get("shelf") if a.get("shelf") in shelves else "user"
        kind = a.get("kind") if a.get("kind") in memory.KINDS else "fact"
        if not text:
            continue
        top = await memory.search_rows(shelves[shelf], text, limit=1)
        if top and top[0].get("score", 0) >= SAME:
            continue  # the model restated something already known
        due = a.get("due") if isinstance(a.get("due"), str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", a["due"]) else None
        await memory.add(shelves[shelf], text[:500], kind=kind, about=[str(x)[:60] for x in (a.get("about") or [])][:5],
                         due=due, done=False if kind == "commitment" else None, source=run_id)
        done["add"] += 1
    for u in plan.get("update") or []:
        if u.get("key") in known and str(u.get("text") or "").strip():
            await memory.update(shelves[known[u["key"]][0]], u["key"], text=str(u["text"]).strip()[:500])
            done["update"] += 1
    for k in plan.get("delete") or []:
        if k in known:
            await memory.remove(shelves[known[k][0]], k)
            done["delete"] += 1
    for k in plan.get("done") or []:
        if k in known:
            await memory.update(shelves[known[k][0]], k, done=True)
            done["done"] += 1
    return done


def schedule(*args: Any) -> None:
    """Fire and forget: learning must never slow down or break a reply."""
    async def run() -> None:
        try:
            changes = await learn(*args)
            if any(changes.values()):
                log.info("learned: %s", changes)
        except Exception:
            log.exception("learning pass failed")

    task = asyncio.create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
