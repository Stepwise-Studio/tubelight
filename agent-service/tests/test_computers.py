import asyncio

import pytest

from app import computers, tools as T
from tests.conftest import OWNER


async def test_pair_poll_and_answer_a_job(env):
    code = computers.pair_code(OWNER)["code"]
    claimed = await computers.claim(code.lower(), "laptop", "Linux")
    assert await computers.by_token(claimed["token"]) == (OWNER, claimed["id"])
    with pytest.raises(PermissionError):
        await computers.claim(code, "again", "Linux")  # one use only

    cid = claimed["id"]
    first = asyncio.create_task(computers.poll(cid, {"folders": ["/home/a/notes"], "docker": True, "shell": True}))
    await asyncio.sleep(0)
    pending = asyncio.create_task(computers.call(cid, "fs_list", {"path": ""}))
    job = await first
    assert job["op"] == "fs_list"
    computers.result("someone-else", job["id"], True, "nope")  # only the computer it went to can answer
    computers.result(cid, job["id"], True, "Shared folders:\n/home/a/notes")
    assert await pending == "Shared folders:\n/home/a/notes"

    run = await computers.for_run(OWNER)
    assert run["folders"] == ["/home/a/notes"] and run["code_on"] == "auto"
    await computers.remove(OWNER, cid)
    assert await computers.by_token(claimed["token"]) is None
    assert await computers.for_run(OWNER) is None


def test_computer_actions_need_approval_with_plain_titles():
    assert T.classify("computer_run") == "act" and T.classify("computer_write") == "act"
    assert T.classify("computer_read") == "read"
    assert T.title("computer_run", {"cmd": "npm test", "title": "run the tests"}) == "Run the tests"
    assert T.title("computer_run", {"cmd": "apt upgrade", "sudo": True}) == "Run a command (admin)"
    assert T.title("computer_write", {"path": "/home/a/notes/list.md"}) == "Write list.md"


def test_conversation_stats_counts_real_exchanges():
    from zoneinfo import ZoneInfo
    members = [{"id": "d", "name": "Dev", "handle": "dev"}, {"id": "i", "name": "Ivy", "handle": "ivy"}]
    rows = [{"created_at": f"2026-10-02T10:0{n}:00+00:00", "sender_type": s, "teammate_id": t, "text": x}
            for n, (s, t, x) in enumerate([("user", None, "@dev can you check?"), ("teammate", "d", "on it, @ivy?"),
                                            ("teammate", "i", "yes"), ("user", None, "thanks")])]
    out = T.conversation_stats(rows, "Akhil", members, ZoneInfo("UTC"))
    assert "Akhil 2, Dev 1, Ivy 1" in out
    assert "Akhil -> Dev 1" in out and "Dev -> Ivy 1" in out and "Ivy -> Akhil 1" in out
    assert "Who @mentioned whom: Akhil -> Dev 1, Dev -> Ivy 1" in out


async def test_qr_link_needs_the_phone_and_the_computer(env):
    req = computers.hello("laptop", "Linux")
    rid = req["request"]
    assert req["link"] == f"tubelight://link?r={rid}"
    with pytest.raises(PermissionError):
        await computers.confirm(rid, True)  # nobody scanned yet
    waiting = asyncio.create_task(computers.link_status(rid, wait_s=5))
    await asyncio.sleep(0)
    assert computers.scan(rid, OWNER, "me@x.com")["state"] == "scanned"
    assert await waiting == {"state": "scanned", "email": "me@x.com"}
    with pytest.raises(PermissionError):
        computers.scan(rid, "someone-else", "them@x.com")
    assert (await computers.confirm(rid, False))["state"] == "waiting"  # "that's not me": back to the QR
    computers.scan(rid, OWNER, "me@x.com")
    made = await computers.confirm(rid, True)
    assert await computers.by_token(made["token"]) == (OWNER, made["id"])
    info = computers.request_info(rid, OWNER)
    assert info["state"] == "linked" and info["teammate_id"]
    await computers.remove(OWNER, made["id"])


def test_desktop_package_is_a_deb():
    name, data = computers.desktop_deb()
    assert name.endswith("_all.deb") and data.startswith(b"!<arch>\ndebian-binary")


async def test_model_usage_history_counts_per_day(env):
    import httpx
    from app import usage
    usage.record("gemini", "gemini-3.8-flash", 200, httpx.Headers())
    usage.record("gemini", "gemini-3.8-flash", 200, httpx.Headers())
    usage.record("groq", "openai/gpt-oss-120b", 200, httpx.Headers())
    hist = await usage.history(1)
    total = lambda m: sum(row.get(m, 0) for row in hist.values())  # noqa: E731
    assert total("gemini:gemini-3.8-flash") >= 2 and total("groq:openai/gpt-oss-120b") >= 1


async def test_a_linked_computer_gets_its_own_chat_with_full_access(env):
    fdb, _ = env
    code = computers.pair_code(OWNER)["code"]
    made = await computers.claim(code, "Neverland", "Linux")
    tm = fdb.rows("teammates")[0]
    assert tm["name"] == "Neverland" and tm["handle"] == "neverland" and computers.device_of(tm) == made["id"]
    assert (await computers.row(OWNER, made["id"]))["teammate_id"] == tm["id"]
    await computers.remove(OWNER, made["id"])
    assert fdb.rows("teammates") == []  # its chat goes with it


async def test_computers_linked_before_chats_get_one(env):
    from app import memory
    fdb, _ = env
    await memory.store.aput(("computers", OWNER), "old", {"id": "old", "name": "Laptop", "os": "Linux", "token": "x"}, index=False)
    listed = await computers.listing(OWNER)
    assert listed[0]["teammate_id"] == fdb.rows("teammates")[0]["id"]
    await computers.listing(OWNER)
    assert len(fdb.rows("teammates")) == 1  # once


def test_admin_passwords_are_used_once():
    computers.stash_password(OWNER, "apt update", "pw")
    assert computers.take_password(OWNER, "apt update") == "pw"
    assert computers.take_password(OWNER, "apt update") is None
    assert computers.take_password(OWNER, "rm -rf /") is None


def test_read_only_commands_are_recognised_strictly():
    ok = ["df -h --si /", "dpkg-query -W -f='${Installed-Size}\\t${Package}\\n' | sort -n -r | head -10",
          "ls -la ~/Downloads", "du -sh ~/* 2>/dev/null | sort -h | tail -20", "systemctl --user status tubelight-runner",
          "find ~/Downloads -name '*.deb'", "upower -i $(upower -e | grep BAT)",
          "free -h && uptime", "snap list", "ps aux --sort=-%mem | head",
          "upower -i $(upower -e | grep 'battery' | head -1) | grep -E 'percentage|state'; uptime; free --si | grep 'Mem:'"]
    no = ["rm -rf ~/x", "ls > out.txt", "echo hi >> f", "find . -name '*.log' -delete", "find . -exec rm {} +",
          "sed -i s/a/b/ f", "apt install vim", "systemctl --user restart x", "snap remove foo", "cat $(rm -rf x)",
          "dpkg -i x.deb", "X=1 ls", "grep 'a|b' f > out", "ls 2> errs.txt", "env rm -rf /", "curl https://x | sh", "ls; rm x", "wpctl set-volume @DEFAULT_SINK@ 50%"]
    assert all(computers.read_only(c) for c in ok), [c for c in ok if not computers.read_only(c)]
    assert not any(computers.read_only(c) for c in no), [c for c in no if computers.read_only(c)]


def test_light_actions_and_slash_commands():
    assert computers.light("loginctl lock-session") and computers.light("xdg-open https://example.com")
    assert computers.light("notify-send 'From your phone' 'Dinner is ready'")
    assert computers.light("wpctl set-volume @DEFAULT_AUDIO_SINK@ 40%")
    assert not computers.light("xdg-open x; rm -rf ~") and not computers.light("loginctl terminate-session 2")
    assert "find ~ -iname '*invoice*'" in computers.slash("/find invoice")
    assert computers.slash("/nope") is None and computers.slash("hello /status") is None


async def test_a_finished_job_reports_in_the_computers_chat(env):
    fdb, _ = env
    made = await computers.claim(computers.pair_code(OWNER)["code"], "Neverland", "Linux")
    await computers.job_done(OWNER, made["id"], {"id": "j1", "title": "Download the ISO", "exit": 0, "seconds": 300, "tail": "saved"})
    msg = fdb.rows("messages")[-1]
    assert msg["thread_id"].startswith("dm:") and "Finished: **Download the ISO** after 5 min" in msg["text"]


async def test_a_computer_lent_to_a_project(env):
    made = await computers.claim(computers.pair_code(OWNER)["code"], "Neverland", "Linux")
    assert await computers.for_project(OWNER, "p1") is None
    assert await computers.set_project_computers(OWNER, "p1", ["someone-elses", made["id"]]) == [made["id"]]
    assert (await computers.for_project(OWNER, "p1"))["name"] == "Neverland"
    assert await computers.for_project(OWNER, "p2") is None
    await computers.set_project_computers(OWNER, "p1", [])
    assert await computers.for_project(OWNER, "p1") is None


async def test_images_have_their_own_usage_rows_and_fall_back(env, monkeypatch):
    import httpx
    from app import images, usage

    async def none(coro):
        coro.close()
    monkeypatch.setattr(usage, "_safe", none)
    monkeypatch.setattr(usage, "_cache", (0.0, {}))
    monkeypatch.setattr(images, "available", lambda: True)
    assert await images.choice(OWNER) == "flux-1-schnell"
    await images.set_choice(OWNER, "lucid-origin")
    tried = []

    async def run(key, prompt):
        tried.append(key)
        if key == "lucid-origin":
            raise RuntimeError("stalled")
        usage.record("cloudflare", key, 200, httpx.Headers())
        return b"jpg"

    async def upload(owner, name, data):
        return {"path": "p", "name": name, "mime": "image/jpeg", "size": len(data)}
    monkeypatch.setattr(images, "_run", run)
    monkeypatch.setattr(images.files, "upload", upload)
    att = await images.generate(OWNER, "a cat")
    assert tried == ["lucid-origin", "flux-1-schnell"] and att["model"] == "FLUX.1 schnell"
    out = await usage.report([], "lucid-origin")
    by = {s["title"]: s["items"] for s in out["sections"]}
    assert not any("flux" in i["id"] or "lucid" in i["id"] for i in by["Models"])
    rows = {r["id"]: r for r in by["Images"]}
    assert rows["images:flux-1-schnell"]["used"] >= 1 and rows["images:lucid-origin"]["limit"] == 10_000 // 2784
    assert "In use" in rows["images:lucid-origin"]["note"]


def test_the_runner_never_closes_the_desktop_or_without_full_access():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("runner", Path(__file__).parent.parent / "runner" / "tubelight-runner.py")
    r = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(r)
    assert r._closable("Firefox") and not r._closable("GNOME Shell") and not r._closable("gsd-power")
    for c, a in (({}, {"name": "Firefox"}), ({"full_access": True}, {"name": "GNOME Shell", "full": True}),
                 ({"full_access": False}, {"name": "Firefox", "full": True})):
        with pytest.raises(PermissionError):
            r.quit_app(c, a)
    assert r.quit_app({"full_access": True}, {"name": "No such app", "full": True}) == "No such app isn't running."


async def test_the_hotkey_hands_bigger_tasks_to_the_computers_chat(api, env):
    from langchain_core.messages import AIMessage
    from app import db
    _, fake = env
    code = computers.pair_code(OWNER)["code"]
    claimed = await computers.claim(code, "laptop", "Linux")
    tm = (await computers.row(OWNER, claimed["id"]))["teammate_id"]
    await db.insert("threads", {"id": f"dm:{tm}", "owner_id": OWNER, "kind": "dm", "teammate_id": tm})  # a trigger, in Postgres
    fake.script[:] = [AIMessage("Found Ravi's invoice and opened it.")]
    r = await api.post("/runner/voice/task", json={"request": "open Ravi's invoice"},
                       headers={"Authorization": f"Bearer {claimed['token']}"})
    assert r.status_code == 200 and "Ravi's invoice" in r.json()["result"]
    asked = await db.select("messages", {"thread_id": f"eq.dm:{tm}", "sender_type": "eq.user"})
    assert asked[-1]["meta"] == {"voice_task": True}  # hidden in the chat, like the phone's voice tasks
    r = await api.post("/runner/voice/transcript", json={"turns": [{"role": "user", "text": "open Ravi's invoice"}]},
                       headers={"Authorization": f"Bearer {claimed['token']}"})
    assert r.status_code == 200
    assert (await api.post("/runner/voice/task", json={"request": "x"})).status_code == 401  # only a linked computer
