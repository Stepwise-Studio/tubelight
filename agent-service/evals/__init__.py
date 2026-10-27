"""Evals call real models. BENCH_KEY=<name of a key in .env> (e.g. GEMINI_BENCH_API_KEY) runs them on a separate free
Gemini project, so the live app's daily quota is untouched. Set before app.config reads the environment."""
import os
from pathlib import Path

from dotenv import dotenv_values

if os.environ.get("BENCH_KEY"):
    _key = dotenv_values(Path(__file__).resolve().parent.parent / ".env").get(os.environ["BENCH_KEY"])
    if not _key:
        raise SystemExit(f"BENCH_KEY names {os.environ['BENCH_KEY']}, which isn't in agent-service/.env")
    os.environ["GEMINI_API_KEY"] = _key
