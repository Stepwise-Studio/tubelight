"""Emoji reactions on chat messages, WhatsApp-style: one per person per message, stored in `meta.reactions` as
[{"by": teammate id or "user", "emoji": "👍"}]. The message row's realtime update carries them to the app.

Teammates react when the floor director says to (acknowledging a plan, a thanks, a joke) instead of writing a message;
the user reacts from the long-press menu.
"""
from typing import Any

from . import db

EMOJI = ("👍", "❤️", "😂", "🔥", "🙏", "👀")


async def react(message_id: str, by: str, emoji: str, toggle: bool = False) -> list[dict[str, Any]] | None:
    """Set `by`'s reaction (replacing their previous one). toggle: the same emoji again removes it. None if the
    message is gone or the emoji isn't one of ours."""
    if emoji not in EMOJI:
        return None
    m = await db.one("messages", {"id": f"eq.{message_id}", "select": "id,meta"})
    if not m:
        return None
    meta = m.get("meta") or {}
    mine = next((r for r in meta.get("reactions") or [] if r.get("by") == by), None)
    rest = [r for r in meta.get("reactions") or [] if r.get("by") != by]
    reactions = rest if toggle and mine and mine.get("emoji") == emoji else [*rest, {"by": by, "emoji": emoji}]
    # ponytail: read-modify-write on meta; two reactions landing in the same instant can drop one (rare, harmless).
    await db.update("messages", {"id": f"eq.{message_id}"}, {"meta": {**meta, "reactions": reactions}})
    return reactions
