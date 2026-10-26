import json

from app import results


def mails(n, body=3000):
    return {"data": {"messages": [{"id": i, "from": f"p{i}@x.com", "subject": f"S{i}", "body": "x" * body} for i in range(n)]}}


def test_small_results_pass_through():
    assert results.fit("hello") == "hello" and results.fit(str({"a": 1})) == "{'a': 1}"


def test_long_fields_shrink_but_every_item_stays():
    out = results.fit(str(mails(50)))  # a Python repr, as Composio's tools return it
    data = json.loads(out.split("\n[Complete")[0])
    assert len(data["data"]["messages"]) == 50 and data["data"]["messages"][49]["subject"] == "S49"
    assert "every item is here" in out and len(out) < results.BUDGET + 300


def test_when_items_must_go_it_says_how_many():
    out = results.fit(mails(2000, body=10))
    data = json.loads(out.split("\n[RESULT COMPACTED")[0])
    shown = [m for m in data["data"]["messages"] if "_more" not in m]
    assert data["data"]["messages"][-1]["_more"] == 2000 - len(shown) and len(shown) > 100
    assert "NOT SHOWN" in out and "Don't present this as complete" in out


def test_plain_text_says_it_was_cut():
    out = results.fit("a" * 50_000)
    assert "RESULT CUT" in out and out.startswith("a") and out.endswith("a")
