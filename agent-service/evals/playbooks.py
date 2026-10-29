"""Playbook evals on real models: a teammate saves what it's taught word for word, follows the steps of a clear
match in order, and doesn't stretch one playbook over a request it only looks like.

    .venv/bin/python -m evals.playbooks [model ...]     e.g. gemini:gemini-3.5-flash-lite groq:openai/gpt-oss-120b

Not part of pytest: it calls real, rate-limited models.
"""
import asyncio
import sys
from typing import Literal

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import StructuredTool

from app import config, llm, playbooks

O = "eval-playbooks"
STEPS = ("1. Write a draft post in my voice, short\n2. Make an image for it\n"
         "3. Open LinkedIn in the browser and attach the image to a new post\n4. Save it as a draft, never post it")
TEACH = f"From now on whenever I ask you for a LinkedIn post, do it like this:\n{STEPS}\nRemember that."
PACE = 5


def _tools():
    async def playbook(action: Literal["save", "read", "list", "delete"], name: str = "", when: str = "", steps: str = "") -> str:
        """Playbooks: how the user taught you to do something, step by step. save when they teach you (steps in their
        words exactly as given), read one before following it, list, delete."""
        return "ok"

    async def generate_image(prompt: str) -> str:
        """Make an image from a prompt."""
        return "made"

    async def browser_use(site: str, task: str) -> str:
        """Ask to use the browser on a site for a task."""
        return "ok"

    async def web_search(query: str) -> str:
        """Search the web."""
        return "results"
    return [StructuredTool.from_function(coroutine=f, name=f.__name__, description=f.__doc__)
            for f in (playbook, generate_image, browser_use, web_search)]


async def turn(model: str, system: str, user: str):
    m = llm.chat_model(model, _tools())
    return await m.ainvoke([SystemMessage(system), HumanMessage(user)])


def calls(r) -> list[tuple[str, dict]]:
    return [(c["name"], c["args"]) for c in (r.tool_calls or [])]


async def main(models: list[str]) -> None:
    base = "You are Nova, the user's marketing teammate in Tubelight. Use tools when they help; reply briefly."
    await playbooks.save(O, "LinkedIn post", "when they ask for a LinkedIn post", STEPS, "Nova")
    await playbooks.save(O, "Weekly invoices", "when they ask to send the week's invoices", "1. Find them in Gmail", "Ivy")
    playbooks.SHOWN, shown = -1.0, await playbooks.for_request(O, "linkedin post")  # a clear match
    playbooks.SHOWN, listed = 2.0, await playbooks.for_request(O, "x")  # only the list
    for model in models:
        ok = 0
        r = calls(await turn(model, base, TEACH))
        save = next((a for n, a in r if n == "playbook" and a.get("action") == "save"), None)
        good = bool(save) and all(s.split(". ", 1)[1] in save.get("steps", "") for s in STEPS.split("\n"))
        print(f"  teach   {'ok' if good else 'MISS'}  {r}")
        ok += good
        await asyncio.sleep(PACE)
        r = await turn(model, f"{base}\n\n{shown}", "make a linkedin post about our new memory feature")
        first = calls(r)[:1]
        # step 1 is writing: text (or a draft) first, never straight to the browser or a post
        good = not first or first[0][0] in ("generate_image", "playbook")
        good = good and "post it" not in (r.content if isinstance(r.content, str) else "").lower()
        print(f"  follow  {'ok' if good else 'MISS'}  {calls(r)} {str(r.content)[:160]!r}")
        ok += good
        await asyncio.sleep(PACE)
        r = await turn(model, f"{base}\n\n{listed}", "post on X that we shipped memory today")
        stretched = any(n == "generate_image" or (n == "playbook" and "linkedin" in str(a).lower()
                                                  and a.get("action") != "list") for n, a in calls(r))
        print(f"  other   {'ok' if not stretched else 'MISS'}  {calls(r)} {str(r.content)[:120]!r}")
        ok += not stretched
        print(f"{model}: {ok}/3")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:] or [config.DEFAULT_MODEL]))
