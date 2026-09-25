"""Chat models across OpenAI-compatible free providers, with a fallback chain.

Model ids: `<provider>:<model>` (openrouter, groq, gemini, mistral). A bare id is an OpenRouter id,
e.g. `nvidia/nemotron-3-super-120b-a12b:free`.
"""
import asyncio
import re
import time
from typing import Any

import httpx
import openai
from langchain_core.language_models import BaseChatModel
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool
from langchain_openai import ChatOpenAI

from . import config

PROVIDERS: dict[str, dict[str, str]] = {
    "openrouter": {"base": "https://openrouter.ai/api/v1", "key": "OPENROUTER_API_KEY", "name": "OpenRouter",
                   "default": config.DEFAULT_MODEL},
    "groq": {"base": "https://api.groq.com/openai/v1", "key": "GROQ_API_KEY", "name": "Groq",
             "default": "groq:openai/gpt-oss-120b"},
    "gemini": {"base": "https://generativelanguage.googleapis.com/v1beta/openai/", "key": "GEMINI_API_KEY",
               "name": "Google Gemini", "default": "gemini:gemini-2.5-flash"},
    "mistral": {"base": "https://api.mistral.ai/v1", "key": "MISTRAL_API_KEY", "name": "Mistral",
                "default": "mistral:mistral-small-latest"},
}
NOT_CHAT = re.compile(r"whisper|tts|embed|guard|imagen|veo|aqa|moderation|ocr|audio|image", re.I)
_models: tuple[float, list[dict[str, Any]]] = (0.0, [])


def parse(model_id: str) -> tuple[str, str]:
    provider, sep, rest = model_id.partition(":")
    return (provider, rest) if sep and provider in PROVIDERS else ("openrouter", model_id)


def key(provider: str) -> str:
    return config.env(PROVIDERS[provider]["key"])


def fallbacks() -> list[str]:
    ids = [m.strip() for m in config.env("LLM_FALLBACKS").split(",") if m.strip()] or \
        [p["default"] for p in PROVIDERS.values()]
    return [m for m in ids if key(parse(m)[0])]


def _one(model_id: str) -> ChatOpenAI:
    provider, model = parse(model_id)
    headers = {"HTTP-Referer": config.APP_URL, "X-Title": "Tubelight"} if provider == "openrouter" else None
    return ChatOpenAI(model=model, base_url=PROVIDERS[provider]["base"], api_key=key(provider) or "missing",
                      default_headers=headers, timeout=120, max_retries=1)


def chat_model(model: str | None = None, tools: list[BaseTool] | None = None) -> Runnable:
    """The model (tools bound) followed by the fallback chain for 429s, 5xx, timeouts and provider errors.
    Tests monkeypatch this to return a scripted fake."""
    primary = model or config.DEFAULT_MODEL
    chain: list[BaseChatModel | Runnable] = []
    for m in [primary] + [f for f in fallbacks() if parse(f) != parse(primary)]:
        llm = _one(m)
        chain.append(llm.bind_tools(tools) if tools else llm)
    return chain[0].with_fallbacks(chain[1:], exceptions_to_handle=(openai.APIError,)) if len(chain) > 1 else chain[0]


async def _list(provider: str, c: httpx.AsyncClient) -> list[dict[str, Any]]:
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
    return min(ctx, config.MAX_CONTEXT)


def human_error(e: BaseException) -> str:
    """Turn a model/provider exception into one short sentence for the thread."""
    if isinstance(e, openai.RateLimitError):
        if "per-day" in str(e) or "per day" in str(e).lower():
            return "Daily free model limit reached. It resets at 00:00 UTC."
        return "The model is rate limited right now. Try again in a minute."
    if isinstance(e, openai.AuthenticationError):
        return "The model provider rejected the API key. Check the provider keys in agent-service/.env."
    if isinstance(e, openai.NotFoundError):
        return "This teammate's model is not available. Pick another model in its settings."
    if isinstance(e, (openai.APITimeoutError, openai.APIConnectionError)):
        return "Could not reach the model provider. Try again in a moment."
    if isinstance(e, openai.APIStatusError):
        return f"The model provider returned an error ({e.status_code}). Try again in a moment."
    if isinstance(e, openai.APIError):  # errors reported mid-stream, e.g. an overloaded upstream
        return f"The model provider had a problem: {str(e)[:120]}. Try again in a minute."
    return "Something went wrong while working on this. Try again."
