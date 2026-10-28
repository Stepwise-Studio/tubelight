"""Short-term (checkpointer) and long-term (store) memory.

Postgres when SUPABASE_DB_URL is set (schema `langgraph`), in-memory otherwise.
Embeddings: fastembed BAAI/bge-small-en-v1.5 (384 dims), local, no API requests.
"""
import asyncio
import logging
import uuid
from functools import lru_cache
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.base import BaseStore
from langgraph.store.memory import InMemoryStore

from . import config

log = logging.getLogger(__name__)
DIMS = 384

checkpointer: BaseCheckpointSaver = MemorySaver()
store: BaseStore = InMemoryStore()
db_ok = False
_pool = None


@lru_cache(maxsize=1)
def _embedder():
    from fastembed import TextEmbedding

    return TextEmbedding("BAAI/bge-small-en-v1.5")


def _embed_sync(texts: list[str]) -> list[list[float]]:
    return [v.tolist() for v in _embedder().embed(texts)]


async def _embed_cloudflare(texts: list[str]) -> list[list[float]]:
    """The same bge-small-en-v1.5 on Workers AI: no local model in RAM (small servers, CPUs without AVX)."""
    import httpx

    url = f"https://api.cloudflare.com/client/v4/accounts/{config.env('CF_ACCOUNT_ID')}/ai/run/@cf/baai/bge-small-en-v1.5"
    async with httpx.AsyncClient(timeout=30) as c:
        for wait in (2, 6, 0):  # a rate limit or a hiccup is usually gone in seconds (2026-10-27: three runs died on one)
            r = await c.post(url, headers={"Authorization": f"Bearer {config.env('CF_API_TOKEN')}"}, json={"text": texts})
            if r.status_code != 429 and r.status_code < 500 or not wait:
                break
            await asyncio.sleep(wait)
    r.raise_for_status()
    return r.json()["result"]["data"]


async def embed(texts: list[str]) -> list[list[float]]:
    if config.env("EMBEDDINGS") == "cloudflare":
        return await _embed_cloudflare(texts)
    return await asyncio.to_thread(_embed_sync, texts)


def index_config(embed_fn=embed) -> dict[str, Any]:
    return {"dims": DIMS, "embed": embed_fn, "fields": ["text"]}


async def init(embed_fn=embed) -> None:
    global checkpointer, store, db_ok, _pool
    if not config.SUPABASE_DB_URL:
        checkpointer, store, db_ok = MemorySaver(), InMemoryStore(index=index_config(embed_fn)), False
        log.warning("SUPABASE_DB_URL is empty: using in-memory checkpointer and store")
        return
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from langgraph.store.postgres import AsyncPostgresStore
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    async def use_langgraph_schema(conn) -> None:
        # Supabase installs pgvector in `extensions`; it must be visible for the store's vector column.
        await conn.execute("SET search_path TO langgraph, public, extensions")

    # Port 6543 is Supabase's transaction pooler, which cannot keep prepared statements.
    prepare = None if ":6543/" in config.SUPABASE_DB_URL else 0
    _pool = AsyncConnectionPool(
        config.SUPABASE_DB_URL,
        min_size=1,
        max_size=10,
        open=False,
        configure=use_langgraph_schema,
        check=AsyncConnectionPool.check_connection,  # drop connections that died (e.g. a network change)
        kwargs={"autocommit": True, "prepare_threshold": prepare, "row_factory": dict_row, "connect_timeout": 10,
                "keepalives": 1, "keepalives_idle": 30, "keepalives_interval": 10, "keepalives_count": 3},
    )
    await _pool.open(wait=True, timeout=20)
    async with _pool.connection() as conn:  # never let the tables fall through to `public`
        if not await (await conn.execute("select 1 from pg_namespace where nspname = 'langgraph'")).fetchone():
            raise RuntimeError("schema langgraph is missing; apply supabase/migrations/0001_init.sql first")
    saver, pg_store = AsyncPostgresSaver(_pool), AsyncPostgresStore(_pool, index=index_config(embed_fn))
    await saver.setup()
    await pg_store.setup()
    checkpointer, store = saver, pg_store  # only swap in once setup worked
    async with _pool.connection() as conn:
        rows = await (
            await conn.execute(
                "select table_schema, table_name from information_schema.tables "
                "where table_name in ('checkpoints', 'store', 'store_vectors')"
            )
        ).fetchall()
    log.info("langgraph tables: %s", [f"{r['table_schema']}.{r['table_name']}" for r in rows])
    db_ok = True


async def close() -> None:
    if _pool is not None:
        await _pool.close()


# ------------------------------------------------------------------ namespaces
def ns(scope: str, id: str) -> tuple[str, ...]:
    """scope: teammate | project | user (id = owner id for user)."""
    if scope == "user":
        return (f"user:{id}", "profile")
    return (id, "memories")


# A memory is {text, kind, about, due, done}: kind is person | commitment | preference | lesson | fact,
# about names the people, companies or topics it concerns (the Memory graph links them), and commitments
# carry an optional due date and a done flag. Older rows are just {text}.
KINDS = ("person", "commitment", "preference", "lesson", "fact")


def _row(item) -> dict[str, Any]:
    v = item.value
    return {
        "key": item.key,
        "text": v.get("text", ""),
        "kind": v.get("kind") or "fact",
        "about": v.get("about") or [],
        "due": v.get("due"),
        "done": bool(v.get("done")),
        "created_at": item.created_at.isoformat(),
        "updated_at": item.updated_at.isoformat(),
        **({"score": item.score} if getattr(item, "score", None) is not None else {}),
    }


async def add(namespace: tuple[str, ...], text: str, **meta: Any) -> str:
    key = str(uuid.uuid4())
    await store.aput(namespace, key, {"text": text, **{k: v for k, v in meta.items() if v is not None}})
    return key


async def get(namespace: tuple[str, ...], key: str) -> dict[str, Any] | None:
    item = await store.aget(namespace, key)
    return _row(item) if item else None


async def update(namespace: tuple[str, ...], key: str, **changes: Any) -> bool:
    """Merge changes into a memory (text, done, due, about...). False when it no longer exists."""
    item = await store.aget(namespace, key)
    if not item:
        return False
    await store.aput(namespace, key, {**item.value, **{k: v for k, v in changes.items() if v is not None}})
    return True


async def listing(namespace: tuple[str, ...], limit: int = 100, **filter: Any) -> list[dict[str, Any]]:
    items = await store.asearch(namespace, filter=filter or None, limit=limit)
    return sorted((_row(i) for i in items), key=lambda r: r["created_at"], reverse=True)


async def search_rows(namespace: tuple[str, ...], query: str, limit: int = 4) -> list[dict[str, Any]]:
    return [_row(i) for i in await store.asearch(namespace, query=query or None, limit=limit)]


async def search(namespace: tuple[str, ...], query: str, limit: int = 4) -> list[str]:
    return [r["text"] for r in await search_rows(namespace, query, limit)]


async def remove(namespace: tuple[str, ...], key: str) -> None:
    await store.adelete(namespace, key)
