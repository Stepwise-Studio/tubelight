# Tubelight agent service

FastAPI + LangGraph backend that runs Tubelight teammates. The API, realtime and approval
contract lives in [`../docs/CONTRACT.md`](../docs/CONTRACT.md).

## Setup

```bash
cd agent-service
python3 -m pip install --user --break-system-packages uv   # once; Ubuntu's python3 has no ensurepip
~/.local/bin/uv venv .venv --python /usr/bin/python3
~/.local/bin/uv pip install -p .venv -r requirements.txt
cp .env.example .env   # then fill it in
```

The first memory write or search downloads the local embedding model
(fastembed `BAAI/bge-small-en-v1.5`, 384 dims, ~70 MB). Memory search makes no API requests.

## Run

```bash
.venv/bin/uvicorn app.main:app --port 8787
curl localhost:8787/health   # {ok, llm, db, docker, composio, push}
```

Everything optional degrades instead of failing:

| Missing | Effect |
|---|---|
| `SUPABASE_DB_URL` | in-memory checkpointer + store (`db:false`), lost on restart |
| `COMPOSIO_API_KEY` | `composio:false`; `/connections` lists the 4 toolkits as `unavailable`; no connector tools |
| Docker | `docker:false`; developer/tester get no sandbox tools and their prompt says so |

With `SUPABASE_DB_URL` set (the `tubelight_langgraph` role, which can only use schema `langgraph` and
`extensions`), the service creates the LangGraph tables on startup in schema `langgraph` (search_path
`langgraph, public, extensions` is set per pooled connection; startup refuses to run if the schema is
missing, so tables never land in `public`) and logs where they landed. To double check:

```sql
select table_schema, table_name from information_schema.tables
where table_name in ('checkpoints', 'checkpoint_writes', 'store', 'store_vectors');
```

Use the session pooler (port 5432). The transaction pooler (6543) is detected and prepared statements are disabled.

## Sandbox (developer / tester)

```bash
docker build -t tubelight-sandbox agent-service/sandbox
```

One container per teammate per run (1 CPU, 1 GB, pids limit, 10-minute wall timeout, network on),
running as your uid with a single bind mount: `~/.tubelight/workspaces/<run_id>` at `/workspace`
(the project's `repo_url` is cloned there). Tools: `run_shell`, `read_file`, `write_file`, and `git_push`
(needs approval; uses `GITHUB_TOKEN` if set). `git push` inside `run_shell` is blocked. When the run
ends the `git diff` is stored in `activity` and the workdir is deleted (it survives approval pauses).

## Push

Expo push via `https://exp.host/--/api/v2/push/send` to the tokens in `push_tokens`; no server keys.
Tokens reported `DeviceNotRegistered` are deleted.

## Connectors (Composio)

Composio Platform sessions, `user_id` = Supabase user id. Teammates get the session meta tools
(search, schemas, multi-execute) scoped to their `allowed_toolkits`: direct tools are too big for a free
model's context (GitHub alone is ~870 tools). Approval classification looks at each app tool slug inside
`COMPOSIO_MULTI_EXECUTE_TOOL`. Connecting happens in the app (`POST /connections/{toolkit}` returns a
Composio Connect Link); in-chat connection management and Composio's remote sandbox are disabled.

## Tests

```bash
.venv/bin/pytest
```

Tests use a scripted fake chat model, an in-memory fake of the Supabase REST helpers and the
in-memory checkpointer/store. They make no network requests.

## Layout

```
app/config.py      env
app/auth.py        Supabase JWT check (cached 5 min)
app/db.py          PostgREST + realtime broadcast + activity helper
app/llm.py         providers (OpenRouter, Groq, Gemini, Mistral), fallback chain, model list, human errors
app/memory.py      checkpointer + store (Postgres or in-memory), fastembed embeddings
app/tools.py       tool classification (read/draft/act), memory/handoff/sandbox/spawn_helper tools
app/connectors.py  Composio (optional)
app/sandbox.py     Docker sandbox (optional)
app/graph.py       the LangGraph graph: router, teammates, approval gate, tools, compaction
app/runs.py        run lifecycle: background tasks, per-thread lock, cancel, resume
app/events.py      webhooks, rule matching, rate limits, cron scheduler
app/push.py        Expo push
teammates/*.md     default teammate templates (served at GET /templates)
```

## Models

Model ids are `<provider>:<model>` (`openrouter`, `groq`, `gemini`, `mistral`; all through their
OpenAI-compatible endpoints). A bare id is an OpenRouter id. Each call falls back through `LLM_FALLBACKS`
(LangChain `with_fallbacks`) on 429s, 5xx, timeouts and provider errors, skipping providers without a key.

`DEFAULT_MODEL=openrouter:nvidia/nemotron-3-super-120b-a12b:free` was verified to stream and call tools
correctly through LangChain and this graph. OpenRouter's free tier allows 50 free-model requests per day;
a 429 posts "Daily free model limit reached. It resets at 00:00 UTC." in the thread instead of crashing.
Groq, Gemini and Mistral are wired but untested (no keys yet).
