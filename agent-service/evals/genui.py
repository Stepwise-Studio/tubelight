"""Generative UI evals: does a teammate draw (```openui, app/genui.md) when it helps, stay in prose when it doesn't,
and write blocks the app can render, using only the numbers it was given?

    .venv/bin/python -m evals.genui [model ...]     e.g. gemini:gemini-3.5-flash-lite groq:openai/gpt-oss-120b

When a drawing comes out wrong in the app, add the moment here first, then improve the rules in
app/scripts/genui-prompt.ts (and `npm run genui-prompt`). Not part of pytest: it calls real, rate-limited models.
"""
import asyncio
import re
import sys
import time

from langchain_core.messages import HumanMessage, SystemMessage

from app import config, genui, llm

PACE = 5
SYSTEM = ("You are Ivy, an operations teammate in Tubelight, chatting with Akhil on his phone. Today is Fri 2 Oct 2026. "
          "You have no tools in this chat.\n\n" + genui.PROMPT)
KNOWN = set(re.findall(r"^(\w+)\(", genui.PROMPT, re.M))

# (name, message, None = must not draw | set of components one of which must appear, numbers it may use)
CASES = [
    ("week of numbers", "Visualise my focus hours this week: Mon 3, Tue 5, Wed 4, Thu 2, Fri 4",
     {"BarChart", "LineChart"}, {3, 5, 4, 2}),
    ("a day's calendar", "My calendar today: 9:30-10 standup, 12-1 lunch with Kishore, 3-4:30 design review. Lay it out for me",
     {"Schedule"}, set()),
    ("where money goes", "My spending this month: rent 15000, food 6200, travel 2400, other 1800. Show me where it goes",
     {"Donut", "BarChart"}, {15000, 6200, 2400, 1800}),
    ("stages of a plan", "Launch plan: design is done, build is in progress, QA is next, launch on Oct 20. Show the stages",
     {"Timeline"}, set()),
    ("who talks to whom", "chat_stats gave: Messages per person: Akhil 40, Dev 22, Ivy 15. Who answered whom: Akhil -> Dev 14, "
     "Dev -> Akhil 11, Akhil -> Ivy 9, Ivy -> Dev 4, Dev -> Ivy 3. Visualise our exchanges, me to agents and agent to agent",
     {"Flows"}, {14, 11, 9, 4, 3}),
    ("pie of model usage", "model_usage gave: Chat requests per model, last 14 days: gemini:gemini-3.8-flash 182, "
     "gemini:gemini-3.5-flash-lite 96, groq:openai/gpt-oss-120b 41, cloudflare:@cf/openai/gpt-oss-120b 12. "
     "Get me a pie chart of which models I used most", {"Donut"}, {182, 96, 41, 12}),
    ("small talk", "hey, how's your day going?", None, set()),
    ("plain question", "What's a good way to say no to a meeting politely?", None, set()),
    ("chart with no data", "Show me a chart of my sleep last week", None, set()),
]


def block(text: str) -> str | None:
    m = re.search(r"```openui(?:-lang)?\s*\n(.*?)```", text, re.S)
    return m.group(1) if m else None


def problems(src: str, want: set[str], numbers: set[int]) -> list[str]:
    out = []
    lines = [ln.strip() for ln in src.strip().splitlines() if ln.strip()]
    if not lines or not lines[0].startswith("root = Card("):
        out.append("first line isn't root = Card(...)")
    used = set(re.findall(r"\b([A-Z]\w*)\(", src))
    if used - KNOWN:
        out.append(f"unknown components {sorted(used - KNOWN)}")
    if want and not used & want:
        out.append(f"expected one of {sorted(want)}, got {sorted(used)}")
    names = [ln.split("=", 1)[0].strip() for ln in lines if "=" in ln.split("(", 1)[0]]
    for n in names:
        if n != "root" and not re.search(rf"[\[(,]\s*{re.escape(n)}\s*[\]),]", src):
            out.append(f"'{n}' is defined but never used")
    if numbers:
        found = {float(x) for x in re.findall(r"(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])", src)}
        if not {float(n) for n in numbers} <= found:
            out.append(f"missing given numbers {sorted(n for n in numbers if float(n) not in found)}")
    return out


async def run(model: str) -> None:
    m = llm._one(model)
    ok = 0
    print(f"\n{model}")
    for name, msg, want, numbers in CASES:
        t = time.time()
        try:
            reply = (await m.ainvoke([SystemMessage(SYSTEM), HumanMessage(msg)])).text
        except Exception as e:
            print(f"  ERR  {name}: {str(e)[:160]}")
            await asyncio.sleep(PACE)
            continue
        src = block(reply)
        if want is None:
            bad = ["drew when it shouldn't"] if src else []
        else:
            bad = ["no ```openui block"] if src is None else problems(src, want, numbers)
        ok += not bad
        print(f"  {'ok  ' if not bad else 'FAIL'} {name} ({time.time() - t:.1f}s){': ' + '; '.join(bad) if bad else ''}")
        if bad:
            print("       " + reply.replace("\n", "\n       ")[:900])
        await asyncio.sleep(PACE)
    print(f"  {ok}/{len(CASES)}")


async def main():
    for model in sys.argv[1:] or [config.DEFAULT_MODEL]:
        await run(model)

asyncio.run(main())
