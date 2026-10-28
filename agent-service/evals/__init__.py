"""Evals call real models. They must never spend the live app's free quotas: on 2026-10-27 evals on the laptop shared
the server's Gemini key and Cloudflare account, the server's embeddings hit 429 and three inbox automations crashed.

BENCH_KEY=<name of a key in .env> (e.g. GEMINI_BENCH_API_KEY) runs Gemini on a separate free project. With
CF_BENCH_ACCOUNT_ID and CF_BENCH_API_TOKEN in .env (a second free Cloudflare account), embeddings move there too:
the same bge-small model on the same service, so results stay comparable (the laptop's local copy of the model gives
vectors only 0.94-0.96 cosine-similar to Cloudflare's, so it is not a substitute). Set before app.config reads them."""
import os
import sys
from pathlib import Path

from dotenv import dotenv_values

_env = dotenv_values(Path(__file__).resolve().parent.parent / ".env")
if os.environ.get("BENCH_KEY"):
    _key = _env.get(os.environ["BENCH_KEY"])
    if not _key:
        raise SystemExit(f"BENCH_KEY names {os.environ['BENCH_KEY']}, which isn't in agent-service/.env")
    os.environ["GEMINI_API_KEY"] = _key
    if _env.get("CF_BENCH_ACCOUNT_ID") and _env.get("CF_BENCH_API_TOKEN"):
        os.environ["CF_ACCOUNT_ID"], os.environ["CF_API_TOKEN"] = _env["CF_BENCH_ACCOUNT_ID"], _env["CF_BENCH_API_TOKEN"]
    else:
        print("evals: embeddings still use the live Cloudflare account (no CF_BENCH_ACCOUNT_ID / CF_BENCH_API_TOKEN)",
              file=sys.stderr)
