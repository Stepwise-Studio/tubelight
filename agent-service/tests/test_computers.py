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
