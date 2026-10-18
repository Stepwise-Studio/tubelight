"""The memory agent (app/mind.py): what it asks, and its tools. Needs TL_TEST_PG like tests/test_mem.py."""
import time

import pytest

from app import mem, memory, mind
from tests.test_mem import PRIOR, episode, facts, m, run  # noqa: F401 (m is the fixture)

pytestmark = pytest.mark.skipif(not __import__("os").environ.get("TL_TEST_PG"), reason="needs TL_TEST_PG (Postgres with pgvector)")


async def unsure(owner, text="Kishore is Jayanth's friend on WhatsApp"):
    a = await episode(owner, f"{text}, I think")
    await run(owner, [a], {"entities": [{"ref": "n1", "name": "Kishore", "kind": "person"}],
                           "facts": [{"about": "n1", "text": text, "episode": 1, "quote": "I think",
                                      "importance": "trivial", "lasts": "hours"}]})
    return (await mem._q("select id from mem_facts where owner = %s and text = %s", owner, text))[0]["id"]


async def test_it_asks_about_what_it_is_least_sure_of_and_overdue_promises(m, monkeypatch):
    monkeypatch.setattr(mem, "GATE", PRIOR)
    _, owner = m
    fid = await unsure(owner)
    b = await episode(owner, "I promised Dev the review by 2026-09-03", days=1)
    await run(owner, [b], {"entities": [{"ref": "n1", "name": "Dev", "kind": "person"}],
                           "facts": [{"about": "n1", "kind": "commitment", "text": "Jayanth promised Dev a review", "due": "2026-09-03",
                                      "episode": 1, "quote": "promised Dev the review", "importance": "important", "lasts": "days"}]})
    q = await mind.queue(owner)
    ids = [x["id"] for x in q]
    assert f"t:{fid}" in ids and any(i.startswith("o:") for i in ids) and "story" in ids
    assert q[0]["id"].startswith("o:")  # an overdue promise outranks a trivial unsure fact


async def test_two_questions_a_conversation_and_never_the_same_one_soon(m, monkeypatch):
    monkeypatch.setattr(mem, "GATE", PRIOR)
    _, owner = m
    await unsure(owner)
    first = await mind.offer(owner)
    assert 1 <= len(first) <= mind.PER_CONVERSATION
    assert [q["id"] for q in await mind.offer(owner)] == [q["id"] for q in first]  # same conversation, same questions
    state = (await memory.store.aget(mind._ns(owner), "state")).value
    state["at"] = time.time() - mind.CONVERSATION - 1  # the chat went quiet: a new conversation
    await memory.store.aput(mind._ns(owner), "state", state, index=False)
    again = {q["id"] for q in await mind.offer(owner)}
    assert not again & {q["id"] for q in first}  # asked two weeks ago at most: not again


async def test_confirm_dismiss_merge(m, monkeypatch):
    monkeypatch.setattr(mem, "GATE", PRIOR)
    _, owner = m
    fid = await unsure(owner)
    tools = {t.name: t for t in mind.build(owner)}
    assert "Confirmed" in await tools["memory_confirm"].ainvoke({"fact_id": str(fid)})
    assert "Kishore is Jayanth's friend on WhatsApp" in await facts(owner)
    assert (await memory.store.aget(("mem_labels", owner), str(fid))).value["label"] == "keep"
    assert "Let go" in await tools["memory_dismiss"].ainvoke({"fact_id": str(fid)})
    assert await facts(owner, "faded") == ["Kishore is Jayanth's friend on WhatsApp"]
    assert "No such fact" in await tools["memory_confirm"].ainvoke({"fact_id": "not-an-id"})
    b = await episode(owner, "Kish called about the game", days=2)
    await run(owner, [b], {"entities": [{"ref": "n1", "name": "Kish", "kind": "person"}],
                           "facts": [{"about": "n1", "kind": "event", "text": "Kish called Jayanth about the game", "episode": 1,
                                      "quote": "Kish called", "importance": "useful", "lasts": "months"}]})
    assert "Merged Kish into Kishore." == await tools["memory_merge"].ainvoke({"keep": "Kishore", "other": "Kish"})
    rows = await mem._q("select name, aliases from mem_entities where owner = %s and kind = 'person'", owner)
    assert rows == [{"name": "Kishore", "aliases": ["Kish"]}]


async def test_it_can_read_back_what_it_learned_from_what_you_told_it(m, monkeypatch):
    monkeypatch.setattr(mem, "GATE", PRIOR)
    _, owner = m
    await mem.log_episode(owner, "journal", "I'm a designer at heart", trust=2, ref="dm:mem", speaker="Jayanth")
    a = (await mem._q("select * from mem_episodes where owner = %s", owner))[0]
    assert "Still reading 1 paragraph" in await mind.notes(owner)
    await run(owner, [a], {"facts": [{"about": "user", "text": "Jayanth is a designer at heart", "episode": 1, "quote": "designer at heart",
                                      "importance": "important", "lasts": "years"}]})
    await mem._q("update mem_episodes set extracted = 5 where owner = %s", owner)
    notes = await mind.notes(owner)
    assert "Learned from what they told you" in notes and "designer at heart" in notes and "Still reading" not in notes
