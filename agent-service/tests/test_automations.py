"""Automations: set up by chatting, run on a schedule (in the user's time zone) or on app events, quiet when idle."""
from datetime import UTC, datetime
from types import SimpleNamespace

from app import automations, config, connectors, events
from tests.conftest import OWNER, ai, settle, teammate


def rule_of(fdb):
    [r] = fdb.rows("event_rules")
    return r


async def test_teammate_sets_up_a_schedule_from_chat_with_a_capsule(api, env, monkeypatch):
    fdb, fake = env
    ivy = teammate(fdb, "ivy", "email")
    fake.script = [ai(calls=[("automate", {"action": "create", "name": "Mail brief", "when": "every 3 hours",
                                          "schedule": "0 */3 * * *", "instructions": "Brief the new mail since last run."})]),
                   ai("Done: a mail brief every 3 hours.")]
    await api.post(f"/threads/dm:{ivy['id']}/messages", json={"text": "give me a 3 hour brief of my mail from now on"})
    await settle()
    r = rule_of(fdb)
    assert r["event_type"] == "schedule" and r["match"]["cron"] == "0 */3 * * *" and r["teammate_id"] == ivy["id"]
    assert fdb.rows("messages", kind="event")[-1]["text"] == "Ivy set up an automation: Mail brief · every 3 hours"
    [shown] = (await api.get("/automations")).json()
    assert shown["name"] == "Mail brief" and shown["enabled"] and shown["next_run"] and shown["thread_id"] == f"dm:{ivy['id']}"


async def test_too_frequent_or_bad_schedules_are_refused():
    assert automations.check_cron("*/5 * * * *") and automations.check_cron("every hour")
    assert automations.check_cron("0 8 * * 1-5") is None and automations.check_cron("*/15 * * * *") is None


async def test_schedules_run_in_the_users_time_zone_quietly_when_idle_and_remember_the_last_run(env):
    fdb, fake = env
    ivy = teammate(fdb, "ivy", "email")
    await automations.create(OWNER, ivy, None, name="Morning brief", instructions="Summarise yesterday's mail.",
                             cron="0 8 * * *", tz="Asia/Kolkata", when="every day at 8 AM")
    # 8 AM in Kolkata is 02:30 UTC, not 08:00 UTC.
    await events.tick(datetime(2026, 9, 29, 8, 0, tzinfo=UTC))
    assert not fdb.rows("events", type="schedule")
    fake.script = [ai("QUIET")]
    await events.tick(datetime(2026, 9, 29, 2, 31, tzinfo=UTC))
    await settle()
    first = fake.calls[-1][-1].content
    assert "[Automation: Morning brief, every day at 8 AM]" in first and "first run" in first and "QUIET" in first
    assert not fdb.rows("messages", sender_type="teammate")  # nothing to say: nothing posted
    fake.script = [ai("Three mails need you today.")]
    await events.tick(datetime(2026, 9, 30, 2, 31, tzinfo=UTC))
    await settle()
    assert "It last ran" in fake.calls[-1][-1].content and "never repeat" in fake.calls[-1][-1].content
    [msg] = fdb.rows("messages", sender_type="teammate")
    assert msg["proactive"] and msg["meta"]["event_type"] == "automation:Morning brief"


class _Triggers:
    def __init__(self, calls):
        self.calls = calls

    def create(self, slug, user_id, trigger_config=None):
        self.calls.append(("create", slug, trigger_config))
        return SimpleNamespace(trigger_id="ti_1")

    def delete(self, tid):
        self.calls.append(("delete", tid))

    def disable(self, tid):
        self.calls.append(("disable", tid))

    def enable(self, tid):
        self.calls.append(("enable", tid))

    def verify_webhook(self, *, id, payload, secret, signature, timestamp):
        if signature != "good":
            raise ValueError("bad signature")
        import json
        return {"payload": json.loads(payload)}


async def test_app_event_automation_runs_on_the_webhook_with_its_keyword_filter(api, env, monkeypatch):
    fdb, fake = env
    calls: list = []
    monkeypatch.setattr(connectors, "_client", lambda: SimpleNamespace(triggers=_Triggers(calls)))
    monkeypatch.setattr(config, "env", lambda k, d=None: "secret" if k == "COMPOSIO_WEBHOOK_SECRET" else d)
    fdb.tables.setdefault("profiles", []).append({"id": OWNER})
    ivy = teammate(fdb, "ivy", "email")
    await automations.create(OWNER, ivy, None, name="Mail from abc", instructions="Ping them at once with the gist.",
                             trigger="GMAIL_NEW_GMAIL_MESSAGE", config={"query": "from:abc"}, contains=["abc"],
                             when="when a mail from abc arrives")
    assert calls == [("create", "GMAIL_NEW_GMAIL_MESSAGE", {"query": "from:abc"})]
    import json
    hook = lambda sender: {"id": "ti_1", "user_id": OWNER, "trigger_slug": "GMAIL_NEW_GMAIL_MESSAGE",  # noqa: E731
                           "toolkit_slug": "gmail", "payload": {"sender": sender, "subject": "Contract"}}
    headers = {"webhook-id": "msg_1", "webhook-timestamp": "1", "webhook-signature": "good"}
    assert (await api.post("/composio/webhook", content=json.dumps(hook("abc@acme.com")),
                           headers={**headers, "webhook-signature": "forged"})).status_code == 401
    fake.script = [ai("abc wrote about the contract.")]
    r = await api.post("/composio/webhook", content=json.dumps(hook("abc@acme.com")), headers=headers)
    await settle()
    assert r.json()["fired"] == 1 and "abc@acme.com" in fake.calls[-1][-1].content
    r = await api.post("/composio/webhook", content=json.dumps(hook("someone@else.com")), headers=headers)
    assert r.json()["fired"] == 0  # the keyword filter held it back

    rule = rule_of(fdb)
    assert (await api.patch(f"/automations/{rule['id']}", json={"enabled": False})).json()["enabled"] is False
    assert ("disable", "ti_1") in calls
    assert (await api.post(f"/automations/{rule['id']}/run")).status_code == 400  # app ones run on their event
    assert (await api.delete(f"/automations/{rule['id']}")).status_code == 200
    assert ("delete", "ti_1") in calls and not fdb.rows("event_rules")
    assert [m["text"] for m in fdb.rows("messages", kind="event")][-2:] == [
        "You paused an automation: Mail from abc", "You deleted an automation: Mail from abc"]


async def test_run_now_fires_a_scheduled_automation(api, env):
    fdb, fake = env
    ivy = teammate(fdb, "ivy", "email")
    rule = await automations.create(OWNER, ivy, None, name="Brief", instructions="Brief.", cron="0 8 * * *",
                                    tz="UTC", when="daily")
    fake.script = [ai("Here's your brief.")]
    assert (await api.post(f"/automations/{rule['id']}/run")).status_code == 200
    await settle()
    assert fdb.rows("messages", sender_type="teammate")[-1]["text"] == "Here's your brief."


async def test_detail_shows_each_run_and_edits_come_with_a_capsule(api, env):
    fdb, fake = env
    ivy = teammate(fdb, "ivy", "email")
    rule = await automations.create(OWNER, ivy, None, name="Brief", instructions="Brief.", cron="0 8 * * *",
                                    tz="Asia/Kolkata", when="every day at 8 AM")
    fake.script = [ai("QUIET")]
    await api.post(f"/automations/{rule['id']}/run")
    await settle()
    fake.script = [ai("Two new mails.")]
    await api.post(f"/automations/{rule['id']}/run")
    await settle()
    d = (await api.get(f"/automations/{rule['id']}")).json()
    assert [h["outcome"] for h in d["runs"]] == ["posted", "quiet"] and d["runs"][0]["preview"] == "Two new mails."
    assert d["last_run"] and d["when"] == "every day at 8 AM"

    r = await api.patch(f"/automations/{rule['id']}", json={"cron": "*/5 * * * *"})
    assert r.status_code == 400 and "too often" in r.json()["detail"]
    r = (await api.patch(f"/automations/{rule['id']}", json={"cron": "0 9 * * 1-5", "when": "weekdays at 9 AM",
                                                           "instructions": "Brief me."})).json()
    assert r["cron"] == "0 9 * * 1-5" and r["when"] == "weekdays at 9 AM" and r["instructions"] == "Brief me."
    assert fdb.rows("messages", kind="event")[-1]["text"] == "You updated an automation: Brief · weekdays at 9 AM"


async def test_set_up_from_the_app_in_a_project_the_teammate_is_in(api, env):
    fdb, fake = env
    ivy = teammate(fdb, "ivy", "email")
    fdb.tables.setdefault("projects", []).append({"id": "p1", "owner_id": OWNER, "name": "Launch"})
    body = {"teammate_id": ivy["id"], "project_id": "p1", "name": "Weekly wrap", "instructions": "Sum up the week.",
            "cron": "0 17 * * 5", "when": "Fridays at 5:00 PM", "tz": "Asia/Kolkata"}
    assert (await api.post("/automations", json=body)).status_code == 400  # not a member
    fdb.tables.setdefault("project_members", []).append({"project_id": "p1", "teammate_id": ivy["id"], "owner_id": OWNER})
    a = (await api.post("/automations", json=body)).json()
    assert a["thread_id"] == "proj:p1" and a["next_run"] and a["tz"] == "Asia/Kolkata"
    assert fdb.rows("messages", kind="event")[-1]["text"] == "You set up an automation: Weekly wrap · Fridays at 5:00 PM"
