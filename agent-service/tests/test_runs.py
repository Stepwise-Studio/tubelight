from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool

from app import connectors, graph
from tests.conftest import ai, plan, project, settle, teammate


async def test_dm_run_posts_message_and_streams(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    fake.script = [ai("Hello from Dev.")]

    r = await api.post(f"/threads/dm:{dev['id']}/messages", json={"text": "hi"})
    assert r.status_code == 200, r.text
    run_id = r.json()["run_id"]
    await settle()

    msgs = fdb.rows("messages", sender_type="teammate")
    assert [m["text"] for m in msgs] == ["Hello from Dev."]
    stream_id = msgs[0]["meta"]["stream_id"]
    deltas = [p for _, e, p in fdb.broadcasts if e == "delta"]
    assert deltas and deltas[-1] == {"run_id": run_id, "teammate_id": dev["id"], "stream_id": stream_id, "text": "Hello from Dev."}
    assert ("dm:" + dev["id"], "done", {"run_id": run_id, "teammate_id": dev["id"], "stream_id": stream_id}) in fdb.broadcasts
    assert fdb.rows("runs", id=run_id)[0]["status"] == "done"
    states = [p["state"] for _, e, p in fdb.broadcasts if e == "status"]
    assert states[0] == "thinking" and states[-1] == "idle"
    # the system preamble names the teammate and the date
    assert "You are Dev (@dev)" in fake.calls[0][0].content


async def test_rate_limit_error_posts_human_message(api, env):
    import httpx
    import openai

    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    resp = httpx.Response(429, request=httpx.Request("POST", "https://openrouter.ai"))

    def boom(_):
        raise openai.RateLimitError("Rate limit exceeded: free-models-per-day", response=resp, body=None)

    fake.script = [boom]
    await api.post(f"/threads/dm:{dev['id']}/messages", json={"text": "hi"})
    await settle()
    err = fdb.rows("messages", kind="error")
    assert err[0]["text"] == "Daily free model limit reached. It resets at 00:00 UTC."
    assert fdb.rows("runs")[0]["status"] == "error"


async def test_rejected_tool_call_is_retried_with_a_nudge(api, env):
    import httpx
    import openai

    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")

    def rejected(_):
        raise openai.APIError("Tool call validation failed: attempted to call tool 'COMPOSIO_SEARCH_TOOLS' which was "
                              "not in request.tools", request=httpx.Request("POST", "https://api.groq.com"), body=None)

    fake.script = [rejected, ai("Here you go.")]
    await api.post(f"/threads/dm:{dev['id']}/messages", json={"text": "hi"})
    await settle()
    assert [m["text"] for m in fdb.rows("messages", sender_type="teammate")] == ["Here you go."]
    assert "[Note: your last reply called a tool" in fake.calls[1][-1].content
    assert not fdb.rows("messages", kind="error")


async def test_project_routes_by_mention(api, env):
    fdb, fake = env
    dev, tess = teammate(fdb, "dev", "developer"), teammate(fdb, "tess", "tester")
    p = project(fdb, [dev, tess])
    fake.script = [plan(("tess", "Test it.")), ai("Tess checking in.")]
    await api.post(f"/threads/proj:{p['id']}/messages", json={"text": "@tess test it", "mentions": [tess["id"]]})
    await settle()
    [m] = fdb.rows("messages", sender_type="teammate")
    assert m["teammate_id"] == tess["id"]
    # the director reads the chat with the latest message marked; tags are evidence it weighs, not orders
    assert "LATEST MESSAGE — Akhil: @tess test it" in fake.calls[0][-1].content


async def test_project_routes_by_router_model(api, env):
    fdb, fake = env
    dev, tess = teammate(fdb, "dev", "developer"), teammate(fdb, "tess", "tester")
    p = project(fdb, [dev, tess])
    fake.script = [plan(("tess", "Check whether login works."), read="A testing question for Tess."), ai("On it.")]
    await api.post(f"/threads/proj:{p['id']}/messages", json={"text": "does login still work?"})
    await settle()
    [m] = fdb.rows("messages", sender_type="teammate")
    assert m["teammate_id"] == tess["id"]
    # the speaker gets the shared reading and its own part
    assert "What's happening: A testing question for Tess." in fake.calls[1][0].content
    assert "Your part: Check whether login works." in fake.calls[1][0].content


async def test_router_falls_back_to_first_member(api, env):
    fdb, fake = env
    dev, tess = teammate(fdb, "dev", "developer"), teammate(fdb, "tess", "tester")
    p = project(fdb, [dev, tess])
    fake.script = [ai("no idea"), ai("Dev here.")]
    await api.post(f"/threads/proj:{p['id']}/messages", json={"text": "hmm"})
    await settle()
    assert fdb.rows("messages", sender_type="teammate")[0]["teammate_id"] == dev["id"]


async def test_mentions_pass_the_turn_with_a_cap(api, env):
    fdb, fake = env
    dev, tess = teammate(fdb, "dev", "developer"), teammate(fdb, "tess", "tester")
    p = project(fdb, [dev, tess])

    def ping_pong(messages):
        me = "dev" if "(@dev)" in messages[0].content else "tess"
        return ai(f"Over to you, @{'tess' if me == 'dev' else 'dev'}.")

    fake.script = [ping_pong] * 20
    r = await api.post(f"/threads/proj:{p['id']}/messages", json={"text": "go", "mentions": [dev["id"]]})
    await settle()
    said = fdb.rows("messages", kind="text", sender_type="teammate")
    assert len(said) == 7  # dev's first reply, then at most 6 turns asked for by mention
    assert [m["teammate_id"] for m in said[:3]] == [dev["id"], tess["id"], dev["id"]]
    assert fdb.rows("runs", id=r.json()["run_id"])[0]["status"] == "done"
    # tess sees dev's words as a named message, never dev's tool traffic
    tess_view = next(c for c in fake.calls if "(@tess)" in c[0].content)
    assert any(isinstance(m, HumanMessage) and m.content.startswith("[Dev · developer]: Over to you, @tess") for m in tess_view)
    assert "Dev @mentioned you" in tess_view[0].content
    assert not any(isinstance(m, ToolMessage) for m in tess_view)


async def test_at_all_asks_everyone(api, env):
    fdb, fake = env
    dev, tess = teammate(fdb, "dev", "developer"), teammate(fdb, "tess", "tester")
    p = project(fdb, [dev, tess])
    fake.script = [plan(("dev", "Pick one."), ("tess", "Pick one.")), ai("Dev: tabs."), ai("Tess: spaces.")]
    await api.post(f"/threads/proj:{p['id']}/messages", json={"text": "@all tabs or spaces?"})
    await settle()
    said = fdb.rows("messages", kind="text", sender_type="teammate")
    assert [m["teammate_id"] for m in said] == [dev["id"], tess["id"]]
    # each knows the turn order, so nobody replies to someone who hasn't spoken yet
    dev_sys, tess_sys = fake.calls[1][0].content, fake.calls[2][0].content
    assert "Replying after you: Tess" in dev_sys and "Already replied" not in dev_sys
    assert "Already replied to the latest message: Dev" in tess_sys and "Replying after you" not in tess_sys


async def test_plan_orders_the_round_and_speakers_may_pass(api, env):
    fdb, fake = env
    dev, tess, ivy = teammate(fdb, "dev", "developer"), teammate(fdb, "tess", "tester"), teammate(fdb, "ivy", "email")
    p = project(fdb, [dev, tess, ivy])
    fake.script = [plan(("tess", "Roast Dev."), ("ivy", "Roast Dev."), ("dev", "You're the target: fire back last.")),
                   ai("one"), ai("PASS"), ai("three")]
    await api.post(f"/threads/proj:{p['id']}/messages", json={"text": "I want everyone to roast @dev", "mentions": [dev["id"]]})
    await settle()
    said = fdb.rows("messages", kind="text", sender_type="teammate")
    assert [(m["teammate_id"], m["text"]) for m in said] == [(tess["id"], "one"), (dev["id"], "three")]  # Ivy passed
    assert "Your part: You're the target: fire back last." in fake.calls[3][0].content


async def test_a_request_for_later_gets_one_confirmation_not_the_action(api, env):
    fdb, fake = env
    dev, tess, sol = teammate(fdb, "dev", "developer"), teammate(fdb, "tess", "tester"), teammate(fdb, "sol", "social")
    p = project(fdb, [dev, tess, sol])
    fake.script = [plan(("tess", "Confirm the roast."), ("dev", "Roast Sol."), ("sol", "Fire back."), timing="later"),
                   ai("Set for 6 pm.")]
    await api.post(f"/threads/proj:{p['id']}/messages", json={"text": "everyone roast @sol at 6 pm"})
    await settle()
    assert [m["teammate_id"] for m in fdb.rows("messages", sender_type="teammate")] == [tess["id"]]
    assert "set a follow-up with follow_up" in fake.calls[1][0].content


async def test_plan_may_choose_nobody_for_a_short_ack_only(api, env):
    fdb, fake = env
    dev, tess = teammate(fdb, "dev", "developer"), teammate(fdb, "tess", "tester")
    p = project(fdb, [dev, tess])
    fake.script = [plan()]
    r = await api.post(f"/threads/proj:{p['id']}/messages", json={"text": "ok thanks!"})
    await settle()
    assert not fdb.rows("messages", sender_type="teammate")
    assert fdb.rows("runs", id=r.json()["run_id"])[0]["status"] == "done"
    # a real question never goes unanswered: an empty plan falls back to a speaker
    fake.script = [plan(), ai("Dev here.")]
    await api.post(f"/threads/proj:{p['id']}/messages", json={"text": "can someone look at why the deploy failed last night?"})
    await settle()
    assert [m["teammate_id"] for m in fdb.rows("messages", sender_type="teammate")] == [dev["id"]]


def _gmail_tool(sent: list):
    def send(recipient_email: str, subject: str, body: str) -> str:
        sent.append({"recipient_email": recipient_email, "subject": subject, "body": body})
        return "sent"

    return StructuredTool.from_function(send, name="GMAIL_SEND_EMAIL", description="Send an email")


async def _approval_setup(api, env, monkeypatch, final: str):
    fdb, fake = env
    sent: list = []

    async def tools_for(user_id, toolkits):
        return [_gmail_tool(sent)]

    monkeypatch.setattr(connectors, "tools_for", tools_for)
    ivy = teammate(fdb, "ivy", "email", allowed_toolkits=["GMAIL"])
    fake.script = [ai(calls=[("GMAIL_SEND_EMAIL", {"recipient_email": "jane@acme.com", "subject": "Hi", "body": "Hello"})]),
                   ai(final)]
    r = await api.post(f"/threads/dm:{ivy['id']}/messages", json={"text": "email jane"})
    await settle()
    return fdb, fake, sent, r.json()["run_id"]


async def test_act_tool_waits_then_approve_with_edits(api, env, monkeypatch):
    fdb, fake, sent, run_id = await _approval_setup(api, env, monkeypatch, "Sent it.")
    [appr] = fdb.rows("approvals")
    assert appr["title"] == "Send email to jane@acme.com: Hi" and appr["status"] == "pending"
    [card] = fdb.rows("messages", kind="approval")
    assert card["meta"]["approval_id"] == appr["id"] and appr["message_id"] == card["id"]
    assert fdb.rows("runs", id=run_id)[0]["status"] == "waiting_approval"
    assert ("waiting" in [p["state"] for _, e, p in fdb.broadcasts if e == "status"])
    assert sent == []

    edited = {"recipient_email": "jane@acme.com", "subject": "Hi", "body": "Hello Jane"}
    r = await api.post(f"/approvals/{appr['id']}", json={"action": "approve", "args": edited})
    assert r.json() == {"ok": True, "status": "approved"}
    await settle()
    assert sent == [edited]
    assert fdb.rows("messages", kind="text", sender_type="teammate")[0]["text"] == "Sent it."
    assert fdb.rows("runs", id=run_id)[0]["status"] == "done"
    r = await api.post(f"/approvals/{appr['id']}", json={"action": "approve"})
    assert r.status_code == 409


async def test_act_tool_reject_tells_the_model(api, env, monkeypatch):
    fdb, fake, sent, run_id = await _approval_setup(api, env, monkeypatch, "Understood, not sending.")
    [appr] = fdb.rows("approvals")
    await api.post(f"/approvals/{appr['id']}", json={"action": "reject", "note": "wrong person"})
    await settle()
    assert sent == []
    last_tool_msg = [m for m in fake.calls[-1] if isinstance(m, ToolMessage)][-1]
    assert "rejected" in last_tool_msg.content and "wrong person" in last_tool_msg.content
    assert fdb.rows("messages", kind="text", sender_type="teammate")[0]["text"] == "Understood, not sending."
    assert fdb.rows("approvals")[0]["status"] == "rejected"


async def test_new_message_supersedes_pending_approval(api, env, monkeypatch):
    fdb, fake, sent, run_id = await _approval_setup(api, env, monkeypatch, "unused")
    fake.script = [ai("Okay, new topic.")]
    ivy = fdb.rows("teammates")[0]
    await api.post(f"/threads/dm:{ivy['id']}/messages", json={"text": "never mind"})
    await settle()
    assert fdb.rows("approvals")[0]["status"] == "expired"
    assert fdb.rows("runs", id=run_id)[0]["status"] == "cancelled"
    # the dangling tool call got a synthetic result so the provider accepts the history
    assert any(isinstance(m, ToolMessage) and "not completed" in m.content for m in fake.calls[-1])


def test_view_names_other_teammates():
    dev = {"id": "1", "handle": "dev", "name": "Dev", "role": "developer"}
    tess = {"id": "2", "handle": "tess", "name": "Tess", "role": "tester"}
    d = ai("I fixed it.")
    d.name = "dev"
    view = graph.view_for(tess, [HumanMessage("fix login"), d], [dev, tess])
    assert view[1].content == "[Dev · developer]: I fixed it." and isinstance(view[1], HumanMessage)
    assert graph.view_for(dev, [HumanMessage("x"), d], [dev, tess])[1] is d


async def test_ask_user_pauses_and_answer_resumes(api, env):
    fdb, fake = env
    sol = teammate(fdb, "sol", "social")
    fake.script = [ai(calls=[("ask_user", {"question": "Which tone?", "options": ["Playful", "Formal"]})]),
                   ai("Going playful.")]
    r = await api.post(f"/threads/dm:{sol['id']}/messages", json={"text": "draft a launch post"})
    await settle()
    [q] = fdb.rows("approvals", kind="question")
    [card] = fdb.rows("messages", kind="question")
    assert card["meta"]["options"] == ["Playful", "Formal"] and card["meta"]["approval_id"] == q["id"]
    assert fdb.rows("runs", id=r.json()["run_id"])[0]["status"] == "waiting_approval"
    assert (await api.post(f"/approvals/{q['id']}", json={"action": "approve"})).status_code == 400

    r = await api.post(f"/approvals/{q['id']}", json={"action": "answer", "answer": "Playful"})
    assert r.json()["status"] == "approved"
    await settle()
    assert [m["text"] for m in fdb.rows("messages", sender_type="user")] == ["draft a launch post", "Playful"]
    tool_msg = [m for m in fake.calls[-1] if isinstance(m, ToolMessage)][-1]
    assert tool_msg.content == "The user answered: Playful"
    assert fdb.rows("messages", kind="text", sender_type="teammate")[0]["text"] == "Going playful."


async def test_reply_to_quotes_the_message(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    fake.script = [ai("First."), ai("Second.")]
    await api.post(f"/threads/dm:{dev['id']}/messages", json={"text": "hi"})
    await settle()
    first = fdb.rows("messages", kind="text", sender_type="teammate")[0]
    await api.post(f"/threads/dm:{dev['id']}/messages", json={"text": "why?", "reply_to": first["id"]})
    await settle()
    human = [m for m in fake.calls[-1] if isinstance(m, HumanMessage)][-1]
    assert human.content.startswith('[Replying to Dev\'s message: "First."]') and human.content.endswith("why?")


async def test_mentioned_app_is_lent_for_the_request_through_approval(api, env, monkeypatch):
    fdb, fake = env
    sent: list = []
    asked: list = []

    async def tools_for(user_id, toolkits):
        asked.append(list(toolkits))
        return [_gmail_tool(sent)] if "GMAIL" in toolkits else []

    async def resolve(name):
        return {"gmail": "GMAIL", "notion": "NOTION"}.get(name.lower())

    async def ready(user_id):
        return {"GMAIL"}  # Notion isn't connected: dropped

    monkeypatch.setattr(connectors, "tools_for", tools_for)
    monkeypatch.setattr(connectors, "resolve", resolve)
    monkeypatch.setattr(connectors, "ready", ready)
    ivy = teammate(fdb, "ivy", "email")  # Gmail isn't one of Ivy's apps
    fake.script = [ai(calls=[("GMAIL_SEND_EMAIL", {"recipient_email": "jane@acme.com", "subject": "Hi", "body": "Hello"})]),
                   ai("Sent it.")]
    r = await api.post(f"/threads/dm:{ivy['id']}/messages", json={"text": "@gmail email jane", "apps": ["gmail", "notion"]})
    await settle()
    assert fdb.rows("messages", sender_type="user")[0]["meta"]["apps"] == ["GMAIL"]
    assert asked[0] == ["GMAIL"] and "@mentioned Gmail in this request" in fake.calls[0][0].content
    [appr] = fdb.rows("approvals")
    # resumed in a fresh run context: the lent app comes back from the saved message, so the call can run
    await api.post(f"/approvals/{appr['id']}", json={"action": "approve"})
    await settle()
    assert sent and fdb.rows("runs", id=r.json()["run_id"])[0]["status"] == "done"
    assert fdb.rows("teammates", id=ivy["id"])[0].get("allowed_toolkits") in (None, [])  # lent, not granted


async def test_a_reply_cut_off_mid_stream_is_retried_not_saved(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    cut = ai("Follow-up set for 1:1")
    cut.response_metadata = {"finish_reason": None}
    fake.script = [cut, ai("Follow-up set for 1:12 PM.")]
    await api.post(f"/threads/dm:{dev['id']}/messages", json={"text": "remind me at 1:12"})
    await settle()
    assert [m["text"] for m in fdb.rows("messages", sender_type="teammate")] == ["Follow-up set for 1:12 PM."]
