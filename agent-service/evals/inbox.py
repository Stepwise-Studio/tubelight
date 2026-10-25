"""Real-inbox eval (read-only): the user's actual Ivy, preamble, tools and Gmail, asked for a weekly summary with a
stale answer already in the chat (the 2026-10-25 failure: she repeated "Quiet week, 8 newsletters" without looking).
Run inside the server container: docker exec -i -w /srv tubelight-agent python -m evals.inbox <owner_id> [model ...]
Nothing is posted; Gmail is only read."""
import asyncio
import sys
import uuid

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app import db, graph, llm, runs

ASK = "Could you look at my inbox of the last week and summarise it and let me know if anything needs my attention"
STALE = "Quiet week, nothing needs you: 8 newsletters and promos, no urgent items."


async def once(owner: str, model: str, history: bool) -> dict:
    ivy = await db.one("teammates", {"owner_id": f"eq.{owner}", "handle": "eq.ivy"})
    ctx = await runs.load_ctx(str(uuid.uuid4()), owner, f"dm:{ivy['id']}", "message")
    tm = {**ivy, "model": model}
    tools = await ctx.tools_for(tm)
    by = {t.name: t for t in tools}
    msgs = ([HumanMessage(ASK), AIMessage(STALE, name="ivy")] if history else []) + [HumanMessage(ASK)]
    system = await graph.preamble(ctx, tm, msgs, list(by))
    convo = [SystemMessage(system), *graph.view_for(tm, msgs, ctx.members)]
    m = llm.chat_model(model, tools)
    called = []
    for _ in range(6):
        out = await m.ainvoke(convo)
        convo.append(out)
        if not out.tool_calls:
            break
        for tc in out.tool_calls:
            called.append(tc["name"])
            t = by.get(tc["name"])
            res = await t.ainvoke(tc["args"]) if t and graph.T.classify_call(tc["name"], tc["args"]) != "act" else "[skipped]"
            convo.append(ToolMessage(str(res)[:60_000], tool_call_id=tc["id"]))
    reply = graph.said(convo[-1])
    return {"looked at the inbox": "inbox" in called, "not the stale answer": STALE[:20] not in reply,
            "says how many emails": any(ch.isdigit() for ch in reply[:200]), "calls": called, "reply": reply}


async def main(owner: str, models: list[str]) -> None:
    for model in models:
        for history in (False, True):
            r = await once(owner, model, history)
            checks = {k: v for k, v in r.items() if isinstance(v, bool)}
            print(f"\n{model} ({'stale answer in chat' if history else 'fresh chat'}): {sum(checks.values())}/{len(checks)} calls={r['calls']}")
            for k, v in checks.items():
                print(f"  {'✓' if v else '✗'} {k}")
            print("  " + r["reply"][:1200].replace("\n", "\n  "))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2:] or [llm.config.DEFAULT_MODEL]))
