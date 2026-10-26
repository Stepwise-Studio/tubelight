"""Look-first judge eval (ground.py): does it send teammates to their tools whenever a true answer needs fresh data,
and leave small talk alone? A missed LOOK is the costly error (a confident made-up answer); a needless LOOK costs one
tool call. Cases come from real use; add a case for every miss seen in a chat, then fix the prompt, never the code.
    .venv/bin/python -m evals.grounding [model ...]     default: ROUTER_MODEL
"""
import asyncio
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
    asyncio.run(main(sys.argv[1:] or [config.ROUTER_MODEL]))
