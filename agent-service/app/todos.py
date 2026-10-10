"""To-dos: the user's own list (the app's Tasks tab), Linear-style. Teammates add, read and update it too (tool
`todos`), and say so in the chat with a capsule.

Kept in the store per user (("todos", owner)), not embedded. Status: backlog, todo, doing, done, canceled.
Priority is Linear's: 0 none, 1 urgent, 2 high, 3 medium, 4 low. `sort` orders a status column (ascending; new ones
go on top), `due` is a date.
"""
import time
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

from . import db, memory

STATUSES = ("backlog", "todo", "doing", "done", "canceled")
STATUS_NAMES = {"backlog": "Backlog", "todo": "Todo", "doing": "In progress", "done": "Done", "canceled": "Canceled"}
PRIORITY_NAMES = {0: "", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low"}
EDITABLE = ("title", "notes", "status", "priority", "due", "project_id", "assignee", "sort")


def _ns(owner_id: str) -> tuple[str, ...]:
    return ("todos", owner_id)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def clean(changes: dict[str, Any]) -> dict[str, Any]:
    """The editable fields of a change, validated; raises ValueError with a sentence for the user."""
    out: dict[str, Any] = {}
    for k, v in changes.items():
        if k not in EDITABLE:
            continue
        if k == "title":
            v = " ".join(str(v or "").split())[:300]
            if not v:
                raise ValueError("A to-do needs a title.")
        elif k == "notes":
            v = str(v or "")[:5000]
        elif k == "status" and v not in STATUSES:
            raise ValueError(f"Status is one of: {', '.join(STATUSES)}.")
        elif k == "priority":
            v = int(v or 0)
            if not 0 <= v <= 4:
                raise ValueError("Priority is 0 (none) to 4 (low); 1 is urgent.")
        elif k == "due":
            try:
                v = date.fromisoformat(str(v)[:10]).isoformat() if v else None
            except ValueError:
                raise ValueError("Give the due date as YYYY-MM-DD.") from None
        elif k in ("project_id", "assignee"):
            v = v or None
        elif k == "sort":
            v = float(v)
        out[k] = v
    return out


async def listing(owner_id: str) -> list[dict[str, Any]]:
    """Every to-do, in board order."""
    items = await memory.store.asearch(_ns(owner_id), limit=5000)
    return sorted(({"id": i.key, **i.value} for i in items), key=lambda t: (t.get("sort", 0), t.get("created_at", "")))


async def get(owner_id: str, key: str) -> dict[str, Any] | None:
    item = await memory.store.aget(_ns(owner_id), key)
    return {"id": key, **item.value} if item else None


async def add(owner_id: str, title: str, *, added_by: str | None = None, thread_id: str | None = None,
              id: str | None = None, **fields: Any) -> dict[str, Any]:
    """`id`: the phone makes its own (offline to-dos), so sending the same add twice keeps one."""
    if id:
        key = str(uuid.UUID(id))  # ValueError for anything that isn't one
        if existing := await get(owner_id, key):
            return existing
    now = _now()
    t: dict[str, Any] = {"title": "", "notes": "", "status": "todo", "priority": 0, "due": None, "project_id": None, "assignee": None,
                         "sort": -time.time(), **clean({**fields, "title": title}),
                         "added_by": added_by, "thread_id": thread_id, "created_at": now, "updated_at": now}
    t["completed_at"] = now if t["status"] == "done" else None
    key = str(uuid.UUID(id)) if id else str(uuid.uuid4())
    await memory.store.aput(_ns(owner_id), key, t, index=False)
    return {"id": key, **t}


async def update(owner_id: str, key: str, changes: dict[str, Any]) -> dict[str, Any] | None:
    item = await memory.store.aget(_ns(owner_id), key)
    if not item:
        return None
    ch = clean(changes)
    t = {**item.value, **ch, "updated_at": _now()}
    if "status" in ch and ch["status"] != item.value.get("status"):
        t["completed_at"] = _now() if ch["status"] == "done" else None
    await memory.store.aput(_ns(owner_id), key, t, index=False)
    return {"id": key, **t}


async def remove(owner_id: str, key: str) -> bool:
    if not await memory.store.aget(_ns(owner_id), key):
        return False
    await memory.store.adelete(_ns(owner_id), key)
    return True


async def find(owner_id: str, ref: str) -> dict[str, Any] | None:
    """A to-do by id or the id's first characters (what the tool shows), or by its exact title."""
    ref = ref.strip().strip("[]")
    rows = await listing(owner_id)
    hits = [t for t in rows if t["id"].startswith(ref)] if len(ref) >= 6 else []
    hits = hits or [t for t in rows if t["title"].lower() == ref.lower()]
    return hits[0] if len(hits) == 1 else None


def describe(t: dict[str, Any], names: dict[str, str] | None = None) -> str:
    """One line for a teammate: id, title, status, priority, due, who added it."""
    bits = [STATUS_NAMES.get(t["status"], t["status"])]
    if PRIORITY_NAMES.get(t.get("priority") or 0):
        bits.append(PRIORITY_NAMES[t["priority"]])
    if t.get("due"):
        bits.append(f"due {date.fromisoformat(t['due']):%a %b %d}")
    if t.get("assignee"):
        bits.append(f"assigned to {(names or {}).get(t['assignee'], 'a teammate')}")
    if t.get("added_by"):
        bits.append(f"added by {(names or {}).get(t['added_by'], 'a teammate')}")
    notes = f" — {t['notes'][:160]}" if t.get("notes") else ""
    return f"- [{t['id'][:8]}] {t['title']} · {' · '.join(bits)}{notes}"


def open_and_recent(rows: list[dict[str, Any]], days: int = 7) -> list[dict[str, Any]]:
    """What a teammate needs to see: everything open, and what was finished in the last week."""
    since = (datetime.now(UTC) - timedelta(days=days)).isoformat()
    return [t for t in rows if t["status"] not in ("done", "canceled") or (t.get("completed_at") or t["updated_at"]) >= since]


async def note(owner_id: str, thread_id: str, text: str, event: str) -> None:
    """A capsule in the chat, so the to-do list's changes are visible where they were made."""
    await db.insert("messages", {"thread_id": thread_id, "owner_id": owner_id, "sender_type": "system", "kind": "event",
                                 "text": text, "meta": {"todo": event}})


async def hand_to(owner_id: str, t: dict[str, Any]) -> bool:
    """You assigned a to-do to a teammate: it lands in their chat and they get on with it (and keep its status)."""
    from . import runs  # runs -> graph -> tools -> todos

    mate = await db.one("teammates", {"id": f"eq.{t['assignee']}", "owner_id": f"eq.{owner_id}", "select": "id,name"})
    if not mate:
        return False
    thread = f"dm:{mate['id']}"
    await note(owner_id, thread, f"You assigned {mate['name']} a to-do: {t['title']}", "assigned")
    due = f" Due {date.fromisoformat(t['due']):%a %b %d}." if t.get("due") else ""
    notes = f" Notes: {t['notes'][:1500]}" if t.get("notes") else ""
    await runs.start(owner_id, thread,
                     f"[A to-do they assigned you: [{t['id'][:8]}] {t['title']}.{due}{notes}] Set it to doing with the todos "
                     "tool, do what you can now, tell them here what you did, and mark it done when it's finished. If you "
                     "need something from them first, ask.",
                     trigger="event", teammate_id=mate["id"], event_type="todo")
    return True
