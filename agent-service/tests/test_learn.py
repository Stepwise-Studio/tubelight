"""The learning pass: turns an exchange into memory changes (add, update, done, delete)."""
import json

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app import learn, memory

from .conftest import OWNER


async def test_learns_people_commitments_and_closes_them(env):
    fdb, fake = env
    tm = {"id": "tm1", "name": "Ivy"}
    shelf = memory.ns("user", OWNER)
    old = await memory.add(shelf, "Priya is a designer", kind="person", about=["Priya Raman"])
    msgs = [HumanMessage("summarise today's email"),
            AIMessage("", tool_calls=[{"id": "c1", "name": "GMAIL_FETCH_EMAILS", "args": {}}]),
            ToolMessage("Priya Raman <priya@northwind.design>: please send the 5-seat invoice by Monday", tool_call_id="c1"),
            AIMessage("One thing needs you: Priya wants the invoice by Monday.", name="ivy")]

    def plan(messages):
        assert old in messages[0].content  # existing memories are offered for updating
        return AIMessage(json.dumps({
            "add": [{"text": "Owes Priya Raman (Northwind) the 5-seat Stepwise UI invoice", "kind": "commitment",
                     "about": ["Priya Raman", "Northwind"], "shelf": "user", "due": "2026-09-28"},
                    {"text": "Gmail: fetch with a newer_than:1d query for today's mail", "kind": "lesson", "shelf": "teammate"}],
            "update": [{"key": old, "text": "Priya Raman runs design at Northwind, a Stepwise UI customer"}],
            "delete": ["not-a-real-key"], "done": []}))
    fake.script.append(plan)
    changes = await learn.learn(OWNER, "Akhil", tm, None, "run1", msgs, "Sunday, September 27, 2026")
    assert changes == {"add": 2, "update": 1, "delete": 0, "done": 0}

    owed = await memory.listing(shelf, kind="commitment", done=False)
    assert owed[0]["due"] == "2026-09-28" and owed[0]["about"] == ["Priya Raman", "Northwind"]
    assert (await memory.get(shelf, old))["text"].startswith("Priya Raman runs design")
    assert (await memory.listing(memory.ns("teammate", "tm1")))[0]["kind"] == "lesson"

    # a later exchange shows it was handled
    fake.script.append(AIMessage(json.dumps({"add": [], "update": [], "delete": [], "done": [owed[0]["key"]]})))
    msgs2 = [HumanMessage("I sent Priya the invoice just now"), AIMessage("Nice, ticked off.", name="ivy")]
    assert (await learn.learn(OWNER, "Akhil", tm, None, "run2", msgs2, "Sunday"))["done"] == 1
    assert await memory.listing(shelf, kind="commitment", done=False) == []


async def test_small_talk_is_not_sent_to_the_model(env):
    _, fake = env
    assert await learn.learn(OWNER, "Akhil", {"id": "tm1", "name": "Ivy"}, None, "r", [HumanMessage("hey")], "today") == {}
    assert fake.calls == []
