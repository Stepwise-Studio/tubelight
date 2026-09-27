"""Composio Platform connectors via sessions. Optional: without COMPOSIO_API_KEY everything reports unavailable.

Composio user_id = Supabase user id. Teammates get the session meta tools (search, schemas, multi-execute)
scoped to their allowed toolkits: a toolkit's direct tools are far too large for a free model's context
(GitHub alone is ~870 tools). Connections are made from the app's own UI, so in-chat connection
management and Composio's remote sandbox are off. The SDK is sync, so calls run in a thread.
"""
import asyncio
import copy
import difflib
import logging
import re
import time
from functools import lru_cache
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool

from . import config

log = logging.getLogger(__name__)
DEFAULT_TOOLKITS = {"GMAIL": "Gmail", "GITHUB": "GitHub", "LINEAR": "Linear", "NOTION": "Notion"}
SESSION_TTL = 3600
CATALOG_TTL = 6 * 3600
_catalog: tuple[float, list[dict[str, Any]]] = (0.0, [])
_sessions: dict[tuple[str, tuple[str, ...]], tuple[float, Any]] = {}


def enabled() -> bool:
    return bool(config.COMPOSIO_API_KEY)


@lru_cache(maxsize=1)
def _client():
    from composio import Composio
    from composio_langchain import LangchainProvider

    return Composio(provider=LangchainProvider(), api_key=config.COMPOSIO_API_KEY)


def _session(user_id: str, toolkits: tuple[str, ...] | None = None):
    """One session per user and toolkit scope, reused for an hour. None = unrestricted (connection UI)."""
    # ponytail: in-process cache; persist session ids if sessions must survive restarts
    k = (user_id, toolkits or ())
    hit = _sessions.get(k)
    if hit and hit[0] > time.time():
        return hit[1]
    scope = {"toolkits": [t.lower() for t in toolkits]} if toolkits is not None else {}
    s = _client().create(user_id=user_id, manage_connections=False, sandbox={"enable": False}, **scope)
    _sessions[k] = (time.time() + SESSION_TTL, s)
    return s


def _row(state) -> dict[str, Any]:
    conn = state.connection
    account = getattr(conn, "connected_account", None) if conn else None
    active = bool(conn and conn.is_active)
    status = "active" if active else (str(getattr(account, "status", "") or "not_connected").lower())
    row = {"toolkit": state.slug.upper(), "name": state.name, "connected": active, "status": status}
    if account is not None and getattr(account, "id", None):
        row["account"] = account.id
    return row


async def list_connections(user_id: str) -> list[dict[str, Any]]:
    if not enabled():
        return [{"toolkit": s, "name": n, "connected": False, "status": "unavailable"} for s, n in DEFAULT_TOOLKITS.items()]

    def fetch() -> list[dict[str, Any]]:
        s = _session(user_id)
        states = s.toolkits(toolkits=[t.lower() for t in DEFAULT_TOOLKITS]).items + s.toolkits(is_connected=True).items
        rows: dict[str, dict[str, Any]] = {}
        for st in states:
            rows.setdefault(st.slug.upper(), _row(st))
        return list(rows.values())

    return await asyncio.to_thread(fetch)


def _auth(t: dict[str, Any]) -> str:
    """none: works without signing in. oauth: one-tap sign-in Composio manages. key: Composio's hosted page asks for a key."""
    if t.get("no_auth"):
        return "none"
    return "oauth" if t.get("composio_managed_auth_schemes") else "key"


async def catalog() -> list[dict[str, Any]]:
    """Every Composio toolkit, most used first. Cached: it's ~1.5k rows and changes slowly."""
    global _catalog
    if _catalog[1] and _catalog[0] > time.time():
        return _catalog[1]
    if not enabled():
        return [{"toolkit": s, "name": n, "logo": "", "description": "", "categories": [], "tools": 0, "auth": "oauth"}
                for s, n in DEFAULT_TOOLKITS.items()]

    def fetch() -> list[dict[str, Any]]:
        rows, cursor = [], None
        while True:
            page = _client().toolkits.list(limit=1000, cursor=cursor, sort_by="usage")
            for item in page.items:
                t = item.model_dump()
                if t.get("is_local_toolkit") or t["slug"] == "composio":
                    continue
                meta = t.get("meta") or {}
                rows.append({
                    "toolkit": t["slug"].upper(), "name": t["name"], "logo": meta.get("logo") or "",
                    "description": " ".join((meta.get("description") or "").split())[:160],
                    "categories": [c["name"] for c in meta.get("categories") or [] if c.get("name")],
                    "tools": int(meta.get("tools_count") or 0), "auth": _auth(t),
                })
            cursor = page.next_cursor
            if not cursor or not page.items:
                return rows

    rows = await asyncio.to_thread(fetch)
    _catalog = (time.time() + CATALOG_TTL, rows)
    return rows


async def ready(user_id: str) -> set[str]:
    """Toolkits a teammate can use right now: connected ones plus those that need no sign-in."""
    connected = {c["toolkit"] for c in await list_connections(user_id) if c["connected"]}
    return connected | {t["toolkit"] for t in await catalog() if t["auth"] == "none"}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


async def resolve(toolkit: str) -> str | None:
    """The catalog slug for whatever a model called an app: GOOGLE_CALENDAR, "Google Calendar" -> GOOGLECALENDAR."""
    want = _norm(toolkit)
    if not want:
        return None
    return next((t["toolkit"] for t in await catalog() if want in (_norm(t["toolkit"]), _norm(t["name"]))), None)


async def similar(toolkit: str, n: int = 3) -> list[str]:
    names = {_norm(t["name"]): t["name"] for t in await catalog()}
    return [names[k] for k in difflib.get_close_matches(_norm(toolkit), list(names), n=n, cutoff=0.6)]


def name_of(toolkit: str) -> str:
    return next((t["name"] for t in _catalog[1] if t["toolkit"] == toolkit), DEFAULT_TOOLKITS.get(toolkit, toolkit.title()))


async def connect(user_id: str, toolkit: str, callback_url: str) -> str:
    req = await asyncio.to_thread(lambda: _session(user_id).authorize(toolkit.lower(), callback_url=callback_url))
    return req.redirect_url


async def disconnect(user_id: str, toolkit: str) -> None:
    c = _client()
    res = await asyncio.to_thread(c.connected_accounts.list, user_ids=[user_id], toolkit_slugs=[toolkit.lower()])
    for acc in res.items:
        await asyncio.to_thread(c.connected_accounts.delete, acc.id)


def _nullable(schema: Any) -> Any:
    """Composio's optional fields default to null but are typed non-null (e.g. known_fields: string). Models send
    the null and strict validators (Groq) reject the whole call, so let every null-default field accept null."""
    if isinstance(schema, list):
        return [_nullable(v) for v in schema]
    if not isinstance(schema, dict):
        return schema
    out = {k: _nullable(v) for k, v in schema.items()}
    if "default" in out and out["default"] is None:
        if isinstance(out.get("type"), str) and out["type"] != "null":
            out["type"] = [out["type"], "null"]
        elif "$ref" in out:
            out["anyOf"] = [{"$ref": out.pop("$ref")}, {"type": "null"}]
    return out


def _lean(schema: Any) -> Any:
    """Composio's schemas are verbose (the search tool alone is ~3k tokens): clip field notes, drop examples and
    titles. Groq's free tier caps a request at 8k tokens per minute, and the tools ride along on every call."""
    if isinstance(schema, list):
        return [_lean(v) for v in schema]
    if not isinstance(schema, dict):
        return schema
    out = {k: _lean(v) for k, v in schema.items() if k not in ("examples", "title")}
    if isinstance(out.get("description"), str) and len(out["description"]) > 160:
        out["description"] = out["description"][:157].rsplit(" ", 1)[0] + "..."
    return out


def _clip(text: str, n: int = 700) -> str:
    return text if len(text) <= n else text[:n].rsplit(" ", 1)[0] + "..."


def _drop_nones(v: Any) -> Any:
    if isinstance(v, dict):
        return {k: _drop_nones(x) for k, x in v.items() if x is not None}
    if isinstance(v, list):
        return [_drop_nones(x) for x in v]
    return v


def _lenient(t: BaseTool) -> BaseTool:
    """The same tool with null-tolerant arguments; nulls are dropped before Composio sees them."""
    raw = t.args_schema if isinstance(t.args_schema, dict) else t.args_schema.model_json_schema()
    return StructuredTool(name=t.name, description=_clip(t.description), args_schema=_lean(_nullable(copy.deepcopy(raw))),
                          func=lambda **kw: t.invoke(_drop_nones(kw)))


async def tools_for(user_id: str, toolkits: list[str]) -> list[BaseTool]:
    if not enabled() or not toolkits:
        return []
    try:
        tools = await asyncio.to_thread(lambda: _session(user_id, tuple(sorted(toolkits))).tools())
        return [_lenient(t) for t in tools]
    except Exception as e:  # a connector outage must not break the teammate
        log.warning("composio tools unavailable: %s", e)
        return []
