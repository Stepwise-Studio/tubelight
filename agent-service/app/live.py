"""Live voice (Gemini Live): the phone talks to Gemini directly over a WebSocket, with a short-lived token minted here.

The token locks the whole session setup (model, the teammate's voice persona, tools), so the app never holds the API
key and can't change what the session is. Anything that needs the user's apps goes through one tool, run_task, which
the app turns into a normal chat message to the teammate (apps, approvals, memory all apply) and whose reply comes
back as the tool result for Gemini to speak.
"""
import datetime
import hashlib
from typing import Any

import httpx

from . import brief, config, connectors, db, graph, memory

VOICES = ["Puck", "Kore", "Charon", "Aoede", "Fenrir", "Leda", "Orus", "Zephyr"]

SPEAKING = """## How you talk (this is a live voice call)
- Talk like a person on a phone call: warm, relaxed, natural. One to three short sentences, then stop and let them talk.
- Never read out lists, markdown, links, IDs, email addresses letter by letter, or long numbers. Summarise instead.
- Ask one question at a time. If they interrupt you, stop and listen.
- For anything that needs their apps or doing something (email, calendar, meetings, Teams, messages, files, looking
  things up, drafting, scheduling, sending), call run_task with one complete, specific request, and first say a few
  words like "Let me check" or "On it". Never invent results.
- When a result comes back, say the gist in a sentence or two. If there's more, say the details are in the chat.
- Sending, posting or scheduling always waits for their approval in the chat. When a result says approval is
  needed, tell them it's ready for them to approve in the chat.
- Small talk, advice and quick questions you can answer yourself: just answer, no tool.
- Some answers are better read than heard: code, tables, long lists, drafts to copy, anything with many numbers or
  steps. Don't read those out. Say in one short sentence that it's better as text, then call switch_to_text with the
  full request. If they'd rather stay in voice, give a short spoken version and offer the full one in the chat."""

RUN_TASK = {"functionDeclarations": [{
    "name": "switch_to_text",
    "description": "Offer to continue in text when the answer is better read than heard (code, tables, long lists, "
                   "drafts to copy). The app shows a Switch to text button; if they take it, the teammate writes the "
                   "full answer in the chat.",
    "parameters": {"type": "OBJECT", "properties": {
        "request": {"type": "STRING", "description": "The full request to answer in text"},
        "reason": {"type": "STRING", "description": "A few words, e.g. 'It's code you'll want to copy'"}},
        "required": ["request"]},
}, {
    "name": "run_task",
    "behavior": "NON_BLOCKING",
    "description": "Have the teammate do something with the user's apps and tools (email, calendar, Teams, Notion, "
                   "GitHub, files, the web...), or look something up. Pass one complete request in plain words, with "
                   "names, dates and times spelled out.",
    "parameters": {"type": "OBJECT", "properties": {"request": {"type": "STRING", "description": "The full task"}},
                   "required": ["request"]},
}]}


def voice_for(tm: dict) -> str:
    return VOICES[int(hashlib.md5(tm["id"].encode()).hexdigest(), 16) % len(VOICES)]


async def instruction(ctx: "graph.RunCtx", tm: dict, thread_id: str) -> str:
    now = graph.local_now(ctx)
    shelf = memory.ns("user", ctx.owner_id)
    prefs = await memory.listing(shelf, limit=12, kind="preference")
    owed = await memory.listing(shelf, limit=10, kind="commitment", done=False)
    facts = [r for r in await memory.listing(shelf, limit=15) if r["kind"] in ("person", "fact")]
    apps = ", ".join(connectors.name_of(t) for t in tm.get("allowed_toolkits") or []) or "none yet"
    recent = await db.select("messages", {"thread_id": f"eq.{thread_id}", "kind": "eq.text", "order": "created_at.desc",
                                          "limit": "12", "select": "sender_type,text"})
    lines = [
        f"You are {tm['name']}, {ctx.user_name}'s {tm['role']} teammate in the Tubelight app, talking with them by voice. "
        f"It is {now:%A, %B %d, %I:%M %p} where they are. Say times in their local time.",
        f"Apps you can use through run_task: {apps}.",
        "## Your role\n" + (tm.get("system_prompt") or "")[:2500],
    ]
    if prefs:
        lines.append("How they like things:\n" + "\n".join(f"- {r['text']}" for r in prefs))
    if owed:
        lines.append("Open to-dos:\n" + "\n".join(f"- {r['text']}" for r in owed))
    if facts:
        lines.append("What you know:\n" + "\n".join(f"- {r['text']}" for r in facts))
    summary = await brief.get(thread_id)
    if summary:
        lines.append("A brief of this chat so far (background only):\n" + summary)
    if recent:
        convo = "\n".join(f"{'Them' if m['sender_type'] == 'user' else 'You'}: {m['text'][:400]}" for m in reversed(recent))
        lines.append("The chat so far, as background only (most recent last). Don't pick up earlier requests on your own "
                     "or speak first: wait for them to say what they want now.\n" + convo)
    lines.append(SPEAKING)
    return "\n\n".join(lines)


def setup(tm: dict, system: str) -> dict[str, Any]:
    return {
        "model": f"models/{config.LIVE_MODEL}",
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice_for(tm)}}},
        },
        "systemInstruction": {"parts": [{"text": system}]},
        "tools": [RUN_TASK],
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
        # Server-side turn taking: a short pause ends the turn, and talking over the model interrupts it.
        "realtimeInputConfig": {
            "automaticActivityDetection": {"endOfSpeechSensitivity": "END_SENSITIVITY_HIGH", "silenceDurationMs": 600},
            "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
        },
        "contextWindowCompression": {"slidingWindow": {}},
    }


def dictation_setup() -> dict[str, Any]:
    """Speech to text only (the long-press on the mic): no persona, no replies, just the transcript."""
    return {"model": f"models/{config.DICTATE_MODEL}", "inputAudioTranscription": {}}


async def mint(session_setup: dict) -> str:
    """A single-use token: 1 minute to connect, 30 minutes of talking, the setup locked in."""
    now = datetime.datetime.now(datetime.UTC)
    iso = lambda d: d.isoformat().replace("+00:00", "Z")  # noqa: E731
    body = {"uses": 1, "expireTime": iso(now + datetime.timedelta(minutes=30)),
            "newSessionExpireTime": iso(now + datetime.timedelta(minutes=1)), "bidiGenerateContentSetup": session_setup}
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post("https://generativelanguage.googleapis.com/v1beta/auth_tokens",
                         headers={"x-goog-api-key": config.env("GEMINI_API_KEY")}, json=body)
    r.raise_for_status()
    return r.json()["name"]
