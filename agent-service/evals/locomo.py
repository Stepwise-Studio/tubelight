"""LoCoMo (Maharana et al., ACL 2024) run the way Mem0's paper ran it (arXiv:2504.19413), so the numbers sit beside theirs.

    .venv/bin/python -m evals.locomo ingest [conv,...]     # build each speaker's memory (real model calls, resumable)
    .venv/bin/python -m evals.locomo answer [conv,...]     # answer + judge every question from memory (resumable)
    .venv/bin/python -m evals.locomo full [conv,...]       # the same questions with the whole conversation in context
    .venv/bin/python -m evals.locomo report                # J per category, with 95% intervals

Protocol, as in Mem0's published evaluation code (mem0ai/mem0 @ aae5989e78, evaluation/; Apache-2.0):
- One memory per speaker: in speaker X's memory X is the user and the other speaker is another person. Here that's
  Tubelight's own model of it: X's words are the user's (trust 2), the other's are outside words (trust 0).
- A question is answered from both speakers' memories, with Mem0's ANSWER_PROMPT, temperature 0.
- An LLM judge labels each answer CORRECT/WRONG with Mem0's ACCURACY_PROMPT (J). Category 5 (adversarial) is left out,
  as Mem0 did: 1540 questions. Categories: 1 multi-hop, 2 temporal, 3 open-domain, 4 single-hop.
Differences, stated with every result:
- Answer and judge model: gpt-4.1-mini (Azure). Mem0 used gpt-4o-mini, which is deprecated; a stronger answer model
  lifts every system, so the `full` baseline (whole conversation in context, same model) is run to show by how much.
- Memory is read the way a Tubelight teammate gets it before replying: mem.recall(question, brief=True), whole lines up
  to its budget, instead of Mem0's top-30 memory list.
- Text turns only, as Mem0's adder did (images' captions are left out).
Memory is built by app/mem.py exactly as on the server (extraction by MEM_MODEL, the gate, linking, profiles), in a
scratch Postgres (TL_TEST_PG). Extraction uses GEMINI_BENCH_API_KEY, a separate free quota, so the live app keeps its own.
Results: evals/data/bench/results/ (gitignored; the dataset is fetched from snap-research/locomo).
"""
import asyncio
import json
import math
import os
import re
import sys
import time
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

from dotenv import dotenv_values

_env = dotenv_values(Path(__file__).resolve().parent.parent / ".env")
if _env.get("GEMINI_BENCH_API_KEY"):  # before app.config reads it
    os.environ["GEMINI_API_KEY"] = _env["GEMINI_BENCH_API_KEY"]

from langchain_core.messages import HumanMessage, SystemMessage  # noqa: E402

from app import llm, mem  # noqa: E402

BENCH = Path(__file__).resolve().parent / "data" / "bench"
OUT = BENCH / "results"
MODEL = os.environ.get("BENCH_MODEL", "azure:gpt-4.1-mini")
CATS = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop"}
NS = uuid.UUID("6f1d2c1e-5b1a-4c8e-9a51-1b0c0c0ffee0")

# Mem0's ANSWER_PROMPT (evaluation/prompts.py), verbatim; filled the way their search.py fills it.
ANSWER_PROMPT = """
    You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.

    # CONTEXT:
    You have access to memories from two speakers in a conversation. These memories contain
    timestamped information that may be relevant to answering the question.

    # INSTRUCTIONS:
    1. Carefully analyze all provided memories from both speakers
    2. Pay special attention to the timestamps to determine the answer
    3. If the question asks about a specific event or fact, look for direct evidence in the memories
    4. If the memories contain contradictory information, prioritize the most recent memory
    5. If there is a question about time references (like "last year", "two months ago", etc.),
       calculate the actual date based on the memory timestamp. For example, if a memory from
       4 May 2022 mentions "went to India last year," then the trip occurred in 2021.
    6. Always convert relative time references to specific dates, months, or years. For example,
       convert "last year" to "2022" or "two months ago" to "March 2023" based on the memory
       timestamp. Ignore the reference while answering the question.
    7. Focus only on the content of the memories from both speakers. Do not confuse character
       names mentioned in memories with the actual users who created those memories.
    8. The answer should be less than 5-6 words.

    # APPROACH (Think step by step):
    1. First, examine all memories that contain information related to the question
    2. Examine the timestamps and content of these memories carefully
    3. Look for explicit mentions of dates, times, locations, or events that answer the question
    4. If the answer requires calculation (e.g., converting relative time references), show your work
    5. Formulate a precise, concise answer based solely on the evidence in the memories
    6. Double-check that your answer directly addresses the question asked
    7. Ensure your final answer is specific and avoids vague time references

    Memories for user {speaker_1_user_id}:

    {speaker_1_memories}

    Memories for user {speaker_2_user_id}:

    {speaker_2_memories}

    Question: {question}

    Answer:
    """

# Mem0's ACCURACY_PROMPT (evaluation/metrics/llm_judge.py), verbatim.
ACCURACY_PROMPT = """
Your task is to label an answer to a question as ’CORRECT’ or ’WRONG’. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a ’gold’ (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: {question}
Gold answer: {gold_answer}
Generated answer: {generated_answer}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label".
"""


def data() -> list[dict]:
    return json.loads((BENCH / "locomo10.json").read_text())


def sessions(conv: dict) -> list[tuple[datetime, list[dict]]]:
    """(when, turns) for every session, in order. Dates look like '1:56 pm on 8 May, 2023'."""
    out = []
    for k in sorted((k for k in conv if re.fullmatch(r"session_\d+", k)), key=lambda k: int(k.split("_")[1])):
        when = datetime.strptime(conv[f"{k}_date_time"], "%I:%M %p on %d %B, %Y").replace(tzinfo=UTC)
        out.append((when, conv[k]))
    return out


def owner(sample: str, speaker: str) -> str:
    return str(uuid.uuid5(NS, f"locomo|{sample}|{speaker}"))


async def _db() -> None:
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    pool = AsyncConnectionPool(os.environ["TL_TEST_PG"], open=False, kwargs={"autocommit": True, "row_factory": dict_row})
    await pool.open()
    await mem.setup(pool)

    async def no_teammates(_owner: str) -> list[str]:  # LoCoMo has two people and no AI teammates
        return []
    mem._roster = no_teammates


def pick(only: str) -> list[dict]:
    want = {int(x) for x in only.split(",") if x.strip()} if only else None
    return [x for i, x in enumerate(data()) if want is None or i in want]


async def ingest(only: str = "") -> None:
    await _db()
    for x in pick(only):
        conv = x["conversation"]
        for me in (conv["speaker_a"], conv["speaker_b"]):
            o = owner(x["sample_id"], me)
            if (await mem._q("select count(*) as n from mem_episodes where owner = %s", o))[0]["n"] == 0:
                await mem.user_entity(o, me)
                for s, (when, turns) in enumerate(sessions(conv)):
                    for i, t in enumerate(turns):
                        await mem.log_episode(o, "chat", t["text"], trust=2 if t["speaker"] == me else 0, ref=f"s{s + 1}",
                                              speaker=t["speaker"], at=when + timedelta(seconds=30 * i))
            t0, batches, waits = time.monotonic(), 0, 0
            while (await mem._q("select count(*) as n from mem_episodes where owner = %s and extracted = 0", o))[0]["n"]:
                n = await mem.tick(o, force=True, max_batches=1, names={o: me})
                batches += n
                if not n:  # rate limited (tick keeps the batch for the next try): wait it out
                    waits += 1
                    await asyncio.sleep(min(60 * waits, 600))
                else:
                    waits = 0
                    await asyncio.sleep(4)
            await mem.tick(o, force=True, max_batches=1, names={o: me})  # profiles and links once the backlog is through
            facts = (await mem._q("select count(*) filter (where status = 'current') as cur, count(*) filter "
                                  "(where status = 'tentative') as ten from mem_facts where owner = %s", o))[0]
            lost = (await mem._q("select count(*) as n from mem_episodes where owner = %s and extracted < 0", o))[0]["n"]
            print(f"{x['sample_id']} {me}: {batches} batches in {time.monotonic() - t0:.0f}s, {facts['cur']} facts "
                  f"+ {facts['ten']} tentative, {lost} episodes given up", flush=True)


def _results(kind: str) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    return OUT / f"locomo_{kind}.jsonl"


def _done(path: Path) -> set[tuple[str, int]]:
    return {(r["sample"], r["i"]) for r in map(json.loads, path.read_text().splitlines())} if path.exists() else set()


async def _ask(model, prompt: str) -> str:
    for attempt in range(6):
        try:
            return (await model.ainvoke([SystemMessage(prompt)])).text
        except Exception as e:  # rate limits and timeouts: wait them out
            print("  retry:", str(e)[:120], flush=True)
            await asyncio.sleep(10 * (attempt + 1))
    raise SystemExit("the answer model kept failing")


async def _judge(model, q: str, gold: str, answer: str) -> int:
    raw = await _ask(model, ACCURACY_PROMPT.format(question=q, gold_answer=gold, generated_answer=answer))
    m = re.search(r'"label"\s*:\s*"(CORRECT|WRONG)"', raw) or re.search(r"\b(CORRECT|WRONG)\b", raw)
    return int(bool(m) and m.group(1) == "CORRECT")


def transcript(conv: dict) -> str:
    return "\n\n".join(f"[{when:%-d %B %Y, %H:%M}]\n" + "\n".join(f"{t['speaker']}: {t['text']}" for t in turns)
                       for when, turns in sessions(conv))


async def answer(only: str = "", full: bool = False) -> None:
    """Every non-adversarial question: context (both speakers' recall, or the whole conversation), answer, judge."""
    if not full:
        await _db()
    path = _results("full" if full else "memory")
    done = _done(path)
    model = llm._one(MODEL, retries=2).bind(temperature=0)
    judge = llm._one(MODEL, retries=2).bind(temperature=0, response_format={"type": "json_object"})
    for x in pick(only):
        conv, sample = x["conversation"], x["sample_id"]
        a, b = conv["speaker_a"], conv["speaker_b"]
        whole = transcript(conv) if full else ""
        for i, qa in enumerate(x["qa"]):
            if qa["category"] == 5 or (sample, i) in done:
                continue
            q, gold = qa["question"], str(qa["answer"])
            if full:  # one transcript holds both speakers' words: shown once, under the first speaker
                ma, mb = whole, "(the conversation above holds both speakers' words)"
            else:
                ma = await mem.recall(owner(sample, a), q, brief=True)
                mb = await mem.recall(owner(sample, b), q, brief=True)
            got = (await _ask(model, ANSWER_PROMPT.format(speaker_1_user_id=a, speaker_1_memories=ma or "(nothing)",
                                                          speaker_2_user_id=b, speaker_2_memories=mb or "(nothing)",
                                                          question=q))).strip()
            label = await _judge(judge, q, gold, got)
            row = {"sample": sample, "i": i, "category": qa["category"], "question": q, "gold": gold, "answer": got,
                   "label": label, "context_chars": len(ma) + len(mb)}
            with path.open("a") as f:
                f.write(json.dumps(row) + "\n")
            print(f"{'OK ' if label else 'NO '} c{qa['category']} {sample}#{i}: {q[:70]} -> {got[:60]!r} (gold {gold[:40]!r})",
                  flush=True)


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if not n:
        return 0.0, 0.0
    p, d = k / n, 1 + z * z / n
    c, h = (p + z * z / (2 * n)) / d, z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def report() -> None:
    for kind in ("memory", "full"):
        path = _results(kind)
        if not path.exists():
            continue
        rows = [json.loads(r) for r in path.read_text().splitlines()]
        by = defaultdict(list)
        for r in rows:
            by[r["category"]].append(r["label"])
        print(f"\nLoCoMo, {kind} ({MODEL} answers and judges; {len({r['sample'] for r in rows})} conversations, "
              f"{len(rows)} questions)")
        for c in sorted(by):
            k, n = sum(by[c]), len(by[c])
            lo, hi = wilson(k, n)
            print(f"  {CATS[c]:12s} J {k / n:6.1%}  ({k}/{n}, 95% CI {lo:.1%}–{hi:.1%})")
        k, n = sum(r["label"] for r in rows), len(rows)
        lo, hi = wilson(k, n)
        print(f"  {'overall':12s} J {k / n:6.1%}  ({k}/{n}, 95% CI {lo:.1%}–{hi:.1%}); "
              f"mean context {sum(r['context_chars'] for r in rows) / n:,.0f} chars")


if __name__ == "__main__":
    cmd, only = (sys.argv[1:] + ["", ""])[:2]
    if cmd == "report":
        report()
    elif cmd in ("ingest", "answer", "full"):
        asyncio.run(ingest(only) if cmd == "ingest" else answer(only, full=cmd == "full"))
    else:
        raise SystemExit(__doc__)
