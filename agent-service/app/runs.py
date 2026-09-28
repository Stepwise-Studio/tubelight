"""Run lifecycle: background tasks, per-thread locks, cancel, approval resume."""
import asyncio
import logging
from collections import defaultdict
from typing import Any

from langchain_core.messages import HumanMessage
from langgraph.errors import GraphRecursionError
from langgraph.types import Command

from . import db, graph, learn, llm, memory, sandbox

log = logging.getLogger(__name__)
tasks: dict[str, asyncio.Task] = {}
_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
docker_ok = False  # set at startup
RUN_TIMEOUT_S = 15 * 60  # a run past this is hung, not slow (sandbox commands cap at 10 minutes)


async def load_ctx(run_id: str, owner_id: str, thread_id: str, trigger: str, event_type: str | None = None) -> graph.RunCtx:
    thread = await db.one("threads", {"id": f"eq.{thread_id}", "owner_id": f"eq.{owner_id}"})
    if not thread:
        raise LookupError("This conversation no longer exists.")
    project = None
    if thread["kind"] == "dm":
        members = await db.select("teammates", {"id": f"eq.{thread['teammate_id']}"})
    else:
        project = await db.one("projects", {"id": f"eq.{thread['project_id']}"})
        links = await db.select("project_members", {"project_id": f"eq.{thread['project_id']}", "order": "added_at"})
        ids = [l["teammate_id"] for l in links]
        rows = {t["id"]: t for t in await db.select("teammates", {"id": f"in.({','.join(ids)})"})} if ids else {}
        members = [rows[i] for i in ids if i in rows]
    if not members:
        raise LookupError("Add a teammate to this project first.")
    profile = await db.one("profiles", {"id": f"eq.{owner_id}"})
    return graph.RunCtx(
        run_id=run_id, owner_id=owner_id, thread_id=thread_id, members=members, project=project,
        user_name=(profile or {}).get("display_name") or "the user", trigger=trigger, event_type=event_type,
        timezone=await db.user_timezone(owner_id) or "UTC",
        docker=docker_ok,
    )


async def sweep_orphans() -> None:
    """Runs still marked running at startup died with the previous process; close them out."""
    for run in await db.select("runs", {"status": "eq.running"}):
        await _finish(run["id"], run["owner_id"], run["thread_id"], "error", "Interrupted by a server restart.",
                      teammate_id=run["teammate_id"])


async def start(owner_id: str, thread_id: str, text: str, *, mentions: list[str] | None = None, apps: list[str] | None = None,
                trigger: str = "message", teammate_id: str | None = None, event_type: str | None = None,
                sender: str | None = None, message_id: str | None = None) -> str:
    """Insert a runs row and start the graph in the background. Returns run_id."""
    run = await db.insert("runs", {"owner_id": owner_id, "thread_id": thread_id, "trigger": trigger,
                                   "teammate_id": teammate_id, "status": "running"})
    await db.activity(owner_id, "run_start", trigger, run_id=run["id"], thread_id=thread_id, teammate_id=teammate_id)
    # A named teammate (a DM, an event, a schedule) answers; in a group, the floor plan decides (floor.py): tags are
    # evidence there, not orders ("everyone roast @dev" is for the whole group).
    queue = [teammate_id] if teammate_id else []
    # With the message's id, a retry replaces the failed attempt's copy in the history instead of adding a second one.
    kw: dict[str, Any] = {"id": f"user:{message_id}"} if message_id else {}
    if apps:
        kw["additional_kwargs"] = {"apps": list(apps)}
    state = {"messages": [HumanMessage(text, name=sender, **kw) if sender else HumanMessage(text, **kw)],
             "queue": queue, "active": None, "handoffs": 0, "plan": {}, "pending": [], "decisions": {}}
    _spawn(run["id"], _execute(run["id"], owner_id, thread_id, trigger, state, event_type))
    return run["id"]


async def resume(run: dict[str, Any], decision: dict[str, Any]) -> None:
    await db.update("runs", {"id": f"eq.{run['id']}"}, {"status": "running"})
    _spawn(run["id"], _execute(run["id"], run["owner_id"], run["thread_id"], run["trigger"], Command(resume=decision)))


async def cancel(run: dict[str, Any]) -> None:
    task = tasks.get(run["id"])
    if task:
        task.cancel()
    elif run["status"] in ("running", "waiting_approval"):
        await db.update("approvals", {"run_id": f"eq.{run['id']}", "status": "eq.pending"}, {"status": "expired"})
        await _finish(run["id"], run["owner_id"], run["thread_id"], "cancelled")
        sandbox.cleanup_workdir(run["id"])


def _spawn(run_id: str, coro) -> None:
    task = asyncio.create_task(coro)
    tasks[run_id] = task
    task.add_done_callback(lambda _: tasks.pop(run_id, None))


async def _finish(run_id: str, owner_id: str, thread_id: str, status: str, error: str | None = None,
                  teammate_id: str | None = None) -> None:
    await db.update("runs", {"id": f"eq.{run_id}"}, {"status": status, "error": error, "ended_at": db.now()})
    await db.activity(owner_id, "run_end", status, run_id=run_id, thread_id=thread_id, teammate_id=teammate_id,
                      status="error" if status == "error" else "ok", output={"error": error} if error else None)
    await db.broadcast(thread_id, "status", {"run_id": run_id, "teammate_id": teammate_id, "state": "idle"})


async def _supersede(thread_id: str) -> None:
    """A new message arrived while the thread waited for approval: the old request is void."""
    await db.update("approvals", {"thread_id": f"eq.{thread_id}", "status": "eq.pending"}, {"status": "expired"})
    stale = await db.update("runs", {"thread_id": f"eq.{thread_id}", "status": "eq.waiting_approval"},
                            {"status": "cancelled", "error": "Superseded by a newer message.", "ended_at": db.now()})
    for r in stale:
        sandbox.cleanup_workdir(r["id"])
        await db.broadcast(thread_id, "status", {"run_id": r["id"], "teammate_id": r["teammate_id"], "state": "idle"})


async def _execute(run_id: str, owner_id: str, thread_id: str, trigger: str, graph_input: Any,
                   event_type: str | None = None) -> None:
    ctx: graph.RunCtx | None = None
    active, paused = None, False
    try:
        async with _locks[thread_id], asyncio.timeout(RUN_TIMEOUT_S):
            ctx = await load_ctx(run_id, owner_id, thread_id, trigger, event_type)
            app = graph.build(ctx, memory.checkpointer)
            cfg = {"configurable": {"thread_id": thread_id}, "recursion_limit": 100}
            state = await app.aget_state(cfg)
            if isinstance(graph_input, Command):
                if not state.interrupts:
                    await db.update("approvals", {"run_id": f"eq.{run_id}", "status": "eq.approved"}, {"status": "expired"})
                    await _finish(run_id, owner_id, thread_id, "cancelled", "This approval was no longer active.")
                    return
            elif state.interrupts:
                await _supersede(thread_id)
            await app.ainvoke(graph_input, cfg)
            state = await app.aget_state(cfg)
            active = state.values.get("active")
            paused = bool(state.interrupts)
            if paused:
                await db.update("runs", {"id": f"eq.{run_id}"}, {"status": "waiting_approval"})
            else:
                await _finish(run_id, owner_id, thread_id, "done", teammate_id=active)
                tm = next((m for m in ctx.members if m["id"] == active), None) or (
                    ctx.members[0] if len(ctx.members) == 1 else None)
                if tm:
                    learn.schedule(owner_id, ctx.user_name, tm, ctx.project["id"] if ctx.project else None, run_id,
                                   state.values.get("messages") or [], f"{graph.local_now(ctx):%A, %B %d, %Y}")
    except asyncio.CancelledError:
        await _finish(run_id, owner_id, thread_id, "cancelled", teammate_id=active)
    except Exception as e:
        log.exception("run %s failed", run_id)
        text = str(e) if isinstance(e, LookupError) else "This took too long, so I stopped. Try again." if isinstance(
            e, TimeoutError) else (
            "I stopped because this took too many steps. Try splitting the request into smaller parts."
            if isinstance(e, GraphRecursionError) else llm.human_error(e))
        try:
            await db.insert("messages", {"thread_id": thread_id, "owner_id": owner_id, "sender_type": "system",
                                         "text": text, "kind": "error", "run_id": run_id})
            await db.activity(owner_id, "error", type(e).__name__, run_id=run_id, thread_id=thread_id,
                              output={"error": str(e)[:1000]}, status="error")
            await _finish(run_id, owner_id, thread_id, "error", text, teammate_id=active)
        except Exception:
            log.exception("could not record failure of run %s", run_id)
    finally:
        for tm_id, box in (ctx.sandboxes.items() if ctx else []):
            diff = await box.close()
            if diff:
                await db.activity(owner_id, "sandbox", "diff", run_id=run_id, thread_id=thread_id,
                                  teammate_id=tm_id, output={"diff": diff})
        if not paused:  # the workdir outlives an approval pause (git_push needs it)
            sandbox.cleanup_workdir(run_id)
