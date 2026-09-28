import asyncio
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
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import automations, config, connectors, db, events, files, followups, live, llm, memory, reactions, runs, sandbox, usage
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
    yield
    warm.cancel()
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
app.add_middleware(GZipMiddleware, minimum_size=1024)
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


async def _problems(rules: list[dict[str, Any]], owner_id: str) -> dict[str, list[str]]:
    """What would stop each automation from working, in words: a disconnected app, a teammate who left the project."""
    if not rules:
        return {}
    try:
        ready = await connectors.ready(owner_id)
    except Exception:
        ready = None  # Composio unreachable: don't cry wolf
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


@app.patch("/automations/{rule_id}")
async def patch_automation(rule_id: str, body: AutomationPatch, user: User = Depends(current_user)):
    rule = await owned("event_rules", rule_id, user, "automation")
    sent = body.model_fields_set
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
    try:
        if changes:
            rule = await automations.update(rule, "You", **changes)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if body.enabled is not None and body.enabled != rule["enabled"]:
        rule = await automations.set_enabled(rule, body.enabled, "You")
    return _automation_view(rule, None)


@app.get("/usage")
async def get_usage(user: User = Depends(current_user)):
    """How much of each free allowance is left: models today, shared pools, app tool calls this month, storage."""
    tms = await db.select("teammates", {"owner_id": f"eq.{user['id']}", "select": "model"})
    models = [config.DEFAULT_MODEL, config.ROUTER_MODEL, config.KEEPER_MODEL, config.LEARN_MODEL, *llm.fallbacks(),
              *(t["model"] for t in tms if t.get("model"))]
    return await usage.report(list(dict.fromkeys(models)))


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
