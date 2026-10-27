"""Playbooks: how the user taught a teammate to do something, kept in their own words.

"When I ask for a LinkedIn post: write a draft, make an image, attach it, save it as a draft." Said once in a chat,
the teammate saves it (tool `playbook`) and every teammate follows it next time. Unlike learn.py's lessons (which a
model distils), a playbook's steps are stored exactly as given and only change when the user says so.

Every teammate sees the list (name + when it applies) in its instructions and reads the one that fits; a request
that clearly matches one gets its steps there already.
"""
import uuid
from datetime import UTC, datetime
from typing import Any

from . import memory

SHOWN = 0.75  # cosine (bge-small) above which a request clearly matches: measured "LinkedIn post about X" 0.71-0.81,
# but "a post on X" scored 0.71 against the LinkedIn one, so below this the teammate decides from the list.
# ponytail: one embedding threshold; a judge call if close calls start picking the wrong playbook.
MAX = 30


def _ns(owner_id: str) -> tuple[str, ...]:
    return ("playbooks", owner_id)


async def all_(owner_id: str) -> list[dict[str, Any]]:
    items = await memory.store.asearch(_ns(owner_id), limit=MAX)
    return sorted(({"id": i.key, **i.value} for i in items), key=lambda r: r["name"].lower())


async def find(owner_id: str, name: str) -> dict[str, Any] | None:
    want = name.strip().lower()
    rows = await all_(owner_id)
    return next((r for r in rows if r["name"].lower() == want), None) or next(
        (r for r in rows if want and want in r["name"].lower()), None)


async def save(owner_id: str, name: str, when: str, steps: str, by: str) -> str:
    """Saves (or replaces, by name) a playbook. Returns 'saved' or 'updated'."""
    old = await find(owner_id, name)
    if old and old["name"].lower() != name.strip().lower():
        old = None  # only an exact name replaces one
    await memory.store.aput(_ns(owner_id), old["id"] if old else uuid.uuid4().hex, {
        "text": f"{name.strip()}. {when.strip()}", "name": name.strip(), "when": when.strip(), "steps": steps.strip(),
        "by": by, "updated_at": datetime.now(UTC).isoformat()})
    return "updated" if old else "saved"


async def remove(owner_id: str, name: str) -> bool:
    hit = await find(owner_id, name)
    if hit:
        await memory.store.adelete(_ns(owner_id), hit["id"])
    return bool(hit)


async def for_request(owner_id: str, query: str) -> str:
    """The preamble's part: the list, and the steps of the one this request clearly asks for."""
    rows = await all_(owner_id)
    if not rows:
        return ""
    best = None
    if query.strip():
        got = await memory.store.asearch(_ns(owner_id), query=query[:500], limit=1)
        if got and (got[0].score or 0) >= SHOWN:
            best = got[0].value
    lines = ["Playbooks they taught you (how they want these done, in their words). When a request fits one, follow "
             "its steps in order; read one with playbook (action read) first if it isn't shown below. A request that "
             "only looks similar (another site, another kind of task) isn't covered:"]
    lines += [f"- {r['name']}: {r['when']}" for r in rows]
    if best:
        lines.append(f"This request fits “{best['name']}”. Its steps, exactly as they gave them:\n{best['steps']}")
    return "\n".join(lines)
