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
LEARN_MODEL = env("LEARN_MODEL", "gemini:gemini-3.5-flash-lite")
MEM_MODEL = env("MEM_MODEL", LEARN_MODEL)  # memory v2 extraction + profiles (mem.py), JSON mode
KEEPER_MODEL = env("KEEPER_MODEL", LEARN_MODEL)  # brief + follow-up reconciliation after each reply (brief.py)
CU_MODEL = env("CU_MODEL", "groq:openai/gpt-oss-120b")  # computer use: the fast helper that clicks through subtasks
LIVE_MODEL = env("LIVE_MODEL", "gemini-3.8-live")
DICTATE_MODEL = env("DICTATE_MODEL", "gemini-3.5-transcribe-live")
COMPOSIO_API_KEY = env("COMPOSIO_API_KEY")
GITHUB_TOKEN = env("GITHUB_TOKEN")  # optional, used only by the approved git_push tool
APP_URL = env("APP_URL", "http://localhost:3000")
PUBLIC_URL = env("PUBLIC_URL", "https://tubelight.stepwise.studio").rstrip("/")  # where phones reach this service
CORS_ORIGINS = list({o.strip() for o in f"{env('CORS_ORIGINS', APP_URL)},http://localhost:8081".split(",") if o.strip()})
SANDBOX_IMAGE = env("SANDBOX_IMAGE", "tubelight-sandbox")
# On the home server (deploy/server-setup.sh): sandboxes live on an internal network and reach the web only through
# the egress proxy, which refuses private addresses. Unset (a laptop): Docker's default bridge, no proxy.
SANDBOX_NETWORK = env("SANDBOX_NETWORK")
SANDBOX_PROXY = env("SANDBOX_PROXY")  # e.g. http://tl-egress-proxy:3128
SANDBOX_UID = env("SANDBOX_UID")  # the unprivileged user sandboxes run as (the agent itself may run as root)
# The server browser (app/browser.py): its own internal network (tl-browser) with the same egress proxy.
BROWSER_IMAGE = env("BROWSER_IMAGE", "tubelight-browser")
BROWSER_NETWORK = env("BROWSER_NETWORK")
BROWSER_PROXY = env("BROWSER_PROXY", SANDBOX_PROXY or "")
WORKSPACES = Path(env("WORKSPACES_DIR", str(Path.home() / ".tubelight" / "workspaces")))

MAX_HANDOFFS = 6
MAX_CONTEXT = 32_000  # effective window cap in tokens, keeps free models fast
