import asyncio
import faulthandler
import logging
import signal
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import httpx
import yaml
from fastapi import Depends, FastAPI, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import config, connectors, db, events, files, llm, memory, runs, sandbox, voice
from .auth import current_user

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)  # request URLs can carry webhook tokens
log = logging.getLogger("tubelight")
TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "teammates"
User = dict[str, Any]


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        await memory.init()
    except Exception as e:
        log.error("Postgres memory unavailable (%s); using in-memory checkpointer and store", e)
        await memory.close()
        memory.config.SUPABASE_DB_URL = ""
        await memory.init()
    runs.docker_ok = await asyncio.to_thread(sandbox.available)
    await runs.sweep_orphans()
    asyncio.get_running_loop().add_signal_handler(signal.SIGUSR1, _dump_stacks)
    scheduler = asyncio.create_task(events.schedule_loop())
    yield
    scheduler.cancel()
    for t in list(runs.tasks.values()):
        t.cancel()
    await memory.close()


def _dump_stacks() -> None:
    """`kill -USR1 <pid>` prints every asyncio task and thread stack to stderr, for diagnosing hangs."""
    for task in asyncio.all_tasks():
        task.print_stack(limit=40, file=sys.stderr)
    faulthandler.dump_traceback(all_threads=True)


app = FastAPI(title="Tubelight agent service", lifespan=lifespan)
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
    voice: bool = False  # sent from voice mode: the teammate answers as speech


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


@app.post("/threads/{thread_id}/messages")
async def post_message(thread_id: str, body: MessageIn, user: User = Depends(current_user)):
    if not body.text.strip() and not body.attachments:
        raise HTTPException(400, "Write a message first.")
    thread = await owned("threads", thread_id, user, "conversation")
    meta = {"attachments": body.attachments} if body.attachments else {}
    message = await db.insert("messages", {"thread_id": thread_id, "owner_id": user["id"], "sender_type": "user",
                                           "text": body.text, "mentions": body.mentions, "reply_to": body.reply_to,
                                           "meta": meta})
    prompt = await _quoted(thread_id, body.reply_to) + body.text + await files.describe(user["id"], body.attachments)
    if body.voice:
        prompt += voice.INSTRUCTION
    run_id = await runs.start(user["id"], thread_id, prompt, mentions=body.mentions,
                              teammate_id=thread.get("teammate_id"))
    await db.update("messages", {"id": f"eq.{message['id']}"}, {"run_id": run_id})
    return {"message": {**message, "run_id": run_id}, "run_id": run_id}


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
        if not any(c["toolkit"] == toolkit and c["connected"] for c in await connectors.list_connections(user["id"])):
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
@app.post("/voice/transcribe")
async def transcribe(audio: UploadFile, user: User = Depends(current_user)):
    return {"text": await voice.transcribe(await audio.read(), audio.filename or "speech.m4a")}


class SpeakIn(BaseModel):
    text: str
    teammate_id: str | None = None


@app.post("/voice/speak")
async def speak(body: SpeakIn, user: User = Depends(current_user)):
    return Response(await voice.speak(body.text, body.teammate_id), media_type="audio/wav")


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
    try:
        return {"redirect_url": await connectors.connect(user["id"], toolkit, body.callback_url)}
    except Exception:
        log.exception("composio connect failed")
        raise HTTPException(502, f"Could not start connecting {toolkit.title()}. Try again in a moment.")


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


@app.post("/event-rules/{rule_id}/test")
async def test_rule(rule_id: str, user: User = Depends(current_user)):
    rule = await owned("event_rules", rule_id, user, "rule")
    return {"ok": True, "event_id": await events.test_rule(rule)}
