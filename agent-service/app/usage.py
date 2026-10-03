"""Usage: how much of each free allowance is left (models, apps, storage), for the app's Usage screen.

Sources, the provider's own word first:
- Groq sends each model's requests left today (and tokens left this minute) in response headers;
- OpenRouter's /key reports free-model requests today; Composio's usage API reports tool calls this month;
- Cloudflare's analytics report neurons today (needs "Account Analytics: Read" on CF_API_TOKEN);
- Postgres reports the database size;
- Gemini says nothing, so every chat request is counted here, per model per provider day (Google's day ends at
  midnight Pacific), kept in the LangGraph store; a per-day 429 marks a model used up until its reset.
"""
import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from . import config, memory

log = logging.getLogger(__name__)

RESET_TZ = {"gemini": "America/Los_Angeles"}  # everyone else's day is UTC
# Free requests a day where the provider doesn't say (Gemini's free tier as of Sep 2026; AI Studio shows the truth).
DAILY_LIMITS = {"gemini-3.8-flash": 20, "gemini-flash-latest": 20, "gemini-3.5-flash": 20, "gemini-3.7-flash": 20,
                "gemini-3.6-flash": 20, "gemini-3.5-flash-lite": 500, "gemini-3.1-flash-lite": 500}
ALIASES = {"gemini-flash-latest": "gemini-3.8-flash"}  # shares its quota
COMPOSIO_MONTHLY = int(config.env("COMPOSIO_MONTHLY_TOOL_CALLS", "100000"))  # the free plan
DB_LIMIT_MB = int(config.env("SUPABASE_DB_LIMIT_MB", "500"))  # Supabase free plan
CF_NEURONS = 10_000  # Workers AI free allocation a day

_counts: dict[tuple[str, str, str], dict[str, Any]] = {}  # (provider, model, day) -> {"requests", "out"}
_limits: dict[tuple[str, str], dict[str, Any]] = {}  # latest rate-limit headers per (provider, model)
_dirty: set[tuple[str, str, str]] = set()
_loaded: set[str] = set()


def _zone(provider: str) -> ZoneInfo:
    return ZoneInfo(RESET_TZ.get(provider, "UTC"))


def day_of(provider: str, now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).astimezone(_zone(provider)).date().isoformat()


def next_reset(provider: str, now: datetime | None = None) -> str:
    local = (now or datetime.now(UTC)).astimezone(_zone(provider))
    return (local.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)).astimezone(UTC).isoformat()


def provider_of(url: httpx.URL) -> str | None:
    host, path = url.host, url.path
    if host == "gateway.ai.cloudflare.com":  # /v1/<account>/<gateway>/<provider path>/...
        seg = path.split("/")[4:6]
        return {"openrouter": "openrouter", "groq": "groq", "mistral": "mistral", "workers-ai": "cloudflare",
                "google-ai-studio": "gemini"}.get(seg[0] if seg else "")
    return {"generativelanguage.googleapis.com": "gemini", "api.groq.com": "groq", "openrouter.ai": "openrouter",
            "api.mistral.ai": "mistral", "api.cloudflare.com": "cloudflare"}.get(host)


def record(provider: str, model: str, status: int, headers: httpx.Headers, per_day_limit: bool = False) -> None:
    """One chat request (llm._Transport calls this). A 2xx counts; a per-day 429 marks the model used up."""
    model = ALIASES.get(model, model)
    k = (provider, model, day_of(provider))
    c = _counts.setdefault(k, {"requests": 0, "out": False})
    if 200 <= status < 300:
        c["requests"] += 1
    if status == 429 and per_day_limit:
        c["out"] = True
    rl = {h[len("x-ratelimit-"):]: v for h, v in headers.items() if h.lower().startswith("x-ratelimit-")}
    if rl:
        _limits[(provider, model)] = {**rl, "at": time.time()}
    _dirty.add(k)


async def flush() -> None:
    """Persist changed counters (the schedule loop calls this every 30 s)."""
    if not memory.store or not _dirty:
        return
    keys = list(_dirty)
    _dirty.clear()
    for p, m, d in keys:
        try:
            await memory.store.aput(("usage", d), f"{p}|{m}", _counts[(p, m, d)])
        except Exception as e:
            _dirty.add((p, m, d))
            log.warning("usage flush failed: %s", e)
            return


async def _load(day: str) -> None:
    if day in _loaded or not memory.store:
        return
    _loaded.add(day)
    try:
        for item in await memory.store.asearch(("usage", day), limit=500):
            p, _, m = item.key.partition("|")
            mine = _counts.setdefault((p, m, day), {"requests": 0, "out": False})
            mine["requests"] = max(mine["requests"], int(item.value.get("requests") or 0))
            mine["out"] = mine["out"] or bool(item.value.get("out"))
    except Exception as e:
        _loaded.discard(day)
        log.warning("usage load failed: %s", e)


async def history(days: int = 14, now: datetime | None = None) -> dict[str, dict[str, int]]:
    """Chat requests per model per day for the last `days` days (oldest first), as counted by llm._Transport."""
    now = now or datetime.now(UTC)
    out: dict[str, dict[str, int]] = {}
    for back in range(days, -1, -1):  # one extra: each provider counts days in its own zone (Gemini: Pacific)
        d = (now - timedelta(days=back)).strftime("%Y-%m-%d")
        await _load(d)
        row = {f"{p}:{m}": c["requests"] for (p, m, day), c in _counts.items() if day == d and c["requests"]}
        if row:
            out[d] = row
    return out


# ------------------------------------------------------------------ what the providers say
async def _openrouter(c: httpx.AsyncClient) -> dict[str, Any] | None:
    if not config.OPENROUTER_API_KEY:
        return None
    r = await c.get("https://openrouter.ai/api/v1/key", headers={"Authorization": f"Bearer {config.OPENROUTER_API_KEY}"})
    return (r.json().get("data") or {}).get("free_model_daily_requests") if r.status_code == 200 else None


async def _composio(c: httpx.AsyncClient) -> dict[str, Any] | None:
    if not config.COMPOSIO_API_KEY:
        return None
    now = datetime.now(UTC)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    r = await c.post("https://backend.composio.dev/api/v3.1/project/usage/tool_calls",
                     headers={"x-api-key": config.COMPOSIO_API_KEY},
                     json={"from": int(start.timestamp() * 1000), "to": int(now.timestamp() * 1000), "limit": 200})
    if r.status_code != 200:
        return None
    d = r.json()
    by_app: dict[str, int] = {}
    for g in d.get("groups") or []:
        # COMPOSIO_* are the router's own lookups (finding the right tool); the rest start with their app
        app = "Tool lookups" if g["key"].startswith("COMPOSIO_") else g["key"].split("_", 1)[0]
        by_app[app] = by_app.get(app, 0) + int(float(g.get("total_quantity") or 0))
    nxt = (start + timedelta(days=32)).replace(day=1)
    return {"used": int(float(d.get("total_quantity") or 0)), "by_app": by_app, "resets": nxt.isoformat()}


async def _cloudflare(c: httpx.AsyncClient) -> dict[str, Any] | None:
    acct, token = config.env("CF_ACCOUNT_ID"), config.env("CF_API_TOKEN")
    if not acct or not token:
        return None
    now = datetime.now(UTC)
    q = ("query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){aiInferenceAdaptiveGroups("
         "filter:{datetime_geq:$s,datetime_leq:$e},limit:100){sum{totalNeurons}}}}}")
    r = await c.post("https://api.cloudflare.com/client/v4/graphql", headers={"Authorization": f"Bearer {token}"},
                     json={"query": q, "variables": {"a": acct, "s": f"{now:%Y-%m-%d}T00:00:00Z", "e": f"{now:%Y-%m-%dT%H:%M:%S}Z"}})
    body = r.json() if r.status_code == 200 else {}
    if body.get("errors") or not body.get("data"):
        return {"denied": True}
    groups = body["data"]["viewer"]["accounts"][0]["aiInferenceAdaptiveGroups"]
    return {"neurons": int(sum(g["sum"]["totalNeurons"] or 0 for g in groups))}


async def _db_mb() -> float | None:
    if memory._pool is None:
        return None
    async with memory._pool.connection() as conn:
        cur = await conn.execute("select pg_database_size(current_database()) as b")
        row = await cur.fetchone()
    return round(row["b"] / 1_048_576, 1)


async def _safe(coro: Any) -> Any:
    try:
        return await asyncio.wait_for(coro, 12)
    except Exception as e:
        log.warning("usage source failed: %s", e)
        return None


_cache: tuple[float, dict[str, Any]] = (0.0, {})


async def report(models: list[str], image_model: str = "") -> dict[str, Any]:
    """Everything the Usage screen shows. `models`: the model ids in use (defaults, fallbacks, teammates')."""
    global _cache
    if time.time() - _cache[0] < 30:
        return _cache[1]
    from . import images, llm

    now = datetime.now(UTC)
    for p in {"gemini", *llm.PROVIDERS}:
        await _load(day_of(p, now))
    async with httpx.AsyncClient(timeout=10) as c:
        orouter, composio, cf, db_mb = await asyncio.gather(
            _safe(_openrouter(c)), _safe(_composio(c)), _safe(_cloudflare(c)), _safe(_db_mb()))

    items: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    today = {(p, m): v for (p, m, d), v in _counts.items() if d == day_of(p, now)}
    for mid in [*models, *(f"{p}:{m}" for p, m in today)]:
        p, m = llm.parse(mid)
        if p == "cloudflare" and m in images.MODELS:  # images get their own section
            continue
        m = ALIASES.get(m, m)
        if (p, m) in seen or not llm.key(p):
            continue
        seen.add((p, m))
        count = today.get((p, m), {"requests": 0, "out": False})
        item: dict[str, Any] = {"id": f"{p}:{m}", "provider": p, "used": count["requests"], "limit": None,
                                "unit": "requests", "period": "today", "resets": next_reset(p, now), "source": "counted"}
        h = _limits.get((p, m))
        if p == "groq" and h and h.get("limit-requests") and day_of(p, datetime.fromtimestamp(h["at"], UTC)) == day_of(p, now):
            lim, left = int(h["limit-requests"]), int(h.get("remaining-requests") or 0)
            item |= {"used": lim - left, "limit": lim, "source": "provider",
                     "note": f"{int(h['limit-tokens']):,} tokens a minute" if h.get("limit-tokens") else ""}
        elif p == "gemini" and m in DAILY_LIMITS:
            item["limit"] = DAILY_LIMITS[m]
        elif p == "cloudflare":
            item["note"] = "Shares Cloudflare’s daily neurons (below)."
        elif p == "openrouter":
            item["note"] = "Shares OpenRouter’s free daily requests (below)."
        if count["out"]:
            item |= {"out": True, "used": max(item["used"], item["limit"] or 0)}
        items.append(item)
    sections = [{"title": "Models", "items": items}]
    if images.available():
        rows = []
        for key, m in images.MODELS.items():
            made = today.get(("cloudflare", key), {}).get("requests", 0)
            # What's left of today's neurons buys the rest (chat fallbacks on Cloudflare draw on the same neurons).
            left = (CF_NEURONS - cf["neurons"]) // m["neurons"] if cf and not cf.get("denied") else None
            rows.append({"id": f"images:{key}", "name": m["name"], "provider": "cloudflare", "used": made,
                         "unit": "images", "period": "today", "source": "counted", "resets": next_reset("cloudflare", now),
                         "limit": made + max(left, 0) if left is not None else CF_NEURONS // m["neurons"],
                         "note": f"About {m['neurons']:,} neurons each. {'In use' if key == image_model else ''}".strip()})
        sections.append({"title": "Images", "items": rows})

    pools: list[dict[str, Any]] = []
    if orouter and orouter.get("limit"):
        pools.append({"id": "openrouter", "provider": "openrouter", "used": int(orouter.get("used") or 0),
                      "limit": int(orouter["limit"]), "unit": "requests", "period": "today",
                      "resets": next_reset("openrouter", now), "source": "provider"})
    if cf is not None and llm.key("cloudflare"):
        if cf.get("denied"):
            n = sum(v["requests"] for (p, _), v in today.items() if p == "cloudflare")
            pools.append({"id": "cloudflare", "provider": "cloudflare", "used": n, "limit": None, "unit": "requests",
                          "period": "today", "resets": next_reset("cloudflare", now), "source": "counted",
                          "note": "For neurons left, give CF_API_TOKEN the “Account Analytics: Read” permission."})
        else:
            pools.append({"id": "cloudflare", "provider": "cloudflare", "used": cf["neurons"], "limit": CF_NEURONS,
                          "unit": "neurons", "period": "today", "resets": next_reset("cloudflare", now), "source": "provider"})
    if pools:
        sections.append({"title": "Shared allowances", "items": pools})

    apps: list[dict[str, Any]] = []
    if composio:
        apps.append({"id": "composio", "provider": "composio", "used": composio["used"], "limit": COMPOSIO_MONTHLY,
                     "unit": "tool calls", "period": "this month", "resets": composio["resets"], "source": "provider",
                     "breakdown": sorted(({"name": k, "value": v} for k, v in composio["by_app"].items()),
                                         key=lambda x: -x["value"])})
    if apps:
        sections.append({"title": "Apps", "items": apps})
    if db_mb is not None:
        sections.append({"title": "Storage", "items": [{"id": "database", "provider": "supabase", "used": db_mb,
                                                        "limit": DB_LIMIT_MB, "unit": "MB", "period": "", "source": "provider"}]})
    out = {"updated": now.isoformat(), "sections": sections}
    _cache = (time.time(), out)
    return out
