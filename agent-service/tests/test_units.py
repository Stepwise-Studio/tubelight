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
    assert tools.label(tools.MULTI, {"tools": [fetch]}) == "Gmail: fetch emails"


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


def test_voice_heard_drops_silence_and_phantoms():
    from app.voice import heard, parts

    assert heard({"text": " Thank you.", "segments": [{"text": " Thank you.", "no_speech_prob": 0.2}]}) == ""
    assert heard({"segments": [{"text": " Hi Dev", "no_speech_prob": 0.1}, {"text": " blah", "no_speech_prob": 0.9}]}) == "Hi Dev"
    assert heard({"text": "Book a meeting"}) == "Book a meeting"
    assert parts("") == [] and len(parts("Short. " * 40)[0]) <= 120
