"""The inbox in one call: every email of a period, compact. Mail that may need the user (Primary, Important, or no
Gmail category) is listed one line each with its ids; Promotions/Social/Updates/Forums fold into per-sender counts.
A week of a busy inbox (~200 mails) fits in ~15k characters, so a teammate sees all of it instead of the first page
of verbose bodies."""
import ast
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from . import connectors

PAGE = 100
MAX_MAILS = 500
FOLDED = {"CATEGORY_PROMOTIONS": "Promotions", "CATEGORY_SOCIAL": "Social", "CATEGORY_UPDATES": "Updates",
          "CATEGORY_FORUMS": "Forums"}


async def fetch(owner_id: str, query: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    token = ""
    while len(out) < MAX_MAILS:
        args: dict[str, Any] = {"query": query, "max_results": PAGE, "verbose": False, "include_payload": False}
        if token:
            args["page_token"] = token
        d = await connectors.execute(owner_id, "GMAIL_FETCH_EMAILS", args)
        out += d.get("messages") or []
        token = d.get("nextPageToken") or ""
        if not token:
            break
    return out[:MAX_MAILS]


def _labels(m: dict[str, Any]) -> list[str]:
    v = m.get("labelIds") or []
    return ast.literal_eval(v) if isinstance(v, str) and v.startswith("[") else list(v)


def _snippet(m: dict[str, Any]) -> str:
    p = m.get("preview") or {}
    if isinstance(p, str):
        try:
            p = ast.literal_eval(p)
        except (ValueError, SyntaxError):
            p = {"body": p}
    return " ".join(str((p or {}).get("body") or m.get("messageText") or "").split())[:160]


def _who(sender: str) -> str:
    name = re.sub(r"\s*<[^>]*>", "", sender or "").strip().strip('"')
    return name or (sender or "unknown")


def digest(mails: list[dict[str, Any]], tz: str, period: str) -> str:
    zone = ZoneInfo(tz)
    unread = sum("UNREAD" in _labels(m) for m in mails)
    lines = [f"{len(mails)} emails {period} ({unread} unread)" + (" — capped, there are more" if len(mails) >= MAX_MAILS else "") + "."]
    keep, folded = [], {}
    for m in mails:
        labels = _labels(m)
        cat = next((FOLDED[l] for l in labels if l in FOLDED), None)
        if cat and "IMPORTANT" not in labels and "STARRED" not in labels:
            folded.setdefault(cat, {}).setdefault(_who(m.get("sender", "")), []).append(m.get("subject") or "")
        else:
            keep.append(m)
    lines.append(f"\nMail that may need them ({len(keep)}), newest first:")
    for m in keep:
        at = datetime.fromisoformat(str(m.get("messageTimestamp", "")).replace("Z", "+00:00")).astimezone(zone)
        flags = [f for f, l in (("unread", "UNREAD"), ("important", "IMPORTANT"), ("starred", "STARRED")) if l in _labels(m)]
        atts = m.get("attachmentList") or []
        names = [f"{a.get('filename') or a.get('name') or 'file'} (attachment_id {a.get('attachmentId') or a.get('id')})"
                 for a in atts if isinstance(a, dict)]
        lines.append(f"- {at:%a %b %d %I:%M %p} · {m.get('sender', '')} · {m.get('subject') or '(no subject)'}"
                     + (f" — {s}" if (s := _snippet(m)) else "")
                     + (f" [{', '.join(flags)}]" if flags else "")
                     + (f" [attachments: {', '.join(names)}]" if names else "")
                     + f" (message_id {m.get('messageId')})")
    for cat, senders in sorted(folded.items(), key=lambda kv: -sum(map(len, kv[1].values()))):
        n = sum(map(len, senders.values()))
        top = sorted(senders.items(), key=lambda kv: -len(kv[1]))
        lines.append(f"\n{cat} ({n}): " + "; ".join(f"{who} ×{len(s)} ({s[0][:60]})" if len(s) > 1 else f"{who} ({s[0][:60]})"
                                                    for who, s in top[:25])
                     + (f"; +{len(top) - 25} more senders" if len(top) > 25 else ""))
    return "\n".join(lines)
