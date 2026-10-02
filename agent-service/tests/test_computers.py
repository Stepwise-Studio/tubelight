import asyncio

import pytest

from app import computers, tools as T
from tests.conftest import OWNER


async def test_pair_poll_and_answer_a_job():
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
    assert T.title("computer_run", {"cmd": "npm test"}) == "Run on your computer: npm test"


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


async def test_qr_link_needs_the_phone_and_the_computer():
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
    assert computers.request_info(rid, OWNER)["state"] == "linked"
    await computers.remove(OWNER, made["id"])


def test_desktop_package_is_a_deb():
    name, data = computers.desktop_deb()
    assert name.endswith("_all.deb") and data.startswith(b"!<arch>\ndebian-binary")
