"""Expo push notifications to every device token of the user (table push_tokens)."""
import logging

import httpx

from . import db

log = logging.getLogger(__name__)
EXPO_PUSH = "https://exp.host/--/api/v2/push/send"


async def notify(owner_id: str, title: str, body: str, thread_id: str) -> None:
    """Best effort: never breaks a run."""
    try:
        tokens = [r["token"] for r in await db.select("push_tokens", {"owner_id": f"eq.{owner_id}", "select": "token"})]
        if not tokens:
            return
        messages = [{"to": t, "title": title, "body": body[:200], "data": {"thread_id": thread_id}, "sound": "default",
                     # the app's high-importance "Teammates" channel (heads-up + sound); without it Android files
                     # them under a quiet fallback channel
                     "channelId": "default", "priority": "high"}
                    for t in tokens[:100]]
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(EXPO_PUSH, json=messages)
        r.raise_for_status()
        for token, ticket in zip(tokens, r.json().get("data", [])):
            if (ticket.get("details") or {}).get("error") == "DeviceNotRegistered":
                await db.delete("push_tokens", {"token": f"eq.{token}"})
    except (db.DBError, httpx.HTTPError, ValueError) as e:
        log.warning("push failed: %s", e)
