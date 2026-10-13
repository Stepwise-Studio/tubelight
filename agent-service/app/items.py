"""Small per-user lists in the store (to-do labels, alarms, reminders): rows keyed by an id the phone may make itself
(it works offline), so the same add sent twice keeps one. Each kind validates with its own `clean`, which raises
ValueError with a sentence for the user."""
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from . import memory


class Items:
    def __init__(self, ns: str, clean: Callable[[dict[str, Any]], dict[str, Any]], defaults: dict[str, Any], order: str):
        self.ns, self.clean, self.defaults, self.order = ns, clean, defaults, order

    async def listing(self, owner_id: str) -> list[dict[str, Any]]:
        rows = await memory.store.asearch((self.ns, owner_id), limit=5000)
        return sorted(({"id": i.key, **i.value} for i in rows), key=lambda r: str(r.get(self.order) or ""))

    async def get(self, owner_id: str, key: str) -> dict[str, Any] | None:
        item = await memory.store.aget((self.ns, owner_id), key)
        return {"id": key, **item.value} if item else None

    async def add(self, owner_id: str, fields: dict[str, Any], id: str | None = None) -> dict[str, Any]:
        key = str(uuid.UUID(id)) if id else str(uuid.uuid4())  # ValueError for anything that isn't one
        if existing := await self.get(owner_id, key):
            return existing
        now = datetime.now(UTC).isoformat()
        row = {**self.defaults, **self.clean({**self.defaults, **fields}), "created_at": now, "updated_at": now}
        await memory.store.aput((self.ns, owner_id), key, row, index=False)
        return {"id": key, **row}

    async def update(self, owner_id: str, key: str, changes: dict[str, Any]) -> dict[str, Any] | None:
        item = await memory.store.aget((self.ns, owner_id), key)
        if not item:
            return None
        row = {**item.value, **self.clean({**item.value, **changes}), "updated_at": datetime.now(UTC).isoformat()}
        await memory.store.aput((self.ns, owner_id), key, row, index=False)
        return {"id": key, **row}

    async def remove(self, owner_id: str, key: str) -> bool:
        if not await memory.store.aget((self.ns, owner_id), key):
            return False
        await memory.store.adelete((self.ns, owner_id), key)
        return True
