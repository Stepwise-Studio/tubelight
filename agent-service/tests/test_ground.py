from langchain_core.messages import ToolMessage

from app import ground, llm
from tests.conftest import ai, settle, teammate


async def test_a_data_question_forces_a_look_and_a_lazy_answer_is_redrawn(api, env, monkeypatch):
    fdb, fake = env
    ivy = teammate(fdb, "ivy", "Inbox manager")
    asked = []

    async def look(*a):
        return {"look": True, "what": "the last week of mail"}
    monkeypatch.setattr(ground, "judge", look)
    real = llm.chat_model
    monkeypatch.setattr(llm, "chat_model", lambda *a, must_use_tool=False, **k: asked.append(must_use_tool) or real(*a, **k))
    # first draw ignores tool_choice and answers from nothing; the redraw searches the chat; then it answers
    fake.script = [ai("Quiet week, 8 newsletters."), ai(calls=[("search_chat", {"query": "mail"})]), ai("Here's the week.")]
    await api.post(f"/threads/dm:{ivy['id']}/messages", json={"text": "summarise my last week"})
    await settle()
    assert [m["text"] for m in fdb.rows("messages", sender_type="teammate")] == ["Here's the week."]
    assert asked[1:3] == [True, True]  # [0] is the unforced model built before the verdict
    assert "Check first: the last week of mail" in fake.calls[0][-1].content
    assert any(isinstance(m, ToolMessage) for m in fake.calls[-1])
    assert fdb.rows("activity", name="grounding")[0]["output"] == {"look": True, "what": "the last week of mail"}


async def test_small_talk_is_not_forced(api, env):
    fdb, fake = env
    iris = teammate(fdb, "iris", "Chief of staff")
    fake.script = [ai("Hey! Good to see you.")]
    await api.post(f"/threads/dm:{iris['id']}/messages", json={"text": "hi"})
    await settle()
    assert [m["text"] for m in fdb.rows("messages", sender_type="teammate")] == ["Hey! Good to see you."]
    assert not fdb.rows("activity", name="grounding") or not fdb.rows("activity", name="grounding")[0]["output"]["look"]


async def test_a_reply_that_brushes_off_the_data_is_redrawn_once(api, env, monkeypatch):
    fdb, fake = env
    ivy = teammate(fdb, "ivy", "Inbox manager")
    seen = []

    async def check(request, data, reply):
        seen.append(reply)
        return {"ok": False, "problems": ["It leaves out the 31 job applications from HR."]}
    monkeypatch.setattr(ground, "check", check)
    from app import tools
    fake.script = [ai(calls=[("search_chat", {"query": "mail"})]), ai("Nothing needs you."),
                   ai("31 job applications came in from HR; want them ranked?")]
    monkeypatch.setattr(tools, "run_tool", lambda *a, **k: _big())  # a big tool result: worth a check
    await api.post(f"/threads/dm:{ivy['id']}/messages", json={"text": "summarise my week"})
    await settle()
    assert [m["text"] for m in fdb.rows("messages", sender_type="teammate")] == ["31 job applications came in from HR; want them ranked?"]
    assert seen == ["Nothing needs you."]  # checked once, never again for the same request
    assert "leaves out the 31 job applications" in fake.calls[-1][-1].content


async def _big():
    return "x" * 3000, "ok"


async def test_quiet_is_never_the_answer_to_a_direct_message(api, env):
    fdb, fake = env
    ivy = teammate(fdb, "ivy", "Inbox manager")
    fake.script = [ai("QUIET"), ai("14 emails since yesterday, all routine: Google setup, Medium, Truecaller.")]
    await api.post(f"/threads/dm:{ivy['id']}/messages", json={"text": "check all the mails I got since yesterday"})
    await settle()
    assert [m["text"] for m in fdb.rows("messages", sender_type="teammate")] == [
        "14 emails since yesterday, all routine: Google setup, Medium, Truecaller."]
    assert "QUIET is no answer" in fake.calls[-1][-1].content
