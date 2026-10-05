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


def test_only_the_phone_uses_the_phone(env):
    from app import graph, tools
    phone_tm = {"id": "p1", "name": "Galaxy", "handle": "galaxy", "role": "Your phone", "avatar_shape": "phone", "allowed_toolkits": []}
    ivy = {"id": "i1", "name": "Ivy", "handle": "ivy", "role": "Chief of staff", "avatar_shape": "face:ivy", "allowed_toolkits": []}
    names = lambda tm, mate: {t.name for t in tools.build(graph.RunCtx(  # noqa: E731
        run_id="r", owner_id="u1", thread_id=f"dm:{tm['id']}", members=[tm], phone_mate=mate, phone_notes=True), tm, [])}
    assert {"phone_action", "phone_notifications"} <= names(phone_tm, phone_tm) and "ask_phone" not in names(phone_tm, phone_tm)
    assert "ask_phone" in names(ivy, phone_tm) and not {"phone_action", "phone_notifications"} & names(ivy, phone_tm)
    assert not {"phone_action", "ask_phone"} & names(ivy, None)  # no phone registered: nobody touches it
    assert tools.title("phone_action", {"action": "alarm", "when": "06:30"}) == "On your phone: Set an alarm for 06:30"


async def test_phone_status_reads_like_android(env):
    assert "hasn't reported" in await phone.status_text("u9", IST)
    await phone.save_status("u9", {"model": "Shelby", "android": "15", "storage_total": 128e9, "storage_free": 40e9,
                                   "battery": 72, "charging": True, "memory_total": 8e9, "memory_free": 2.5e9,
                                   "network": "Wi-Fi", "usage_access": True, "kinds": {"photos": 20e9, "videos": 30e9},
                                   "apps": [{"name": "WhatsApp", "bytes": 9e9, "cache": 1e9}]})
    out = await phone.status_text("u9", IST)
    assert "88.0 GB used of 128.0 GB, 40.0 GB free" in out and "72% and charging" in out
    assert "videos 30.0 GB, photos 20.0 GB" in out and "WhatsApp 9.0 GB (1.0 GB cache)" in out
    assert "Say which settings page" in phone.action("settings", None, None, "")
