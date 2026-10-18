"""The salience gate (app/mem.py GATE) against labelled real history: what memory keeps, holds or skips, vs what it should.

    .venv/bin/python -m evals.gate run    # extract the labelled history in a scratch Postgres (real model, ~30 calls)
    .venv/bin/python -m evals.gate fit    # refit the gate's weights on the last run (no model calls) and report

Labels: evals/data/gate_labels.json (gitignored: it holds the user's own chats), one per episode: keep | maybe | skip.
A run saves every fact the extractor proposed, with the gate's inputs, to evals/data/gate_run.json. Inputs don't
depend on the weights, so `fit` can try weights without calling the model again. (Approximation: novelty was measured
against what the run's own weights had stored.)
Metrics: recall = keep moments with a fact kept or restated; held = also counting tentative; noise = kept facts from
moments labelled skip; maybe = unsure moments that land tentative or kept.
Needs TL_TEST_PG (see tests/test_mem.py).
"""
import asyncio
import json
import math
import os
import sys
from datetime import datetime
from pathlib import Path

from app import mem

DATA = Path(__file__).parent / "data"
FEATURES = ("imp", "dur", "nov", "tr", "ex")


async def run() -> None:
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    labels = json.loads((DATA / "gate_labels.json").read_text())
    owner = labels[0]["owner"]
    pool = AsyncConnectionPool(os.environ["TL_TEST_PG"], open=False, kwargs={"autocommit": True, "row_factory": dict_row})
    await pool.open()
    await mem.setup(pool)
    await mem._q("delete from mem_entities where owner = %s", owner)
    await mem._q("delete from mem_episodes where owner = %s", owner)
    for r in labels:
        await mem.log_episode(owner, r["source"], r["text"], trust=r["trust"], ref=r["ref"], speaker=r["speaker"],
                              at=datetime.fromisoformat(r["at"]))
    await mem._q("update mem_episodes set created_at = occurred_at where owner = %s", owner)  # all quiet: extract now
    ids = {(r["text"], r["occurred_at"]): str(r["id"]) for r in
           await mem._q("select id, text, occurred_at from mem_episodes where owner = %s", owner)}
    label_of = {ids[(r["text"][:4000], datetime.fromisoformat(r["at"]))]: r for r in labels}
    name = await mem._user_name(owner)
    decisions, stage0, calls = [], 0, 0
    while batches := await mem._batches(owner, force=True):
        for batch in batches:
            for attempt in range(4):
                try:
                    res = await mem.extract(owner, name, batch)
                    break
                except Exception as e:  # rate limits: wait them out
                    print("  retry:", str(e)[:120])
                    await asyncio.sleep(30 * (attempt + 1))
            else:
                raise SystemExit("the model kept failing")
            await mem._q("update mem_episodes set extracted = %s where id = any(%s)", mem.VERSION, [e["id"] for e in batch])
            calls += "decisions" in res
            stage0 += res.get("stage0", 0)
            for d in res.get("decisions", []):
                lab = label_of[d["episode"]]
                decisions.append({**d, "label": lab["label"], "i": lab["i"], "want": lab["fact"]})
            print(f"  batch {len(batch):3d} episodes -> {', '.join(f'{k} {v}' for k, v in res.items() if v and k != 'decisions')}")
            await asyncio.sleep(4)
    (DATA / "gate_run.json").write_text(json.dumps({"decisions": decisions, "stage0": stage0, "calls": calls,
                                                    "episodes": len(labels)}, indent=1))
    print(f"{calls} model calls, {stage0} episodes ruled out by stage 0, {len(decisions)} decisions")
    await pool.close()
    report(json.loads((DATA / "gate_run.json").read_text()))


def p_of(w: dict, g: dict, seen: int = 1) -> float:
    z = w["b0"] + sum(w[k] * g.get(k, 0) for k in FEATURES) + w["rep"] * math.log(seen)
    return 1 / (1 + math.exp(-z))


def score(run_: dict, w: dict) -> dict:
    labels = json.loads((DATA / "gate_labels.json").read_text())
    keep = {r["i"] for r in labels if r["label"] == "keep"}
    maybe = {r["i"] for r in labels if r["label"] == "maybe"}
    kept, held, noise, stored, mb = set(), set(), 0, 0, set()
    for d in run_["decisions"]:
        p = 1.0 if d["status"] == "same" else p_of(w, d["gate"])
        if p >= mem.SURE:
            kept.add(d["i"])
            stored += d["status"] != "same"
            noise += d["label"] == "skip" and d["status"] != "same"
        if p >= mem.KEEP:
            held.add(d["i"])
    return {"recall": len(kept & keep) / len(keep), "held": len(held & keep) / len(keep),
            "noise": noise / max(1, stored), "kept facts": stored, "maybe placed": len(held & maybe) / len(maybe),
            "missed": sorted(keep - held), "never proposed": sorted(keep - {d["i"] for d in run_["decisions"]})}


def fit(run_: dict, w0: dict, steps: int = 4000, lr: float = 0.3, l2: float = 0.02) -> dict:
    """Logistic regression, keep = 1 vs skip = 0 (maybe left out), from the starting weights, with a pull back toward
    them (L2) so a few labels can't swing a weight wildly. Recall-weighted: a missed keep costs 3x a kept skip,
    the same 1:3 the thresholds assume."""
    rows = [(d["gate"], 1.0 if d["label"] == "keep" else 0.0) for d in run_["decisions"]
            if d["status"] != "same" and d["label"] != "maybe"]
    w = dict(w0)
    for _ in range(steps):
        grad = dict.fromkeys(w, 0.0)
        for g, y in rows:
            err = (p_of(w, g) - y) * (3.0 if y else 1.0)
            grad["b0"] += err
            for k in FEATURES:
                grad[k] += err * g.get(k, 0)
        for k in grad:
            if k != "rep":  # restatements aren't in these rows: keep the starting weight
                w[k] -= lr * (grad[k] / max(1, len(rows)) + l2 * (w[k] - w0[k]))
    return {k: round(v, 2) for k, v in w.items()}


def report(run_: dict) -> None:
    labels = {r["i"]: r for r in json.loads((DATA / "gate_labels.json").read_text())}
    print(f"\n{run_['episodes']} episodes, stage 0 ruled out {run_['stage0']}, {run_['calls']} model calls")
    fitted = fit(run_, mem.GATE)
    for name, w in (("starting weights", mem.GATE), ("fitted weights", fitted)):
        s = score(run_, w)
        print(f"\n{name}: {w}")
        print(f"  recall {s['recall']:.0%} (held {s['held']:.0%}) · noise {s['noise']:.0%} of {s['kept facts']} kept facts "
              f"· maybe placed {s['maybe placed']:.0%}")
        for i in s["missed"]:
            print(f"  missed #{i}: {labels[i]['fact']}" + (" (never proposed by the extractor)" if i in s["never proposed"] else ""))
    print("\nkept from moments labelled skip (fitted):")
    for d in run_["decisions"]:
        if d["status"] != "same" and d["label"] == "skip" and p_of(fitted, d["gate"]) >= mem.SURE:
            print(f"  #{d['i']} p={p_of(fitted, d['gate']):.2f} {d['text'][:110]}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["run"]:
        asyncio.run(run())  # scratch Postgres only; embeddings as configured (local on the laptop)
    else:
        report(json.loads((DATA / "gate_run.json").read_text()))
