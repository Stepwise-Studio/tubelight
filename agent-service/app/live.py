"""Live voice (Gemini Live): the phone talks to Gemini directly over a WebSocket, with a short-lived token minted here.

The token locks the whole session setup (model, the teammate's voice persona, tools), so the app never holds the API
key and can't change what the session is. Anything that needs the user's apps goes through one tool, run_task, which
the app turns into a normal chat message to the teammate (apps, approvals, memory all apply) and whose reply comes
back as the tool result for Gemini to speak.
"""
import datetime
from typing import Any

import httpx

from . import brief, config, connectors, db, graph, mem, memory, mind

VOICE = "Despina"  # every voice mode speaks with her (the user's pick, 2026-10-27: smooth and natural)
# Every prebuilt Live voice a computer's hotkey may ask for instead (runner config "voice").
ALL_VOICES = {"Puck", "Kore", "Charon", "Aoede", "Fenrir", "Leda", "Orus", "Zephyr", "Sulafat", "Despina", "Achernar", "Vindemiatrix", "Callirrhoe", "Autonoe", "Erinome", "Laomedeia",
              "Pulcherrima", "Gacrux", "Algieba", "Schedar", "Umbriel", "Iapetus", "Enceladus", "Rasalgethi", "Achird",
              "Zubenelgenubi", "Sadachbia", "Sadaltager", "Alnilam", "Algenib"}

SPEAKING = """## How you talk (this is a live voice call)
- Talk like a person on a phone call: warm, relaxed, natural. One to three short sentences, then stop and let them talk.
- Never read out lists, markdown, links, IDs, email addresses letter by letter, or long numbers. Summarise instead.
- Ask one question at a time. If they interrupt you, stop and listen.
- For anything that needs their apps or doing something (email, calendar, meetings, Teams, messages, files, looking
  things up, drafting, scheduling, sending), call run_task with one complete, specific request, and first say a few
  words like "Let me check" or "On it". Never invent results.
- Only run_task acts or looks things up. Never say you checked, opened, set or sent anything unless run_task returned
  that in this call. The chat so far shows what was done back then, not now: asked again, run it again.
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


# The hotkey on their computer (runner/tubelight_voice.py): these run on the computer itself, at once, with no trip
# through the server; everything else goes to the computer's own chat through run_task.
_S = {"type": "STRING"}
DESKTOP_TOOLS = {"functionDeclarations": [
    {"name": "list_windows", "description": "The computer's monitors (which is the laptop's own screen) and open windows.",
     "parameters": {"type": "OBJECT", "properties": {}}},
    {"name": "place_window", "description": "Move or resize a window at once. window: an app name or part of its title. "
     "monitor: laptop, external, other, left, right, primary, a number from 1 or a monitor's name. where: left, right, "
     "top, bottom (halves), top-left, top-right, bottom-left, bottom-right, left-third, center-third, right-third, "
     "left-two-thirds, right-two-thirds, center, full. size: 1280x800, 60% or 70%x80%. state: maximize, restore, "
     "minimize, fullscreen, unfullscreen. focus: true to bring it to the front.",
     "parameters": {"type": "OBJECT", "properties": {"window": _S, "monitor": _S, "where": _S, "size": _S, "state": _S,
                                                     "focus": {"type": "BOOLEAN"}}, "required": ["window"]}},
    {"name": "open_app", "description": "Open an app by name (Firefox, Files, Spotify, Settings...), or bring it up if it's open.",
     "parameters": {"type": "OBJECT", "properties": {"app": _S}, "required": ["app"]}},
    {"name": "close_app", "description": "Close an app the way its close button would (unsaved work prompts as usual).",
     "parameters": {"type": "OBJECT", "properties": {"app": _S}, "required": ["app"]}},
    {"name": "press_keys", "description": "Press keys in an app (its window gets the keyboard): chords like ctrl+l, "
     "ctrl+t, enter, page_down, page_up, space, or text:words to type.",
     "parameters": {"type": "OBJECT", "properties": {"keys": {"type": "ARRAY", "items": _S}, "app": _S}, "required": ["keys", "app"]}},
    {"name": "look_at_app", "description": "Read an app's window: every button, field, link, item and text on screen, each "
     "with an id like e12 and what can be done to it. app: its name (Zen, Files, Settings...). window: part of a title.",
     "parameters": {"type": "OBJECT", "properties": {"app": _S, "window": _S}, "required": ["app"]}},
    {"name": "act_in_app", "description": "Do one thing to one element from look_at_app (or the last act_in_app): action "
     "CLICK, DOUBLE_CLICK (open an item), RIGHT_CLICK, TYPE (value: the field's new text), FOCUS, READ, SCROLL_TO. Answers "
     "with the screen after; if the app changed first, nothing happens and you get the new screen. confirmed: only after "
     "they said yes out loud to a button that deletes, sends or pays.",
     "parameters": {"type": "OBJECT", "properties": {"snapshot": _S, "element": _S, "action": _S, "value": _S,
                                                     "confirmed": {"type": "BOOLEAN"}}, "required": ["snapshot", "element", "action"]}},
]}

DESKTOP = """## On their computer (they pressed the hotkey)
- They're at the computer and want it done now. Window and app commands (move, resize, maximize, minimize, put on a
  monitor, open, close, keys): call the tool straight away, no confirming, and say at most a few words after
  ("Done.", "On your laptop screen."). Several windows: one call each, back to back.
- When you're unsure which window they mean, call list_windows first rather than asking.
- Inside an app (go to a website, search, type in a box, click, select, read what's on screen): look_at_app, then
  act_in_app on its ids, one step at a time, checking each answer. A website: press_keys ["ctrl+l", "text:<address>",
  "enter"] in the browser. A search box: TYPE into it, then press_keys ["enter"]. Scrolling: press_keys ["page_down"]
  (or page_up) with the app. It's done only when the screen you got back shows it: never say it worked otherwise.
- While you work through steps, say nothing between them (no "continuing", no "still working"): one short line when
  it's done, or what stopped you.
- Buttons that delete, send, post or pay: ask them out loud first and press only after a clear yes (confirmed).
- Anything else that needs their apps, files, mail or the crew: run_task, as usual. Its answer also lands in the chat
  with you on their phone.
- They can see a small card with what's said and the full answers, but no chat: never say "in the chat below".
- Sound like a warm, relaxed person sitting next to them: natural pace, short sentences, no announcer voice."""


async def instruction(ctx: "graph.RunCtx", tm: dict, thread_id: str) -> str:
    now = graph.local_now(ctx)
    shelf = memory.ns("user", ctx.owner_id)
    prefs, owed, facts, known = [], [], [], ""
    if mem.ready():
        known = await mem.recall(ctx.owner_id, "", brief=True)
    else:
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
        "## Your role\n" + (mind.PROMPT.format(owner=ctx.user_name) if mind.is_memory(tm) else (tm.get("system_prompt") or "")[:2500]),
    ]
    if mind.is_memory(tm):  # by voice too: what it learned, what it's still reading, and what it may ask
        lines.append(await mind.notes(ctx.owner_id))
    if known:
        lines.append("What you know (memory; anything marked no longer true isn't current):\n" + known)
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


def setup(tm: dict, system: str, desktop: bool = False, voice: str = "") -> dict[str, Any]:
    return {
        "model": f"models/{config.LIVE_MODEL}",
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice if voice in ALL_VOICES else VOICE}}},
        },
        "systemInstruction": {"parts": [{"text": system}]},
        "tools": [_desktop_tools()] if desktop else [RUN_TASK],
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
        # Server-side turn taking: a short pause ends the turn, and talking over the model interrupts it.
        "realtimeInputConfig": {
            "automaticActivityDetection": {"endOfSpeechSensitivity": "END_SENSITIVITY_HIGH", "silenceDurationMs": 600},
            "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
        },
        "contextWindowCompression": {"slidingWindow": {}},
    }


def _desktop_tools() -> dict:
    """The local tools plus run_task (switch_to_text needs the app's chat, which the hotkey doesn't have)."""
    run_task = next(f for f in RUN_TASK["functionDeclarations"] if f["name"] == "run_task")
    return {"functionDeclarations": [*DESKTOP_TOOLS["functionDeclarations"], run_task]}


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
