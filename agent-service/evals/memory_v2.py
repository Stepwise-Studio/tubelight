"""The memory evals' adapter for app/mem: a scratch Postgres (TL_TEST_PG), wiped per run."""
import asyncio
import os
import uuid
from datetime import UTC, datetime, timedelta

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app import mem

TRUST = {"user": 2, "email": 0}


class Adapter:
    def __init__(self, user: str, pace: float) -> None:
        self.user, self.pace, self.owner, self.n = user, pace, str(uuid.uuid4()), 0
        self.ready = False

    async def _setup(self) -> None:
        if not self.ready:
            pool = AsyncConnectionPool(os.environ["TL_TEST_PG"], open=False, kwargs={"autocommit": True, "row_factory": dict_row})
            await pool.open()
            await mem.setup(pool)
            self.ready = True

    async def ingest(self, day: str, source: str, lines: list[tuple[str, str]]) -> None:
        await self._setup()
        start = datetime.fromisoformat(day).replace(hour=10, tzinfo=UTC)
        self.n += 1
        for i, (who, text) in enumerate(lines):
            trust = TRUST.get(who, 0 if source == "call" and who != "assistant" else 1)
            speaker = self.user if who == "user" else "app GMAIL" if who == "email" else \
                f"caller {who}" if source == "call" and who != "assistant" else who
            await mem.log_episode(self.owner, source, text, trust=trust, ref=f"{source}-{self.n}", speaker=speaker,
                                  at=start + timedelta(minutes=i))

    async def settle(self, _: float = 0) -> None:
        names = {self.owner: self.user}
        while await mem.tick(self.owner, force=True, max_batches=1, names=names):
            await asyncio.sleep(self.pace)

    async def context(self, question: str) -> str:
        return await mem.recall(self.owner, question, brief=True)
