import asyncio
import time
import faulthandler
import logging
import re
import signal
import sys
import uuid
import zoneinfo
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import httpx
import yaml
from croniter import croniter
from fastapi import Depends, FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from . import automations, computers, config, connectors, db, events, files, followups, images, live, llm, memory, phone, push, reactions, repo, runs, sandbox, todos, usage, vault
from .auth import current_user

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)  # request URLs can carry webhook tokens
log = logging.getLogger("tubelight")
TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "teammates"
User = dict[str, Any]


async def _warm_catalog() -> None:
    if connectors.enabled():
        try:
            await connectors.catalog()
        except Exception as e:
            log.warning("app catalog warm-up failed: %s", e)


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        await memory.init()
    except Exception as e:
        log.error("Postgres memory unavailable (%s); using in-memory checkpointer and store", e)
        await memory.close()
        memory.config.SUPABASE_DB_URL = ""
        await memory.init()
    try:  # times are wrong for everyone without a zone database (slim images): say so loudly
        zoneinfo.ZoneInfo("Asia/Kolkata")
    except zoneinfo.ZoneInfoNotFoundError:
        log.error("No time zone database: every user's time would be UTC. Install the tzdata package.")
    runs.docker_ok = await asyncio.to_thread(sandbox.available)
    await runs.sweep_orphans()
    asyncio.get_running_loop().add_signal_handler(signal.SIGUSR1, _dump_stacks)
    scheduler = asyncio.create_task(events.schedule_loop())
    warm = asyncio.create_task(_warm_catalog())  # the first Connections visit shouldn't wait on Composio
    faces = asyncio.create_task(push.prewarm_faces())  # notification faces ready before they're needed
    yield
    warm.cancel()
    faces.cancel()
    scheduler.cancel()
    for t in list(runs.tasks.values()):
        t.cancel()
    await usage.flush()
    await memory.close()


def _dump_stacks() -> None:
    """`kill -USR1 <pid>` prints every asyncio task and thread stack to stderr, for diagnosing hangs."""
    for task in asyncio.all_tasks():
        task.print_stack(limit=40, file=sys.stderr)
    faulthandler.dump_traceback(all_threads=True)


app = FastAPI(title="Tubelight agent service", lifespan=lifespan)
# The home server's uplink is slow: compress anything sizeable (the app catalog shrinks ~5x).
# Media is already compressed (and video needs plain byte ranges): vault files pass through as they are.
app.add_middleware(GZipMiddleware, minimum_size=1024, exclude_content_types=(
    *DEFAULT_EXCLUDED_CONTENT_TYPES, "video/*", "application/pdf", "image/heic", "image/heif"))
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(db.DBError)
async def db_error(_, e: db.DBError):
    log.warning("%s", e)
    return JSONResponse({"detail": "The database request failed. Try again in a moment."}, status_code=502)


# ------------------------------------------------------------------ helpers
async def owned(table: str, id: str, user: User, what: str) -> dict[str, Any]:
    row = await db.one(table, {"id": f"eq.{id}", "owner_id": f"eq.{user['id']}"})
    if not row:
        raise HTTPException(404, f"That {what} was not found.")
    return row


# ------------------------------------------------------------------ meta
@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True, "llm": any(llm.key(p) for p in llm.PROVIDERS), "db": memory.db_ok, "docker": runs.docker_ok,
            "composio": connectors.enabled(), "push": True}


@app.get("/models")
async def models() -> list[dict[str, Any]]:
    try:
        return await llm.free_tool_models()
    except httpx.HTTPError:
        raise HTTPException(502, "Could not load the model list from the model providers. Try again in a moment.")


def _load_templates() -> list[dict[str, Any]]:
    out = []
    for f in sorted(TEMPLATES_DIR.glob("*.md")):
        _, front, body = f.read_text().split("---", 2)
        out.append({**yaml.safe_load(front), "system_prompt": body.strip()})
    return out


TEMPLATES = _load_templates()


@app.get("/templates")
async def templates() -> list[dict[str, Any]]:
    return TEMPLATES


# ------------------------------------------------------------------ messages + runs
class MessageIn(BaseModel):
    text: str
    mentions: list[str] = []
    reply_to: str | None = None
    attachments: list[dict[str, Any]] = []
    apps: list[str] = []  # toolkits the user @mentioned: the answering teammate gets them for this request
    voice_task: bool = False  # sent by live voice mode (run_task): hidden in the chat, where the spoken words show instead


async def _quoted(thread_id: str, reply_to: str | None) -> str:
    """What the teammate sees when the user swipes to reply: the quoted message ahead of the text."""
    if not reply_to:
        return ""
    q = await db.one("messages", {"id": f"eq.{reply_to}", "thread_id": f"eq.{thread_id}"})
    if not q:
        return ""
    who = "their own earlier message" if q["sender_type"] == "user" else "a teammate's message"
    if q.get("teammate_id"):
        tm = await db.one("teammates", {"id": f"eq.{q['teammate_id']}"})
        who = f"{tm['name']}'s message" if tm else who
    snippet = " ".join(q["text"].split())[:400]
    return f'[Replying to {who}: "{snippet}"]\n'


async def _mentioned_apps(owner_id: str, asked: list[str]) -> list[str]:
    """Catalog slugs of the @mentioned apps the user has connected (or that need no sign-in); others are dropped."""
    if not asked:
        return []
    slugs = [s for s in [await connectors.resolve(a) for a in asked[:10]] if s]
    ready = await connectors.ready(owner_id) if slugs else set()
    return [s for s in dict.fromkeys(slugs) if s in ready]


@app.get("/threads/{thread_id}/followups")
async def thread_followups(thread_id: str, user: User = Depends(current_user)):
    """A chat's follow-ups: pending (soonest first) and finished (latest first, with how they ended)."""
    await owned("threads", thread_id, user, "conversation")
    keep = ("id", "what", "owner", "at", "until", "check_by", "poll_hours", "set_by", "set_at", "created", "status", "closed")
    return {"pending": [{k: f.get(k) for k in keep} for f in await followups.pending(user["id"], thread_id)],
            "done": [{k: f.get(k) for k in keep} for f in await followups.history(user["id"], thread_id)]}


class ReactIn(BaseModel):
    emoji: str


@app.post("/messages/{message_id}/react")
async def react(message_id: str, body: ReactIn, user: User = Depends(current_user)):
    """The user's reaction on a message; the same emoji again removes it."""
    m = await db.one("messages", {"id": f"eq.{message_id}", "owner_id": f"eq.{user['id']}", "select": "id"})
    if not m:
        raise HTTPException(404, "That message is gone.")
    got = await reactions.react(message_id, "user", body.emoji, toggle=True)
    if got is None:
        raise HTTPException(400, "Pick one of the reactions.")
    return {"reactions": got}


@app.delete("/followups/{followup_id}")
async def cancel_followup(followup_id: str, user: User = Depends(current_user)):
    if not await followups.cancel(followup_id, user["id"]):
        raise HTTPException(404, "That follow-up is already gone.")
    return {"ok": True}


@app.post("/threads/{thread_id}/messages")
async def post_message(thread_id: str, body: MessageIn, user: User = Depends(current_user)):
    if not body.text.strip() and not body.attachments:
        raise HTTPException(400, "Write a message first.")
    thread = await owned("threads", thread_id, user, "conversation")
    meta = {"attachments": body.attachments} if body.attachments else {}
    apps = await _mentioned_apps(user["id"], body.apps)
    if apps:
        meta["apps"] = apps
    if body.voice_task:
        meta["voice_task"] = True
    message = await db.insert("messages", {"thread_id": thread_id, "owner_id": user["id"], "sender_type": "user",
                                           "text": body.text, "mentions": body.mentions, "reply_to": body.reply_to,
                                           "meta": meta})
    prompt = await _quoted(thread_id, body.reply_to) + body.text + await files.describe(user["id"], body.attachments)
    run_id = await runs.start(user["id"], thread_id, prompt, mentions=body.mentions, apps=apps,
                              teammate_id=thread.get("teammate_id"), message_id=message["id"])
    await db.update("messages", {"id": f"eq.{message['id']}"}, {"run_id": run_id})
    return {"message": {**message, "run_id": run_id}, "run_id": run_id}


@app.post("/messages/{message_id}/retry")
async def retry_message(message_id: str, user: User = Depends(current_user)):
    """Run the user's message again, in place: no second copy of it; the failed attempt's error notes go."""
    m = await owned("messages", message_id, user, "message")
    if m["sender_type"] != "user":
        raise HTTPException(400, "Only your own messages can be retried.")
    thread = await owned("threads", m["thread_id"], user, "conversation")
    if await db.one("runs", {"thread_id": f"eq.{m['thread_id']}", "status": "eq.running"}):
        raise HTTPException(409, "Already on it: wait for this reply to finish.")
    await db.delete("messages", {"thread_id": f"eq.{m['thread_id']}", "kind": "eq.error", "created_at": f"gt.{m['created_at']}"})
    attachments = (m.get("meta") or {}).get("attachments") or []
    prompt = await _quoted(m["thread_id"], m.get("reply_to")) + m["text"] + await files.describe(user["id"], attachments)
    run_id = await runs.start(user["id"], m["thread_id"], prompt, mentions=m.get("mentions") or [],
                              apps=(m.get("meta") or {}).get("apps") or [],
                              teammate_id=thread.get("teammate_id"), message_id=message_id)
    await db.update("messages", {"id": f"eq.{message_id}"}, {"run_id": run_id})
    return {"run_id": run_id}


@app.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, user: User = Depends(current_user)):
    await runs.cancel(await owned("runs", run_id, user, "run"))
    return {"ok": True}


class Decision(BaseModel):
    # approve/reject: approvals. answer/skip: questions. connected/skip: connect cards.
    action: Literal["approve", "reject", "answer", "connected", "skip"]
    args: dict[str, Any] | None = None
    note: str | None = None
    answer: str | None = None
    # An admin command's password (computers.py): handed to the computer once, never stored, logged or shown to a model.
    secret: str | None = Field(None, max_length=256, repr=False)


@app.post("/approvals/{approval_id}")
async def decide(approval_id: str, body: Decision, user: User = Depends(current_user)):
    approval = await owned("approvals", approval_id, user, "approval")
    if approval["status"] != "pending":
        raise HTTPException(409, f"This approval was already {approval['status']}.")
    run = await db.one("runs", {"id": f"eq.{approval['run_id']}"}) if approval.get("run_id") else None
    if not run or run["status"] not in ("waiting_approval", "running"):  # running: another decision is resuming it
        await db.update("approvals", {"id": f"eq.{approval_id}"}, {"status": "expired"})
        raise HTTPException(409, "This request is no longer active, so nothing was done.")
    kind = approval.get("kind", "approval")
    allowed = {"approval": {"approve", "reject"}, "question": {"answer", "skip"}, "connect": {"connected", "skip"}}[kind]
    if body.action not in allowed:
        raise HTTPException(400, "That response doesn't fit this request.")
    if body.action == "answer" and not (body.answer or "").strip():
        raise HTTPException(400, "Pick an option or write an answer.")
    if body.action == "connected":
        toolkit = approval["draft"].get("toolkit", "")
        if toolkit not in await connectors.ready(user["id"]):
            raise HTTPException(409, f"{approval['draft'].get('name', toolkit)} isn't connected yet. Finish signing in, then try again.")
    if body.action == "approve" and approval["tool_name"] == "computer_run" and (approval.get("draft") or {}).get("sudo"):
        if not body.secret:
            raise HTTPException(400, "This command needs your computer's password. Type it on the card, then approve.")
        computers.stash_password(user["id"], (body.args or approval["draft"]).get("cmd", ""), body.secret)
    status = "approved" if body.action in ("approve", "answer", "connected") else "rejected"
    await db.update("approvals", {"id": f"eq.{approval_id}"}, {
        "status": status, "final_args": body.args if body.action == "approve" else None,
        "note": body.note, "answer": body.answer, "decided_at": db.now()})
    if body.action == "answer":  # the chosen option reads as the user's reply in the thread
        await db.insert("messages", {"thread_id": approval["thread_id"], "owner_id": user["id"], "sender_type": "user",
                                     "text": body.answer.strip(), "run_id": run["id"], "meta": {"answer_to": approval_id}})
    await db.activity(user["id"], "approval_decision", approval["tool_name"], run_id=run["id"],
                      thread_id=approval["thread_id"], teammate_id=approval.get("teammate_id"),
                      input={"approval_id": approval_id, "action": body.action, "note": body.note},
                      output={"args": body.args} if body.args else None)
    await runs.resume(run, {"approval_id": approval_id, "action": body.action, "args": body.args, "note": body.note,
                            "answer": body.answer})
    return {"ok": True, "status": status}


# ------------------------------------------------------------------ voice
class LiveIn(BaseModel):
    thread_id: str


@app.post("/voice/live")
async def voice_live(body: LiveIn, user: User = Depends(current_user)):
    """Start a live voice session: a single-use Gemini Live token with the teammate's voice persona locked in."""
    if not config.env("GEMINI_API_KEY"):
        raise HTTPException(503, "Live voice needs a Gemini API key on the server.")
    await owned("threads", body.thread_id, user, "conversation")
    ctx = await runs.load_ctx(str(uuid.uuid4()), user["id"], body.thread_id, "message", None)
    tm = ctx.members[0]
    try:
        token = await live.mint(live.setup(tm, await live.instruction(ctx, tm, body.thread_id)))
    except httpx.HTTPError:
        log.exception("live token failed")
        raise HTTPException(502, "Could not start the voice session. Try again in a moment.")
    return {"token": token, "model": config.LIVE_MODEL, "teammate_id": tm["id"]}


@app.post("/voice/dictate")
async def voice_dictate(user: User = Depends(current_user)):
    """Start dictation: a single-use token for Gemini's live transcription, nothing else."""
    if not config.env("GEMINI_API_KEY"):
        raise HTTPException(503, "Dictation needs a Gemini API key on the server.")
    try:
        return {"token": await live.mint(live.dictation_setup())}
    except httpx.HTTPError:
        log.exception("dictation token failed")
        raise HTTPException(502, "Could not start dictation. Try again in a moment.")


class TranscriptIn(BaseModel):
    thread_id: str
    turns: list[dict[str, str]]


@app.post("/voice/transcript")
async def voice_transcript(body: TranscriptIn, user: User = Depends(current_user)):
    """Save what was said in a live voice session into the chat, so the conversation carries on in text."""
    thread = await owned("threads", body.thread_id, user, "conversation")
    ctx = await runs.load_ctx(str(uuid.uuid4()), user["id"], body.thread_id, "message", None)
    tm_id = thread.get("teammate_id") or ctx.members[0]["id"]
    for t in body.turns[:200]:
        text = str(t.get("text") or "").strip()
        if not text:
            continue
        mine = t.get("role") == "user"
        await db.insert("messages", {"thread_id": body.thread_id, "owner_id": user["id"], "sender_type": "user" if mine else "teammate",
                                     "teammate_id": None if mine else tm_id, "text": text[:4000], "kind": "text",
                                     "meta": {"voice": True}})
    return {"ok": True}


class EnhanceIn(BaseModel):
    name: str = ""
    role: str = ""
    bio: str = ""
    instructions: str = ""
    toolkits: list[str] = []


ENHANCE = """You write the instructions (system prompt) for an AI teammate in Tubelight, a team chat where people
work with AI teammates. Rewrite the user's notes into a clear, specific brief the teammate will follow.

The name given is the teammate's own name, and the person they work for is "the user". Start with
"You are <name>, …" and write in the second person. Use short plain-text sections with a heading line each:
Role, What you do, How you work, Tone, Boundaries. Bullets where they help. Under 250 words.

Keep every concrete detail the user gave (names, tools, preferences, limits) and do not invent facts,
companies or people. Where the notes are vague, choose sensible defaults for the role. Always include:
ask one short question when a request is unclear; anything
that sends, posts, pays or changes data waits for the user's approval; keep chat replies short.
Reply with the instructions only: no preamble, no markdown code fences."""


@app.post("/teammates/enhance")
async def enhance_instructions(body: EnhanceIn, user: User = Depends(current_user)):
    if not (body.instructions.strip() or body.role.strip()):
        raise HTTPException(400, "Add a role or a few words about what they should do first.")
    from langchain_core.messages import HumanMessage, SystemMessage

    notes = "\n".join(f"{k}: {v}" for k, v in (
        ("Teammate's name", body.name.strip()), ("Teammate's role", body.role.strip()), ("Bio", body.bio.strip()),
        ("Apps they can use", ", ".join(body.toolkits)), ("User's notes", body.instructions.strip()),
    ) if v)
    try:
        out = await llm.chat_model().ainvoke([SystemMessage(ENHANCE), HumanMessage(notes[:6000])])
    except Exception:
        log.exception("enhance failed")
        raise HTTPException(502, "The model didn't respond. Try again in a moment.")
    text = re.sub(r"^```\w*\n|\n```$", "", (out.text or "").strip()).replace("**", "").strip()
    if not text:
        raise HTTPException(502, "The model returned nothing. Try again.")
    return {"prompt": text[:8000]}


# ------------------------------------------------------------------ memories
class MemoryIn(BaseModel):
    scope: Literal["teammate", "project", "user"]
    id: str
    text: str


async def _memory_ns(scope: str, id: str, user: User) -> tuple[str, ...]:
    if scope == "user":
        if id != user["id"]:
            raise HTTPException(404, "That profile was not found.")
    elif scope in ("teammate", "project"):
        await owned("teammates" if scope == "teammate" else "projects", id, user, scope)
    else:
        raise HTTPException(400, "scope must be teammate, project or user.")
    return memory.ns(scope, id)


@app.get("/memories")
async def list_memories(scope: str, id: str, user: User = Depends(current_user)):
    return await memory.listing(await _memory_ns(scope, id, user))


@app.post("/memories")
async def add_memory(body: MemoryIn, user: User = Depends(current_user)):
    if not body.text.strip():
        raise HTTPException(400, "A memory needs some text.")
    return {"key": await memory.add(await _memory_ns(body.scope, body.id, user), body.text.strip())}


@app.get("/memories/all")
async def all_memories(user: User = Depends(current_user)):
    """Everything the teammates have learned, across shelves, for the Memory screen."""
    shelves = [("user", user["id"], "You")]
    shelves += [("teammate", t["id"], t["name"]) for t in await db.select("teammates", {"owner_id": f"eq.{user['id']}"})]
    shelves += [("project", p["id"], p["name"]) for p in await db.select("projects", {"owner_id": f"eq.{user['id']}"})]
    out = []
    for scope, id, name in shelves:
        for r in await memory.listing(memory.ns(scope, id), limit=500):
            out.append({**r, "scope": scope, "scope_id": id, "scope_name": name})
    return sorted(out, key=lambda r: r["updated_at"], reverse=True)


class MemoryPatch(BaseModel):
    scope: Literal["teammate", "project", "user"]
    id: str
    key: str
    text: str | None = None
    done: bool | None = None


@app.patch("/memories")
async def patch_memory(body: MemoryPatch, user: User = Depends(current_user)):
    if body.text is not None and not body.text.strip():
        raise HTTPException(400, "A memory needs some text.")
    ok = await memory.update(await _memory_ns(body.scope, body.id, user), body.key,
                             text=body.text.strip()[:500] if body.text else None, done=body.done)
    if not ok:
        raise HTTPException(404, "That memory was not found.")
    return {"ok": True}


@app.delete("/memories")
async def delete_memory(scope: str, id: str, key: str, user: User = Depends(current_user)):
    await memory.remove(await _memory_ns(scope, id, user), key)
    return {"ok": True}


# ------------------------------------------------------------------ connections
class ConnectIn(BaseModel):
    callback_url: str


def _need_composio() -> None:
    if not connectors.enabled():
        raise HTTPException(503, "Connectors are not set up on this server yet (COMPOSIO_API_KEY is missing).")


@app.get("/toolkits")
async def toolkits(user: User = Depends(current_user)):
    try:
        return await connectors.catalog()
    except Exception:
        log.exception("composio catalog failed")
        raise HTTPException(502, "Could not load the app list from Composio. Try again in a moment.")


@app.get("/connections")
async def connections(user: User = Depends(current_user)):
    try:
        return await connectors.list_connections(user["id"])
    except Exception:
        log.exception("composio list failed")
        raise HTTPException(502, "Could not load your connections from Composio. Try again in a moment.")


@app.post("/connections/{toolkit}")
async def connect(toolkit: str, body: ConnectIn, user: User = Depends(current_user)):
    _need_composio()
    slug = await connectors.resolve(toolkit)
    if slug is None:
        raise HTTPException(404, f"There's no app called {toolkit}.")
    try:
        return {"redirect_url": await connectors.connect(user["id"], slug, body.callback_url)}
    except Exception:
        log.exception("composio connect failed")
        raise HTTPException(502, f"Could not start connecting {connectors.name_of(slug)}. Try again in a moment.")


@app.delete("/connections/{toolkit}")
async def disconnect(toolkit: str, user: User = Depends(current_user)):
    _need_composio()
    try:
        await connectors.disconnect(user["id"], toolkit)
    except Exception:
        log.exception("composio disconnect failed")
        raise HTTPException(502, f"Could not disconnect {toolkit.title()}. Try again in a moment.")
    return {"ok": True}


# ------------------------------------------------------------------ events
class EventIn(BaseModel):
    type: str
    source: str = "webhook"
    payload: dict[str, Any] = {}


@app.post("/events/{webhook_token}")
async def receive_event(webhook_token: str, body: EventIn):
    profile = await db.one("profiles", {"webhook_token": f"eq.{webhook_token}"})
    if not profile:
        raise HTTPException(404, "Unknown webhook token.")
    event_id, routed = await events.receive(profile["id"], body.type, body.source, body.payload)
    return {"ok": True, "event_id": event_id, "routed": routed}


@app.post("/composio/webhook")
async def composio_webhook(request: Request):
    """App events from Composio triggers (signed): each runs the automations set on that trigger."""
    secret = config.env("COMPOSIO_WEBHOOK_SECRET")
    if not secret:
        raise HTTPException(503, "Webhook secret not configured.")
    body = (await request.body()).decode()
    h = request.headers
    try:
        ev = connectors._client().triggers.verify_webhook(
            id=h.get("webhook-id", ""), payload=body, secret=secret, signature=h.get("webhook-signature", ""),
            timestamp=h.get("webhook-timestamp", ""))["payload"]
    except Exception:
        log.warning("rejected a Composio webhook")
        raise HTTPException(401, "Bad signature.")
    trigger_id = ev.get("id") or (ev.get("metadata") or {}).get("id")
    owner = ev.get("user_id") or ((ev.get("metadata") or {}).get("connected_account") or {}).get("user_id")
    if not trigger_id or not owner or not await db.one("profiles", {"id": f"eq.{owner}", "select": "id"}):
        return {"ok": True, "fired": 0}
    fired = await events.receive_app(owner, trigger_id, ev.get("trigger_slug") or "", ev.get("toolkit_slug") or "",
                                     ev.get("payload") or {})
    return {"ok": True, "fired": fired}


def _trigger_app(trigger: str | None) -> str | None:
    """GMAIL_NEW_GMAIL_MESSAGE -> GMAIL: Composio trigger slugs start with their toolkit."""
    return trigger.split("_", 1)[0] if trigger else None


def _automation_view(r: dict[str, Any], last: str | None, problems: list[str] | None = None) -> dict[str, Any]:
    m = r.get("match") or {}
    nxt: list[str] = []
    if r["event_type"] == "schedule" and m.get("cron"):
        try:
            zone = zoneinfo.ZoneInfo(m.get("tz") or "UTC")
        except (zoneinfo.ZoneInfoNotFoundError, ValueError):
            zone = zoneinfo.ZoneInfo("UTC")
        it = croniter(m["cron"], datetime.now(zone))
        nxt = [it.get_next(datetime).isoformat() for _ in range(3)]
    return {"id": r["id"], "name": r["name"], "instructions": r["instructions"], "kind": r["event_type"],
            "when": m.get("when") or "", "enabled": r["enabled"], "teammate_id": r["teammate_id"],
            "thread_id": automations.thread_of(r), "created_at": r.get("created_at"),
            "cron": m.get("cron"), "tz": m.get("tz"), "trigger": m.get("trigger"), "app": _trigger_app(m.get("trigger")),
            "settings": m.get("config") or {}, "keywords": m.get("contains") or [],
            # None: every app the teammate may use; a list: only these
            "toolkits": m.get("toolkits"), "last_run": last,
            "next_run": nxt[0] if nxt and r["enabled"] else None, "upcoming": nxt if r["enabled"] else [],
            "problems": problems or []}


_ready: dict[str, tuple[float, set[str] | None]] = {}


async def _ready_cached(owner_id: str) -> set[str] | None:
    """Connected apps, cached for a minute: the automation lists shouldn't wait on Composio every time."""
    hit = _ready.get(owner_id)
    if hit and time.monotonic() - hit[0] < 60:
        return hit[1]
    try:
        ready: set[str] | None = await connectors.ready(owner_id)
    except Exception:
        ready = None  # Composio unreachable: don't cry wolf
    _ready[owner_id] = (time.monotonic(), ready)
    return ready


async def _problems(rules: list[dict[str, Any]], owner_id: str) -> dict[str, list[str]]:
    """What would stop each automation from working, in words: a disconnected app, a teammate who left the project."""
    if not rules:
        return {}
    ready = await _ready_cached(owner_id)
    members = {(m["project_id"], m["teammate_id"]) for m in await db.select(
        "project_members", {"owner_id": f"eq.{owner_id}", "select": "project_id,teammate_id"})}
    out: dict[str, list[str]] = {}
    for r in rules:
        m, issues = r.get("match") or {}, []
        if r.get("project_id") and (r["project_id"], r["teammate_id"]) not in members:
            issues.append("Its teammate is no longer in this project, so it can't post there.")
        if ready is not None:
            app = _trigger_app(m.get("trigger"))
            if app and app not in ready:
                issues.append(f"{connectors.name_of(app)} isn't connected, so its events can't arrive. Reconnect it.")
            for t in m.get("toolkits") or []:
                if t not in ready and t != app:
                    issues.append(f"{connectors.name_of(t)} isn't connected: runs can't use it.")
        out[r["id"]] = issues
    return out


async def _last_runs(rule_ids: list[str]) -> dict[str, str]:
    if not rule_ids:
        return {}
    rows = await db.select("events", {"rule_id": f"in.({','.join(rule_ids)})", "status": "eq.routed",
                                      "order": "created_at.desc", "limit": "500", "select": "rule_id,created_at"})
    last: dict[str, str] = {}
    for e in rows:
        last.setdefault(e["rule_id"], e["created_at"])
    return last


@app.get("/automations")
async def list_automations(user: User = Depends(current_user)):
    """Every automation (schedules and app events), newest first; the app groups them by chat or teammate."""
    rules = await db.select("event_rules", {"owner_id": f"eq.{user['id']}", "event_type": "in.(schedule,app)",
                                            "order": "created_at.desc"})
    last, problems = await asyncio.gather(_last_runs([r["id"] for r in rules]), _problems(rules, user["id"]))
    return [_automation_view(r, last.get(r["id"]), problems.get(r["id"])) for r in rules]


def _outcome(event: dict[str, Any], run: dict[str, Any] | None, posted: str | None) -> str:
    if event["status"] != "routed":
        return {"ignored": "filtered", "rate_limited": "limited"}.get(event["status"], "failed")
    status = (run or {}).get("status")
    if status in ("running", "waiting_approval", "error", "cancelled"):
        return {"running": "working", "waiting_approval": "approval", "error": "failed", "cancelled": "cancelled"}[status]
    return "posted" if posted else "quiet"


@app.get("/automations/{rule_id}")
async def get_automation(rule_id: str, user: User = Depends(current_user)):
    """One automation with its last 20 runs: when, and how each went (posted, quiet, approval, working, failed,
    filtered out, over the hourly limit), with the start of what it posted or why it failed."""
    rule = await owned("event_rules", rule_id, user, "automation")
    evs = await db.select("events", {"rule_id": f"eq.{rule_id}", "order": "created_at.desc", "limit": "20",
                                     "select": "id,status,created_at,run_id,payload"})
    run_ids = [e["run_id"] for e in evs if e.get("run_id")]
    runs_by, posted = {}, {}
    if run_ids:
        ids = f"in.({','.join(run_ids)})"
        runs_by = {r["id"]: r for r in await db.select("runs", {"id": ids, "select": "id,status,error"})}
        for m in await db.select("messages", {"run_id": ids, "sender_type": "eq.teammate", "order": "created_at",
                                              "select": "id,run_id,text"}):
            posted.setdefault(m["run_id"], m)
    history = []
    for e in evs:
        run, msg = runs_by.get(e.get("run_id")), posted.get(e.get("run_id"))
        outcome = _outcome(e, run, msg)
        history.append({"at": e["created_at"], "outcome": outcome, "late": bool((e.get("payload") or {}).get("late")),
                        "preview": ((msg or {}).get("text") or ((run or {}).get("error") if outcome == "failed" else "") or "")[:200],
                        "message_id": (msg or {}).get("id")})
    last = next((h["at"] for h, e in zip(history, evs) if e["status"] == "routed"), None)
    problems = await _problems([rule], user["id"])
    return {**_automation_view(rule, last, problems.get(rule_id)), "runs": history}


async def _project_member(tm: dict[str, Any], project_id: str | None, user: User) -> None:
    if project_id:
        await owned("projects", project_id, user, "project")
        if not await db.one("project_members", {"project_id": f"eq.{project_id}", "teammate_id": f"eq.{tm['id']}"}):
            raise HTTPException(400, f"{tm['name']} isn't in that project.")


class NewAutomation(BaseModel):
    teammate_id: str
    project_id: str | None = None  # None: the teammate's direct chat
    name: str = Field(min_length=1, max_length=80)
    instructions: str = Field(min_length=1, max_length=2000)
    cron: str | None = None  # a schedule, in the user's time zone
    trigger: str | None = None  # or an app event (a Composio trigger slug from /apps/{toolkit}/events)
    settings: dict[str, Any] = Field(default_factory=dict)
    keywords: list[str] = Field(default_factory=list)
    when: str = Field("", max_length=120)
    tz: str = "UTC"
    toolkits: list[str] | None = None  # None: every app the teammate may use
    run_now: bool = False


@app.post("/automations")
async def new_automation(body: NewAutomation, user: User = Depends(current_user)):
    """Set up an automation from the app: a schedule or an app event, with the apps its runs may use."""
    tm = await owned("teammates", body.teammate_id, user, "teammate")
    await _project_member(tm, body.project_id, user)
    try:
        zoneinfo.ZoneInfo(body.tz)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        raise HTTPException(400, "Unknown time zone.") from None
    try:
        rule = await automations.create(user["id"], tm, body.project_id, name=body.name, instructions=body.instructions,
                                        cron=body.cron or None, tz=body.tz, trigger=body.trigger or None,
                                        config=body.settings, contains=body.keywords, when=body.when, by="You",
                                        toolkits=body.toolkits)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if body.run_now and rule["event_type"] == "schedule":
        event = await db.insert("events", {"owner_id": user["id"], "type": "schedule", "source": "run_now",
                                           "payload": {"run_now": True}, "rule_id": rule["id"]})
        await events.fire(rule, event)
    return _automation_view(rule, None)


class DraftRequest(BaseModel):
    text: str = Field(min_length=3, max_length=1000)
    teammate_id: str
    tz: str = "UTC"


@app.post("/automations/draft")
async def draft_automation(body: DraftRequest, user: User = Depends(current_user)):
    """Plain words -> a filled-in automation form (nothing is saved)."""
    tm = await owned("teammates", body.teammate_id, user, "teammate")
    try:
        zone = zoneinfo.ZoneInfo(body.tz)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        zone = zoneinfo.ZoneInfo("UTC")
    try:
        ready = await connectors.ready(user["id"])
    except Exception:
        ready = set()
    apps = [t for t in tm.get("allowed_toolkits") or [] if t in ready]
    try:
        return await automations.draft(body.text, tm, apps, datetime.now(zone))
    except Exception as e:
        log.warning("draft failed: %s", e)
        raise HTTPException(503, "Couldn't read that right now. Fill it in below, or try again in a moment.") from e


@app.get("/apps/{toolkit}/events")
async def app_events(toolkit: str, user: User = Depends(current_user)):
    """What an app can send (Composio triggers), to start an automation on."""
    try:
        return await automations.app_events(toolkit, limit=30)
    except Exception as e:
        raise HTTPException(502, f"Couldn't load {toolkit.title()}'s events: {str(e)[:120]}") from e


# ------------------------------------------------------------------ repo knowledge (repo.py)
def _repo_view(stored: dict[str, Any]) -> dict[str, Any]:
    b = stored.get("brief") or {}
    areas = (stored.get("areas") or {}).get("areas") or {}
    return {"state": stored.get("state"), "brief": repo.brief_text(stored), "generated": b.get("text") or "",
            "edited": bool(b.get("edited")), "mine": b.get("edited") or "", "notes": b.get("notes") or [],
            "areas": [{"name": a, "summary": v["summary"], "files": v["files"]} for a, v in areas.items()],
            "log": ((stored.get("log") or {}).get("entries") or [])[:20]}


@app.get("/projects/{project_id}/repo")
async def get_repo(project_id: str, user: User = Depends(current_user)):
    p = await owned("projects", project_id, user, "project")
    stored = await repo.get(project_id) if p.get("repo_url") else {}
    return {"repo": "/".join(repo.parse(p.get("repo_url")) or ()) or None, **_repo_view(stored)}


class RepoChoice(BaseModel):
    repo: str | None = Field(None, max_length=200)  # "owner/name", or null to remove it


@app.put("/projects/{project_id}/repo")
async def set_repo(project_id: str, body: RepoChoice, user: User = Depends(current_user)):
    """Pick (or remove) the project's GitHub repo; picking one starts reading it in the background."""
    await owned("projects", project_id, user, "project")
    target = repo.parse(body.repo) if body.repo else None
    if body.repo and not target:
        raise HTTPException(400, "Give the repo as owner/name.")
    url = f"https://github.com/{target[0]}/{target[1]}" if target else None
    await db.update("projects", {"id": f"eq.{project_id}"}, {"repo_url": url})
    if url:
        repo.schedule(user["id"], project_id, force=True)
    else:
        await repo.forget(project_id)
    return {"repo": "/".join(target) if target else None}


@app.post("/projects/{project_id}/repo/reindex")
async def reindex_repo(project_id: str, user: User = Depends(current_user)):
    p = await owned("projects", project_id, user, "project")
    if not repo.parse(p.get("repo_url")):
        raise HTTPException(400, "This project has no repo.")
    repo.schedule(user["id"], project_id, force=True)
    return {"ok": True}


class BriefEdit(BaseModel):
    text: str | None = Field(None, max_length=8000)  # null: go back to the generated brief


@app.patch("/projects/{project_id}/repo/brief")
async def edit_repo_brief(project_id: str, body: BriefEdit, user: User = Depends(current_user)):
    await owned("projects", project_id, user, "project")
    await repo.edit_brief(project_id, (body.text or "").strip() or None)
    return _repo_view(await repo.get(project_id))


@app.get("/apps/{toolkit}/choices/{field}")
async def setting_choices(toolkit: str, field: str, user: User = Depends(current_user)):
    """Names to pick from for an ID-like event setting (Linear teams, Gmail labels, GitHub repos); 404 if none."""
    try:
        opts = await automations.choices(user["id"], toolkit, field)
    except Exception as e:
        raise HTTPException(502, f"Couldn't look those up: {str(e)[:160]}") from e
    if opts is None:
        raise HTTPException(404, "No list for this setting.")
    return opts


class AutomationPatch(BaseModel):
    enabled: bool | None = None
    name: str | None = Field(None, max_length=80)
    instructions: str | None = Field(None, max_length=2000)
    cron: str | None = None  # schedules only, in the user's time zone
    tz: str | None = None
    when: str | None = Field(None, max_length=120)  # the schedule or event in plain words, shown everywhere
    trigger: str | None = None  # app events: a new event and/or settings swap the Composio trigger
    settings: dict[str, Any] | None = None
    keywords: list[str] | None = None
    toolkits: list[str] | None = None  # send null to allow every app the teammate may use
    teammate_id: str | None = None  # move it to another teammate
    project_id: str | None = None  # or another chat: a project, or null for the teammate's direct chat


@app.patch("/automations/{rule_id}")
async def patch_automation(rule_id: str, body: AutomationPatch, user: User = Depends(current_user)):
    rule = await owned("event_rules", rule_id, user, "automation")
    sent = body.model_fields_set
    moves: dict[str, Any] = {}
    if "teammate_id" in sent or "project_id" in sent:
        tm = await owned("teammates", body.teammate_id or rule["teammate_id"], user, "teammate")
        project = body.project_id if "project_id" in sent else rule.get("project_id")
        await _project_member(tm, project, user)
        moves = {"teammate_id": tm["id"], "project_id": project}
    if body.tz:
        try:
            zoneinfo.ZoneInfo(body.tz)
        except (zoneinfo.ZoneInfoNotFoundError, ValueError):
            raise HTTPException(400, "Unknown time zone.") from None
    changes: dict[str, Any] = {k: getattr(body, k) for k in ("name", "instructions", "cron", "tz", "when", "trigger") if getattr(body, k)}
    if body.settings is not None:
        changes["config"] = body.settings
    if body.keywords is not None:
        changes["contains"] = body.keywords
    if "toolkits" in sent:
        changes["toolkits"] = body.toolkits
    changes |= moves
    try:
        if changes:
            rule = await automations.update(rule, "You", **changes)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if body.enabled is not None and body.enabled != rule["enabled"]:
        rule = await automations.set_enabled(rule, body.enabled, "You")
    return _automation_view(rule, None)


@app.get("/faces/{seed}.png")
async def face_image(seed: str, c: str = "a1a1aa"):
    """A teammate's face for notifications (public: it's a cartoon from a seed, nothing private)."""
    color = re.sub(r"[^0-9a-fA-F]", "", c)[:6] or "a1a1aa"
    try:
        png = await push.face_png(seed[:80], color)
    except httpx.HTTPError as e:
        raise HTTPException(502, "Couldn't draw that face right now.") from e
    return Response(png, media_type="image/png", headers={"Cache-Control": "public, max-age=604800"})


class NotifyPrefs(BaseModel):
    mode: Literal["all", "needed", "off"] | None = None
    sound: str | None = None
    chats: dict[str, Literal["all", "needed", "off"] | None] | None = None  # a chat's own setting; null = follow overall


@app.get("/notifications/prefs")
async def get_notify_prefs(user: User = Depends(current_user)):
    return {**await push.prefs(user["id"]), "sounds": list(push.SOUNDS)}


@app.patch("/notifications/prefs")
async def patch_notify_prefs(body: NotifyPrefs, user: User = Depends(current_user)):
    if body.sound and body.sound not in push.SOUNDS:
        raise HTTPException(400, "Unknown sound.")
    return {**await push.set_prefs(user["id"], **body.model_dump(exclude_none=True) | (
        {"chats": body.chats} if body.chats is not None else {})), "sounds": list(push.SOUNDS)}


# ------------------------------------------------------------------ your computers (computers.py)
class ComputerPrefs(BaseModel):
    code_on: Literal["server", "computer", "auto"] | None = None
    cowork: bool | None = None


@app.get("/computers")
async def get_computers(user: User = Depends(current_user)):
    return {"computers": await computers.listing(user["id"]), **await computers.prefs(user["id"])}


@app.get("/computers/commands")
async def computer_commands(user: User = Depends(current_user)):
    """The slash commands a computer's chat understands (computers.SLASH)."""
    return [{"name": n, "about": a, "arg": "{arg}" in instr} for n, (a, instr) in computers.SLASH.items()]


@app.post("/computers/pair")
async def pair_computer(user: User = Depends(current_user)):
    return computers.pair_code(user["id"])


@app.patch("/computers/prefs")
async def patch_computer_prefs(body: ComputerPrefs, user: User = Depends(current_user)):
    return await computers.set_prefs(user["id"], body.code_on, body.cowork)


class ComputerPatch(BaseModel):
    ask: bool


class ProjectComputers(BaseModel):
    computers: list[str] = Field(default_factory=list, max_length=5)


@app.get("/projects/{project_id}/computers")
async def get_project_computers(project_id: str, user: User = Depends(current_user)):
    await owned("projects", project_id, user, "project")
    return {"computers": await computers.project_computers(user["id"], project_id)}


@app.put("/projects/{project_id}/computers")
async def put_project_computers(project_id: str, body: ProjectComputers, user: User = Depends(current_user)):
    await owned("projects", project_id, user, "project")
    return {"computers": await computers.set_project_computers(user["id"], project_id, body.computers)}


class PhoneRegister(BaseModel):
    name: str = Field(default="Phone", max_length=60)


@app.post("/phone/register")
async def phone_register(body: PhoneRegister, user: User = Depends(current_user)):
    """The app on a phone that can do phone actions: its own teammate and chat (made once)."""
    tm = await phone.ensure(user["id"], body.name)
    return {"teammate_id": tm["id"], "name": tm["name"]}


class PhoneStatus(BaseModel):
    status: dict = Field(default_factory=dict)


@app.post("/phone/status")
async def phone_status(body: PhoneStatus, user: User = Depends(current_user)):
    """The phone's storage, battery, memory and network, for its teammate (sent when the app opens or a message goes out)."""
    await phone.save_status(user["id"], body.status)
    return {"ok": True}


class PhoneNotes(BaseModel):
    items: list[dict] = Field(default_factory=list, max_length=300)


@app.post("/phone/notifications")
async def phone_notifications(body: PhoneNotes, user: User = Depends(current_user)):
    """The phone shares its recent notifications (opt-in, Profile → Phone) for teammates to look through."""
    return {"kept": await phone.save_notes(user["id"], body.items)}


class CloseApp(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    force: bool = False


@app.post("/computers/{computer_id}/apps/close")
async def computer_close_app(computer_id: str, body: CloseApp, user: User = Depends(current_user)):
    """The Close button beside an app in the computer's info sheet (the computer refuses desktop parts)."""
    if not await computers.row(user["id"], computer_id):
        raise HTTPException(404, "No such computer.")
    try:
        return {"result": await computers.call(computer_id, "quit_app", {"name": body.name, "force": body.force, "full": True}, 30)}
    except (RuntimeError, PermissionError, TimeoutError) as e:
        raise HTTPException(409, str(e))


@app.get("/computers/{computer_id}/live")
async def computer_live(computer_id: str, user: User = Depends(current_user)):
    """The computer's info sheet: battery, disk, memory and the apps using memory and CPU now (polled while open)."""
    if not await computers.row(user["id"], computer_id):
        raise HTTPException(404, "No such computer.")
    try:
        return await computers.call(computer_id, "live", {}, 15)
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e


@app.patch("/computers/{computer_id}")
async def patch_computer(computer_id: str, body: ComputerPatch, user: User = Depends(current_user)):
    await computers.set_ask(user["id"], computer_id, body.ask)
    return {"ok": True}


@app.delete("/computers/{computer_id}")
async def delete_computer(computer_id: str, user: User = Depends(current_user)):
    await computers.remove(user["id"], computer_id)
    return {"ok": True}


class RunnerClaim(BaseModel):
    code: str = Field(max_length=20)
    name: str = Field("", max_length=80)
    os: str = Field("", max_length=40)


class RunnerResult(BaseModel):
    id: str
    ok: bool
    out: Any = None


async def runner_auth(request: Request) -> tuple[str, str]:
    token = (request.headers.get("authorization") or "").removeprefix("Bearer ").strip()
    found = await computers.by_token(token) if token else None
    if not found:
        raise HTTPException(401, "Unknown computer.")
    return found


@app.post("/runner/claim")
async def runner_claim(body: RunnerClaim):
    try:
        return await computers.claim(body.code, body.name, body.os)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e


@app.post("/runner/poll")
async def runner_poll(request: Request, who: tuple[str, str] = Depends(runner_auth)):
    job = await computers.poll(who[1], await request.json())
    return job if job else Response(status_code=204)


@app.post("/runner/result")
async def runner_result(body: RunnerResult, who: tuple[str, str] = Depends(runner_auth)):
    computers.result(who[1], body.id, body.ok, body.out)
    return {"ok": True}


class RunnerHello(BaseModel):
    name: str = Field("", max_length=80)
    os: str = Field("", max_length=40)


class RunnerLink(BaseModel):
    request: str = Field(max_length=64)
    approve: bool = True


@app.post("/runner/hello")
async def runner_hello(body: RunnerHello):
    return computers.hello(body.name, body.os)


@app.post("/runner/link-status")
async def runner_link_status(body: RunnerLink):
    return await computers.link_status(body.request)


@app.post("/runner/link-confirm")
async def runner_link_confirm(body: RunnerLink):
    try:
        return await computers.confirm(body.request, body.approve)
    except (LookupError, PermissionError) as e:
        raise HTTPException(409, str(e)) from e


class RunnerDone(BaseModel):
    id: str = Field(max_length=32)
    title: str = Field("", max_length=200)
    exit: int | None = None
    seconds: int = 0
    tail: str = Field("", max_length=4000)


@app.post("/runner/done")
async def runner_done(body: RunnerDone, who: tuple[str, str] = Depends(runner_auth)):
    await computers.job_done(who[0], who[1], body.model_dump())
    return {"ok": True}


@app.post("/runner/unlink")
async def runner_unlink(who: tuple[str, str] = Depends(runner_auth)):
    await computers.remove(*who)
    return {"ok": True}


@app.get("/computers/requests/{rid}")
async def get_link_request(rid: str, user: User = Depends(current_user)):
    try:
        return computers.request_info(rid, user["id"])
    except LookupError as e:
        raise HTTPException(404, str(e)) from e


@app.post("/computers/requests/{rid}")
async def claim_link_request(rid: str, user: User = Depends(current_user)):
    try:
        return computers.scan(rid, user["id"], user.get("email") or "")
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except PermissionError as e:
        raise HTTPException(409, str(e)) from e


@app.get("/desktop/tubelight-desktop.deb")
async def desktop_deb():
    name, data = await asyncio.to_thread(computers.desktop_deb)
    return Response(data, media_type="application/vnd.debian.binary-package",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/desktop")
async def desktop_page():
    """Where the laptop downloads Tubelight for desktop (public)."""
    return Response(DESKTOP_PAGE, media_type="text/html")


DESKTOP_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tubelight for desktop</title><style>
:root{color-scheme:light dark;--bg:#fafafa;--panel:#fff;--ink:#18181b;--ink3:#71717a;--line:rgba(0,0,0,.08);--tube:#0284c7}
@media(prefers-color-scheme:dark){:root{--bg:#09090b;--panel:#18181b;--ink:#f4f4f5;--ink3:#a1a1aa;--line:rgba(255,255,255,.08);--tube:#0ea5e9}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:460px;margin:24px 16px;background:var(--panel);border:1px solid var(--line);border-radius:24px;padding:32px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.4px}p{color:var(--ink3);margin:0 0 20px}
a.btn{display:block;text-align:center;background:var(--ink);color:var(--bg);text-decoration:none;font-weight:600;padding:14px;border-radius:14px}
ol{padding-left:20px;color:var(--ink3);margin:20px 0 0}li{margin:6px 0}code{font-size:13px}
</style></head><body><main><h1>Tubelight for desktop</h1>
<p>Let your teammates work on this computer: read the folders you share, and change files or run commands after you approve each step on your phone.</p>
<a class="btn" href="/desktop/tubelight-desktop.deb">Download for Ubuntu / Debian</a>
<ol><li>Open the download to install it (or <code>sudo apt install ./tubelight-desktop_*.deb</code>).</li>
<li>Open <b>Tubelight</b> from your apps. It shows a QR code.</li>
<li>On your phone: Tubelight → Profile → Computers → <b>Scan</b>. Confirm on both.</li></ol></main></body></html>"""


@app.get("/runner/{name}")
async def runner_file(name: str):
    """The runner script and what it builds sandboxes from (public: nothing secret in them)."""
    path = computers.FILES.get(name)
    if not path or not path.exists():
        raise HTTPException(404, "No such file.")
    return FileResponse(path, media_type="text/plain")


@app.get("/usage")
async def get_usage(user: User = Depends(current_user)):
    """How much of each free allowance is left: models today, shared pools, app tool calls this month, storage."""
    tms = await db.select("teammates", {"owner_id": f"eq.{user['id']}", "select": "model"})
    models = [config.DEFAULT_MODEL, config.ROUTER_MODEL, config.KEEPER_MODEL, config.LEARN_MODEL, *llm.fallbacks(),
              *(t["model"] for t in tms if t.get("model"))]
    return await usage.report(list(dict.fromkeys(models)), await images.choice(user["id"]))


class ImageModel(BaseModel):
    model: str


@app.get("/images/model")
async def get_image_model(user: User = Depends(current_user)):
    """The image models teammates can draw with (Profile) and the one in use."""
    return {"model": await images.choice(user["id"]),
            "models": [{"id": k, "name": m["name"], "about": m["about"], "per_day": usage.CF_NEURONS // m["neurons"]}
                       for k, m in images.MODELS.items()]}


@app.put("/images/model")
async def put_image_model(body: ImageModel, user: User = Depends(current_user)):
    try:
        return {"model": await images.set_choice(user["id"], body.model)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/automations/{rule_id}")
async def delete_automation(rule_id: str, user: User = Depends(current_user)):
    await automations.delete(await owned("event_rules", rule_id, user, "automation"), "You")
    return {"ok": True}


@app.post("/automations/{rule_id}/run")
async def run_automation(rule_id: str, user: User = Depends(current_user)):
    """Run a scheduled automation now (app-event ones run when their event happens)."""
    rule = await owned("event_rules", rule_id, user, "automation")
    if rule["event_type"] != "schedule":
        raise HTTPException(400, "This one runs when its app event happens.")
    event = await db.insert("events", {"owner_id": user["id"], "type": "schedule", "source": "run_now",
                                       "payload": {"run_now": True}, "rule_id": rule["id"]})
    return {"ok": True, "run_id": await events.fire(rule, event)}


@app.post("/event-rules/{rule_id}/test")
async def test_rule(rule_id: str, user: User = Depends(current_user)):
    rule = await owned("event_rules", rule_id, user, "rule")
    return {"ok": True, "event_id": await events.test_rule(rule)}


# ------------------------------------------------------------------ tasks: to-dos and every chat's follow-ups
class TodoIn(BaseModel):
    title: str
    notes: str = ""
    status: str = "todo"
    priority: int = 0
    due: str | None = None
    project_id: str | None = None
    assignee: str | None = None


@app.get("/todos")
async def list_todos(user: User = Depends(current_user)):
    return {"todos": await todos.listing(user["id"])}


@app.post("/todos")
async def add_todo(body: TodoIn, user: User = Depends(current_user)):
    try:
        t = await todos.add(user["id"], body.title, **body.model_dump(exclude={"title"}))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if t.get("assignee"):
        await todos.hand_to(user["id"], t)
    return t


@app.patch("/todos/{todo_id}")
async def edit_todo(todo_id: str, body: dict[str, Any], user: User = Depends(current_user)):
    before = await todos.get(user["id"], todo_id)
    try:
        t = await todos.update(user["id"], todo_id, body)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    if not t:
        raise HTTPException(404, "That to-do is gone.")
    if t.get("assignee") and t["assignee"] != (before or {}).get("assignee"):
        await todos.hand_to(user["id"], t)  # newly assigned: they pick it up
    return t


@app.delete("/todos/{todo_id}")
async def delete_todo(todo_id: str, user: User = Depends(current_user)):
    if not await todos.remove(user["id"], todo_id):
        raise HTTPException(404, "That to-do is gone.")
    return {"ok": True}


_FOLLOWUP_KEEP = ("id", "thread_id", "what", "owner", "at", "until", "check_by", "poll_hours", "set_by", "set_at",
                  "created", "status", "closed")


@app.get("/followups")
async def all_followups(user: User = Depends(current_user)):
    """Every chat's follow-ups: pending (soonest first) and recently finished (latest first)."""
    return {"pending": [{k: f.get(k) for k in _FOLLOWUP_KEEP} for f in await followups.pending(user["id"])],
            "done": [{k: f.get(k) for k in _FOLLOWUP_KEEP} for f in await followups.recent(user["id"])]}


class FollowupEdit(BaseModel):
    what: str | None = None
    at: datetime | None = None
    until: str | None = None
    check_by: datetime | None = None


@app.patch("/followups/{followup_id}")
async def edit_followup(followup_id: str, body: FollowupEdit, user: User = Depends(current_user)):
    """The user changes a follow-up; its chat gets a capsule and its teammate sees the new version."""
    for d in (body.at, body.check_by):
        if d and d.tzinfo is None:
            raise HTTPException(400, "Send times with their offset.")
    try:
        f = await followups.edit(followup_id, user["id"], what=body.what, at=body.at, until=body.until, check_by=body.check_by)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not f:
        raise HTTPException(404, "That follow-up is already gone.")
    return {k: f.get(k) for k in _FOLLOWUP_KEEP}


@app.post("/followups/{followup_id}/now")
async def followup_now(followup_id: str, user: User = Depends(current_user)):
    """Do it now: the teammate picks it up in its chat straight away."""
    f = next((f for f in await followups.pending(user["id"]) if f["id"] == followup_id), None)
    if not f:
        raise HTTPException(404, "That follow-up is already gone.")
    if not await followups.fire(followup_id, "time"):
        raise HTTPException(409, "It's already being picked up.")
    return {"ok": True}


# ------------------------------------------------------------------ vault: the user's files on this server
@app.get("/vault")
async def list_vault(user: User = Depends(current_user)):
    rows = await vault.items(user["id"])
    return {"items": [vault.public(user["id"], r) for r in rows], "usage": await vault.usage(user["id"])}


class VaultFolder(BaseModel):
    name: str
    parent: str = ""


@app.post("/vault/folders")
async def add_vault_folder(body: VaultFolder, user: User = Depends(current_user)):
    try:
        return vault.public(user["id"], await vault.add_folder(user["id"], body.name, body.parent))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/vault/upload")
async def upload_to_vault(file: UploadFile, parent: str = Form(""), user: User = Depends(current_user)):
    tmp = vault.ROOT / user["id"] / f".in-{uuid.uuid4()}"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with tmp.open("wb") as out:
            while chunk := await file.read(1 << 20):
                size += len(chunk)
                if size > vault.MAX_BYTES:
                    raise HTTPException(413, "Files up to 100 MB for now.")
                await asyncio.to_thread(out.write, chunk)
        row = await vault.add_file(user["id"], file.filename or "file", tmp, size, parent, file.content_type or "")
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        tmp.unlink(missing_ok=True)
    return vault.public(user["id"], row)


class VaultSave(BaseModel):
    path: str
    name: str
    parent: str = ""


@app.post("/vault/save")
async def save_to_vault(body: VaultSave, user: User = Depends(current_user)):
    """A chat attachment (a file a teammate made or you sent) kept in the vault."""
    try:
        data = await files._download(user["id"], body.path)
        return vault.public(user["id"], await vault.add_bytes(user["id"], body.name, data, body.parent))
    except PermissionError:
        raise HTTPException(404, "That file is gone.")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/vault/{item_id}")
async def edit_vault_item(item_id: str, body: dict[str, Any], user: User = Depends(current_user)):
    try:
        row = await vault.update(user["id"], item_id, body)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not row:
        raise HTTPException(404, "That item is gone.")
    return vault.public(user["id"], row)


@app.delete("/vault/{item_id}")
async def delete_vault_item(item_id: str, user: User = Depends(current_user)):
    if not await vault.remove(user["id"], item_id):
        raise HTTPException(404, "That item is gone.")
    return {"ok": True}


@app.get("/vault/{item_id}/preview")
async def preview_vault_item(item_id: str, user: User = Depends(current_user)):
    row = await vault.get(user["id"], item_id)
    if not row or row["kind"] != "file":
        raise HTTPException(404, "That file is gone.")
    try:
        return await asyncio.to_thread(vault.preview, user["id"], item_id, row["name"], row["mime"])
    except Exception as e:
        log.warning("vault preview %s failed: %s", item_id, e)
        return {"type": "error", "message": "This file couldn't be opened."}


@app.get("/attachments/preview")
async def preview_attachment(path: str, name: str, user: User = Depends(current_user)):
    """A chat file (one a teammate made or you sent) as the app's viewer draws it."""
    try:
        data = await files._download(user["id"], path)
        return await asyncio.to_thread(vault.preview_of, name, data)
    except PermissionError:
        raise HTTPException(404, "That file is gone.")
    except Exception as e:
        log.warning("attachment preview failed: %s", e)
        return {"type": "error", "message": "This file couldn't be opened."}


@app.get("/vault/f/{owner_id}/{item_id}")
async def vault_file(owner_id: str, item_id: str, k: str = "file", e: int = 0, s: str = "", dl: int = 0):
    """A file (or its thumbnail) by signed link: no login, so players and image views can load and seek it."""
    if k not in ("file", "thumb") or not vault.verify(owner_id, item_id, k, e, s):
        raise HTTPException(403, "This link has expired.")
    row = await vault.get(owner_id, item_id)
    path = vault.file_path(owner_id, item_id, ".thumb.jpg" if k == "thumb" else "")
    if not row or not path.exists():
        raise HTTPException(404, "That file is gone.")
    headers = {"Cache-Control": "private, max-age=21600"}
    if k == "thumb":
        return FileResponse(path, media_type="image/jpeg", headers=headers)
    return FileResponse(path, media_type=row["mime"] or "application/octet-stream", headers=headers,
                        filename=row["name"], content_disposition_type="attachment" if dl else "inline")
