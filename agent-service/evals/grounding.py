"""Grounding evals (ground.py). Part 1, the look-first judge: does it send teammates to their tools whenever a true answer needs fresh data,
and leave small talk alone? A missed LOOK is the costly error (a confident made-up answer); a needless LOOK costs one
tool call. Cases come from real use; add a case for every miss seen in a chat, then fix the prompt, never the code.
Part 2, the reply check: labelled replies against small fixed data. It must flag a reply that loses the user
something (missed applications, a missed deadline, a made-up meeting, "that's all" over cut data) and pass a reply
that leaves out routine things (codes they asked for, $0 invoices, holidays). A fussy check is as bad as a blind one:
it makes teammates list everything.
    .venv/bin/python -m evals.grounding [model ...]     default: ROUTER_MODEL
"""
import asyncio
import os
import sys
import time

from app import config, ground

ROLES = {
    "ivy": ("Ivy", "Inbox manager", ["inbox", "read_attachments", "save_attachments", "COMPOSIO_MULTI_EXECUTE_TOOL", "search_chat", "recall"]),
    "tempo": ("Tempo", "Calendar manager", ["COMPOSIO_MULTI_EXECUTE_TOOL", "search_chat", "recall", "reminders"]),
    "rex": ("Rex", "Senior software engineer", ["open_repo", "run_shell", "COMPOSIO_MULTI_EXECUTE_TOOL", "web_search", "read_page"]),
    "quill": ("Quill", "IITM study partner", ["knowledge", "vault", "web_search", "read_page", "new_chat"]),
    "nova": ("Nova", "Social media manager", ["browser_use", "browser_look", "schedule_post", "COMPOSIO_MULTI_EXECUTE_TOOL"]),
    "iris": ("Iris", "Chief of staff", ["ask_teammate", "inbox", "COMPOSIO_MULTI_EXECUTE_TOOL", "recall", "web_search", "todos"]),
}
STALE = "user: summarise my week of mail\nivy: Quiet week, nothing needs you: 8 newsletters."

CASES = [  # (teammate, recent chat, request, must look?)
    ("ivy", "", "Hello ivy", False),
    ("ivy", "", "Could you look at my inbox of the last week and summarise it and let me know if anything needs my attention", True),
    ("ivy", STALE, "Could you look at my inbox of the last week and summarise it", True),
    ("ivy", STALE, "are you sure? that seems low", True),
    ("ivy", "", "did Priya reply to me?", True),
    ("ivy", "", "anything new?", True),
    ("ivy", "", "thanks!", False),
    ("ivy", "ivy: Want me to draft a reply to Priya?", "yes please", True),
    ("ivy", "", "save the resumes from today's applications into a Hiring folder", True),
    ("ivy", "", "how do you decide what's important?", False),
    ("tempo", "", "what's on my calendar tomorrow", True),
    ("tempo", "", "move my 4pm to 6", True),
    ("tempo", "", "am I free on friday evening?", True),
    ("tempo", "", "what's a good way to plan deep work blocks?", False),
    ("rex", "", "what changed in tubelight this week?", True),
    ("rex", "", "explain how a CDN works", False),
    ("rex", "", "fix the failing test in my stepwise-ui repo", True),
    ("rex", "", "what's the latest version of Expo?", True),
    ("rex", "", "rust or go for a CLI tool?", False),
    ("quill", "", "when is my next quiz?", True),
    ("quill", "", "explain eigenvalues simply", False),
    ("quill", "", "what does the handbook say about the eligibility for end term?", True),
    ("quill", "", "I'm feeling stressed about exams", False),
    ("nova", "", "any new DMs on X?", True),
    ("nova", "", "write me a tweet about shipping the inbox fix", False),
    ("nova", "", "how did my last LinkedIn post do?", True),
    ("iris", "", "my day was rough honestly", False),
    ("iris", "", "lol I just saw a dog wearing sunglasses on a scooter", False),
    ("iris", "", "what's going on across everything today?", True),
    ("iris", "", "do I have anything urgent pending?", True),
    ("iris", "", "remind me what we decided about the GitHub token?", True),
    ("iris", "", "what do you think I should focus on this week, given my deadlines?", True),
]


MAIL = """151 emails in the last 7 days (127 unread).
People and services, not promotions/social/updates (8), newest first; judge each:
- BATCH: 31 emails from "hr@acme.com", Fri Oct 23 – Fri Oct 23, 31 with attachments: Fw: Application – Junior AI Engineer (Rashmi); Fw: Application – Junior AI Engineer (Mahesh); +29 more
- Sun Oct 25 10:13 PM · Microsoft account team · Your single-use code — Hi, we received your request for a single-use code [unread]
- Mon Oct 26 07:42 PM · Cloudflare · Your invoice is available — Invoice IN-857: $0.00 due October 26 [unread, important]
- Fri Oct 23 10:26 PM · Act Fibernet · Update on your service — You may face interruption on 24/10 02:00-05:00
Promotions (36): Pinterest ×7; Rapido ×5
Updates (71): GitHub ×20 (Run failed: TDS checks); Railway ×2 (Changelog)"""
CAL = """[{"summary": "Maharishi Valmiki Jayanti", "start": "2026-10-26", "allDay": true},
{"summary": "CT Instructor Session", "start": "2026-10-26T18:00"}, {"summary": "TDS Project 1 Submission", "start": "2026-10-27"},
{"summary": "Python TA Session", "start": "2026-10-27T18:00"}]"""
CUT = MAIL + "\n[RESULT COMPACTED: NOT SHOWN: 60 items of the list at messages. Don't present this as complete.]"
CHECKS = [  # (request, data, reply, should it pass?)
    ("summarise my week of mail", MAIL, "Quiet week: newsletters, promos and a $0 Cloudflare invoice. Nothing needs you.", False),
    ("summarise my week of mail", MAIL, "31 job applications came in from HR on Friday, all with resumes: want them ranked? The rest is routine: a sign-in code you asked for, a $0 invoice, promos.", True),
    ("summarise my week of mail", MAIL, "31 applications from HR need you (Friday, resumes attached). Plus 36 promos and 71 updates.", True),
    ("anything urgent in my mail?", MAIL, "The 31 HR applications are the only real thing; everything else is routine.", True),
    ("what's on my calendar this week?", CAL, "Just tonight's CT Instructor Session at 6 PM.", False),
    ("what's on my calendar this week?", CAL, "Tonight: CT Instructor Session at 6. Tomorrow: TDS Project 1 is due, and a Python TA Session at 6.", True),
    ("what's on my calendar this week?", CAL, "CT session tonight, TDS Project 1 due tomorrow, and your 1:1 with Priya on Wednesday.", False),
    ("summarise my week of mail", CUT, "That's everything from the week: 31 applications from HR and routine mail.", False),
]


async def checks(models: list[str]) -> None:
    for model in models:
        config.CHECK_MODEL = model
        t, bad = time.time(), []
        gate = asyncio.Semaphore(2)

        async def one(req: str, data: str, reply: str) -> dict:
            async with gate:
                return await ground.check(req, data, reply)
        verdicts = await asyncio.gather(*(one(r, d, a) for r, d, a, _ in CHECKS))
        for (req, _, reply, want), v in zip(CHECKS, verdicts):
            if v["ok"] != want:
                bad.append(f"{'should pass' if want else 'should flag'}: {reply[:90]} → {v['problems'] or v.get('minor')}")
        print(f"\nreply check · {model}: {len(CHECKS) - len(bad)}/{len(CHECKS)} in {time.time() - t:.0f}s")
        for b in bad:
            print(f"  ✗ {b}")


async def main(models: list[str]) -> None:
    for model in models:
        config.ROUTER_MODEL = model
        t, misses, needless = time.time(), [], []
        gate = asyncio.Semaphore(3)  # free tiers: a burst of 32 calls trips the per-minute limits

        async def one(h: str, recent: str, req: str) -> dict:
            async with gate:
                return await ground.judge({"name": ROLES[h][0], "role": ROLES[h][1]}, ROLES[h][2], req, recent)
        verdicts = await asyncio.gather(*(one(h, recent, req) for h, recent, req, _ in CASES))
        for (h, _, req, want), v in zip(CASES, verdicts):
            if want and not v["look"]:
                misses.append(f"{h}: {req}")
            elif v["look"] and not want:
                needless.append(f"{h}: {req}")
        ok = len(CASES) - len(misses) - len(needless)
        print(f"\n{model}: {ok}/{len(CASES)} in {time.time() - t:.0f}s · missed looks {len(misses)} · needless {len(needless)}")
        for m in misses:
            print(f"  ✗ should look: {m}")
        for m in needless:
            print(f"  · needless look: {m}")


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv(".env")
    models = sys.argv[1:] or [config.ROUTER_MODEL]
    which = os.environ.get("ONLY", "")

    async def both() -> None:
        if which != "check":
            await main(models)
        if which != "judge":
            await checks(models)
    asyncio.run(both())
