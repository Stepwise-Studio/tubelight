"""Floor-plan evals: realistic group-chat moments against the real director model (app/floor.py).

    .venv/bin/python -m evals.floor [model ...]     e.g. groq:openai/gpt-oss-120b gemini:gemini-3.5-flash-lite

When routing goes wrong in the app, add the moment here first, then improve the prompt until everything passes.
Not part of pytest: it calls real, rate-limited models.
"""
import asyncio
import sys
import time

from langchain_core.messages import AIMessage, HumanMessage

from app import config, floor

MEMBERS = [
    {"id": "dev", "handle": "dev", "name": "Dev", "role": "Developer", "bio": "Senior engineer. Reviews code, fixes bugs."},
    {"id": "ivy", "handle": "ivy", "name": "Ivy", "role": "Inbox chief of staff", "bio": "Triages email and drafts replies."},
    {"id": "sol", "handle": "sol", "name": "Sol", "role": "Social media lead", "bio": "Drafts posts and launch threads."},
    {"id": "tess", "handle": "tess", "name": "Tess", "role": "QA engineer", "bio": "Tests things and files bugs."},
]
ROAST = [("dev", "Cats are tiny landlords who judge your code."),
         ("ivy", "Cats respect boundaries, unlike @dev's entire personality."),
         ("sol", "Dogs are needy PR flacks for your anxiety.")]


def only(*ids):
    return lambda got: got == list(ids)


def first(i):
    return lambda got: bool(got) and got[0] == i


def everyone_then(last):
    return lambda got: set(got) == {m["id"] for m in MEMBERS} and got[-1] == last


def nobody_or_one(got):
    return len(got) <= 1


def several(got):
    return len(got) >= 3


# (name, history as [(speaker id or "user", text)], latest message, check)
CASES = [
    ("group roast of a tagged target", [], "I want everyone to roast @dev", everyone_then("dev")),
    ("tag addressee, other tag referent", [], "@dev can you check what @tess wrote above?", only("dev")),
    ("skill fit, no tags", [], "can someone draft a launch tweet for tomorrow?", only("sol")),
    ("inbox by role", [], "anything urgent in my inbox?", only("ivy")),
    ("two addressees", [], "@sol and @tess, what do you think of the new onboarding?", lambda g: set(g) == {"sol", "tess"}),
    ("name without @", [], "Tess, can you retest the login flow?", only("tess")),
    ("pronoun: apologise to him", ROAST, "this is too much dude, apologise to him", first("ivy")),
    ("continuing a 1:1 exchange", [("user", "@dev why is the build red?"), ("dev", "A flaky test in auth. Want me to skip it?")],
     "yes do that", only("dev")),
    ("acknowledgement", [("user", "@sol draft the post"), ("sol", "Here's the draft: ...")], "thanks!", nobody_or_one),
    ("open question to the group", [], "what should we name the new feature? everyone pitch one", several),
    ("delegate across roles", [], "ask @tess to test it and @dev to fix what she finds", lambda g: set(g) >= {"tess", "dev"}),
    ("@all", [], "@all quick standup: what are you on today?", lambda g: len(g) == 4),
    ("group task later, at a time", [], "hey everyone, let's roast Sol again at 6 pm", lambda g: len(g) == 1),
    ("task once something happens", [], "@dev deploy the landing page once Sol finishes the design tweak", only("dev")),
]


def history(lines):
    return [HumanMessage(t) if who == "user" else AIMessage(t, name=who) for who, t in lines]


async def run(model: str) -> int:
    config.ROUTER_MODEL = model
    passed = 0
    for name, lines, latest, check in CASES:
        t = time.monotonic()
        p = await floor.plan([*history(lines), HumanMessage(latest)], MEMBERS, "Akhil", latest)
        ok = check(p.speakers)
        passed += ok
        print(f"{'PASS' if ok else 'FAIL'} {time.monotonic() - t:4.1f}s  {name}: {p.speakers}  | {p.read[:110]}")
    print(f"== {model}: {passed}/{len(CASES)}\n")
    return passed


async def main():
    for model in sys.argv[1:] or [config.ROUTER_MODEL]:
        await run(model)

asyncio.run(main())
