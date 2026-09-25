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


async def embed(texts: list[str]) -> list[list[float]]:
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


def _row(item) -> dict[str, Any]:
    return {
        "key": item.key,
        "text": item.value.get("text", ""),
        "created_at": item.created_at.isoformat(),
        "updated_at": item.updated_at.isoformat(),
    }


async def add(namespace: tuple[str, ...], text: str) -> str:
    key = str(uuid.uuid4())
    await store.aput(namespace, key, {"text": text})
    return key


async def listing(namespace: tuple[str, ...], limit: int = 100) -> list[dict[str, Any]]:
    items = await store.asearch(namespace, limit=limit)
    return sorted((_row(i) for i in items), key=lambda r: r["created_at"], reverse=True)


async def search(namespace: tuple[str, ...], query: str, limit: int = 4) -> list[str]:
    items = await store.asearch(namespace, query=query or None, limit=limit)
    return [i.value.get("text", "") for i in items]


async def remove(namespace: tuple[str, ...], key: str) -> None:
    await store.adelete(namespace, key)
