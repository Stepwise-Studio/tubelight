"""Supabase PostgREST + Realtime broadcast over httpx with the service role key."""
import logging
from datetime import UTC, datetime
from typing import Any

import httpx

from . import config

log = logging.getLogger(__name__)
_client: httpx.AsyncClient | None = None


class DBError(RuntimeError):
    pass


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        key = config.SUPABASE_SERVICE_ROLE_KEY
        _client = httpx.AsyncClient(
            base_url=config.SUPABASE_URL,
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=20,
        )
    return _client


def now() -> str:
    return datetime.now(UTC).isoformat()


def _check(r: httpx.Response) -> None:
    if r.is_error:
        raise DBError(f"Database request failed ({r.status_code}): {r.text[:300]}")


async def select(table: str, params: dict[str, str]) -> list[dict[str, Any]]:
    """params are raw PostgREST filters, e.g. {"id": "eq.x", "select": "*"}."""
    r = await client().get(f"/rest/v1/{table}", params={"select": "*", **params})
    _check(r)
    return r.json()


async def one(table: str, params: dict[str, str]) -> dict[str, Any] | None:
    rows = await select(table, {**params, "limit": "1"})
    return rows[0] if rows else None


async def insert(table: str, row: dict[str, Any]) -> dict[str, Any]:
    r = await client().post(f"/rest/v1/{table}", json=row, headers={"Prefer": "return=representation"})
    _check(r)
    return r.json()[0]


async def update(table: str, match: dict[str, str], values: dict[str, Any]) -> list[dict[str, Any]]:
    r = await client().patch(
        f"/rest/v1/{table}", params=match, json=values, headers={"Prefer": "return=representation"}
    )
    _check(r)
    return r.json()


async def delete(table: str, match: dict[str, str]) -> None:
    _check(await client().delete(f"/rest/v1/{table}", params=match))


async def broadcast(thread_id: str, event: str, payload: dict[str, Any]) -> None:
    """Send to the private channel thread:<id>. Best effort: never breaks a run."""
    body = {"messages": [{"topic": f"thread:{thread_id}", "event": event, "payload": payload, "private": True}]}
    try:
        r = await client().post("/realtime/v1/api/broadcast", json=body)
        if r.is_error:
            log.warning("broadcast failed %s: %s", r.status_code, r.text[:200])
    except httpx.HTTPError as e:
        log.warning("broadcast failed: %s", e)


async def activity(owner_id: str, type: str, name: str = "", **fields: Any) -> None:
    """Activity log rows are best effort too."""
    try:
        await insert("activity", {"owner_id": owner_id, "type": type, "name": name, **fields})
    except (DBError, httpx.HTTPError) as e:
        log.warning("activity insert failed: %s", e)
