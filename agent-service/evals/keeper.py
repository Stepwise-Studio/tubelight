"""Keeper evals: follow-up reconciliation (app/brief.py decide) on real models.

    .venv/bin/python -m evals.keeper [model ...]     e.g. gemini:gemini-3.5-flash-lite groq:openai/gpt-oss-120b

When the keeper misses or invents a follow-up in the app, add the moment here first, then improve the prompt.
Not part of pytest: it calls real, rate-limited models.
"""
import asyncio
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from app import brief, config

NOW = datetime(2026, 9, 28, 14, 0, tzinfo=ZoneInfo("Asia/Kolkata"))  # a Monday, 2 PM
PACE = 5  # seconds between calls: the free tiers allow ~15 requests a minute
ROSTER = "@dev (Dev), @sol (Sol), @ivy (Ivy), @tess (Tess)"
DEPLOY = "- id A [group Launch] @dev: deploy the site (once Sol's design tweak is done)"
COPY = "- id B [group Launch] group: circle back on the launch copy (at Mon Sep 28, 06:00 PM)"


def adds(p):
    return p.get("add") or []


def met(p):
    return [m.get("id") for m in p.get("met") or []]


def quiet(p):
    return not adds(p) and not met(p) and not (p.get("cancel") or [])


def at(p, day, lo, hi):
    return any(str(a.get("at") or "").startswith(f"2026-09-{day}T") and lo <= int(str(a["at"])[11:13]) <= hi for a in adds(p))


def cond(p, *words):
    return any(a.get("until") and all(w in a["until"].lower() for w in words) and not a.get("at") for a in adds(p))


# (name, pending follow-ups, new messages, check)
CASES = [
    ("a phone alarm or timer is no follow-up (the phone rings itself)", "(none)",
     ["Akhil: start a 2 minute timer", "Shelby: Timer set for 2 minutes.", "Akhil: and set an alarm for 6am tomorrow",
      "Shelby: Alarm set for 6:00 AM."],
     lambda p: not adds(p)),
    ("group agrees on a time", "(none)",
     ["Akhil: let's circle back on the launch copy at 6pm today", "Sol: works for me"],
     lambda p: at(p, 28, 18, 18) and len(adds(p)) == 1),
    ("condition on a teammate's task", "(none)",
     ["Akhil: we'll deploy once Sol finishes the design tweak", "Dev: got it, I'll deploy right after"],
     lambda p: cond(p, "design") and any(a.get("owner", "").lstrip("@") == "dev" for a in adds(p))),
    ("teammate promise with a time", "(none)",
     ["Akhil: can you get me the benchmark numbers?", "Dev: I'll send them tomorrow morning"],
     lambda p: at(p, 29, 7, 11)),
    ("condition met from another chat", DEPLOY,
     ["Sol: the design tweak is done, files are up in Figma"],
     lambda p: met(p) == ["A"] and not adds(p)),
    ("condition not met yet", DEPLOY,
     ["Sol: still on the design tweak, need a couple more hours"],
     lambda p: not met(p) and not adds(p)),
    ("dropped follow-up", COPY,
     ["Akhil: forget the 6pm copy check, I already approved the copy"],
     lambda p: (p.get("cancel") or []) == ["B"]),
    ("no duplicate of a pending one", COPY,
     ["Akhil: remember we're circling back on the copy at 6"],
     lambda p: not adds(p)),
    ("banter changes nothing", DEPLOY + "\n" + COPY,
     ["Akhil: cats or dogs?", "Dev: cats, obviously", "Sol: dogs, fight me"],
     quiet),
    ("vague maybe is not a follow-up", "(none)",
     ["Akhil: maybe we should revisit pricing someday", "Ivy: could be worth it"],
     lambda p: not adds(p)),
    ("app-checkable condition polls", "(none)",
     ["Dev: I'll deploy as soon as PR #42 is merged"],
     lambda p: cond(p, "42") and any(a.get("poll_hours") for a in adds(p))),
    ("condition with a deadline", "(none)",
     ["Akhil: once the design is done, ship it. If it isn't done by Wednesday, ping me"],
     lambda p: cond(p, "design") and any(str(a.get("check_by") or "").startswith("2026-09-30") and "ship" in a["what"].lower()
                                         for a in adds(p))),
]


async def run(model: str) -> int:
    config.KEEPER_MODEL = model
    passed = 0
    for name, pending, lines, check in CASES:
        t = time.monotonic()
        stamped = [f"[Mon Sep 28, 01:5{i} PM] {line}" for i, line in enumerate(lines)]
        p = await brief.decide("Akhil", ROSTER, NOW, "", pending, stamped)
        ok = check(p)
        passed += ok
        await asyncio.sleep(PACE)
        print(f"{'PASS' if ok else 'FAIL'} {time.monotonic() - t:4.1f}s  {name}: add={adds(p)} met={p.get('met')} cancel={p.get('cancel')}")
    print(f"== {model}: {passed}/{len(CASES)}\n")
    return passed


async def main():
    for model in sys.argv[1:] or [config.KEEPER_MODEL]:
        await run(model)

asyncio.run(main())
