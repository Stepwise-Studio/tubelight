"""The memory agent: the user's memory as someone to talk to (docs/memory-v3.html §7).

A built-in teammate ("Memory", avatar_shape "memory", made on first open like the phone's). The user tells it about
their life and work, asks what it knows and why, and fixes it. What the user says there is logged as `journal`
episodes, which the gate treats as deliberate ("remember this"); everything still goes through extraction and quote
checks, so the agent can't invent memories even when it's the one talking.

The curiosity queue picks what to ask without a model: unsure (tentative) facts ranked by how unsure the gate is
(binary entropy H(p) x importance, uncertainty sampling), facts that contradict each other, promises past their due
date, people mentioned with almost nothing on record, and, while little is known about the user, their story. It
offers at most two per conversation (30 quiet minutes start a new one) and never the same one within two weeks.
Confirm / dismiss / correct are logged as labels for refitting the gate (store namespace mem_labels).
"""
import math
import time
from datetime import UTC, date, datetime
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool

from . import config, db, mem, memory

CONVERSATION = 30 * 60   # quiet seconds after which a new conversation (and new questions) starts
REASK = 14 * 86400       # never the same question within this
PER_CONVERSATION = 2

PROMPT = """You are {owner}'s memory: the part of Tubelight that remembers {owner}'s life, work and people for all of
their teammates. You don't run tasks (alarms, emails, apps); for those, say which teammate to ask. {owner} talks to you
to tell you about their journey, to check what you know, and to fix it.

- Listen like a good friend with a notebook: warm, brief, curious. When they tell you something, reflect back what you
  understood in one short line, nothing more.
- What {owner} says here goes into memory a couple of minutes after the chat goes quiet, checked against their exact
  words. So say you'll remember it, never that it's already saved.
- What you know is in the notes below and memory_search. Never invent a memory: if it isn't on record, say so plainly.
- "Why do you think that?": memory_why, and quote where it came from.
- They correct something: memory_correct. "Not important" or "forget that": memory_dismiss. "Yes, that's right" about
  something you weren't sure of: memory_confirm. Two entries for one person: memory_merge. Say what you changed.
- Questions: the notes list what you're unsure about. Ask one at a time, at most two in a conversation, only at a
  natural pause (never while they're mid-story), short and specific, with a few words on why you're asking. If they
  skip or don't know, drop it and move on; you won't be asked to raise it again for a while.
- Sensitive things (health, money, family) are theirs to share: never push for them."""


def is_memory(tm: dict[str, Any]) -> bool:
    return tm.get("avatar_shape") == "memory"


async def mate(owner_id: str) -> dict[str, Any] | None:
    return await db.one("teammates", {"owner_id": f"eq.{owner_id}", "avatar_shape": "eq.memory"})


async def ensure(owner_id: str) -> dict[str, Any]:
    """The memory teammate (its chat, dm:<id>, is made by the database with it)."""
    if have := await mate(owner_id):
        return have
    taken = {t["handle"] for t in await db.select("teammates", {"owner_id": f"eq.{owner_id}", "select": "handle"})}
    handle = next(h for h in ["memory", *(f"memory-{i}" for i in range(2, 99))] if h not in taken)
    return await db.insert("teammates", {
        "owner_id": owner_id, "name": "Memory", "handle": handle, "role": "Your memory",
        "bio": "What Tubelight remembers about you and your people. Tell it your story, ask what it knows, fix it.",
        "system_prompt": "(set in app/mind.py)", "model": config.DEFAULT_MODEL, "allowed_toolkits": [],
        "avatar_shape": "memory", "color": "#3f3f46",
    })


# ------------------------------------------------------------------ curiosity queue
def _entropy(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return -p * math.log2(p) - (1 - p) * math.log2(1 - p)


async def queue(owner_id: str, limit: int = 12) -> list[dict[str, Any]]:
    """Everything worth asking about, most useful first: {id, ask, score}. No model calls."""
    if not mem.ready():
        return []
    out: list[dict[str, Any]] = []
    for f in await mem._q("select f.id, f.text, f.salience, f.importance, e.name from mem_facts f join mem_entities e "
                          "on e.id = f.subject where f.owner = %s and f.status = 'tentative' order by f.learned_at desc "
                          "limit 30", owner_id):
        out.append({"id": f"t:{f['id']}", "fact": str(f["id"]), "score": _entropy(f["salience"] or 0.4) * (f["importance"] or 0.5),
                    "ask": f"You're not sure of this (fact {f['id']}): \"{f['text']}\". Is it right, and does it matter?"})
    for a in await mem._q(
            "select a.id as a, a.text as at, b.id as b, b.text as bt from mem_facts a join mem_facts b on b.subject = a.subject "
            "and a.id < b.id where a.owner = %s and a.status = 'current' and b.status = 'current' and a.kind = b.kind "
            "and a.kind in ('trait', 'relation') and 1 - (a.embedding <=> b.embedding) >= 0.85 limit 10", owner_id):
        if mem._new_words(a["at"], a["bt"]) and mem._new_words(a["bt"], a["at"]):  # same kind of fact, different details
            out.append({"id": f"c:{a['a']}:{a['b']}", "score": 0.9,
                        "ask": f"These two disagree: \"{a['at']}\" (fact {a['a']}) and \"{a['bt']}\" (fact {a['b']}). Which is right now?"})
    for f in await mem._q("select id, text, due from mem_facts where owner = %s and kind = 'commitment' and status = 'current' "
                          "and done is not true and due < %s order by due desc limit 5", owner_id, date.today()):
        out.append({"id": f"o:{f['id']}", "fact": str(f["id"]), "score": 0.8,
                    "ask": f"This was due {f['due']:%d %b} (fact {f['id']}): \"{f['text']}\". Did it happen?"})
    for e in await mem._q("select e.id, e.name from mem_entities e where e.owner = %s and e.kind = 'person' and "
                          "(select count(*) from mem_facts f where f.subject = e.id and f.status = 'current') <= 1 "
                          "order by e.touched_at desc limit 5", owner_id):
        out.append({"id": f"p:{e['id']}", "score": 0.5, "ask": f"You know almost nothing about {e['name']}. Who are they to them?"})
    me = await mem.user_entity(owner_id)
    known = (await mem._q("select count(*) as n from mem_facts where subject = %s and status = 'current'", me))[0]["n"]
    if known < 12:
        out.append({"id": "story", "score": 0.4,
                    "ask": "You know little about them yet. Invite their story: what they do, where they live, who "
                           "matters to them, what they're working towards (one of these at a time)."})
    return sorted(out, key=lambda q: -q["score"])[:limit]


def _ns(owner_id: str) -> tuple[str, ...]:
    return ("mem_questions", owner_id)


async def offer(owner_id: str) -> list[dict[str, Any]]:
    """The questions for this conversation: the same ones until it goes quiet for CONVERSATION, then the next best
    ones nobody was asked in REASK."""
    item = await memory.store.aget(_ns(owner_id), "state")
    state = item.value if item else {"offered": [], "at": 0, "history": {}}
    now = time.time()
    current = {q["id"]: q for q in await queue(owner_id)}
    if now - state["at"] < CONVERSATION:
        keep = [current[i] for i in state["offered"] if i in current]
        state["at"] = now
        await memory.store.aput(_ns(owner_id), "state", state, index=False)
        return keep
    picked = [q for q in current.values() if now - state["history"].get(q["id"], 0) > REASK][:PER_CONVERSATION]
    state = {"offered": [q["id"] for q in picked], "at": now,
             "history": {**{k: v for k, v in state["history"].items() if now - v < REASK}, **{q["id"]: now for q in picked}}}
    await memory.store.aput(_ns(owner_id), "state", state, index=False)
    return picked


async def notes(owner_id: str) -> str:
    """The memory agent's extra preamble: what it may ask now and how much is on record."""
    qs = await offer(owner_id)
    c = (await mem.overview(owner_id))["counts"]
    lines = [f"On record: {c['facts']} facts about {c['people']} people and things; {c['waiting']} moments still being read."]
    lines.append("You could ask (at most these, one at a time, at a natural pause):\n" + "\n".join(f"- {q['ask']}" for q in qs)
                 if qs else "Nothing to ask right now: just listen.")
    return "\n".join(lines)


# ------------------------------------------------------------------ tools
async def _label(owner_id: str, fact: dict[str, Any], label: str) -> None:
    """The user's own verdict on a fact: training data for the gate (evals/gate.py can fit on these)."""
    await memory.store.aput(("mem_labels", owner_id), str(fact["id"]), {
        "text": fact["text"], "gate": fact.get("gate"), "label": label, "at": datetime.now(UTC).isoformat()}, index=False)


async def _fact(owner_id: str, fid: str) -> dict[str, Any] | None:
    try:
        rows = await mem._q("select id, text, status, gate, subject from mem_facts where owner = %s and id = %s", owner_id, fid.strip())
    except Exception:  # not a uuid
        return None
    return rows[0] if rows else None


def build(owner_id: str) -> list[BaseTool]:
    async def memory_search(query: str) -> str:
        if not mem.ready():
            return "Memory isn't available right now."
        vec = mem._vec((await memory.embed([query[:500]]))[0])
        rows = await mem._q(
            "select * from (select f.id, f.text, f.status, f.kind, f.trust, f.valid_from, e.name, "
            "1 - (f.embedding <=> %s::vector) as cos, ts_rank(f.tsv, q) as tr, e.name ilike any(%s) as named "
            "from mem_facts f join mem_entities e on e.id = f.subject, plainto_tsquery('english', %s) q "
            "where f.owner = %s and f.status <> 'retracted') x where cos >= 0.55 or tr > 0 or named "
            "order by named desc, cos + least(1, tr * 10) desc limit 15",
            vec, [f"%{w}%" for w in query.split() if len(w) > 2] or ["\x00"], query[:500], owner_id)
        status = {"current": "", "tentative": " (not sure yet)", "closed": " (no longer true)", "faded": " (faded)"}
        return "\n".join(f"- [fact {r['id']}] {r['text']}{status.get(r['status'], '')}" for r in rows) or "Nothing on record about that."

    async def memory_why(fact_id: str) -> str:
        f = await _fact(owner_id, fact_id)
        if not f:
            return "No such fact."
        src = await mem._q("select s.quote, s.role, ep.source, ep.speaker, ep.occurred_at from mem_fact_sources s join mem_episodes ep "
                           "on ep.id = s.episode where s.fact = %s order by ep.occurred_at", f["id"])
        return f"\"{f['text']}\" ({f['status']}) because:\n" + "\n".join(
            f"- {s['occurred_at']:%d %b %Y}, {s['speaker']} ({s['source']}): \"{s['quote']}\"" + (" (marked it wrong)" if s["role"] == "wrong" else "")
            for s in src) if src else f"\"{f['text']}\": no source on record."

    async def memory_confirm(fact_id: str) -> str:
        f = await _fact(owner_id, fact_id)
        if not f:
            return "No such fact."
        await mem._q("update mem_facts set status = 'current', trust = 2, seen = seen + 1, confidence = 1 where id = %s "
                     "and status in ('tentative', 'faded', 'current')", f["id"])
        await _label(owner_id, f, "keep")
        return f"Confirmed: \"{f['text']}\"."

    async def memory_dismiss(fact_id: str) -> str:
        f = await _fact(owner_id, fact_id)
        if not f:
            return "No such fact."
        await mem._q("update mem_facts set status = 'faded' where id = %s and status in ('tentative', 'current')", f["id"])
        await _label(owner_id, f, "skip")
        return f"Let go of: \"{f['text']}\" (kept on record, not brought up)."

    async def memory_correct(fact_id: str, correction: str = "") -> str:
        f = await _fact(owner_id, fact_id)
        if not f or not await mem.correct(owner_id, str(f["id"]), correction):
            return "No such fact."
        await _label(owner_id, f, "wrong")
        return f"Marked wrong: \"{f['text']}\"" + (f"; now on record: \"{correction}\"." if correction.strip() else ".")

    async def memory_merge(keep: str, other: str) -> str:
        rows = await mem._q("select id, name, aliases from mem_entities where owner = %s and kind <> 'user' and "
                            "(lower(name) = any(%s) or exists (select 1 from unnest(aliases) a where lower(a) = any(%s)))",
                            owner_id, [keep.lower(), other.lower()], [keep.lower(), other.lower()])
        a = next((r for r in rows if r["name"].lower() == keep.lower()), None)
        b = next((r for r in rows if r["name"].lower() == other.lower() and r is not a), None)
        if not a or not b:
            return f"Couldn't find both: {', '.join(r['name'] for r in rows) or 'neither'} on record."
        await mem._q("update mem_facts set subject = %s where subject = %s", a["id"], b["id"])
        await mem._q("update mem_entity_ids set entity = %s where entity = %s", a["id"], b["id"])
        await mem._q("update mem_entities set aliases = array(select distinct x from unnest(aliases || %s::text[]) x where "
                     "lower(x) <> lower(name)), touched_at = now() where id = %s", [b["name"], *b["aliases"]], a["id"])
        await mem._q("delete from mem_entities where id = %s", b["id"])
        return f"Merged {b['name']} into {a['name']}."

    def tool(fn, description: str) -> BaseTool:
        return StructuredTool.from_function(coroutine=fn, name=fn.__name__, description=description)

    return [
        tool(memory_search, "Search everything on record (facts with their ids, including unsure, replaced and faded ones)."),
        tool(memory_why, "Where a fact came from: the exact words, who said them and when."),
        tool(memory_confirm, "The user says an unsure (or faded) fact is right: it becomes a sure one."),
        tool(memory_dismiss, "The user says a fact doesn't matter or to forget it: it stops being brought up (stays on record)."),
        tool(memory_correct, "The user says a fact is wrong; give the corrected sentence if they said what's right."),
        tool(memory_merge, "Two entries are the same person or thing: merge `other` into `keep` (their names as on record)."),
    ]
