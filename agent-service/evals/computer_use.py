"""Computer use evals on this laptop's real desktop: the driver (runner/snoofy.py) and the fast helper
(computer_use.subtask) on throwaway apps only: Calculator and a standalone text editor on a scratch file (a plain
editor launch would restore the user's open documents). Measured like arc-cua's BENCHMARKS.md: driver timings, then
each task N times with its pass rate, success checked outside the model (the app's own text).

    .venv/bin/python -m evals.computer_use [runs] [model ...]     on a GNOME desktop with accessibility on

Clicks and typing go to the app in the background; keys go to the window in front, so leave the laptop alone while
it runs. Not part of pytest: it drives real apps and calls real, rate-limited models.
"""
import asyncio
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from statistics import median

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner" / "snoofy"))
sys.path.append("/usr/lib/python3/dist-packages")  # the system's gi (AT-SPI), as the runner uses it
import snoofy as D  # noqa: E402

from app import computer_use as cu, config  # noqa: E402

SCRATCH = Path(tempfile.gettempdir()) / "tubelight-cu-eval.txt"
LINE = "hello from tubelight"


def _text(r: dict) -> dict:
    out = {k: v for k, v in r.items() if k != "elements"}
    if "elements" in r:
        out["text"] = D.text(r)
    return out


async def call(op: str, args: dict, _t: float) -> dict:
    def run():
        if op == "ui_look":
            return _text(D.observe(args["app"]))
        if op == "ui_act":
            return _text(D.act(args["snapshot"], args["element"], args["action"], args.get("value", "")))
        if op == "ui_keys":
            return _text(D.keys(args["keys"], args.get("app", "")))
        raise ValueError(op)
    return await asyncio.to_thread(run)


def shows(app: str, want: str) -> bool:
    snap = D.observe(app)
    return any(cu._plain(want) in cu._plain(e["name"] + " " + e["value"]) for e in snap["elements"])


def editor_text() -> str:
    snap = D.observe("text editor", SCRATCH.name)
    doc = next((e for e in snap["elements"] if "TYPE" in e["actions"] and e["role"] in ("text", "document text")), None)
    return D.act(snap["snapshot"], doc["id"], "READ")["did"] if doc else ""


CASES = [  # name, app, goal, inputs, done when, check
    ("multiply", "calculator", "Work out 125 × 8.", [], "the result 1000 is shown",
     lambda: shows("calculator", "1000")),
    ("add", "calculator", "Work out 3456 + 789.", [], "the result 4245 is shown",
     lambda: shows("calculator", "4245")),
    ("type", "text editor", f"Type the line “{LINE}” into the document.", [LINE], "the document contains that line",
     lambda: LINE in editor_text()),
]


def open_apps() -> None:
    SCRATCH.write_text("")
    for argv, name in ((["gnome-calculator"], "calculator"),
                       (["gnome-text-editor", "--standalone", str(SCRATCH)], SCRATCH.name)):
        if not any(name in (a["app"] + " ".join(w["title"] for w in a["windows"])).lower() for a in D.apps()):
            subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    time.sleep(3)


def timings() -> None:
    """Driver only, no model: how long a look, a click and a text set take, and whether settling saw the app react."""
    look, click, typed, reacted = [], [], [], []
    for _ in range(5):
        t = time.perf_counter()
        snap = D.observe("calculator")
        look.append((time.perf_counter() - t) * 1000)
        seven = next(e for e in snap["elements"] if e["name"] == "7" and "CLICK" in e["actions"])
        t = time.perf_counter()
        r = D.act(snap["snapshot"], seven["id"], "CLICK")
        click.append((time.perf_counter() - t) * 1000)
        reacted.append(r.get("reacted"))
        snap = D.observe("text editor", SCRATCH.name)
        doc = next(e for e in snap["elements"] if "TYPE" in e["actions"])
        t = time.perf_counter()
        D.act(snap["snapshot"], doc["id"], "REPLACE", "x" * 200)
        typed.append((time.perf_counter() - t) * 1000)
    D.act(snap["snapshot"], doc["id"], "REPLACE", "")
    print(f"driver (median of 5): look Calculator {median(look):.0f} ms ({len(D.observe('calculator')['elements'])} elements), "
          f"click + settle + look {median(click):.0f} ms, 200 chars + settle {median(typed):.0f} ms, "
          f"reacted {sum(map(bool, reacted))}/5")


async def run(model: str, runs: int) -> None:
    config.CU_MODEL = model
    print(f"\n{model}")
    for name, app, goal, inputs, done, check in CASES:
        ok, secs = 0, []
        for _ in range(runs):
            if name == "type":  # never rewrite the file on disk: the editor then offers to reload it
                snap = D.observe("text editor", SCRATCH.name)  # an empty document each run
                doc = next(e for e in snap["elements"] if "TYPE" in e["actions"])
                D.act(snap["snapshot"], doc["id"], "REPLACE", "")
            t = time.perf_counter()
            r = await cu.subtask("", app, goal, inputs, done, 15, call=call)
            secs.append(time.perf_counter() - t)
            passed = check()
            ok += passed
            if not passed:
                print(f"  ✗ {name}: {r.splitlines()[0][:160]} | {re.sub(chr(10) + '.*', '', r.split('Steps: ', 1)[-1])[:240]}")
        print(f"  {name}: {ok}/{runs}, median {median(secs):.1f} s")


async def main() -> None:
    args = sys.argv[1:]
    runs = int(args.pop(0)) if args and args[0].isdigit() else 3
    open_apps()
    timings()
    for model in args or [config.CU_MODEL]:
        await run(model, runs)


if __name__ == "__main__":
    asyncio.run(main())
