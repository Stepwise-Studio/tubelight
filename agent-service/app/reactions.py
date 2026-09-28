"""Emoji reactions on chat messages, WhatsApp-style: one per person per message, stored in `meta.reactions` as
[{"by": teammate id or "user", "emoji": "👍"}]. The message row's realtime update carries them to the app.

Teammates react when the floor director says to (acknowledging a plan, a thanks, a joke) instead of writing a message;
the user reacts from the long-press menu.
"""
import re
from typing import Any

from . import db

EMOJI = ("👍", "❤️", "😂", "🔥", "🙏", "👀")  # what teammates react with; the user can pick any emoji


def _modifier(ch: str) -> bool:
    o = ord(ch)
    return o in (0xFE0E, 0xFE0F, 0x20E3) or 0x1F3FB <= o <= 0x1F3FF or 0xE0020 <= o <= 0xE007F


def is_emoji(s: str) -> bool:
    """Exactly one emoji: skin tones, flags and ZWJ sequences (👩‍💻) included; text or several emoji aren't."""
    if not 0 < len(s) <= 16 or re.search(r"[\w\s]", s):
        return False
    for part in s.split("\u200d"):
        bases = [ch for ch in part if not _modifier(ch)]
        flag = len(bases) == 2 and all(0x1F1E6 <= ord(ch) <= 0x1F1FF for ch in bases)
        if not (flag or (len(bases) == 1 and ord(bases[0]) > 0x2000)):
            return False
    return True


async def react(message_id: str, by: str, emoji: str, toggle: bool = False) -> list[dict[str, Any]] | None:
    """Set `by`'s reaction (replacing their previous one). toggle: the same emoji again removes it. None if the
    message is gone or the emoji isn't one of ours."""
    if not is_emoji(emoji):
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
