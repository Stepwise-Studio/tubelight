import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


SUPABASE_URL = env("SUPABASE_URL").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY")
SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY")
SUPABASE_DB_URL = env("SUPABASE_DB_URL")
OPENROUTER_API_KEY = env("OPENROUTER_API_KEY")  # GROQ_/GEMINI_/MISTRAL_API_KEY and LLM_FALLBACKS: see llm.py
DEFAULT_MODEL = env("DEFAULT_MODEL", "openrouter:nvidia/nemotron-3-super-120b-a12b:free")
ROUTER_MODEL = env("ROUTER_MODEL", DEFAULT_MODEL)
COMPOSIO_API_KEY = env("COMPOSIO_API_KEY")
GITHUB_TOKEN = env("GITHUB_TOKEN")  # optional, used only by the approved git_push tool
APP_URL = env("APP_URL", "http://localhost:3000")
CORS_ORIGINS = list({o.strip() for o in f"{env('CORS_ORIGINS', APP_URL)},http://localhost:8081".split(",") if o.strip()})
SANDBOX_IMAGE = env("SANDBOX_IMAGE", "tubelight-sandbox")
WORKSPACES = Path(env("WORKSPACES_DIR", str(Path.home() / ".tubelight" / "workspaces")))

MAX_HANDOFFS = 6
MAX_CONTEXT = 32_000  # effective window cap in tokens, keeps free models fast
