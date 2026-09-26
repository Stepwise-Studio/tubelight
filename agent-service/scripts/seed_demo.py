"""Fill an account with demo data that exercises every chat and activity component.

    .venv/bin/python scripts/seed_demo.py            # seed (the account that owns a teammate named Dev)
    .venv/bin/python scripts/seed_demo.py --clear    # remove everything it created

Everything is tagged (messages/activity: meta/input.demo, the project's description) so --clear finds it.
Approvals have no live run behind them, so deciding one marks it expired: they're for looking at.
"""
import asyncio
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
from app import config, db  # noqa: E402

PROJECT = "Launch week"
MARK = "Demo data: safe to delete (scripts/seed_demo.py --clear)"
NOW = datetime.now(UTC).replace(second=0, microsecond=0)


def at(days: float, hour: int, minute: int = 0) -> str:
    """A timestamp `days` ago at hour:minute (UTC), so day separators and grouping show."""
    return (NOW - timedelta(days=days)).replace(hour=hour, minute=minute).isoformat()


async def owner_and_team() -> tuple[str, dict[str, dict]]:
    dev = await db.one("teammates", {"name": "eq.Dev"})
    if not dev:
        raise SystemExit("No teammate named Dev: create the starter team in the app first.")
    owner = dev["owner_id"]
    team = {t["name"]: t for t in await db.select("teammates", {"owner_id": f"eq.{owner}"})}
    missing = {"Dev", "Sol", "Ivy", "Tess"} - team.keys()
    if missing:
        raise SystemExit(f"Missing teammates: {', '.join(sorted(missing))}")
    return owner, team


async def upload(owner: str, name: str, data: bytes, mime: str) -> dict:
    path = f"{owner}/demo-{uuid.uuid4().hex[:8]}-{name}"
    r = await db.client().post(f"{config.SUPABASE_URL}/storage/v1/object/attachments/{path}", content=data,
                               headers={"Content-Type": mime})
    r.raise_for_status()
    return {"path": path, "name": name, "mime": mime, "size": len(data)}


async def seed() -> None:
    owner, t = await owner_and_team()
    dev, sol, ivy, tess = (t[n]["id"] for n in ("Dev", "Sol", "Ivy", "Tess"))
    project = await db.insert("projects", {"owner_id": owner, "name": PROJECT, "description": MARK, "color": "#38bdf8"})
    for tm in (dev, sol, ivy, tess):
        await db.insert("project_members", {"project_id": project["id"], "teammate_id": tm, "owner_id": owner})
    proj, dm = f"proj:{project['id']}", f"dm:{ivy}"

    async def msg(thread: str, when: str, text: str = "", *, by: str | None = None, kind: str = "text", **extra) -> str:
        mid = str(uuid.uuid4())
        meta = {"demo": True, **extra.pop("meta", {})}
        await db.insert("messages", {
            "id": mid, "thread_id": thread, "owner_id": owner, "created_at": when, "text": text, "kind": kind,
            "sender_type": "teammate" if by else ("system" if kind in ("event",) else "user"),
            "teammate_id": by, "meta": meta, **extra,
        })
        return mid

    async def ask(thread: str, when: str, by: str, kind: str, tool: str, title: str, draft: dict,
                  status: str = "pending", answer: str | None = None, toolkit: str | None = None) -> None:
        aid, mid = str(uuid.uuid4()), str(uuid.uuid4())
        await db.insert("messages", {
            "id": mid, "thread_id": thread, "owner_id": owner, "created_at": when, "sender_type": "teammate",
            "teammate_id": by, "text": title, "kind": "approval" if kind == "approval" else kind,
            "meta": {"demo": True, "approval_id": aid, **draft},
        })
        await db.insert("approvals", {
            "id": aid, "owner_id": owner, "thread_id": thread, "teammate_id": by, "message_id": mid, "kind": kind,
            "tool_name": tool, "toolkit": toolkit, "title": title, "draft": draft, "status": status, "answer": answer,
            "created_at": when, "decided_at": when if status != "pending" else None,
        })

    image = await upload(owner, "brand-sheet.png", (Path(__file__).parent / "demo-image.png").read_bytes(), "image/png")
    doc = await upload(owner, "launch-plan.md", b"# Launch plan\n\n- Mon: pricing page\n- Tue: email\n- Wed: LinkedIn\n", "text/markdown")

    # ---- Launch week (group chat): two days ago
    kick = await msg(proj, at(2, 9, 2), "Kicking off launch week! @dev can you get the pricing page PR ready? @ivy please line up the announcement email.",
                     mentions=[dev, ivy])
    await msg(proj, at(2, 9, 3), (
        "On it. Here's the plan for the pricing page:\n\n"
        "### Pricing page\n"
        "1. Move the plan cards to the new **squircle** style\n"
        "2. Add the annual toggle (saves *20%*)\n"
        "3. Wire `useCheckout()` to the new price IDs\n\n"
        "```ts\nexport const plans = [\n  { id: 'pro', price: 12, annual: 115 },\n  { id: 'team', price: 29, annual: 278 },\n]\n```\n\n"
        "> I'll open a draft PR first so Tess can run the checkout tests against it."
    ), by=dev)
    await msg(proj, at(2, 9, 4), "Draft PR is up: [#128 Pricing page refresh](https://github.com/Stepwise-Studio/tubelight/pull/128).", by=dev)
    await msg(proj, at(2, 9, 5), kind="handoff", by=dev, meta={"to_teammate_id": tess, "note": "run the checkout e2e tests on #128"})
    await msg(proj, at(2, 9, 12), "All **42** checkout tests pass on #128, including annual billing and coupon edge cases.", by=tess,
              meta={"tool_calls": [{"name": "GITHUB_GET_A_PULL_REQUEST", "status": "ok"}, {"name": "sandbox.run", "status": "ok"},
                                   {"name": "sandbox.run", "status": "error"}, {"name": "sandbox.run", "status": "ok"}]})
    await ask(proj, at(2, 9, 14), dev, "approval", "GITHUB_CREATE_A_PULL_REQUEST", "Open PR: Pricing page refresh",
              {"owner": "Stepwise-Studio", "repo": "tubelight", "title": "Pricing page refresh", "head": "pricing-refresh", "base": "main",
               "body": "New plan cards, annual toggle, checkout price IDs."}, status="approved", toolkit="GITHUB")

    # ---- yesterday
    await msg(proj, at(1, 11, 30), kind="event", meta={"event_type": "github.pull_request.merged"}, text="GitHub: PR #128 was merged")
    await msg(proj, at(1, 11, 31), "#128 just merged, so I drafted the announcement email. It's waiting for your approval below.", by=ivy,
              proactive=True, meta={"event_type": "github.pull_request.merged"})
    await ask(proj, at(1, 11, 32), ivy, "approval", "GMAIL_SEND_EMAIL", "Send: Our new pricing is live",
              {"recipient_email": "customers@stepwise.studio", "subject": "Our new pricing is live",
               "body": "Hi there,\n\nNew plans, an annual option that saves 20%, and a faster checkout.\n\nThe Stepwise team"}, toolkit="GMAIL")
    await ask(proj, at(1, 14, 5), sol, "question", "ask_user", "Which headline should lead the launch post?",
              {"question": "Which headline should lead the launch post?",
               "options": ["Pricing that grows with you", "Save 20% with annual plans", "Same tools, simpler pricing"], "allow_other": True})
    await msg(proj, at(1, 14, 20), "Groq's rate limit was reached while drafting variants. Try again in a minute.", kind="error", by=sol)

    # ---- today
    mine = await msg(proj, at(0, 8, 40), "Here's the brand sheet and the launch plan. Keep the post under 200 words.",
                     meta={"attachments": [image, doc]})
    sol_reply = await msg(proj, at(0, 8, 42), (
        "Got both. Three angles for the LinkedIn post:\n\n"
        "| Angle | Hook | Length |\n|---|---|---|\n| Savings | Save 20% yearly | 140 words |\n"
        "| Simplicity | One page, three plans | 120 words |\n| Story | Why we changed pricing | 190 words |\n\n"
        "I'd go with **Simplicity**."
    ), by=sol, reply_to=mine)
    await msg(proj, at(0, 8, 44), "Simplicity it is. Keep the tone warm.", reply_to=sol_reply)
    await ask(proj, at(0, 8, 47), sol, "approval", "LINKEDIN_CREATE_LINKED_IN_POST", "Post on LinkedIn",
              {"text": "One page. Three plans. No surprises.\n\nWe rebuilt our pricing so you can pick a plan in seconds, and save 20% if you go annual."},
              toolkit="LINKEDIN")
    await ask(proj, at(0, 8, 50), dev, "connect", "connect_app", "Connect Notion to keep the launch checklist in sync",
              {"toolkit": "NOTION", "name": "Notion", "reason": "So I can tick off the launch checklist in your Notion as we ship."})
    await ask(proj, at(0, 8, 55), tess, "question", "ask_user", "Run the full regression suite or just checkout?",
              {"question": "Run the full regression suite or just checkout?", "options": ["Full suite (12 min)", "Checkout only (3 min)"],
               "allow_other": False}, status="approved", answer="Checkout only (3 min)")

    # ---- DM with Ivy: no sender lines in a DM
    await msg(dm, at(0, 7, 10), "Morning Ivy, anything urgent in my inbox?")
    await msg(dm, at(0, 7, 11), (
        "Three things need you today:\n\n"
        "- **Invoice #2231** from Figma is due Friday\n- **Priya** asked to move Thursday's sync to 4pm\n"
        "- A **security alert** from Google (a new sign-in, which was you on the Pixel)\n\n"
        "Everything else is newsletters. Want me to draft a reply to Priya?"
    ), by=ivy)
    await msg(dm, at(0, 7, 12), "Yes, say 4pm works.", by=None)
    await ask(dm, at(0, 7, 13), ivy, "approval", "GMAIL_REPLY_TO_THREAD", "Reply to Priya",
              {"recipient_email": "priya@acme.co", "subject": "Re: Thursday sync", "body": "Hi Priya,\n\n4pm Thursday works. See you then.\n\nAkhil"},
              status="rejected", toolkit="GMAIL")
    await msg(dm, at(0, 7, 14), "No problem, I won't send it. Tell me if you want different wording.", by=ivy)

    # ---- Activity, one of each kind
    run = await db.insert("runs", {"owner_id": owner, "thread_id": proj, "teammate_id": dev, "trigger": "message", "status": "done",
                                   "started_at": at(2, 9, 3), "ended_at": at(2, 9, 14)})
    rows = [
        ("run_start", "Dev started", dev, "ok", None, at(2, 9, 3)), ("tool_call", "GITHUB_CREATE_A_PULL_REQUEST", dev, "ok", 842, at(2, 9, 4)),
        ("handoff", "Dev → Tess", dev, "ok", None, at(2, 9, 5)), ("sandbox", "npm test -- checkout", tess, "ok", 41210, at(2, 9, 10)),
        ("tool_call", "sandbox.run", tess, "error", 3100, at(2, 9, 11)), ("approval_request", "Open PR: Pricing page refresh", dev, "pending", None, at(2, 9, 14)),
        ("approval_decision", "Approved: Open PR", dev, "ok", None, at(2, 9, 20)), ("event", "github.pull_request.merged", ivy, "ok", None, at(1, 11, 30)),
        ("memory_write", "Launch tone: warm, under 200 words", sol, "ok", None, at(0, 8, 44)), ("compaction", "Summarised 38 messages", sol, "ok", 1900, at(0, 8, 45)),
        ("error", "Groq rate limit", sol, "error", None, at(1, 14, 20)), ("run_end", "Dev finished", dev, "ok", 660000, at(2, 9, 14)),
    ]
    for typ, name, tm, status, ms, when in rows:
        await db.insert("activity", {"owner_id": owner, "run_id": run["id"], "thread_id": proj, "teammate_id": tm, "type": typ, "name": name,
                                     "status": status, "duration_ms": ms, "created_at": when, "input": {"demo": True}})
    print(f"Seeded '{PROJECT}' ({proj}), a DM with Ivy and {len(rows)} activity rows for owner {owner}.")


async def clear() -> None:
    owner, t = await owner_and_team()
    demo_msgs = await db.select("messages", {"owner_id": f"eq.{owner}", "meta->>demo": "eq.true", "select": "id"})
    ids = [m["id"] for m in demo_msgs]
    for i in range(0, len(ids), 50):
        await db.delete("approvals", {"message_id": f"in.({','.join(ids[i:i + 50])})"})
        await db.delete("messages", {"id": f"in.({','.join(ids[i:i + 50])})"})
    await db.delete("activity", {"owner_id": f"eq.{owner}", "input->>demo": "eq.true"})
    for p in await db.select("projects", {"owner_id": f"eq.{owner}", "description": f"eq.{MARK}"}):
        await db.delete("runs", {"thread_id": f"eq.proj:{p['id']}"})
        await db.delete("projects", {"id": f"eq.{p['id']}"})
    print(f"Removed {len(ids)} demo messages and the demo project.")


if __name__ == "__main__":
    asyncio.run(clear() if "--clear" in sys.argv else seed())
