"""Composio Platform connectors via sessions. Optional: without COMPOSIO_API_KEY everything reports unavailable.

Composio user_id = Supabase user id. Teammates get the session meta tools (search, schemas, multi-execute)
scoped to their allowed toolkits: a toolkit's direct tools are far too large for a free model's context
(GitHub alone is ~870 tools). Connections are made from the app's own UI, so in-chat connection
management and Composio's remote sandbox are off. The SDK is sync, so calls run in a thread.
"""
import asyncio
import logging
import time
from functools import lru_cache
from typing import Any

from langchain_core.tools import BaseTool

from . import config

log = logging.getLogger(__name__)
DEFAULT_TOOLKITS = {"GMAIL": "Gmail", "GITHUB": "GitHub", "LINEAR": "Linear", "NOTION": "Notion"}
SESSION_TTL = 3600
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


async def connect(user_id: str, toolkit: str, callback_url: str) -> str:
    req = await asyncio.to_thread(lambda: _session(user_id).authorize(toolkit.lower(), callback_url=callback_url))
    return req.redirect_url


async def disconnect(user_id: str, toolkit: str) -> None:
    c = _client()
    res = await asyncio.to_thread(c.connected_accounts.list, user_ids=[user_id], toolkit_slugs=[toolkit.lower()])
    for acc in res.items:
        await asyncio.to_thread(c.connected_accounts.delete, acc.id)


async def tools_for(user_id: str, toolkits: list[str]) -> list[BaseTool]:
    if not enabled() or not toolkits:
        return []
    try:
        return list(await asyncio.to_thread(lambda: _session(user_id, tuple(sorted(toolkits))).tools()))
    except Exception as e:  # a connector outage must not break the teammate
        log.warning("composio tools unavailable: %s", e)
        return []
