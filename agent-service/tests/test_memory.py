"""The chat brief, search_chat and follow-ups: context that outlives the message window."""
from datetime import UTC, datetime, timedelta

from langchain_core.messages import ToolMessage

from app import brief, followups
from tests.conftest import OWNER, ai, settle, teammate


def said(fdb, thread_id, at, text, teammate_id=None):
    fdb.tables.setdefault("messages", []).append({
        "id": f"m{len(fdb.tables.get('messages', []))}", "thread_id": thread_id, "owner_id": OWNER, "kind": "text",
        "sender_type": "teammate" if teammate_id else "user", "teammate_id": teammate_id, "text": text, "meta": {},
        "created_at": at})


async def test_brief_folds_in_only_new_messages(env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    thread = f"dm:{dev['id']}"
    said(fdb, thread, "2026-09-28T03:30:00+00:00", "let's circle back on pricing this evening")
    said(fdb, thread, "2026-09-28T03:31:00+00:00", "Sure, I'll bring numbers.", dev["id"])
    fake.script = [ai("Open loops: Dev brings pricing numbers, Mon Sep 28 evening.")]
    assert await brief.refresh(OWNER, thread, "Akhil", "Asia/Kolkata")
    first = fake.calls[-1][-1].content
    assert "(empty" in first and "[Mon Sep 28, 09:00 AM] Akhil: let's circle back on pricing" in first
    assert await brief.get(thread) == "Open loops: Dev brings pricing numbers, Mon Sep 28 evening."

    assert not await brief.refresh(OWNER, thread, "Akhil", "Asia/Kolkata")  # nothing new: no model call
    said(fdb, thread, "2026-09-28T12:00:00+00:00", "ok what are the numbers?")
    fake.script = [ai("Open loops: Dev owes pricing numbers now.")]
    await brief.refresh(OWNER, thread, "Akhil", "Asia/Kolkata")
    second = fake.calls[-1][-1].content
    assert "Current brief:\nOpen loops: Dev brings pricing" in second and "circle back on pricing" not in second


async def test_teammates_read_the_brief(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    from app import memory
    await memory.store.aput(("thread", f"dm:{dev['id']}"), "brief", {"text": "Open loops: pricing numbers tonight."}, index=False)
    fake.script = [ai("Here they are.")]
    await api.post(f"/threads/dm:{dev['id']}/messages", json={"text": "numbers?"})
    await settle()
    assert "## This chat so far" in fake.calls[0][0].content and "pricing numbers tonight" in fake.calls[0][0].content


async def test_search_chat_finds_earlier_words(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    thread = f"dm:{dev['id']}"
    said(fdb, thread, "2026-09-28T03:30:00+00:00", "pricing: keep the free tier at 3 teammates")
    said(fdb, thread, "2026-09-28T04:00:00+00:00", "unrelated chatter")
    seen = {}

    def answer(messages):
        seen["result"] = next(m.content for m in reversed(messages) if isinstance(m, ToolMessage))
        return ai("Found it.")

    fake.script = [ai(calls=[("search_chat", {"query": "free tier pricing"})]), answer]
    await api.post(f"/threads/{thread}/messages", json={"text": "what did we decide on pricing?"})
    await settle()
    assert "keep the free tier at 3 teammates" in seen["result"] and "unrelated" not in seen["result"]


async def test_follow_up_wakes_the_teammate_in_the_chat(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    when = (datetime.now(UTC) + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M")  # UTC here: no timezone set
    fake.script = [ai(calls=[("follow_up", {"when": when, "what": "check whether the deploy went green"})]), ai("Will do.")]
    await api.post(f"/threads/dm:{dev['id']}/messages", json={"text": "check the deploy in 3 hours"})
    await settle()
    assert "Follow-up set for" in fake.calls[1][-1].content

    assert await followups.fire_due(datetime.now(UTC) + timedelta(hours=1)) == 0  # not yet
    fake.script = [ai("Deploy is green.")]
    assert await followups.fire_due(datetime.now(UTC) + timedelta(hours=4)) == 1
    await settle()
    msg = fdb.rows("messages", sender_type="teammate")[-1]
    assert msg["text"] == "Deploy is green." and msg["proactive"]
    assert "[Follow-up you set" in fake.calls[-1][-1].content and "check whether the deploy went green" in fake.calls[-1][-1].content
    assert await followups.fire_due(datetime.now(UTC) + timedelta(days=1)) == 0  # fires once
