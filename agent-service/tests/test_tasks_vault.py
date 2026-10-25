import io
from datetime import UTC, datetime, timedelta

import pytest

from app import followups, todos, vault

U = "00000000-0000-0000-0000-0000000000aa"


async def test_todos_keep_board_order_and_completion(env):
    a = await todos.add(U, "  Book   the flight ", priority=1, due="2026-10-09")
    b = await todos.add(U, "Renew passport")
    assert a["title"] == "Book the flight" and a["status"] == "todo" and not a["completed_at"]
    assert [t["id"] for t in await todos.listing(U)] == [b["id"], a["id"]]  # newest on top
    done = await todos.update(U, a["id"], {"status": "done"})
    assert done["completed_at"]
    assert not (await todos.update(U, a["id"], {"status": "todo"}))["completed_at"]
    with pytest.raises(ValueError):
        await todos.update(U, a["id"], {"status": "someday"})
    with pytest.raises(ValueError):
        await todos.add(U, "   ")
    assert (await todos.find(U, a["id"][:8]))["id"] == a["id"]
    assert "Urgent" in todos.describe(a) and "due Fri Oct 09" in todos.describe(a)
    assert await todos.remove(U, b["id"]) and not await todos.remove(U, b["id"])


async def test_the_user_edits_a_followup_and_the_chat_hears_it(env):
    key = await followups.add(U, "dm:t1", "t1", "Check the PR", until="the PR is merged", by="Ivy")
    at = datetime.now(UTC) + timedelta(days=2)
    f = await followups.edit(key, U, what="Check the PR and deploy", at=at)
    assert f["what"] == "Check the PR and deploy" and f["at"] and f["until"] is None
    capsules = [m["text"] for m in env[0].rows("messages", thread_id="dm:t1")]
    assert any(t.startswith("You changed a follow-up, now for") for t in capsules)
    assert await followups.edit(key, "someone-else", what="x") is None
    with pytest.raises(ValueError):
        await followups.edit(key, U, at=datetime.now(UTC) - timedelta(hours=1))


async def test_vault_folders_files_and_links(env, tmp_path, monkeypatch):
    monkeypatch.setattr(vault, "ROOT", tmp_path)
    from PIL import Image

    notes = await vault.add_folder(U, "Notes")
    buf = io.BytesIO()
    Image.new("RGB", (1200, 800), "teal").save(buf, "JPEG")
    pic = await vault.add_bytes(U, "photo.jpg", buf.getvalue(), notes["id"])
    assert pic["mime"] == "image/jpeg" and pic["meta"] == {"width": 1200, "height": 800, "thumb": True}
    assert vault.file_path(U, pic["id"], ".thumb.jpg").exists()
    again = await vault.add_bytes(U, "photo.jpg", b"x", notes["id"])
    assert again["name"] == "photo (2).jpg"

    sub = await vault.add_folder(U, "Week 1", notes["id"])
    with pytest.raises(ValueError):
        await vault.update(U, notes["id"], {"parent": sub["id"]})  # not into itself
    moved = await vault.update(U, again["id"], {"parent": "", "starred": True})
    assert moved["parent"] == "" and moved["starred"]

    link = vault.public(U, pic)["thumb"]
    q = dict(p.split("=") for p in link.split("?")[1].split("&"))
    assert vault.verify(U, pic["id"], "thumb", int(q["e"]), q["s"])
    assert not vault.verify(U, pic["id"], "file", int(q["e"]), q["s"])

    csv = await vault.add_bytes(U, "marks.csv", b"name,score\nAsha,91\n")
    sheet = vault.preview(U, csv["id"], csv["name"], csv["mime"])
    assert sheet["sheets"][0]["rows"] == [["name", "score"], ["Asha", "91"]]

    assert await vault.remove(U, notes["id"]) == 3  # the folder, the photo and the subfolder
    assert not vault.file_path(U, pic["id"]).exists()
    assert {r["name"] for r in await vault.items(U)} == {"photo (2).jpg", "marks.csv"}


def test_teammates_get_todos_and_vault(env):
    from app import graph, tools

    ivy = {"id": "i1", "name": "Ivy", "handle": "ivy", "role": "Chief of staff", "avatar_shape": "face:ivy", "allowed_toolkits": []}
    names = {t.name for t in tools.build(graph.RunCtx(run_id="r", owner_id=U, thread_id="dm:i1", members=[ivy]), ivy, [])}
    assert {"todos", "vault"} <= names


async def test_assigning_a_todo_hands_it_to_the_teammate(env, monkeypatch):
    from app import runs
    fdb, _ = env
    fdb.tables["teammates"] = [{"id": "i1", "owner_id": U, "name": "Ivy"}]
    started = []

    async def fake_start(owner, thread, text, **kw):
        started.append((thread, text, kw))
        return "run1"
    monkeypatch.setattr(runs, "start", fake_start)
    t = await todos.add(U, "Draft the launch post", assignee="i1", due="2026-10-09")
    assert await todos.hand_to(U, t)
    thread, text, kw = started[0]
    assert thread == "dm:i1" and "Draft the launch post" in text and kw["teammate_id"] == "i1"
    assert any("You assigned Ivy a to-do" in m["text"] for m in fdb.rows("messages", thread_id="dm:i1"))
    assert "assigned to Ivy" in todos.describe(t, {"i1": "Ivy"})


async def test_vault_quota(env, tmp_path, monkeypatch):
    monkeypatch.setattr(vault, "ROOT", tmp_path)
    monkeypatch.setattr(vault, "QUOTA", 10)
    await vault.add_bytes(U, "a.txt", b"123456")
    assert (await vault.usage(U))["free"] == 4
    with pytest.raises(ValueError, match="full"):
        await vault.add_bytes(U, "b.txt", b"12345")
    assert [r["name"] for r in await vault.items(U)] == ["a.txt"]


async def test_todo_add_with_the_phones_id_is_idempotent(env):
    import uuid as _uuid
    key = str(_uuid.uuid4())
    a = await todos.add(U, "Buy milk", id=key)
    b = await todos.add(U, "Buy milk", id=key)
    assert a["id"] == b["id"] == key and len([t for t in await todos.listing(U) if t["id"] == key]) == 1
    with pytest.raises(ValueError):
        await todos.add(U, "x", id="not-a-uuid")


async def test_labels_alarms_and_reminders(env):
    from zoneinfo import ZoneInfo

    from app import clock

    ids = await todos.label_ids(U, "Study, dev,study")
    assert len(ids) == 2 and await todos.label_ids(U, "DEV") == [ids[1]]  # names match case-blind, made once
    t = await todos.add(U, "Revise chapter 4", labels=ids)
    assert "labels Study, dev" in todos.describe(t, {lb["id"]: lb["name"] for lb in await todos.LABELS.listing(U)})
    zone = ZoneInfo("Asia/Kolkata")
    now = datetime(2026, 10, 13, 8, 0, tzinfo=zone)
    assert clock.next_at("07:00", zone, now).startswith("2026-10-14T07:00")  # passed today: tomorrow
    assert clock.parse_days("weekdays") == [0, 1, 2, 3, 4] and clock.parse_days("mon, fri") == [0, 4]
    once = await clock.ALARMS.add(U, {"time": "07:00", "at": clock.next_at("07:00", zone, now)}, id="00000000-0000-0000-0000-0000000000a1")
    assert (await clock.ALARMS.add(U, {"time": "09:00"}, id=once["id"]))["time"] == "07:00"  # resent add keeps one
    assert clock.is_on(once, now) and not clock.is_on(once, now + timedelta(days=2))  # a one-off is off once it rang
    with pytest.raises(ValueError):
        await clock.ALARMS.add(U, {"time": "25:00"})
    r = await clock.REMINDERS.add(U, {"title": "Call Mom", "at": clock.local("2026-10-13T18:00", zone), "repeat": "weekly"})
    assert "Tue Oct 13 18:00 · repeats weekly" in clock.describe_reminder(r, zone)
    assert (await clock.REMINDERS.update(U, r["id"], {"done": True}))["done_at"]
    with pytest.raises(ValueError):
        await clock.REMINDERS.add(U, {"title": "x", "at": "2026-10-13T18:00"})  # no offset


async def test_ensure_folder_reuses_and_makes_paths(env, tmp_path, monkeypatch):
    monkeypatch.setattr(vault, "ROOT", tmp_path)
    hiring = await vault.add_folder(U, "Hiring")
    leaf = await vault.ensure_folder(U, "hiring/Resumes Oct/")
    again = await vault.ensure_folder(U, "Hiring/resumes oct")
    assert leaf == again and await vault.ensure_folder(U, "") == ""
    rows = await vault.items(U)
    assert len([r for r in rows if r["kind"] == "folder"]) == 2
    assert next(r for r in rows if r["id"] == leaf)["parent"] == hiring["id"]
