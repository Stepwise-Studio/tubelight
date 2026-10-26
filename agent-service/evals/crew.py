"""Whole-crew eval on the user's real apps (read-only): each teammate's real prompt, preamble and tools, one probe
that needs fresh data, run the way a chat runs it (look-first judge → forced first tool call). Tools that act
(send, post, push...) and ask_teammate (it would post in another chat) are not run; they return "[skipped]".
Nothing is written to any chat. Run inside the server container:
    docker exec -w /srv tubelight-agent python -m evals.crew <owner_id> [handle ...] [x3]   (x3: each probe 3 times)
Checks per probe: the judge said look, the first move was a tool call, a data tool returned something, the reply
isn't the stale answer planted in history (where one is). Read the replies too: the checks can't judge accuracy."""
import asyncio
import re
import sys
import uuid

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app import db, graph, ground, llm, runs

STALE = "Quiet week, nothing needs you: 8 newsletters and promos, no urgent items."
# Facts from the user's real data that a fair reply must carry (dated: the inbox moves on, refresh them when it does).
MUST = {"ivy": (r"applica", 400), "tempo": (r"TDS Project 1", 2000)}  # handle: (pattern, within the first N chars)
PROBES = {  # handle: (request, stale answer planted before it, or "")
    "ivy": ("Could you look at my inbox of the last week and summarise it and let me know if anything needs my attention", STALE),
    "tempo": ("What's on my calendar this week?", ""),
    "rex": ("Which of my GitHub repos changed most recently?", ""),
    "quill": ("What's in my IITM material so far?", ""),
    "nova": ("What's my LinkedIn headline right now?", ""),
    "iris": ("Is anything urgent waiting on me in my mail or calendar today?", ""),
}
SKIP = {"ask_teammate"}


async def probe(owner: str, handle: str) -> dict:
    request, stale = PROBES[handle]
    tm = await db.one("teammates", {"owner_id": f"eq.{owner}", "handle": f"eq.{handle}"})
    ctx = await runs.load_ctx(str(uuid.uuid4()), owner, f"dm:{tm['id']}", "message")
    tools = await ctx.tools_for(tm)
    by = {t.name: t for t in tools}
    msgs = ([HumanMessage(request), AIMessage(stale, name=handle)] if stale else []) + [HumanMessage(request)]
    verdict = await ground.judge(tm, list(by), request, f"user: {request}\n{handle}: {stale}" if stale else "")
    convo = [SystemMessage(await graph.preamble(ctx, tm, msgs, list(by))), *graph.view_for(tm, msgs, ctx.members)]
    if verdict["look"]:
        convo.append(ground.note(verdict["what"]))
    calls, data = [], 0
    for step in range(8):
        out = await llm.chat_model(tm["model"], tools, must_use_tool=verdict["look"] and step == 0).ainvoke(convo)
        convo.append(out)
        if not out.tool_calls:
            break
        for tc in out.tool_calls:
            calls.append(tc["name"])
            t = by.get(tc["name"])
            run = t and tc["name"] not in SKIP and graph.T.classify_call(tc["name"], tc["args"]) != "act"
            res = graph.T.results.fit(await t.ainvoke(tc["args"])) if run else "[skipped in the eval]"
            data += bool(run and len(str(res)) > 80 and "fail" not in str(res)[:80].lower())
            convo.append(ToolMessage(res, tool_call_id=tc["id"], name=tc["name"]))
    reply = graph.said(convo[-1])
    seen = ground.turn_data(convo)
    first = await ground.check(request, seen, reply) if len(seen) >= ground.DATA_MIN else {"ok": True, "problems": []}
    redrawn = not first["ok"]
    if redrawn:  # as in a chat: one redraw with the problems named (graph._checked)
        out = await llm.chat_model(tm["model"], tools).ainvoke([*convo, ground.redo(first["problems"])])
        reply = graph.said(out)
    final = await ground.check(request, seen, reply) if len(seen) >= ground.DATA_MIN else first
    checks = {"judge said look": verdict["look"], "first move was a tool": bool(calls),
              "a data tool answered": data > 0, "not the stale answer": not stale or stale[:20] not in reply,
              "final reply fair to the data (grader)": final["ok"]}
    if handle in MUST:
        pat, within = MUST[handle]
        checks[f"says '{pat}' early (ground truth)"] = bool(re.search(pat, reply[:within], re.I))
    return {"checks": checks, "calls": calls, "reply": reply, "redrawn": first["problems"] if redrawn else [],
            "still wrong": final["problems"]}


async def main(owner: str, handles: list[str], times: int) -> None:
    total = passed = 0
    for h in handles:
        rates: dict[str, int] = {}
        for n in range(times):
            try:
                r = await probe(owner, h)
            except Exception as e:
                print(f"\n{h} #{n + 1}: ERROR {str(e)[:300]}")
                continue
            for k, v in r["checks"].items():
                rates[k] = rates.get(k, 0) + v
            total, passed = total + len(r["checks"]), passed + sum(r["checks"].values())
            print(f"\n{h} #{n + 1}: {sum(r['checks'].values())}/{len(r['checks'])} calls={r['calls']}")
            if r["redrawn"]:
                print(f"  (first draft redrawn: {'; '.join(r['redrawn'])})")
            if r["still wrong"]:
                print(f"  (grader: {'; '.join(r['still wrong'])})")
            print("  " + r["reply"][:500].replace("\n", "\n  "))
        print(f"{h}: " + " · ".join(f"{k} {v}/{times}" for k, v in rates.items()))
    print(f"\nTOTAL {passed}/{total}")


if __name__ == "__main__":
    args = [a for a in sys.argv[2:] if not a.startswith("x")]
    times = next((int(a[1:]) for a in sys.argv[2:] if a.startswith("x")), 1)
    asyncio.run(main(sys.argv[1], args or list(PROBES), times))
