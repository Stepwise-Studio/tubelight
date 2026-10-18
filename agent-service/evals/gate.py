"""The salience gate (app/mem.py GATE): what memory keeps, holds or skips, against what it should.

    .venv/bin/python -m evals.gate run train|test|real   # extract one set in a scratch Postgres (real model calls)
    .venv/bin/python -m evals.gate fit                   # fit weights on train, report train, test and real (no calls)

Sets:
- train: evals/gate_train.json, synthetic, labelled line by line. The weights are fitted on this only.
- test: evals/gate_test.json, synthetic, a different user; never fitted on. The honest number.
- real: evals/data/gate_labels.json (gitignored: the user's own chats). Mostly app tests, so it's a check that tests
  and chatter stay out, not training data.
A run saves every fact the extractor proposed, with the gate's inputs, to evals/data/gate_run_<set>.json. Inputs don't
depend on the weights, so `fit` can try weights without calling the model. (Approximation: novelty was measured
against what the run's own weights had stored.)
Metrics: recall = keep moments with a fact kept (or restated); held = also counting tentative; noise = kept facts from
moments labelled skip; maybe = unsure moments held or kept.
Needs TL_TEST_PG (see tests/test_mem.py).
"""
import asyncio
import json
import math
import os
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from app import mem

HERE = Path(__file__).parent
DATA = HERE / "data"
FEATURES = ("imp", "dur", "nov", "tr", "ex")


def load(name: str) -> tuple[list[dict], str, list[str]]:
    """A set as labelled episodes in order, the user's name and the teammates' names."""
    if name == "real":
        return json.loads((DATA / "gate_labels.json").read_text()), "", []
    data = json.loads((HERE / f"gate_{name}.json").read_text())
    owner = {"train": "00000000-0000-4000-8000-00000000a001", "test": "00000000-0000-4000-8000-00000000a002"}[name]
    start, rows = date.fromisoformat(data["start"]), []
    for t in data["threads"]:
        for n, (day, who, text, label, fact) in enumerate(t["lines"]):
            at = datetime.combine(start + timedelta(days=day), datetime.min.time(), UTC) + timedelta(hours=9, minutes=n)
            trust = 2 if who == "user" else 0 if who.startswith("app ") else 1
            rows.append({"owner": owner, "ref": t["ref"], "speaker": data["user"] if who == "user" else who, "trust": trust,
                         "source": "chat", "text": text, "label": label, "fact": fact, "at": at.isoformat()})
    for i, r in enumerate(rows):
        r["i"] = i
    return rows, data["user"], data["teammates"]


async def run(name: str) -> None:
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    labels, user, roster = load(name)
    owner = labels[0]["owner"]
    mem.BATCH_CHARS = int(os.environ.get("BATCH_CHARS", mem.BATCH_CHARS))  # to compare batch sizes
    pool = AsyncConnectionPool(os.environ["TL_TEST_PG"], open=False, kwargs={"autocommit": True, "row_factory": dict_row})
    await pool.open()
    await mem.setup(pool)
    await mem._q("delete from mem_entities where owner = %s", owner)
    await mem._q("delete from mem_episodes where owner = %s", owner)
    for r in labels:
        await mem.log_episode(owner, r["source"], r["text"], trust=r["trust"], ref=r["ref"], speaker=r["speaker"],
                              at=datetime.fromisoformat(r["at"]))
    ids = {(r["text"], r["occurred_at"]): str(r["id"]) for r in
           await mem._q("select id, text, occurred_at from mem_episodes where owner = %s", owner)}
    label_of = {ids[(r["text"][:4000], datetime.fromisoformat(r["at"]))]: r for r in labels}
    if roster:  # synthetic users have no account: their name and teammates come from the set
        async def _roster(_owner: str) -> list[str]:
            return roster
        mem._roster = _roster
        await mem.user_entity(owner, user)
    else:
        user = await mem._user_name(owner)
    decisions, stage0, calls = [], 0, 0
    while batches := await mem._batches(owner, force=True):
        for batch in batches:
            for attempt in range(4):
                try:
                    res = await mem.extract(owner, user, batch)
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
                decisions.append({**d, "i": label_of[d["episode"]]["i"]})
            print(f"  batch {len(batch):3d} -> {', '.join(f'{k} {v}' for k, v in res.items() if v and k != 'decisions')}")
            await asyncio.sleep(4)
    (DATA / f"gate_run_{name}.json").write_text(json.dumps({"decisions": decisions, "stage0": stage0, "calls": calls,
                                                           "episodes": len(labels)}, indent=1))
    print(f"{name}: {calls} model calls, {stage0} episodes ruled out by stage 0, {len(decisions)} decisions")
    await pool.close()


def credit(run_: dict, labels: list[dict]) -> list[dict]:
    """Each decision credited to the moment it belongs to: the nearest keep/maybe within 3 messages in the same chat
    (a fact is often quoted from the reply next to what the user said), else its own label."""
    out = []
    for d in run_["decisions"]:
        own = labels[d["i"]]
        near = [r for r in labels[max(0, d["i"] - 3):d["i"] + 4] if r["ref"] == own["ref"] and r["label"] != "skip"]
        best = min(near, key=lambda r: (abs(r["i"] - d["i"]), r["label"] != "keep"), default=own)
        out.append({**d, "i": best["i"], "label": best["label"]})
    return out


def p_of(w: dict, g: dict, seen: int = 1) -> float:
    z = w["b0"] + sum(w[k] * g.get(k, 0) for k in FEATURES) + w["rep"] * math.log(seen)
    return 1 / (1 + math.exp(-z))


def score(decisions: list[dict], labels: list[dict], w: dict) -> dict:
    keep = {r["i"] for r in labels if r["label"] == "keep"}
    maybe = {r["i"] for r in labels if r["label"] == "maybe"}
    kept, held, noise, stored = set(), set(), [], 0
    for d in decisions:
        p = 1.0 if d["status"] == "same" else p_of(w, d["gate"])
        if p >= mem.SURE:
            kept.add(d["i"])
            if d["status"] != "same":
                stored += 1
                if d["label"] == "skip":
                    noise.append(d)
        if p >= mem.KEEP:
            held.add(d["i"])
    return {"recall": len(kept & keep) / max(1, len(keep)), "held": len(held & keep) / max(1, len(keep)),
            "noise": len(noise) / max(1, stored), "kept facts": stored, "maybe": len(held & maybe) / max(1, len(maybe)),
            "missed": sorted(keep - held), "proposed": {d["i"] for d in decisions}, "noisy": noise}


def fit(decisions: list[dict], w0: dict, steps: int = 3000, lr: float = 0.3, l2: float = 0.05) -> dict:
    """Logistic regression, keep = 1 vs skip = 0 (maybe left out), from the starting weights with a pull back toward
    them (L2) so a few labels can't swing a weight wildly. A missed keep costs 3x a kept skip, the same 1:3 the
    thresholds assume."""
    rows = [(d["gate"], 1.0 if d["label"] == "keep" else 0.0) for d in decisions if d["status"] != "same" and d["label"] != "maybe"]
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


def report() -> None:
    sets = {}
    for name in ("train", "test", "real"):
        f = DATA / f"gate_run_{name}.json"
        if f.exists():
            labels = load(name)[0]
            run_ = json.loads(f.read_text())
            sets[name] = (labels, credit(run_, labels), run_)
    if "train" not in sets:
        raise SystemExit("run the train set first")
    fitted = fit(sets["train"][1], mem.GATE)
    print(f"starting weights {mem.GATE}\nfitted on train  {fitted}")
    for name, (labels, decisions, run_) in sets.items():
        print(f"\n{name}: {run_['episodes']} episodes, {run_['stage0']} ruled out by stage 0, {run_['calls']} model calls, "
              f"{len(decisions)} proposals")
        for wname, w in (("start", mem.GATE), ("fitted", fitted)):
            s = score(decisions, labels, w)
            print(f"  {wname:6s} recall {s['recall']:.0%} (held {s['held']:.0%}) · noise {s['noise']:.0%} of "
                  f"{s['kept facts']} kept · maybe held {s['maybe']:.0%}")
        s = score(decisions, labels, fitted)
        for i in s["missed"]:
            print(f"    missed #{i}: {labels[i]['fact'][:100]}" + (" (gate)" if i in s["proposed"] else ""))
        for d in s["noisy"]:
            print(f"    noise  #{d['i']} p={p_of(fitted, d['gate']):.2f}: {d['text'][:100]}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["run"]:
        asyncio.run(run(sys.argv[2]))  # scratch Postgres only; embeddings as configured (local on the laptop)
    else:
        report()
