import time
from typing import Any

import httpx
from fastapi import Header, HTTPException

from . import config, db

_cache: dict[str, tuple[float, dict[str, Any]]] = {}
TTL = 300


async def current_user(authorization: str = Header(default="")) -> dict[str, Any]:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "You are not signed in.")
    hit = _cache.get(token)
    if hit and hit[0] > time.time():
        return hit[1]
    try:
        r = await db.client().get(
            "/auth/v1/user",
            headers={"apikey": config.SUPABASE_ANON_KEY, "Authorization": f"Bearer {token}"},
        )
    except httpx.HTTPError:
        raise HTTPException(503, "Could not reach the sign-in service. Try again in a moment.")
    if r.status_code != 200:
        raise HTTPException(401, "Your session has expired. Sign in again.")
    user = r.json()
    if len(_cache) > 1000:
        _cache.clear()
    _cache[token] = (time.time() + TTL, user)
    return user
