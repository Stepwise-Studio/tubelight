"""The call stand-in: when someone calls and the user taps "let my assistant answer", the phone answers and Gemini Live
talks to the caller as the user's assistant (never as the user), with what Tubelight knows about that person.

- context(): who they are to the user (memory: person facts, commitments, anything `about` them), to-dos and pending
  follow-ups that mention them, and recent chat lines about them with the chats' briefs.
- start(): the call's record and a single-use Live token whose persona carries that context. Two tools, run by the phone
  through this server: check_progress (answers from the teammates' own state: the chats' briefs, to-dos, follow-ups)
  and take_message.
- end(): one model call turns the transcript into a summary, what they asked for and whether the user needs to act;
  the summary goes into memory about them, asks become to-dos, and the phone's chat gets the note (with a push).
Calls live in the store ("calls", owner).
"""
import json
import logging
import re
import time
import uuid
from datetime import datetime
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from . import brief, config, db, followups, live, llm, mem, memory, phone, push, todos

log = logging.getLogger(__name__)


def _ns(owner_id: str) -> tuple[str, ...]:
    return ("calls", owner_id)


def _mentions(text: str, name: str) -> bool:
    words = [w for w in re.split(r"\W+", name.lower()) if len(w) > 2]
    t = (text or "").lower()
    return bool(words) and any(w in t for w in words[:2])


async def context(owner_id: str, name: str, number: str = "") -> str:
    """What Tubelight knows that involves this person, as notes for the stand-in."""
    lines: list[str] = []
    about = []
    if mem.ready():
        if known := await mem.about_caller(owner_id, name, number):
            lines.append("What you know about them (memory; anything marked no longer true isn't current):\n" + known)
    else:
        shelf = memory.ns("user", owner_id)
        rows = await memory.listing(shelf, limit=300)
        about = [r for r in rows if any(_mentions(a, name) for a in r.get("about") or []) or _mentions(r["text"], name)]
        seen = {r["text"] for r in about}
        about += [r for r in await memory.search_rows(shelf, name, limit=4) if r["text"] not in seen and _mentions(r["text"], name)]
    if about:
        lines.append("What you know about them:\n" + "\n".join(
            f"- {r['text']}" + (f" (due {r['due']})" if r.get("due") else "") + (" (done)" if r.get("done") else "") for r in about[:15]))
    open_todos = [t for t in await todos.listing(owner_id)
                  if t["status"] not in ("done", "canceled") and _mentions(f"{t['title']} {t.get('notes', '')}", name)]
    if open_todos:
        lines.append("Open to-dos that involve them:\n" + "\n".join(
            f"- {t['title']} [{t['status']}]" + (f", due {t['due']}" if t.get("due") else "") for t in open_todos[:10]))
    pend = [f for f in await followups.pending(owner_id) if _mentions(f.get("what", ""), name)]
    if pend:
        lines.append("Follow-ups the teammates have that involve them:\n" + "\n".join(f"- {f['what']}" for f in pend[:8]))
    first = re.split(r"\W+", name.strip())[0] if name.strip() else ""
    if len(first) > 2:
        msgs = await db.select("messages", {"owner_id": f"eq.{owner_id}", "text": f"ilike.*{first}*", "kind": "eq.text",
                                            "order": "created_at.desc", "limit": "12", "select": "thread_id,text,created_at"})
        if msgs:
            lines.append("Recent chat lines that mention them (newest first):\n" + "\n".join(
                f"- {m['created_at'][:10]}: {m['text'][:200]}" for m in msgs))
            for t in list(dict.fromkeys(m["thread_id"] for m in msgs))[:3]:
                if b := await brief.get(t):
                    lines.append(f"Brief of a chat where they come up:\n{b[:800]}")
    return "\n\n".join(lines) or "Nothing on record about them yet."


PERSONA = """You are {user}'s assistant, answering a phone call from {caller} because {user} can't take it right now.
It's {now} where {user} is.

How to talk: it's a phone call. Start with a short hello that says who you are ("Hi {caller_first}, this is {user}'s
assistant, {user} can't pick up right now. How can I help?"). Warm, brief, natural: one or two sentences, then let
them talk. Never pretend to be {user}. Speak the caller's language if they switch.

What you can do:
- If they ask about something they asked {user} for, or how something's going, call check_progress with their
  question and tell them what it says, plainly. Don't guess.
- If you can't help, or they want {user} personally, take a clear message (take_message: what they want, by when,
  how urgent) and say {user} will get back to them.
- Never commit {user} to anything new (meetings, money, deadlines): take it as a message instead.
- Never share anything private about {user} or other people beyond what's about this caller and their matter.
- When they're done, say goodbye briefly.

{context}"""

TOOLS = {"functionDeclarations": [{
    "name": "check_progress",
    "description": "Look up how something the caller asked about is going, from the user's to-dos, follow-ups and "
                   "their teammates' chats. Pass the caller's question in full.",
    "parameters": {"type": "OBJECT", "properties": {"question": {"type": "STRING"}}, "required": ["question"]},
}, {
    "name": "take_message",
    "description": "Take a message for the user: what the caller wants, any deadline, how urgent.",
    "parameters": {"type": "OBJECT", "properties": {
        "message": {"type": "STRING"}, "urgent": {"type": "BOOLEAN"}}, "required": ["message"]},
}]}


async def start(owner_id: str, user_name: str, zone, caller: str, number: str = "") -> dict[str, Any]:
    ctx = await context(owner_id, caller, number)
    now = datetime.now(zone)
    system = PERSONA.format(user=user_name, caller=caller or "the caller", caller_first=(caller or "there").split()[0],
                            now=f"{now:%A %d %B, %I:%M %p}", context=ctx)
    mate = await phone.mate(owner_id) or {"id": owner_id}
    setup = live.setup(mate, system)
    setup["tools"] = [TOOLS]
    token = await live.mint(setup)
    call_id = str(uuid.uuid4())
    await memory.store.aput(_ns(owner_id), call_id, {"caller": caller, "number": number, "started": time.time(),
                                                     "messages": [], "context": ctx[:4000]}, index=False)
    return {"call_id": call_id, "token": token, "model": config.LIVE_MODEL}


async def _call(owner_id: str, call_id: str) -> dict[str, Any] | None:
    item = await memory.store.aget(_ns(owner_id), call_id)
    return item.value if item else None


async def ask(owner_id: str, call_id: str, question: str) -> str:
    """check_progress: answered from what's on record (to-dos, follow-ups, the teammates' chat briefs), never guessed."""
    call = await _call(owner_id, call_id)
    if not call:
        return "No record of this call."
    model = llm.chat_model(config.DEFAULT_MODEL)
    res = await model.ainvoke([
        SystemMessage("You answer a caller's question about progress for the user's assistant, from the notes below only. "
                      "One or two plain sentences the assistant can say aloud. If the notes don't say, answer exactly: "
                      "NOT_ON_RECORD. Never share anything unrelated to the caller and their matter."),
        HumanMessage(f"Caller: {call['caller']}\nQuestion: {question}\n\nNotes:\n{call['context']}"),
    ])
    text = res.text.strip()
    if not text or "NOT_ON_RECORD" in text:
        return "Nothing on record about that: take it as a message and say the user will get back to them."
    return text


async def message(owner_id: str, call_id: str, text: str, urgent: bool) -> str:
    call = await _call(owner_id, call_id)
    if call:
        call["messages"].append({"text": text[:1000], "urgent": bool(urgent)})
        await memory.store.aput(_ns(owner_id), call_id, call, index=False)
    return "Noted. Tell them the user will get back to them."


SUMMARY = """A phone call the user's assistant took for them. Write JSON only:
{"summary": "two or three sentences: who called, what about, what the assistant told them",
 "asks": ["each thing the caller wants the user to do, as a to-do title"],
 "attention": "what the user should know or do now, in one sentence, or empty",
 "facts": ["anything new and lasting about the caller worth remembering"]}"""


async def end(owner_id: str, call_id: str, turns: list[dict[str, str]]) -> dict[str, Any]:
    call = await _call(owner_id, call_id)
    if not call:
        return {"ok": False}
    caller = call["caller"] or "Someone"
    said = "\n".join(f"{'Caller' if t.get('role') == 'user' else 'Assistant'}: {t.get('text', '')}" for t in turns if t.get("text"))[:12000]
    plan: dict[str, Any] = {}
    if said.strip():
        model = llm.chat_model(config.KEEPER_MODEL, json=True)
        res = await model.ainvoke([SystemMessage(SUMMARY), HumanMessage(
            f"Caller: {caller}\nMessages taken: {json.dumps(call['messages'])}\n\nTranscript:\n{said}")])
        try:
            plan = json.loads(re.search(r"\{.*\}", res.text, re.S).group(0))
        except (AttributeError, ValueError):
            plan = {"summary": said[:400]}
    summary = str(plan.get("summary") or f"{caller} called; nothing was said.")
    day = datetime.now().strftime("%d %b")
    if mem.ready():  # the caller's own words are the evidence; memory extracts from them like any conversation
        who = f"caller {caller}" + (f" ({call['number']})" if call.get("number") else "")
        for t in turns:
            if t.get("text"):
                await mem.log_episode(owner_id, "call", t["text"], trust=0 if t.get("role") == "user" else 1, ref=call_id,
                                      speaker=who if t.get("role") == "user" else "assistant")
    else:
        shelf = memory.ns("user", owner_id)
        await memory.add(shelf, f"{day}: {summary}"[:500], kind="person", about=[caller[:60]])
        for f in (plan.get("facts") or [])[:3]:
            await memory.add(shelf, str(f)[:500], kind="person", about=[caller[:60]])
    made = []
    for a in (plan.get("asks") or [])[:5]:
        t = await todos.add(owner_id, f"{a}"[:200], notes=f"From {caller}'s call ({day})", added_by="call")
        made.append(t["title"])
    attention = str(plan.get("attention") or "")
    urgent = any(m.get("urgent") for m in call["messages"])
    text = f"📞 {caller} called. {summary}" + (f"\nNeeds you: {attention}" if attention else "") \
        + (f"\nAdded to your to-dos: {'; '.join(made)}" if made else "")
    mate = await phone.mate(owner_id)
    if mate:
        await db.insert("messages", {"thread_id": f"dm:{mate['id']}", "owner_id": owner_id, "sender_type": "teammate",
                                     "teammate_id": mate["id"], "text": text, "kind": "text", "meta": {"call": call_id}})
        await push.notify(owner_id, f"{caller} called" + (" (urgent)" if urgent else ""), attention or summary,
                          f"dm:{mate['id']}", teammate=mate)
    call |= {"ended": time.time(), "summary": summary, "turns": turns[:200]}
    await memory.store.aput(_ns(owner_id), call_id, call, index=False)
    return {"ok": True, "summary": summary, "todos": made, "attention": attention}
