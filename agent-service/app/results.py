"""Tool results that fit the model's budget without lying about what was left out.

The old way cut every result to its first and last 4k characters: a week of mail (~100k) became ~8 emails and the
teammate summed those up as the week. Here data keeps every item: long text fields shrink first (to 2000, 600, 200,
80 characters); only if that isn't enough does the longest list lose its tail, and the result then says how many
items are missing and how to get them. Plain text (logs, pages) keeps head and tail with the same kind of note."""
import ast
import json
from typing import Any

BUDGET = 24_000  # characters of one tool result (~6k tokens)
STEPS = (2000, 600, 200, 80)


def _parse(s: str) -> Any:
    s = s.strip()
    if not s or s[0] not in "[{":
        return None
    try:
        return json.loads(s)
    except ValueError:
        pass
    try:
        return ast.literal_eval(s)  # Composio's LangChain tools hand back a Python repr
    except (ValueError, SyntaxError, MemoryError, RecursionError):
        return None


def _cap(v: Any, n: int, cut: list[int]) -> Any:
    if isinstance(v, str):
        if len(v) > n:
            cut[0] += 1
            return v[:n] + "…"
        return v
    if isinstance(v, dict):
        return {k: _cap(x, n, cut) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_cap(x, n, cut) for x in v]
    return v


def _lists(v: Any, path: tuple = ()) -> list[tuple[tuple, list]]:
    out = []
    if isinstance(v, list):
        out.append((path, v))
        for i, x in enumerate(v):
            out += _lists(x, (*path, i))
    elif isinstance(v, dict):
        for k, x in v.items():
            out += _lists(x, (*path, k))
    return out


def _dump(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"), default=str)


def fit(out: Any, budget: int = BUDGET) -> str:
    text = out if isinstance(out, str) else None
    data = _parse(text) if text is not None else out
    if data is None or isinstance(data, (str, int, float, bool)):
        s = text if text is not None else str(out)
        if len(s) <= budget:
            return s
        half = budget // 2
        return (s[:half] + f"\n[RESULT CUT: {len(s) - budget} of {len(s)} characters in the middle are not shown. Don't "
                "present this as complete: ask for a narrower part, or say it's partial.]\n" + s[-half:])
    s = _dump(data)
    if len(s) <= budget:
        return text if text is not None and len(text) <= budget else s
    notes, shrunk = [], data
    for n in STEPS:
        cut = [0]
        shrunk = _cap(data, n, cut)
        s = _dump(shrunk)
        if len(s) <= budget:
            notes.append(f"{cut[0]} long text fields were shortened to {n} characters; every item is here")
            break
    else:
        notes.append(f"long text fields were shortened to {STEPS[-1]} characters")
        while len(s) > budget:
            path, biggest = max(_lists(shrunk), key=lambda pl: len(_dump(pl[1])), default=((), []))
            if len(biggest) < 2:
                s = s[:budget]
                notes.append("the rest was cut off")
                break
            items = [x for x in biggest if not (isinstance(x, dict) and "_more" in x)]
            missing = sum(x["_more"] for x in biggest if isinstance(x, dict) and "_more" in x)
            keep = max(1, min(len(items) - 1, int(len(items) * budget / len(s) * 0.9)))
            biggest[:] = items[:keep] + [{"_more": missing + len(items) - keep}]
            s = _dump(shrunk)
        lost = [f"{pl[1][-1]['_more']} items of the list at {'/'.join(map(str, pl[0])) or 'top'}"
                for pl in _lists(shrunk) if pl[1] and isinstance(pl[1][-1], dict) and "_more" in pl[1][-1]]
        if lost:
            notes.append("NOT SHOWN: " + "; ".join(lost) + ". Don't present this as complete: page through, ask for "
                         "fewer fields or a narrower range, or say how much you saw")
    return s + "\n[RESULT COMPACTED: " + "; ".join(notes) + ".]"
