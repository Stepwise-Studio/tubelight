"""Hiring-inbox eval: can an automation run do what the user saw Meta AI do? HR mails a batch of applications with
resumes attached; the run must open the attachments (read_attachments, in one call), rank the candidates on what the
resumes say (not the email subjects) and lead with a headline.

    .venv/bin/python -m evals.hiring [model ...]     e.g. gemini:gemini-3.5-flash-lite groq:openai/gpt-oss-120b

Gmail is faked (no account is touched); the model is real. Three resumes are clearly strong, the rest are not, and the
subjects are all alike, so only reading the resumes gives the right top three.
"""
import asyncio
import sys
import time

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool

from app import events, llm

PEOPLE = [  # (name, resume) the strong ones: Asha, Ravi, Meera
    ("Karan Shah", "B.Com 2024. Interested in AI. Skills: MS Excel, PowerPoint, social media. No programming projects."),
    ("Asha Menon", "B.Tech CSE 2023. ML engineer at Finlytics (2 yrs): built and shipped a RAG search used by 2,000 "
                   "analysts (PyTorch, FAISS, FastAPI). Kaggle Expert. Open-source evals for LLM summarisation."),
    ("Nikhil Rao", "BBA 2025. Completed a 4-week online 'AI for everyone' course. Wants to learn Python."),
    ("Ravi Kumar", "M.Tech AI, IIT Hyderabad 2024. Fine-tuned Llama 3 8B for Hindi support tickets (LoRA), cut "
                   "first-response time 40%. Published at an ACL workshop. Python, PyTorch, vLLM."),
    ("Divya Pillai", "Diploma in graphic design. Uses Midjourney and Canva for client work."),
    ("Meera Iyer", "B.Sc Maths + Data Science 2024. Intern at Sarvam AI: built an eval harness for speech models, "
                   "wrote the metrics pipeline (Python, NumPy, W&B). Strong linear algebra and probability."),
    ("Rahul Verma", "B.Tech Mechanical 2022. Sales executive for 2 years. Did a weekend ChatGPT prompting workshop."),
    ("Sneha Joshi", "BA English 2023. Content writer; edits AI-generated blog posts."),
]
STRONG = {"Asha", "Ravi", "Meera"}

# Spelled out, and plain (what the user actually told Meta AI: no word about resumes or ranking). The plain one is
# the real bar: a good assistant opens the resumes and ranks on its own.
SPELLED = ("Check my inbox. Tell me only what needs my attention. When people send job applications, read the "
           "resumes, score each candidate for our Junior AI Engineer role and rank them.")
PLAIN = "Check my emails, summarise them and tell me if anything needs my attention."


def mails():
    return {"messages": [{
        "messageId": f"m{i}", "threadId": f"t{i}", "sender": "hr@mxcignite.example",
        "subject": f"Application: Junior AI Engineer – {n}", "messageTimestamp": "2026-10-24T09:0{i}:00Z",
        "messageText": f"Hi, forwarding {n}'s application for the Junior AI role. Resume attached. – HR",
        "attachmentList": [{"attachmentId": f"a{i}", "filename": f"{n.split()[0]}_resume.pdf", "mimeType": "application/pdf"}],
    } for i, (n, _) in enumerate(PEOPLE)] + [{
        "messageId": "m99", "threadId": "t99", "sender": "newsletter@aiweekly.example", "subject": "AI Weekly #212",
        "messageText": "This week in AI…", "attachmentList": [],
    }]}


async def run(model: str, instructions: str):
    calls: list[tuple[str, dict]] = []

    async def fetch(query: str = "", max_results: int = 20) -> str:
        """Fetch emails from Gmail matching a search query."""
        return str(mails())

    async def read_attachments(files: list[dict[str, str]]) -> str:
        """Read Gmail attachments as text. files: [{message_id, attachment_id, file_name}]."""
        by = {f"a{i}": (n, r) for i, (n, r) in enumerate(PEOPLE)}
        return "\n\n".join(f"### {f.get('file_name')}\n{by[f['attachment_id']][0]}\n{by[f['attachment_id']][1]}"
                           for f in files if f.get("attachment_id") in by)

    tools = [StructuredTool.from_function(coroutine=fetch, name="GMAIL_FETCH_EMAILS"),
             StructuredTool.from_function(coroutine=read_attachments, name="read_attachments",
                                          description="Read Gmail attachments (PDF, Word, …) as text, up to 40 in one call. "
                                                      "files: [{message_id, attachment_id, file_name}] from each email's attachmentList.")]
    by = {t.name: t for t in tools}
    text = (f"[Automation: Inbox check, every 2 hours]\nYour standing instructions: {instructions}\n" + events.CRAFT + events.QUIET)
    msgs = [SystemMessage("You are Ivy, the user's inbox chief of staff. You use tools to do the work, then reply."), HumanMessage(text)]
    m = llm.chat_model(model, tools=tools)
    for _ in range(6):
        out = await m.ainvoke(msgs)
        msgs.append(out)
        if not out.tool_calls:
            break
        for tc in out.tool_calls:
            calls.append((tc["name"], tc["args"]))
            msgs.append(ToolMessage(await by[tc["name"]].coroutine(**tc["args"]), tool_call_id=tc["id"]))
    reply = msgs[-1].text if hasattr(msgs[-1], "text") else str(msgs[-1].content)
    reads = [a for n, a in calls if n == "read_attachments"]
    files = sum(len(a.get("files", [])) for a in reads)
    lines = [l for l in reply.splitlines() if l.strip()]
    head = lines[0] if lines else ""
    # Top three: the first three strong/weak names in the order the reply lists them.
    order = sorted(((reply.find(n.split()[0]), n.split()[0]) for n, _ in PEOPLE if reply.find(n.split()[0]) >= 0))
    top = {n for _, n in order[:3]}
    checks = {
        "read all resumes": files >= len(PEOPLE),
        "in one call": len(reads) == 1,
        "right top three": top == STRONG,
        "headline with a number": any(ch.isdigit() for ch in head) and len(head) < 160,
    }
    return checks, head, reply


async def main(models):
    for model in models:
        for kind, instructions in (("plain", PLAIN), ("spelled out", SPELLED)):
            t = time.time()
            try:
                checks, head, reply = await run(model, instructions)
            except Exception as e:
                print(f"{model} ({kind}): ERROR {str(e)[:200]}")
                continue
            ok = sum(checks.values())
            print(f"\n{model} ({kind}): {ok}/{len(checks)} in {time.time() - t:.0f}s")
            for k, v in checks.items():
                print(f"  {'✓' if v else '✗'} {k}")
            print(f"  headline: {head[:150]}")
            if "-v" in sys.argv:
                print(reply)


if __name__ == "__main__":
    asyncio.run(main([a for a in sys.argv[1:] if not a.startswith("-")] or [llm.config.DEFAULT_MODEL]))
