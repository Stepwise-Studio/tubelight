"""The chat brief, search_chat and follow-ups: context that outlives the message window."""
from datetime import UTC, datetime, timedelta

from langchain_core.messages import ToolMessage

from app import brief, followups, memory
from tests.conftest import OWNER, ai, plan, project, settle, teammate


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


async def test_a_teammates_chats_know_about_each_other(api, env):
    """Several chats with one teammate: each run sees the others' briefs, search_chat spans them, extra ones get named."""
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    main, side = f"dm:{dev['id']}", f"dm:{dev['id']}:a1"
    fdb.tables["threads"].append({"id": side, "owner_id": OWNER, "kind": "dm", "teammate_id": dev["id"], "title": None})
    next(t for t in fdb.tables["threads"] if t["id"] == main)["last_message_at"] = "2026-09-28T04:00:00+00:00"
    said(fdb, main, "2026-09-28T03:30:00+00:00", "pricing: keep the free tier at 3 teammates")
    await memory.store.aput(("thread", main), "brief", {"text": "Decisions: free tier stays at 3 teammates."}, index=False)
    seen = {}

    def answer(messages):
        seen["result"] = next(m.content for m in reversed(messages) if isinstance(m, ToolMessage))
        return ai("In the main chat we kept the free tier at 3.")

    fake.script = [ai(calls=[("search_chat", {"query": "free tier"})]), answer,
                   ai('{"brief": "Asked about pricing.", "title": "Pricing check"}')]
    await api.post(f"/threads/{side}/messages", json={"text": "what did we say about the free tier in the other chat?"})
    await settle()
    assert "## Your other chats" in fake.calls[0][0].content and "free tier stays at 3" in fake.calls[0][0].content
    assert '(in the other chat "main chat")' in seen["result"]
    await brief.refresh(OWNER, side, "Akhil", "UTC")
    assert fdb.rows("threads", id=side)[0]["title"] == "Pricing check"


def later(**kw) -> str:
    """A local (UTC in tests) time from now, as the tools take it."""
    return (datetime.now(UTC) + timedelta(**kw)).strftime("%Y-%m-%dT%H:%M")


async def test_time_follow_up_fires_once_with_a_visible_note(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    fake.script = [ai(calls=[("follow_up", {"when": later(hours=3), "what": "check whether the deploy went green"})]),
                   ai("Will do.")]
    await api.post(f"/threads/dm:{dev['id']}/messages", json={"text": "check the deploy in 3 hours"})
    await settle()
    assert "Follow-up set for" in fake.calls[1][-1].content
    [f] = (await api.get(f"/threads/dm:{dev['id']}/followups")).json()["pending"]
    assert f["what"] == "check whether the deploy went green" and f["owner"] == dev["id"] and f["at"]

    assert await followups.tick(datetime.now(UTC) + timedelta(hours=1)) == 0  # not yet
    fake.script = [ai("Deploy is green.")]
    assert await followups.tick(datetime.now(UTC) + timedelta(hours=4)) == 1
    await settle()
    notes = [(m["meta"]["followup"], m["text"]) for m in fdb.rows("messages", kind="event")]
    assert notes[0][0] == "created" and notes[0][1].startswith("Dev set a follow-up for ")
    assert notes[-1] == ("fired", "Follow-up: check whether the deploy went green")
    msg = fdb.rows("messages", sender_type="teammate")[-1]
    assert msg["text"] == "Deploy is green." and msg["proactive"]
    assert "It's time now" in fake.calls[-1][-1].content
    assert await followups.tick(datetime.now(UTC) + timedelta(days=1)) == 0  # fired once
    got = (await api.get(f"/threads/dm:{dev['id']}/followups")).json()
    assert got["pending"] == [] and [(d["what"], d["status"]) for d in got["done"]] == [("check whether the deploy went green", "fired")]


async def test_group_follow_up_goes_through_the_floor(api, env):
    fdb, fake = env
    dev, sol = teammate(fdb, "dev", "developer"), teammate(fdb, "sol", "social")
    p = project(fdb, [dev, sol])
    thread = f"proj:{p['id']}"
    await followups.add(OWNER, thread, "group", "circle back on the launch copy", at=datetime.now(UTC) + timedelta(minutes=1))
    fake.script = [plan(("sol", "Bring the launch copy back up.")), ai("Circling back: here's the copy.")]
    assert await followups.tick(datetime.now(UTC) + timedelta(minutes=2)) == 1
    await settle()
    assert "LATEST MESSAGE — Scheduled follow-up: [Follow-up set earlier: circle back on the launch copy]" in fake.calls[0][-1].content
    assert fdb.rows("messages", sender_type="teammate")[-1]["teammate_id"] == sol["id"]


async def test_a_teammates_group_follow_up_goes_through_the_floor_with_them_leading(api, env):
    fdb, fake = env
    dev, sol, tess = teammate(fdb, "dev", "developer"), teammate(fdb, "sol", "social"), teammate(fdb, "tess", "tester")
    p = project(fdb, [dev, sol, tess])
    await followups.add(OWNER, f"proj:{p['id']}", sol["id"], "announce the verdict", at=datetime.now(UTC), by="Sol")
    # The director puts Sol third; as the owner, Sol still goes first.
    fake.script = [plan(("dev", "React."), ("tess", "React."), ("sol", "Announce it.")), ai("Verdict: tabs."), ai("Noted."), ai("Fair.")]
    await followups.tick(datetime.now(UTC) + timedelta(minutes=1))
    await settle()
    assert "@sol set it and leads; the members it concerns follow" in fake.calls[0][-1].content  # the director knows who leads
    assert [m["teammate_id"] for m in fdb.rows("messages", sender_type="teammate")] == [sol["id"], dev["id"], tess["id"]]


async def test_owner_who_left_the_group_falls_to_the_floor(api, env):
    fdb, fake = env
    dev, sol = teammate(fdb, "dev", "developer"), teammate(fdb, "sol", "social")
    p = project(fdb, [dev, sol])
    await followups.add(OWNER, f"proj:{p['id']}", "someone-deleted", "ship it", at=datetime.now(UTC))
    fake.script = [plan(("dev", "Ship it.")), ai("Shipping.")]
    await followups.tick(datetime.now(UTC) + timedelta(minutes=1))
    await settle()
    assert fdb.rows("messages", sender_type="teammate")[-1]["teammate_id"] == dev["id"]


async def test_deadline_nudges_and_late_firing_says_so(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    await followups.add(OWNER, f"dm:{dev['id']}", dev["id"], "deploy the site", until="the design tweak is done",
                        check_by=datetime.now(UTC) - timedelta(hours=5))
    fake.script = [ai("Is the design tweak done yet?")]
    assert await followups.tick() == 1
    await settle()
    lead = fake.calls[-1][-1].content
    assert "Still waiting on: the design tweak is done" in lead and "due 5 h ago" in lead


async def test_a_claimed_follow_up_is_not_fired_twice_but_a_stale_claim_is_retried(env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    key = await followups.add(OWNER, f"dm:{dev['id']}", dev["id"], "x", at=datetime.now(UTC))

    async def claim(ago: timedelta) -> None:
        item = await memory.store.aget(followups.NS, key)
        await memory.store.aput(followups.NS, key, {**item.value, "claimed": (datetime.now(UTC) - ago).isoformat()}, index=False)

    await claim(timedelta(seconds=5))  # being fired right now (e.g. by a tick still running)
    assert await followups.tick(datetime.now(UTC) + timedelta(minutes=1)) == 0
    await claim(timedelta(minutes=10))  # a crash after claiming: the lease ran out, so it's retried
    fake.script = [ai("ok")]
    assert await followups.tick(datetime.now(UTC) + timedelta(minutes=1)) == 1
    await settle()
    assert not await memory.store.aget(followups.NS, key)


async def test_follow_up_for_a_deleted_chat_is_dropped(env):
    fdb, fake = env
    await followups.add(OWNER, "dm:gone", "x", "x", at=datetime.now(UTC))
    assert await followups.tick(datetime.now(UTC) + timedelta(minutes=1)) == 0
    assert await followups.pending(OWNER) == []


async def test_polling_check_stays_silent_until_met(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    thread = f"dm:{dev['id']}"
    key = await followups.add(OWNER, thread, dev["id"], "deploy it", until="PR #12 is merged", poll_hours=1)
    fake.script = [ai("NOT_YET")]
    assert await followups.tick(datetime.now(UTC) + timedelta(hours=2)) == 1
    await settle()
    assert "reply exactly NOT_YET" in fake.calls[-1][-1].content
    assert not fdb.rows("messages", sender_type="teammate")  # silent
    assert await memory.store.aget(followups.NS, key)  # still waiting
    assert await followups.tick(datetime.now(UTC) + timedelta(hours=2, minutes=30)) == 0  # checked recently
    fake.script = [ai("PR #12 is merged, deploying now.")]
    assert await followups.tick(datetime.now(UTC) + timedelta(hours=4)) == 1
    await settle()
    assert fdb.rows("messages", sender_type="teammate")[-1]["text"] == "PR #12 is merged, deploying now."
    assert not await memory.store.aget(followups.NS, key)  # done


def keeper(**plan_) -> object:
    import json
    return ai(json.dumps({"brief": "Open loops: see follow-ups.", "add": [], "met": [], "cancel": [], **plan_}))


async def test_keeper_adds_marks_met_across_chats_and_cancels(env):
    fdb, fake = env
    dev, sol = teammate(fdb, "dev", "developer"), teammate(fdb, "sol", "designer")
    p = project(fdb, [dev, sol], name="Launch")
    group = f"proj:{p['id']}"
    said(fdb, group, "2026-09-28T04:00:00+00:00", "let's deploy once Sol's design tweak is done, and circle back on copy at 6")

    fake.script = [keeper(add=[
        {"what": "deploy the site", "owner": "dev", "at": None, "until": "Sol's design tweak is done", "check_by": None},
        {"what": "circle back on the launch copy", "owner": "group", "at": later(hours=6), "until": None},
        {"what": "a time in the past is ignored", "owner": "dev", "at": "2020-01-01T10:00", "until": None},
    ])]
    assert await brief.refresh(OWNER, group, "Akhil", "UTC") == {"add": 2, "met": 0, "cancel": 0}
    pend = {f["what"]: f for f in await followups.pending(OWNER, group)}
    assert pend["deploy the site"]["owner"] == dev["id"] and pend["deploy the site"]["until"]
    assert pend["circle back on the launch copy"]["owner"] == "group"

    # The design news lands in Sol's DM: the keeper there sees the group's pending condition and settles it.
    said(fdb, f"dm:{sol['id']}", "2026-09-28T05:00:00+00:00", "design tweak is done and uploaded", sol["id"])
    cond = pend["deploy the site"]["id"]
    fake.script = [keeper(met=[{"id": cond, "evidence": "Sol said it's uploaded"}]), plan(("dev", "Deploy it.")), ai("Deploying now.")]
    assert (await brief.refresh(OWNER, f"dm:{sol['id']}", "Akhil", "UTC"))["met"] == 1
    listed = next(c[-1].content for c in fake.calls if "uploaded" in c[-1].content)
    assert f"id {cond} [group Launch] @dev: deploy the site (once Sol's design tweak is done)" in listed
    await settle()
    assert fdb.rows("messages", sender_type="teammate")[-1]["teammate_id"] == dev["id"]
    assert fdb.rows("messages", sender_type="teammate")[-1]["thread_id"] == group
    assert "Its condition is met: Sol's design tweak is done. (Sol said it's uploaded)" in fake.calls[-1][-1].content

    said(fdb, group, (datetime.now(UTC) + timedelta(seconds=1)).isoformat(), "forget the copy check, it's done")
    copy = pend["circle back on the launch copy"]["id"]
    fake.script = [keeper(cancel=[copy])]
    assert (await brief.refresh(OWNER, group, "Akhil", "UTC"))["cancel"] == 1
    assert await followups.pending(OWNER, group) == []


async def test_follow_ups_api_lists_per_chat_and_cancels_only_your_own(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    key = await followups.add(OWNER, f"dm:{dev['id']}", dev["id"], "x", at=datetime.now(UTC) + timedelta(hours=1))
    other = await followups.add("someone-else", f"dm:{dev['id']}", dev["id"], "y", at=datetime.now(UTC) + timedelta(hours=1))
    assert [f["id"] for f in (await api.get(f"/threads/dm:{dev['id']}/followups")).json()["pending"]] == [key]
    assert (await api.delete(f"/followups/{other}")).status_code == 404
    assert (await api.delete(f"/followups/{key}")).status_code == 200
    got = (await api.get(f"/threads/dm:{dev['id']}/followups")).json()
    assert got["pending"] == [] and got["done"][0]["status"] == "cancelled"
    assert fdb.rows("messages", kind="event")[-1]["text"] == "You cancelled a follow-up: x"


async def test_keeper_reads_times_as_local_and_cannot_undo_fresh_follow_ups(env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    thread = f"dm:{dev['id']}"
    said(fdb, thread, datetime.now(UTC).isoformat(), "set a follow-up for tonight")
    fresh = await followups.add(OWNER, thread, dev["id"], "check tonight", at=datetime.now(UTC) + timedelta(hours=5))
    local = (datetime.now(UTC) + timedelta(hours=8)).strftime("%Y-%m-%dT%H:%M")  # 2.5 h from now, read as IST
    fake.script = [keeper(add=[{"what": "later check", "owner": "dev", "at": local + ":00Z"}], cancel=[fresh])]
    await brief.refresh(OWNER, thread, "Akhil", "Asia/Kolkata")
    pend = {f["what"]: f for f in await followups.pending(OWNER, thread)}
    assert "check tonight" in pend  # set during these messages: not undone
    # "Z" ignored: the wall-clock time is read in Asia/Kolkata (UTC+5:30)
    got = datetime.fromisoformat(pend["later check"]["at"])
    assert abs((got - (datetime.fromisoformat(local).replace(tzinfo=UTC) - timedelta(hours=5, minutes=30))).total_seconds()) < 60


async def test_met_condition_whose_owner_already_answered_here_is_closed_not_fired(env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    thread = f"dm:{dev['id']}"
    cond = await followups.add(OWNER, thread, dev["id"], "deploy", until="the design is done")
    said(fdb, thread, "2026-09-28T05:00:00+00:00", "the design is done")
    said(fdb, thread, "2026-09-28T05:00:05+00:00", "Deploying now.", dev["id"])
    fake.script = [keeper(met=[{"id": cond, "evidence": "design done"}])]
    changes = await brief.refresh(OWNER, thread, "Akhil", "UTC")
    assert changes["met"] == 0 and changes["cancel"] == 1
    assert [m["meta"]["followup"] for m in fdb.rows("messages", kind="event")] == ["noted", "done"]  # no second wake-up


async def test_director_sets_a_group_follow_up_when_nobody_was_named_and_the_group_reacts(api, env):
    import json
    fdb, fake = env
    dev, sol, ivy = teammate(fdb, "dev", "developer"), teammate(fdb, "sol", "social"), teammate(fdb, "ivy", "email")
    p = project(fdb, [dev, sol, ivy])
    at = (datetime.now(UTC) + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M")  # UTC: no user time zone in tests
    fake.script = [ai(json.dumps({"read": "A roast of Ivy, later.", "when": at, "what": "roast Ivy", "speakers": [],
                                  "react": [{"handle": "dev", "emoji": "👍"}, {"handle": "sol", "emoji": "👍"},
                                            {"handle": "ivy", "emoji": "😂"}, {"handle": "sol", "emoji": "🔥"}]}))]
    r = await api.post(f"/threads/proj:{p['id']}/messages", json={"text": "lets roast ivy in 2 hours"})
    await settle()
    assert not fdb.rows("messages", sender_type="teammate")  # nobody writes; the group reacts
    [f] = await followups.pending(OWNER, f"proj:{p['id']}")
    assert f["owner"] == "group" and f["what"] == "roast Ivy" and f["set_by"] == "floor"
    assert fdb.rows("messages", kind="event")[-1]["text"].startswith("Follow-up set for ")
    [mine] = fdb.rows("messages", id=r.json()["message"]["id"])
    assert mine["meta"]["reactions"] == [{"by": dev["id"], "emoji": "👍"}, {"by": sol["id"], "emoji": "👍"},
                                         {"by": ivy["id"], "emoji": "😂"}]  # everyone, one each, the director's pick kept


async def test_user_reactions_toggle_and_stay_one_per_person(api, env):
    fdb, fake = env
    dev = teammate(fdb, "dev", "developer")
    said(fdb, f"dm:{dev['id']}", datetime.now(UTC).isoformat(), "hello", dev["id"])
    mid = fdb.rows("messages")[0]["id"]
    assert (await api.post(f"/messages/{mid}/react", json={"emoji": "👍"})).json()["reactions"] == [{"by": "user", "emoji": "👍"}]
    assert (await api.post(f"/messages/{mid}/react", json={"emoji": "❤️"})).json()["reactions"] == [{"by": "user", "emoji": "❤️"}]
    assert (await api.post(f"/messages/{mid}/react", json={"emoji": "❤️"})).json()["reactions"] == []
    assert (await api.post(f"/messages/{mid}/react", json={"emoji": "🍕"})).json()["reactions"] == [{"by": "user", "emoji": "🍕"}]
    assert (await api.post(f"/messages/{mid}/react", json={"emoji": "👩‍💻"})).status_code == 200  # a ZWJ sequence
    for bad in ("lol", "a", "", "👍👍👍👍👍👍👍👍👍"):
        assert (await api.post(f"/messages/{mid}/react", json={"emoji": bad})).status_code == 400
