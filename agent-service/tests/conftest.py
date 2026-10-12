import re
"""Fakes: an in-memory PostgREST (db.*), a scripted chat model, and in-memory LangGraph memory."""
import asyncio
import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from app import connectors, db, llm, memory, runs

OWNER = "00000000-0000-0000-0000-00000000000a"
DEFAULTS = {"approvals": {"status": "pending"}, "events": {"status": "received"}, "runs": {"handoffs": 0},
            "messages": {"kind": "text", "meta": {}, "proactive": False}}


class FakeDB:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {}
        self.broadcasts: list[tuple[str, str, dict]] = []

    @staticmethod
    def _ok(row: dict, key: str, cond: str) -> bool:
        if key in ("select", "order", "limit"):
            return True
        if key == "or":  # (text.ilike.*a*,text.ilike.*b*)
            parts = re.split(r",(?![^()]*\))", cond[1:-1])  # commas outside an in.(...) list
            return any(FakeDB._ok(row, *c.split(".", 1)) for c in parts)
        op, _, val = cond.partition(".")
        if "->>" in key:
            col, sub = key.split("->>")
            v = (row.get(col) or {}).get(sub)
        else:
            v = row.get(key)
        s = str(v).lower() if isinstance(v, bool) else str(v)
        return {"eq": lambda: s == val, "in": lambda: s in val.strip("()").split(","), "gte": lambda: s >= val,
                "gt": lambda: s > val, "ilike": lambda: val.strip("*").lower() in s.lower(), "neq": lambda: s != val,
                "like": lambda: s.startswith(val.rstrip("*")),  # ponytail: trailing-* prefixes only
                "not": lambda: not FakeDB._ok(row, key, val),
                "is": lambda: v is None if val == "null" else s == val}[op]()

    def rows(self, table: str, **eq: Any) -> list[dict]:
        return [r for r in self.tables.get(table, []) if all(r.get(k) == v for k, v in eq.items())]

    async def select(self, table: str, params: dict[str, str]) -> list[dict]:
        out = [r for r in self.tables.get(table, []) if all(self._ok(r, k, c) for k, c in params.items())]
        if "order" in params:
            col, _, way = params["order"].partition(".")
            out.sort(key=lambda r: str(r.get(col, "")), reverse=way == "desc")
        return [dict(r) for r in out[: int(params.get("limit", 10**6))]]

    async def one(self, table: str, params: dict[str, str]):
        rows = await self.select(table, params)
        return rows[0] if rows else None

    async def insert(self, table: str, row: dict) -> dict:
        row = {"id": str(uuid.uuid4()), "created_at": datetime.now(UTC).isoformat(), **DEFAULTS.get(table, {}), **row}
        self.tables.setdefault(table, []).append(row)
        return dict(row)

    async def update(self, table: str, match: dict[str, str], values: dict) -> list[dict]:
        hit = [r for r in self.tables.get(table, []) if all(self._ok(r, k, c) for k, c in match.items())]
        for r in hit:
            r.update(values)
        return [dict(r) for r in hit]

    async def delete(self, table: str, match: dict[str, str]) -> None:
        self.tables[table] = [r for r in self.tables.get(table, []) if not all(self._ok(r, k, c) for k, c in match.items())]

    async def broadcast(self, thread_id: str, event: str, payload: dict) -> None:
        self.broadcasts.append((thread_id, event, payload))


class FakeLLM(BaseChatModel):
    """Pops scripted replies. A script item may be a callable(messages) -> AIMessage."""

    script: list[Any] = []
    calls: list[list[BaseMessage]] = []

    @property
    def _llm_type(self) -> str:
        return "fake"

    def _generate(self, messages, stop=None, run_manager=None, **kw) -> ChatResult:
        self.calls.append(list(messages))
        nxt = self.script.pop(0)
        msg = nxt(messages) if callable(nxt) else nxt
        meta = {"finish_reason": "stop", **msg.response_metadata}  # like a real provider; a test can drop it
        return ChatResult(generations=[ChatGeneration(message=msg.model_copy(update={"response_metadata": meta}))])

    def bind_tools(self, tools, **kw):
        return self


def fake_embed(texts: list[str]) -> list[list[float]]:
    out = []
    for t in texts:
        v = [0.0] * memory.DIMS
        for w in t.lower().split():
            v[int(hashlib.md5(w.encode()).hexdigest(), 16) % memory.DIMS] += 1.0
        out.append(v)
    return out


@pytest.fixture
async def env(monkeypatch):
    fdb = FakeDB()
    for name in ("select", "one", "insert", "update", "delete", "broadcast"):
        monkeypatch.setattr(db, name, getattr(fdb, name))

    async def no_tz(user_id: str) -> None:
        return None
    monkeypatch.setattr(db, "user_timezone", no_tz)
    from app import learn
    monkeypatch.setattr(learn, "schedule", lambda *a: None)  # tested on its own in test_learn
    from app import brief
    monkeypatch.setattr(brief, "schedule", lambda *a: None)  # tested on its own in test_memory
    fake = FakeLLM(script=[], calls=[])
    monkeypatch.setattr(llm, "chat_model", lambda model=None, tools=None, size=0, json=False, skip=0: fake)

    async def ctx_window(model: str) -> int:
        return 32_000

    monkeypatch.setattr(llm, "context_window", ctx_window)
    monkeypatch.setattr(connectors, "tools_for", _no_tools)

    async def nothing_connected(user_id: str) -> set[str]:
        return set()

    async def no_catalog() -> list:
        return []

    monkeypatch.setattr(connectors, "ready", nothing_connected)  # never reach the real Composio from tests
    monkeypatch.setattr(connectors, "catalog", no_catalog)
    monkeypatch.setattr(runs, "docker_ok", False)
    monkeypatch.setattr(memory.config, "SUPABASE_DB_URL", "")
    await memory.init(embed_fn=fake_embed)
    fdb.tables["profiles"] = [{"id": OWNER, "display_name": "Akhil", "webhook_token": "tok123"}]
    return fdb, fake


async def _no_tools(user_id, toolkits):
    return []


def teammate(fdb: FakeDB, handle: str, role: str, **kw) -> dict:
    row = {"id": str(uuid.uuid4()), "owner_id": OWNER, "name": handle.title(), "handle": handle, "role": role,
           "bio": "", "system_prompt": f"You are the {role}.", "model": "fake", "allowed_toolkits": [], **kw}
    fdb.tables.setdefault("teammates", []).append(row)
    fdb.tables.setdefault("threads", []).append(
        {"id": f"dm:{row['id']}", "owner_id": OWNER, "kind": "dm", "teammate_id": row["id"]})
    return row


def project(fdb: FakeDB, members: list[dict], name: str = "Launch") -> dict:
    row = {"id": str(uuid.uuid4()), "owner_id": OWNER, "name": name, "description": "", "repo_url": None}
    fdb.tables.setdefault("projects", []).append(row)
    fdb.tables.setdefault("threads", []).append(
        {"id": f"proj:{row['id']}", "owner_id": OWNER, "kind": "project", "project_id": row["id"]})
    for i, m in enumerate(members):
        fdb.tables.setdefault("project_members", []).append(
            {"project_id": row["id"], "teammate_id": m["id"], "owner_id": OWNER, "added_at": f"2026-01-0{i + 1}"})
    return row


async def settle() -> None:
    while runs.tasks:
        await asyncio.gather(*list(runs.tasks.values()), return_exceptions=True)


@pytest.fixture
async def api(env):
    from app.auth import current_user
    from app.main import app

    app.dependency_overrides[current_user] = lambda: {"id": OWNER}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


def plan(*speakers: tuple[str, str], read: str = "", when: str = "now") -> AIMessage:
    """The floor director's reply: ordered (handle, part) pairs; `when`: now, YYYY-MM-DDTHH:MM or condition."""
    return AIMessage(json.dumps({"read": read, "when": when, "speakers": [{"handle": h, "part": p} for h, p in speakers]}))


def ai(text: str = "", calls: list[tuple[str, dict]] | None = None) -> AIMessage:
    return AIMessage(text, tool_calls=[{"name": n, "args": a, "id": f"call_{uuid.uuid4().hex[:8]}"} for n, a in calls or []])

