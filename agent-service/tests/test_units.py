from datetime import UTC, datetime, timedelta

from langchain_core.messages import HumanMessage, RemoveMessage, ToolMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES, add_messages

from app import events, graph, memory, tools
from tests.conftest import OWNER, ai, settle, teammate


def test_tool_classification():
    assert tools.classify("GMAIL_FETCH_EMAILS") == "read"
    assert tools.classify("GITHUB_LIST_REPOSITORY_ISSUES") == "read"
    assert tools.classify("GMAIL_CREATE_EMAIL_DRAFT") == "draft"
    assert tools.classify("GMAIL_SEND_DRAFT") == "act"  # sending a draft is still sending
    assert tools.classify("GMAIL_SEND_EMAIL") == "act"
    assert tools.classify("GITHUB_MERGE_A_PULL_REQUEST") == "act"
    assert tools.classify("LINKEDIN_CREATE_LINKED_IN_POST") == "act"
    assert tools.classify("NOTION_CREATE_NOTION_PAGE") == "act"  # unknown verb defaults to act
    assert tools.classify("GITHUB_DELETE_A_REPOSITORY") == "act"
    assert tools.classify("read_file") == "read"
    assert tools.classify("write_file") == "draft"
    assert tools.classify("run_shell") == "draft"
    assert tools.classify("git_push") == "act"
    assert tools.title("GMAIL_SEND_EMAIL", {"recipient_email": "jane@acme.com"}) == "Send email to jane@acme.com"


def _history(n: int, tool_size: int, human_size: int = 10) -> list:
    msgs = []
    for i in range(n):
        call = ai(calls=[("recall", {"query": str(i)})])
        call.name = "dev"
        msgs += [HumanMessage("q" * human_size, id=f"h{i}"), call.model_copy(update={"id": f"a{i}"}),
                 ToolMessage("x" * tool_size, tool_call_id=call.tool_calls[0]["id"], id=f"t{i}")]
    return msgs


async def test_compaction_trims_old_tool_output(env, monkeypatch):
    fdb, _ = env
    dev = teammate(fdb, "dev", "developer")
    ctx = graph.RunCtx(run_id="r", owner_id=OWNER, thread_id=f"dm:{dev['id']}", members=[dev])

    async def window(model):
        return 1000

    monkeypatch.setattr(graph.llm, "context_window", window)
    msgs = _history(10, tool_size=300)  # ~800 tokens: over 65%, trimming gets it under 80%
    updates, out = await graph.compact(ctx, dev, msgs)
    assert updates and all(u.content == graph.STUB and u.id.startswith("t") for u in updates)
    shrunk = add_messages(msgs, updates)
    assert len(shrunk) == len(msgs) and graph.estimate_tokens(shrunk) < graph.estimate_tokens(msgs)
    assert all(m.content == "x" * 300 for m in shrunk[-graph.KEEP_TAIL:] if isinstance(m, ToolMessage))
    assert fdb.rows("activity", type="compaction")[0]["name"] == "trim"


async def test_compaction_summarizes_and_remembers(env, monkeypatch):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    ctx = graph.RunCtx(run_id="r", owner_id=OWNER, thread_id=f"dm:{dev['id']}", members=[dev])

    async def window(model):
        return 1000

    monkeypatch.setattr(graph.llm, "context_window", window)
    fake.script = [ai("We agreed to ship on Friday.\nFACTS:\n- Release is on Friday\n- User prefers pnpm")]
    msgs = _history(10, tool_size=10, human_size=400)  # human text cannot be trimmed: must summarize
    updates, out = await graph.compact(ctx, dev, msgs)
    assert isinstance(updates[0], RemoveMessage) and updates[0].id == REMOVE_ALL_MESSAGES
    assert out[0].content.startswith("[Summary of the earlier conversation]\nWe agreed to ship on Friday.")
    assert not isinstance(out[1], ToolMessage)
    assert len(add_messages(msgs, updates)) == len(out) < len(msgs)
    facts = [r["text"] for r in await memory.listing(memory.ns("teammate", dev["id"]))]
    assert sorted(facts) == ["Release is on Friday", "User prefers pnpm"]
    assert fdb.rows("activity", type="compaction")[0]["name"] == "summarize"


async def test_a_summary_survives_embeddings_being_down(env, monkeypatch):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    ctx = graph.RunCtx(run_id="r", owner_id=OWNER, thread_id=f"dm:{dev['id']}", members=[dev])

    async def window(model):
        return 1000

    async def down(*a, **k):
        raise RuntimeError("429 daily neurons used up")
    monkeypatch.setattr(graph.llm, "context_window", window)
    monkeypatch.setattr(graph.memory, "add", down)
    fake.script = [ai("We agreed to ship on Friday.\nFACTS:\n- Release is on Friday")]
    updates, out = await graph.compact(ctx, dev, _history(10, tool_size=10, human_size=400))
    assert updates and out[0].content.startswith("[Summary of the earlier conversation]")
    assert fdb.rows("activity", type="compaction")[0]["name"] == "summarize" and not fdb.rows("activity", type="error")


def test_event_rule_matching():
    rule = {"event_type": "error", "match": {"service": "web"}, "enabled": True}
    assert events.matches(rule, "error", {"service": "web", "message": "boom"})
    assert not events.matches(rule, "error", {"service": "api"})
    assert not events.matches(rule, "email", {"service": "web"})
    assert not events.matches({**rule, "enabled": False}, "error", {"service": "web"})
    assert events.matches({"event_type": "email", "match": {}, "enabled": True}, "email", {})


def _rule(fdb, tm, **kw):
    r = {"id": f"rule-{len(fdb.tables.get('event_rules', []))}", "owner_id": OWNER, "name": "Errors",
         "event_type": "error", "match": {}, "project_id": None, "teammate_id": tm["id"], "instructions": "Triage it.",
         "enabled": True, "max_per_hour": 2, "created_at": "2026-01-01", **kw}
    fdb.tables.setdefault("event_rules", []).append(r)
    return r


async def test_webhook_routes_then_rate_limits(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    _rule(fdb, dev)
    fake.script = [ai("Looks like a null list in the dashboard."), ai("Same error again.")]
    for _ in range(3):
        r = await api.post("/events/tok123", json={"type": "error", "payload": {"message": "boom"}})
        await settle()
    assert r.json()["routed"] is False
    assert [e["status"] for e in fdb.rows("events")] == ["routed", "routed", "rate_limited"]
    posts = fdb.rows("messages", sender_type="teammate")
    assert len(posts) == 2 and all(p["proactive"] for p in posts)
    assert fdb.rows("messages", kind="event")[0]["text"] == "Error event from webhook: boom"
    assert (await api.post("/events/nope", json={"type": "error"})).status_code == 404


async def test_low_importance_email_stays_quiet(api, env):
    fdb, fake = env
    ivy = teammate(fdb, "ivy", "email")
    _rule(fdb, ivy, event_type="email")
    fake.script = [ai("SKIP 2: newsletter")]
    await api.post("/events/tok123", json={"type": "email", "payload": {"subject": "Weekly digest"}})
    await settle()
    assert "importance" in fake.calls[0][-1].content
    assert fdb.rows("messages", sender_type="teammate") == []
    assert fdb.rows("activity", name="email_ignored")


async def test_schedule_fires_once_per_slot(env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    _rule(fdb, dev, event_type="schedule", match={"cron": "*/5 * * * *"}, max_per_hour=10)
    fake.script = [ai("Standup: nothing blocked."), ai("Standup again.")]
    now = datetime(2026, 9, 25, 10, 5, 30, tzinfo=UTC)
    await events.tick(now)
    await events.tick(now + timedelta(seconds=20))
    await settle()
    [ev] = fdb.rows("events")
    assert ev["payload"]["slot"] == "2026-09-25T10:05:00+00:00" and ev["status"] == "routed"
    await events.tick(now + timedelta(minutes=10))  # slot 10:15 is 30 s old: fires
    await events.tick(now + timedelta(hours=1, minutes=3))  # latest slot is 3.5 min old: skipped
    assert len(fdb.rows("events")) == 2
    await settle()


async def test_sandbox_guards(tmp_path, monkeypatch):
    import pytest

    from app import config, sandbox

    monkeypatch.setattr(config, "WORKSPACES", tmp_path)
    box = sandbox.Sandbox("run1", "tm1", None)
    for cmd in ("git push origin main", "cd x && git -c a=b push", "npm test; git push"):
        assert "blocked" in await box.run_shell(cmd)
    box.dir.mkdir(parents=True)
    assert box._path("/workspace/src/a.py") == (tmp_path / "run1/src/a.py").resolve()
    with pytest.raises(ValueError):
        box._path("../../etc/passwd")
    assert len(sandbox.truncate("x" * 20000)) < 8100


def test_composio_multi_execute_is_gated_by_inner_slugs():
    send = {"tool_slug": "GMAIL_SEND_EMAIL", "arguments": {"recipient_email": "jane@acme.com", "body": "Hi"}}
    fetch = {"tool_slug": "GMAIL_FETCH_EMAILS", "arguments": {"max_results": 5}}
    assert tools.classify_call(tools.MULTI, {"tools": [fetch]}) == "read"
    assert tools.classify_call(tools.MULTI, {"tools": [fetch, send]}) == "act"
    assert tools.classify_call("COMPOSIO_SEARCH_TOOLS", {"queries": []}) == "read"
    name, title, draft = tools.approval_view(tools.MULTI, {"tools": [send], "thought": "x"})
    assert (name, title, draft) == ("GMAIL_SEND_EMAIL", "Send email to jane@acme.com", send["arguments"])
    edited = tools.apply_edit(tools.MULTI, {"tools": [send], "thought": "x"}, {"recipient_email": "bob@acme.com", "body": "Yo"})
    assert edited == {"tools": [{"tool_slug": "GMAIL_SEND_EMAIL", "arguments": {"recipient_email": "bob@acme.com", "body": "Yo"}}],
                      "thought": "x"}
    assert tools.label(tools.MULTI, {"tools": [fetch]}) == "Fetching emails in Gmail"


def test_model_ids_and_fallback_chain(monkeypatch):
    from langchain_core.runnables import RunnableWithFallbacks

    from app import llm
    monkeypatch.delenv("CF_GATEWAY_ID", raising=False)  # the developer's .env may route through a gateway

    assert llm.parse("nvidia/nemotron-3-super-120b-a12b:free") == ("openrouter", "nvidia/nemotron-3-super-120b-a12b:free")
    assert llm.parse("openrouter:qwen/qwen3.8-27b:free") == ("openrouter", "qwen/qwen3.8-27b:free")
    assert llm.parse("groq:openai/gpt-oss-120b") == ("groq", "openai/gpt-oss-120b")
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    monkeypatch.setenv("GROQ_API_KEY", "k")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("LLM_FALLBACKS", "groq:openai/gpt-oss-120b, gemini:gemini-2.5-flash, openrouter:a/b:free")
    assert llm.fallbacks() == ["groq:openai/gpt-oss-120b", "openrouter:a/b:free"]  # gemini has no key
    chain = llm.chat_model("a/b:free")  # bare id equals the openrouter fallback: not repeated
    assert isinstance(chain, RunnableWithFallbacks) and len(chain.fallbacks) == 1
    assert chain.runnable.openai_api_base == "https://openrouter.ai/api/v1"
    assert chain.fallbacks[0].openai_api_base == "https://api.groq.com/openai/v1"


def test_paid_openrouter_models_are_refused():
    from app import llm

    assert llm.is_free("openrouter:qwen/qwen3.8-27b:free")
    assert llm.is_free("groq:openai/gpt-oss-120b")
    assert not llm.is_free("openrouter:anthropic/claude-opus-5")
    try:
        llm._one("openrouter:openai/gpt-6")
        raise AssertionError("a paid model was constructed")
    except llm.PaidModelError:
        pass


def test_paid_plan_workers_models_are_skipped_not_fatal(monkeypatch):
    from app import config, llm

    monkeypatch.setattr(llm, "_cf_paid", {"@cf/zai-org/glm-5.3"})
    monkeypatch.setattr(config, "DEFAULT_MODEL", "groq:openai/gpt-oss-120b")
    monkeypatch.setattr(llm, "fallbacks", lambda: [])
    assert not llm.is_free("cloudflare:@cf/zai-org/glm-5.3")
    assert llm.is_free("cloudflare:@cf/openai/gpt-oss-120b")
    model = llm.chat_model("cloudflare:@cf/zai-org/glm-5.3")  # a teammate still set to it keeps working
    assert model.model_name == "openai/gpt-oss-120b"


def test_composio_null_defaults_accept_null_and_are_dropped():
    from app.connectors import _drop_nones, _nullable
    schema = {"properties": {
        "q": {"type": "array", "items": {"properties": {"use_case": {"type": "string"}, "known_fields": {"type": "string", "default": None}}}},
        "session": {"$ref": "#/$defs/S", "default": None},
    }}
    out = _nullable(schema)
    assert out["properties"]["q"]["items"]["properties"]["known_fields"]["type"] == ["string", "null"]
    assert out["properties"]["q"]["items"]["properties"]["use_case"]["type"] == "string"
    assert out["properties"]["session"]["anyOf"] == [{"$ref": "#/$defs/S"}, {"type": "null"}]
    assert _drop_nones({"q": [{"use_case": "x", "known_fields": None}], "session": None}) == {"q": [{"use_case": "x"}]}


def test_status_labels_read_as_actions():
    from app.tools import label
    assert label("GMAIL_FETCH_EMAILS", {}) == "Fetching emails in Gmail"
    assert label("GITHUB_CREATE_AN_ISSUE", {}) == "Creating an issue in GitHub"
    assert label("COMPOSIO_SEARCH_TOOLS", {}) == "Finding the right tool"


def test_old_tool_results_shrink_but_the_current_turn_stays_whole():
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

    from app.graph import OLD_RESULT_CHARS, shrink_old_results
    big = "x" * 5000
    msgs = [HumanMessage("yesterday"), AIMessage("", tool_calls=[{"id": "a", "name": "t", "args": {}}]), ToolMessage(big, tool_call_id="a"),
            AIMessage("done"), HumanMessage("today"), AIMessage("", tool_calls=[{"id": "b", "name": "t", "args": {}}]), ToolMessage(big, tool_call_id="b")]
    out = shrink_old_results(msgs)
    assert len(out[2].content) < OLD_RESULT_CHARS + 50 and out[6].content == big
    assert msgs[2].content == big  # history itself untouched


def test_composio_schemas_are_trimmed():
    from app.connectors import _lean
    s = _lean({"title": "X", "examples": [1], "properties": {"q": {"type": "string", "title": "Q", "description": "word " * 100}}})
    assert "title" not in s and "examples" not in s
    assert len(s["properties"]["q"]["description"]) <= 160 and "title" not in s["properties"]["q"]


def test_big_requests_skip_groq_first(monkeypatch):
    from app import config, llm

    monkeypatch.setattr(config, "DEFAULT_MODEL", "groq:openai/gpt-oss-120b")
    monkeypatch.setattr(llm, "fallbacks", lambda: ["cloudflare:@cf/openai/gpt-oss-120b"])
    monkeypatch.setattr(llm, "key", lambda p: "k")
    assert llm.chat_model(size=3000).runnable.model_name == "openai/gpt-oss-120b"  # small: Groq first
    big = llm.chat_model(size=12000)
    assert big.runnable.last.model_name == "@cf/openai/gpt-oss-120b"  # big: Cloudflare first (via the content fix)
    assert big.fallbacks[0].model_name == "openai/gpt-oss-120b"


def test_status_label_for_non_verb_actions():
    from app.tools import label
    assert label("GOOGLECALENDAR_EVENTS_LIST", {}) == "Working in Googlecalendar"


def test_floor_decides_later_by_comparing_times_not_by_model_arithmetic():
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from app.floor import later
    now = datetime(2026, 9, 28, 13, 26, tzinfo=ZoneInfo("Asia/Kolkata"))
    assert later("2026-09-28T13:27", now)  # a minute away is still later
    assert not later("2026-09-28T13:26", now) and not later("2026-09-28T13:10", now)  # now, or already past
    assert later("condition", now) and not later("now", now) and not later(None, now) and not later("soonish", now)


def test_later_request_confirmed_by_a_teammate_only_when_named():
    import json
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from app.floor import parse
    members = [{"id": "d", "handle": "dev", "name": "Dev"}, {"id": "s", "handle": "sol", "name": "Sol"}]
    now = datetime(2026, 9, 28, 13, 0, tzinfo=ZoneInfo("Asia/Kolkata"))
    reply = json.dumps({"when": "2026-09-28T18:00", "what": "roast Ivy", "speakers": [{"handle": "dev", "part": "set it"}]})
    p = parse(reply, members, now, "everyone, roast ivy at 6")
    assert p.speakers == [] and p.what == "roast Ivy" and p.at.hour == 18  # nobody named: the director sets it
    assert parse(reply, members, now, "@dev remind us to roast ivy at 6").speakers == ["d"]
    assert parse(reply, members, now, "Dev, remind us at 6").speakers == ["d"]


def test_director_set_follow_up_uses_the_message_when_the_model_gives_no_task_and_everyone_reacts():
    import json
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from app.floor import parse
    members = [{"id": "d", "handle": "dev", "name": "Dev"}, {"id": "s", "handle": "sol", "name": "Sol"}]
    now = datetime(2026, 9, 28, 13, 0, tzinfo=ZoneInfo("Asia/Kolkata"))
    p = parse(json.dumps({"read": "director notes", "when": "2026-09-28T14:23", "speakers": [],
                          "react": [{"handle": "sol", "emoji": "😂"}]}), members, now, "lets roast ivy at 2:23")
    assert p.what == "lets roast ivy at 2:23" and p.reacts == [("d", "👍"), ("s", "😂")]


def test_a_reply_stuck_in_a_loop_is_caught_but_normal_markdown_is_not():
    from app.graph import looping
    assert looping("Did " + "**\u200b" * 30)
    assert looping("ha " + "lol " * 25)
    assert not looping("Here's the table:\n| a | b |\n|---|---|\n| 1 | 2 |\n" + "-" * 60)
    assert not looping("Some normal reply. " * 3)


async def test_web_tools_return_the_answer_with_sources_and_readable_pages(monkeypatch):
    from app import connectors, graph, tools as T

    async def fake(user_id, slug, args):
        if slug == "COMPOSIO_SEARCH_WEB":
            return {"answer": "Argentina won.", "citations": [{"id": "https://apnews.com/x", "title": "AP"}]}
        return {"results": [{"title": "Docs", "text": "Hello page"}]}
    monkeypatch.setattr(connectors, "execute", fake)
    ctx = graph.RunCtx(run_id="r", owner_id="o", thread_id="dm:x", members=[])
    tm = {"id": "t", "name": "Ivy", "handle": "ivy", "role": "x", "allowed_toolkits": []}
    by = {t.name: t for t in T.build(ctx, tm, [])}
    out = await by["web_search"].coroutine(query="world cup")
    assert out.startswith("Argentina won.") and "- AP https://apnews.com/x" in out
    assert "Hello page" in await by["read_page"].coroutine(url="https://docs.example.com")
    assert "full web address" in await by["read_page"].coroutine(url="docs.example.com")


def test_free_text_roles_decide_who_gets_a_sandbox():
    from app.tools import builder
    assert builder({"role": "Developer"}) and builder({"role": "QA engineer"}) and builder({"role": "Data analyst"})
    assert not builder({"role": "Inbox chief of staff"}) and not builder({"role": "Social media lead"})


async def test_email_attachments_are_read_as_text_in_one_call(monkeypatch, tmp_path):
    from app import connectors, graph, tools as T
    (tmp_path / "a.txt").write_text("Asha: 3 years of PyTorch, built a RAG app")
    calls = []

    async def fake(user_id, slug, args):
        calls.append((slug, args["attachment_id"]))
        if args["attachment_id"] == "bad":
            raise RuntimeError("not found")
        return {"file": {"name": args["file_name"], "mimetype": "text/plain", "s3url": str(tmp_path / "a.txt")}}
    monkeypatch.setattr(connectors, "execute", fake)
    ctx = graph.RunCtx(run_id="r", owner_id="o", thread_id="dm:x", members=[])
    tm = {"id": "t", "name": "Ivy", "handle": "ivy", "role": "x", "allowed_toolkits": []}
    read = {t.name: t for t in T.build(ctx, tm, [])}["read_attachments"]
    out = await read.coroutine(files=[{"message_id": "m1", "attachment_id": "x1", "file_name": "asha.txt"},
                                      {"message_id": "m2", "attachment_id": "bad", "file_name": "ravi.pdf"}])
    assert "### asha.txt\nAsha: 3 years of PyTorch" in out and "### ravi.pdf\n(Couldn't read it: not found)" in out
    assert [c[0] for c in calls] == ["GMAIL_GET_ATTACHMENT"] * 2
    ctx.only = ["github"]
    assert "isn't allowed" in await read.coroutine(files=[{"message_id": "m1", "attachment_id": "x1"}])


def test_gmail_dates_become_what_gmail_understands():
    from app.connectors import _fix_gmail, gmail_query
    # 2026-10-27: "after:...T14:14+05:30" matched nothing, so an inbox check said 0 emails while 15 had arrived
    assert gmail_query("after:2026/10/27 after:2026-10-27T14:14+05:30") == "after:2026/10/27 after:1793090640"
    assert gmail_query("after:2026-10-27 is:unread") == "after:2026/10/27 is:unread"
    assert gmail_query("before:2026-10-28T09:00:00Z") == "before:1793178000"
    for kept in ("newer_than:2d from:college", "after:1793100000", "after:2026/10/27", "subject:after:party"):
        assert gmail_query(kept) == kept
    call = {"tools": [{"tool_slug": "GMAIL_FETCH_EMAILS", "arguments": {"query": "after:2026-10-27"}},
                      {"tool_slug": "SLACK_SEARCH", "arguments": {"query": "after:2026-10-27"}}]}
    fixed = _fix_gmail("COMPOSIO_MULTI_EXECUTE_TOOL", call)
    assert [x["arguments"]["query"] for x in fixed["tools"]] == ["after:2026/10/27", "after:2026-10-27"]


async def test_attachments_are_found_from_the_email_not_copied_ids(monkeypatch, tmp_path):
    from app import connectors, graph, tools as T
    (tmp_path / "a.txt").write_text("resume text")
    got = []

    async def fake(user_id, slug, args):
        if slug == "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID":
            return {"attachmentList": [{"filename": f"{i}.txt", "attachmentId": f"ANG{i}" + "x" * 400} for i in range(15)]}
        got.append(args["attachment_id"])
        return {"file": {"name": args["file_name"], "mimetype": "text/plain", "s3url": str(tmp_path / "a.txt")}}
    monkeypatch.setattr(connectors, "execute", fake)
    ctx = graph.RunCtx(run_id="r", owner_id="o", thread_id="dm:x", members=[])
    tm = {"id": "t", "name": "Ivy", "handle": "ivy", "role": "x", "allowed_toolkits": []}
    read = {t.name: t for t in T.build(ctx, tm, [])}["read_attachments"].coroutine
    out = await read(files=[{"message_id": "m1"}])  # the whole email
    assert out.count("resume text") == 15 and len(got) == 15
    got.clear()
    await read(files=[{"message_id": "m1", "attachment_id": "ANG3xxxx…", "file_name": "3.txt"}])  # a cut id
    assert got == ["ANG3" + "x" * 400]
