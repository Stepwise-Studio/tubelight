import time
from datetime import datetime
from zoneinfo import ZoneInfo

from app import phone

IST = ZoneInfo("Asia/Kolkata")


def test_actions_need_what_the_phone_needs():
    assert phone.action("alarm", None, None, "6.30 pm", title="Gym") == {"action": "alarm", "title": "Gym", "hour": 18, "minute": 30}
    assert "alarm time" in phone.action("alarm", None, None, "tomorrow")
    assert "phone number" in phone.action("call", None, None, "")
    start = datetime(2026, 10, 5, 15, 0, tzinfo=IST)
    cal = phone.action("calendar", start, None, "2026-10-05T15:00", title="Review")
    assert cal["end"] - cal["start"] == 3600_000 and cal["title"] == "Review"
    assert "Unknown action" in phone.action("teleport", None, None, "")


async def test_notifications_are_kept_a_day_and_searchable(env):
    now = time.time() * 1000
    items = [{"key": "a", "app": "WhatsApp", "title": "Kishore", "text": "dinner at 8?", "at": now - 60_000},
             {"key": "b", "app": "Gmail", "title": "Invoice", "text": "due Friday", "at": now - 30_000},
             {"key": "old", "app": "X", "title": "old", "text": "gone", "at": now - 2 * 86400_000}]
    assert await phone.save_notes("u1", items) == 2
    assert await phone.save_notes("u1", items[:1]) == 2  # same key again: no duplicate
    assert await phone.has_notes("u1") and not await phone.has_notes("u2")
    out = await phone.notes("u1", "dinner", "", 12, IST)
    assert "Kishore: dinner at 8?" in out and "Invoice" not in out
    assert "Invoice" in await phone.notes("u1", "", "gmail", 12, IST)
