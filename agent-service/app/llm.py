"""Chat models across OpenAI-compatible free providers, with a fallback chain.

Model ids: `<provider>:<model>` (openrouter, groq, gemini, mistral). A bare id is an OpenRouter id,
e.g. `nvidia/nemotron-3-super-120b-a12b:free`.
"""
import asyncio
import json
import logging
import re
import time
from typing import Any

import httpx
import openai
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.runnables import Runnable, RunnableLambda
from langchain_core.tools import BaseTool
from langchain_openai import ChatOpenAI

from . import config, usage

log = logging.getLogger(__name__)

PROVIDERS: dict[str, dict[str, str]] = {
    "openrouter": {"base": "https://openrouter.ai/api/v1", "key": "OPENROUTER_API_KEY", "name": "OpenRouter",
                   "default": config.DEFAULT_MODEL},
    "groq": {"base": "https://api.groq.com/openai/v1", "key": "GROQ_API_KEY", "name": "Groq",
             "default": "groq:openai/gpt-oss-120b"},
    "gemini": {"base": "https://generativelanguage.googleapis.com/v1beta/openai/", "key": "GEMINI_API_KEY",
               "name": "Google Gemini", "default": "gemini:gemini-2.5-flash"},
    "mistral": {"base": "https://api.mistral.ai/v1", "key": "MISTRAL_API_KEY", "name": "Mistral",
                "default": "mistral:mistral-small-latest"},
    # Workers AI (OpenAI-compatible). Model ids look like cloudflare:@cf/openai/gpt-oss-120b.
    "cloudflare": {"base": f"https://api.cloudflare.com/client/v4/accounts/{config.env('CF_ACCOUNT_ID')}/ai/v1",
                   "key": "CF_API_TOKEN", "name": "Cloudflare Workers AI", "default": "cloudflare:@cf/openai/gpt-oss-120b"},
}
# With CF_GATEWAY_ID set, every provider goes through Cloudflare AI Gateway (retries, caching, logs, rate limits).
GATEWAY_PATH = {"openrouter": "openrouter", "groq": "groq", "mistral": "mistral/v1", "cloudflare": "workers-ai/v1"}
NOT_CHAT = re.compile(r"whisper|tts|embed|guard|imagen|veo|aqa|moderation|ocr|audio|image|orpheus|allam|prompt-guard", re.I)
_models: tuple[float, list[dict[str, Any]]] = (0.0, [])
# Workers AI models flagged require_workers_paid (they 403 on the free plan), filled by the model listing.
_cf_paid: set[str] = set()


def parse(model_id: str) -> tuple[str, str]:
    provider, sep, rest = model_id.partition(":")
    return (provider, rest) if sep and provider in PROVIDERS else ("openrouter", model_id)


def key(provider: str) -> str:
    if provider == "cloudflare" and not config.env("CF_ACCOUNT_ID"):
        return ""
    return config.env(PROVIDERS[provider]["key"])


def base_url(provider: str) -> str:
    gw, acct = config.env("CF_GATEWAY_ID"), config.env("CF_ACCOUNT_ID")
    if gw and acct and provider in GATEWAY_PATH:
        return f"https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/{GATEWAY_PATH[provider]}"
    return PROVIDERS[provider]["base"]


def _headers(provider: str) -> dict[str, str] | None:
    h = {"HTTP-Referer": config.APP_URL, "X-Title": "Tubelight"} if provider == "openrouter" else {}
    if config.env("CF_GATEWAY_ID") and config.env("CF_AIG_TOKEN") and provider in GATEWAY_PATH:
        h["cf-aig-authorization"] = f"Bearer {config.env('CF_AIG_TOKEN')}"  # authenticated gateways only
    return h or None


def fallbacks() -> list[str]:
    ids = [m.strip() for m in config.env("LLM_FALLBACKS").split(",") if m.strip()] or \
        [p["default"] for p in PROVIDERS.values()]
    return [m for m in ids if key(parse(m)[0])]


GROQ_HISTORY_BUDGET = 5500


class PaidModelError(ValueError):
    pass


def is_free(model_id: str) -> bool:
    """OpenRouter bills per model: only ':free' ids, or ones its API listed at $0 (cached listing), are allowed.
    Groq, Cloudflare Workers AI and the other providers here are used on their free tiers only."""
    provider, model = parse(model_id)
    if provider == "cloudflare":
        return model not in _cf_paid
    if provider != "openrouter":
        return True
    return model.endswith(":free") or any(m["id"] == f"openrouter:{model}" for m in _models[1])


_cool: dict[str, float] = {}  # model name -> when (monotonic) it's worth trying again after a 429


def _cooldown(body: str) -> float:
    """Seconds to skip a model after a 429. A spent daily quota (Gemini's free tier is 20 requests a day on some
    models) would otherwise cost a failed call and a retry on every request before the fallback answers."""
    if "PerDay" in body or "per day" in body.lower():
        return 3600  # ponytail: probe hourly; the exact reset time (midnight Pacific) isn't in the error
    m = re.search(r"(?:retry|try again) in ([\d.]+)s", body)
    return min(float(m.group(1)) + 1, 300) if m else 30


class _Transport(httpx.AsyncBaseTransport):
    """Shared by every provider: notes 429s for the cooldown, and adds Gemini's placeholder thought signature.

    Gemini 3 rejects earlier tool calls that carry no "thought signature", and history from Groq or Cloudflare
    turns never has one (the OpenAI-compatible client drops them too). Google documents a placeholder signature for
    history that came from elsewhere; add it to every past tool call on the way out."""

    SKIP = {"google": {"thought_signature": "skip_thought_signature_validator"}}

    def __init__(self) -> None:
        self._inner = httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        model = ""
        if request.method == "POST" and request.url.path.endswith("/chat/completions"):
            body = json.loads(await request.aread())
            model = body.get("model", "")
            if request.url.host == "generativelanguage.googleapis.com":
                for m in body.get("messages", []):
                    for tc in m.get("tool_calls") or []:
                        tc.setdefault("extra_content", self.SKIP)
                content = json.dumps(body).encode()
                headers = {k: v for k, v in request.headers.items() if k.lower() != "content-length"}
                request = httpx.Request("POST", request.url, headers=headers, content=content, extensions=request.extensions)
        res = await self._inner.handle_async_request(request)
        provider = usage.provider_of(request.url) if model else None
        if provider and res.status_code != 429:
            usage.record(provider, model, res.status_code, res.headers)
        if res.status_code == 429 and model:
            raw = await res.aread()
            wait = _cooldown(raw.decode(errors="ignore"))
            _cool[model] = time.monotonic() + wait
            log.warning("%s rate limited: skipping it for %ds", model, wait)
            if provider:
                usage.record(provider, model, 429, res.headers, per_day_limit=wait >= 3600)
            headers = [(k, v) for k, v in res.headers.items() if k.lower() not in ("content-encoding", "content-length")]
            return httpx.Response(429, headers=headers, content=raw, request=request)
        return res

    async def aclose(self) -> None:
        await self._inner.aclose()


_http: httpx.AsyncClient | None = None
# Free tiers sometimes stall a request with no reply at all (Gemini: a minute or more, while a retry answers in a
# second). `read` is the longest silence between bytes, so a streaming reply is never cut off, but a stalled one is
# retried after 30 s instead of holding the chat for minutes.
TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=30.0, pool=10.0)


def _one(model_id: str, retries: int = 1) -> ChatOpenAI:
    provider, model = parse(model_id)
    if not is_free(model_id):
        raise PaidModelError(f"{model_id} is not a free model, so Tubelight won't call it.")
    global _http
    _http = _http or httpx.AsyncClient(transport=_Transport(), timeout=TIMEOUT)
    return ChatOpenAI(model=model, base_url=base_url(provider), api_key=key(provider) or "missing",
                      default_headers=_headers(provider), timeout=TIMEOUT, max_retries=retries, http_async_client=_http)


def _text_content(messages: list) -> list:
    """Workers AI rejects an assistant turn whose content is null (a pure tool call); give it a blank string."""
    return [m.model_copy(update={"content": " "}) if isinstance(m, AIMessage) and not m.content else m for m in messages]


GROQ_REQUEST_LIMIT = 7000  # tokens: Groq's free tier allows 8k per minute per model; leave room for the reply


def chat_model(model: str | None = None, tools: list[BaseTool] | None = None, size: int = 0, json: bool = False) -> Runnable:
    """The model (tools bound) followed by the fallback chain for 429s, 5xx, timeouts and provider errors.
    Tests monkeypatch this to return a scripted fake."""
    primary = model or config.DEFAULT_MODEL
    # The default model is always the first fallback: it handles tool-heavy requests that smaller free tiers reject.
    ids: list[str] = []
    for m in [primary, config.DEFAULT_MODEL, *fallbacks()]:
        if parse(m) in [parse(i) for i in ids] or (m != primary and not key(parse(m)[0])):
            continue  # already in the chain, or a provider without a key
        if not is_free(m):  # e.g. a teammate still set to a model that has since become paid-only: skip, don't fail
            log.warning("skipping %s: not free", m)
            continue
        ids.append(m)
    now = time.monotonic()
    ids = [m for m in ids if _cool.get(parse(m)[1], 0) <= now] or ids  # all cooling down: try them anyway
    if size > GROQ_REQUEST_LIMIT:
        # Too big for Groq's free tier: go straight to providers with bigger budgets; Groq only as a last resort.
        ids = [m for m in ids if parse(m)[0] != "groq"] + [m for m in ids if parse(m)[0] == "groq"]
    chain: list[BaseChatModel | Runnable] = []
    ids = ids or [config.DEFAULT_MODEL]
    for i, m in enumerate(ids):
        # A stalled or rate-limited model isn't retried when a fallback can answer: the retry only doubles the wait
        # (a 30 s read timeout twice). The last one in the chain gets one retry.
        llm = _one(m, retries=1 if i == len(ids) - 1 else 0)
        bound = llm.bind_tools(tools) if tools else llm.bind(response_format={"type": "json_object"}) if json else llm
        chain.append(RunnableLambda(_text_content) | bound if parse(m)[0] == "cloudflare" else bound)
    return chain[0].with_fallbacks(chain[1:], exceptions_to_handle=(openai.APIError,)) if len(chain) > 1 else chain[0]


async def _list_cloudflare(c: httpx.AsyncClient) -> list[dict[str, Any]]:
    r = await c.get(f"https://api.cloudflare.com/client/v4/accounts/{config.env('CF_ACCOUNT_ID')}/ai/models/search",
                    params={"task": "Text Generation", "per_page": 100},
                    headers={"Authorization": f"Bearer {key('cloudflare')}"})
    r.raise_for_status()
    out = []
    for m in r.json().get("result", []):
        props = {p.get("property_id"): p.get("value") for p in m.get("properties") or []}
        if str(props.get("require_workers_paid")).lower() == "true":
            _cf_paid.add(m["name"])  # 403 on the Workers Free plan
            continue
        if str(props.get("function_calling")).lower() != "true":
            continue
        ctx = props.get("context_window") or props.get("max_input_tokens")
        out.append({"id": f"cloudflare:{m['name']}", "name": m["name"].split("/")[-1], "provider": "cloudflare",
                    "context_length": int(ctx) if str(ctx).isdigit() else None})
    return out


async def _list(provider: str, c: httpx.AsyncClient) -> list[dict[str, Any]]:
    if provider == "cloudflare":
        return await _list_cloudflare(c)
    p = PROVIDERS[provider]
    headers = {"Authorization": f"Bearer {key(provider)}"} if provider != "openrouter" else {}
    r = await c.get(p["base"].rstrip("/") + "/models", headers=headers)
    r.raise_for_status()
    out = []
    for m in r.json().get("data", []):
        mid = m["id"].removeprefix("models/")
        if provider == "openrouter":
            pr = m.get("pricing") or {}
            if not (pr.get("prompt") == "0" and pr.get("completion") == "0" and "tools" in (m.get("supported_parameters") or [])):
                continue
        elif NOT_CHAT.search(mid) or (m.get("capabilities") or {}).get("function_calling") is False:
            continue  # groq/gemini/mistral free tiers cover their chat models; skip audio, embedding, image
        ctx = m.get("context_length") or m.get("context_window") or m.get("max_context_length")
        out.append({"id": f"{provider}:{mid}", "name": m.get("name") or mid, "provider": provider, "context_length": ctx})
    return out


async def free_tool_models() -> list[dict[str, Any]]:
    """Free, tool-capable models of every provider with a key. Cached for an hour."""
    global _models
    if _models[1] and _models[0] > time.time():
        return _models[1]
    live = [p for p in PROVIDERS if key(p)]
    async with httpx.AsyncClient(timeout=20) as c:
        results = await asyncio.gather(*(_list(p, c) for p in live), return_exceptions=True)
    out = [m for r in results if isinstance(r, list) for m in r]
    if not out and results and isinstance(results[0], Exception):
        raise results[0]
    _models = (time.time() + 3600, out)
    return out


async def context_window(model: str) -> int:
    provider, name = parse(model)
    try:
        models = await free_tool_models()
    except Exception:
        models = []
    ctx = next((m["context_length"] for m in models if m["id"] == f"{provider}:{name}" and m["context_length"]),
               config.MAX_CONTEXT)
    # Groq's free tier allows 8k tokens per minute per model, so a single request has to fit well under that
    # together with the instructions and tools: compaction treats this as the window for Groq models.
    return min(ctx, config.MAX_CONTEXT, GROQ_HISTORY_BUDGET if provider == "groq" else ctx)


def human_error(e: BaseException) -> str:
    """Turn a model/provider exception into one short sentence for the thread."""
    if isinstance(e, openai.RateLimitError):
        if "per-day" in str(e) or "per day" in str(e).lower():
            return "Daily free model limit reached. It resets at 00:00 UTC."
        return "The model is rate limited right now. Try again in a minute."
    if isinstance(e, openai.AuthenticationError):
        return "The model provider rejected the API key. Check the provider keys in agent-service/.env."
    if isinstance(e, openai.PermissionDeniedError):
        return "This teammate's model isn't available on the free plan. Pick another model in their settings."
    if isinstance(e, openai.NotFoundError):
        return "This teammate's model is not available. Pick another model in its settings."
    if isinstance(e, (openai.APITimeoutError, openai.APIConnectionError)):
        return "Could not reach the model provider. Try again in a moment."
    if isinstance(e, openai.APIStatusError) and e.status_code == 413:
        return "This was too big for the free models right now. Try again in a minute, or start a fresh chat."
    if isinstance(e, openai.APIStatusError):
        return f"The model provider returned an error ({e.status_code}). Try again in a moment."
    if isinstance(e, openai.APIError):  # errors reported mid-stream, e.g. an overloaded upstream
        return f"The model provider had a problem: {str(e)[:120]}. Try again in a minute."
    return "Something went wrong while working on this. Try again."
