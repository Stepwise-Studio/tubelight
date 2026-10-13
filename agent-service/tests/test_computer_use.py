import json

from langchain_core.messages import AIMessage

from app import computer_use, computers

SCREEN = "Snapshot s1: Settings\n[e1] text “Name” (type)\n[e2] button “Save” (click)"


def test_grants_are_per_app_and_expire(monkeypatch):
    computer_use._grants.clear()
    computer_use.grant("u", "c1", "Firefox")
    assert computer_use.granted("u", "c1", "firefox") and computer_use.granted("u", "c1", "Mozilla Firefox")
    assert not computer_use.granted("u", "c1", "Files") and not computer_use.granted("u", "c2", "Firefox")
    monkeypatch.setattr(computer_use.time, "time", lambda: 10**12)
    assert not computer_use.granted("u", "c1", "Firefox") and not computer_use.any_granted("u", "c1")


async def test_subtask_types_only_given_text_and_reports(env, monkeypatch):
    _, fake = env
    calls = []

    async def call(cid, op, args, timeout=0):
        calls.append((op, args))
        return {"snapshot": f"s{len(calls) + 1}", "status": "done", "text": SCREEN}
    monkeypatch.setattr(computers, "call", call)
    fake.script[:] = [
        AIMessage(json.dumps({"action": "TYPE", "element": "e1", "value": "Akhil", "why": "fill the name"})),
        AIMessage(json.dumps({"action": "CLICK", "element": "e2", "why": "save"})),
        AIMessage(json.dumps({"action": "DONE", "evidence": "Save", "why": "saved"})),
    ]
    out = await computer_use.subtask("c1", "Settings", "Set my name", ["Akhil"], "the name shows Akhil", 6)
    assert out.startswith("DONE: saved") and "type e1 'Akhil': done" in out and "click e2: done" in out
    assert [c[0] for c in calls] == ["ui_look", "ui_act", "ui_act"]
    assert calls[1][1]["snapshot"] == "s2" and calls[2][1]["snapshot"] == "s3"  # each action on the latest screen

    fake.script[:] = [AIMessage(json.dumps({"action": "TYPE", "element": "e1", "value": "my password", "why": "?"}))]
    out = await computer_use.subtask("c1", "Settings", "Log in", ["Akhil"], "", 6)
    assert out.startswith("NEEDS_INPUT") and "my password" in out  # never types text it wasn't given


def test_teammates_with_a_computer_get_the_app_tools(env):
    from app import graph, tools
    nev = {"id": "n1", "name": "Neverland", "handle": "neverland", "role": "Your computer", "avatar_shape": "computer",
           "allowed_toolkits": []}
    import app.computers as C
    orig = C.device_of
    C.device_of = lambda tm: "c1"
    try:
        names = {t.name for t in tools.build(graph.RunCtx(run_id="r", owner_id="u", thread_id="dm:n1", members=[nev]), nev, [])}
    finally:
        C.device_of = orig
    assert {"computer_use", "computer_look", "computer_act", "computer_keys", "computer_subtask"} <= names
    assert tools.classify("computer_use") == "act" and tools.classify("computer_act") == "read"


def test_phone_status_reports_the_next_alarm():
    import asyncio, datetime, zoneinfo
    from app import phone
    owner, zone = "u-alarm", zoneinfo.ZoneInfo("Asia/Kolkata")
    at = datetime.datetime(2026, 10, 11, 6, 0, tzinfo=zone).timestamp() * 1000
    asyncio.run(phone.save_status(owner, {"model": "S21", "android": "16", "next_alarm": at, "next_alarm_app": "Clock"}))
    text = asyncio.run(phone.status_text(owner, zone))
    assert "Next alarm: Sun 11 Oct, 06:00 (Clock)" in text


async def test_done_must_be_on_screen(env, monkeypatch):
    _, fake = env
    fake.script[:] = [
        AIMessage(json.dumps({"action": "DONE", "evidence": "1000", "why": "shows 1000"})),
        AIMessage(json.dumps({"action": "CLICK", "element": "e2", "why": "fix it"})),
    ]
    d = await computer_use.decide("work out 125 x 8", [], "shows 1000", [], "[e1] text field “11,02,200” (type)\n[e2] button “C” (click)")
    assert d["action"] == "CLICK"  # the claim wasn't on screen: it looked again
    fake.script[:] = [AIMessage(json.dumps({"action": "DONE", "evidence": "1000", "why": "ok"}))]
    d = await computer_use.decide("work out 125 x 8", [], "shows 1000", [], "[e1] text field “1,000” (type)")
    assert d["action"] == "DONE"  # commas and spaces don't matter
