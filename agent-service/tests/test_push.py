"""Push notifications: bundled per chat, shaped by the user's choices, with faces, sounds and action categories."""
from app import push
from tests.conftest import OWNER, settle


async def test_replies_in_a_burst_go_out_as_one_and_needs_you_kinds_at_once(env, monkeypatch):
    sent = []

    async def send(owner, msg):
        sent.append(msg)
    monkeypatch.setattr(push, "_send", send)
    monkeypatch.setattr(push, "BUNDLE_S", 0.05)
    tess = {"name": "Tess", "avatar_shape": "face:Kai", "color": "#F59E0B"}
    dev = {"name": "Dev", "avatar_shape": "robot", "color": "#3B82F6"}
    await push.notify(OWNER, "Tess in Launch", "First **thing**", "proj:p", teammate=tess)
    await push.notify(OWNER, "Dev in Launch", "Second", "proj:p", teammate=dev)
    await push.notify(OWNER, "Tess in Launch", "Third", "proj:p", teammate=tess)
    await push.notify(OWNER, "Ivy needs your approval", "Send the invoice", "proj:p", kind="approval",
                      teammate={"name": "Ivy"}, approval_id="a1")
    assert len(sent) == 1 and sent[0]["categoryId"] == "approval" and sent[0]["data"]["approval_id"] == "a1"
    await settle()
    import asyncio
    await asyncio.sleep(0.1)
    burst = sent[1]
    assert burst["title"] == "Tess and Dev · Launch" and burst["body"] == "Tess: Third (+2 more)"
    assert burst["tag"] == "proj:p" and burst["categoryId"] == "reply" and burst["channelId"] == "tl-chime"
    assert "seed=Kai" in burst["richContent"]["image"] and "backgroundColor=F59E0B" in burst["richContent"]["image"]


async def test_only_when_it_needs_me_and_per_chat_settings(env, monkeypatch):
    sent = []

    async def send(owner, msg):
        sent.append(msg)
    monkeypatch.setattr(push, "_send", send)
    monkeypatch.setattr(push, "BUNDLE_S", 0.01)
    await push.set_prefs(OWNER, mode="needed", sound="drop", chats={"dm:x": "all", "proj:quiet": "off"})
    await push.notify(OWNER, "Tess", "hi", "proj:p")  # a reply: not needed
    await push.notify(OWNER, "Dev asked you", "Which branch?", "proj:p", kind="question", approval_id="q1")
    await push.notify(OWNER, "Ivy", "hello", "dm:x")  # this chat wants everything
    await push.notify(OWNER, "Ivy needs your approval", "x", "proj:quiet", kind="approval", approval_id="a2")  # muted
    import asyncio
    await asyncio.sleep(0.05)
    assert [m["data"].get("kind") for m in sent] == ["question", "reply"]
    assert sent[0]["channelId"] == "tl-drop" and sent[0]["categoryId"] == "question"
    p = await push.set_prefs(OWNER, chats={"dm:x": None})
    assert "dm:x" not in p["chats"] and p["mode"] == "needed"


async def test_preferences_api(api, env):
    r = (await api.patch("/notifications/prefs", json={"mode": "needed", "sound": "bell", "chats": {"proj:a": "off"}})).json()
    assert r["mode"] == "needed" and r["sound"] == "bell" and r["chats"] == {"proj:a": "off"} and "chime" in r["sounds"]
    assert (await api.patch("/notifications/prefs", json={"sound": "foghorn"})).status_code == 400
    assert (await api.get("/notifications/prefs")).json()["sound"] == "bell"
