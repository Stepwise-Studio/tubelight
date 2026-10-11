import json

from langchain_core.messages import AIMessage

from app import calls, memory, todos

U = "u-calls"


async def test_context_gathers_what_involves_the_caller(env):
    shelf = memory.ns("user", U)
    await memory.add(shelf, "Saqlain is Jayanth's college friend; they're building a pitch deck together", kind="person", about=["Saqlain"])
    await memory.add(shelf, "Jayanth prefers mornings for calls", kind="preference")
    await todos.add(U, "Send Saqlain the pitch deck", due="2026-10-12")
    await todos.add(U, "Renew passport")
    ctx = await calls.context(U, "Saqlain")
    assert "college friend" in ctx and "Send Saqlain the pitch deck" in ctx
    assert "passport" not in ctx and "mornings" not in ctx  # nothing that isn't about them


async def test_progress_is_never_guessed_and_the_call_lands_in_memory_and_todos(env, monkeypatch):
    _, fake = env

    async def mint(setup):
        assert "Saqlain" in setup["systemInstruction"]["parts"][0]["text"] and setup["tools"] == [calls.TOOLS]
        return "tok"
    monkeypatch.setattr(calls.live, "mint", mint)
    import zoneinfo
    started = await calls.start(U, "Jayanth", zoneinfo.ZoneInfo("Asia/Kolkata"), "Saqlain")
    cid = started["call_id"]
    fake.script[:] = [AIMessage("NOT_ON_RECORD")]
    assert "message" in await calls.ask(U, cid, "Did he book the venue?")
    await calls.message(U, cid, "Call back about the venue", True)
    fake.script[:] = [AIMessage(json.dumps({"summary": "Saqlain asked about the venue; took a message.",
                                            "asks": ["Call Saqlain back about the venue"], "attention": "He needs the venue sorted today.",
                                            "facts": []}))]
    out = await calls.end(U, cid, [{"role": "user", "text": "Did Jayanth book the venue?"}, {"role": "teammate", "text": "I'll ask him."}])
    assert out["todos"] == ["Call Saqlain back about the venue"]
    assert any("venue" in r["text"] for r in await memory.listing(memory.ns("user", U), limit=50))
