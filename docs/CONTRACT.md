# Tubelight contract

The single source of truth shared by `agent-service/` (Python) and `app/` (Expo / React Native).
Change it here first, then in code.

## Layout

```
tubelight/
  supabase/migrations/   SQL, applied in order
  agent-service/         FastAPI + LangGraph (port 8787)
  app/                   Expo app (Expo Router): iOS, Android, web dev on :8081
  docs/                  CONTRACT.md (this), DESIGN.md
```

## Who talks to what

- **App → Supabase directly** (supabase-js, user JWT, RLS) for all plain CRUD:
  teammates, projects, project_members, event_rules, push_tokens, and reading
  threads, messages, approvals, activity, runs, events, profiles.
- **App → agent-service** only for things that run the engine or need secrets (table below).
  Every call sends `Authorization: Bearer <supabase access_token>`. The service verifies it
  by calling `GET {SUPABASE_URL}/auth/v1/user` (cached ~5 min per token) and acts as that user.
- **agent-service → Supabase** with the service role key (bypasses RLS; it must always set `owner_id`).
- **agent-service → Postgres directly** (`SUPABASE_DB_URL`) only for LangGraph checkpointer + store,
  in schema `langgraph`.

## Schema

See `supabase/migrations/0001_init.sql`. Key rules:

- Thread ids: `dm:<teammate_id>` and `proj:<project_id>`. DB triggers create them when a teammate
  or project is inserted. The same string is the LangGraph checkpoint `thread_id`.
- `messages.sender_type`: `user` | `teammate` | `system`. `teammate_id` set when sender is a teammate.
- `messages.kind`:
  - `text`: normal message. `meta.tool_calls?: [{name, status}]` short summary for the UI.
  - `approval`: teammate asked to do something risky. `meta.approval_id`, `meta.tool_name`.
  - `handoff`: `meta.to_teammate_id`, `meta.note`. Text is a one-line summary.
  - `error`: run failed. Text is short and human-readable.
  - `event`: an external event arrived (proactive). `meta.event_id`, `meta.event_type`, `meta.rule_id`.
- `messages.proactive = true` when a teammate posted without being asked (event/schedule).
- `messages.mentions`: teammate uuids the user @tagged.
- Long-term memory namespaces (LangGraph store): `(<teammate_id>, "memories")`,
  `(<project_id>, "memories")`, `("user:<owner_id>", "profile")`. Always scope by owner
  (teammate/project ids are uuids owned by one user, so they are already unique).

## agent-service HTTP API (base `EXPO_PUBLIC_AGENT_URL`, default http://localhost:8787)

| Method & path | Body | Returns | Notes |
|---|---|---|---|
| `GET /health` | | `{ok, llm, db, docker, composio, push}` booleans | no auth. `llm` = at least one provider key; `push` is always true (Expo push needs no server keys) |
| `GET /models` | | `[{id, name, provider, context_length}]` | free, tool-capable models of every provider with a key. `id` is `<provider>:<model>` (see Models) |
| `GET /templates` | | `[{role, name, handle, bio, system_prompt, allowed_toolkits, avatar_shape, color}]` | default teammates (developer, tester, social, email); no auth |
| `POST /threads/{thread_id}/messages` | `{text, mentions?: uuid[]}` | `{message, run_id}` | inserts the user message, starts a background run, returns immediately |
| `POST /runs/{run_id}/cancel` | | `{ok}` | |
| `POST /approvals/{id}` | `{action: "approve"\|"reject", args?: object, note?: string}` | `{ok, status}` | `args` = edited draft (edit+approve). Resumes the paused graph. 409 if already decided or no longer active (a newer message in the thread expires pending approvals) |
| `GET /memories?scope=teammate\|project\|user&id=<uuid>` | | `[{key, text, created_at, updated_at}]` | |
| `POST /memories` | `{scope, id, text}` | `{key}` | user adds a fact manually |
| `DELETE /memories?scope=&id=&key=` | | `{ok}` | |
| `GET /connections` | | `[{toolkit, name, connected, status, account?}]` | GMAIL, GITHUB, LINEAR, NOTION (+ any connected). `status`: `unavailable` (no COMPOSIO_API_KEY), `not_connected`, or Composio's status lowercased (`active`, `initiated`, `expired`, `failed`, ...) |
| `POST /connections/{toolkit}` | `{callback_url}` | `{redirect_url}` | starts Composio OAuth (Composio Connect Link). `callback_url` may be a deep link (`tubelight://connections`) or https |
| `DELETE /connections/{toolkit}` | | `{ok}` | |
| `POST /events/{webhook_token}` | `{type, source?, payload}` | `{ok, event_id, routed}` | public; token from `profiles.webhook_token` |
| `POST /event-rules/{id}/test` | | `{ok, event_id}` | fires a sample event through the rule |

Errors: `{detail: string}` with a proper status code. `detail` is written for humans.

## Realtime

1. **postgres_changes** (RLS applies) on `messages`, `threads`, `approvals`, `activity`, `runs`.
   Final messages always arrive this way.
2. **Private broadcast channel** `thread:<thread_id>` (`config: { private: true }`), sent by the
   service via `POST {SUPABASE_URL}/realtime/v1/api/broadcast`:

| event | payload | meaning |
|---|---|---|
| `status` | `{run_id, teammate_id, state: "thinking"\|"tool"\|"writing"\|"waiting"\|"idle", label?}` | typing indicator; `label` e.g. "Reading inbox", "Running tests" |
| `delta` | `{run_id, teammate_id, stream_id, text}` | **accumulated** text so far (not a diff), throttled ~120 ms |
| `done` | `{run_id, teammate_id, stream_id, discarded?: true}` | stream finished; the DB row with the same text follows via postgres_changes (`meta.stream_id` = `stream_id`) so the client swaps the ghost bubble for the real one without a jump. `discarded: true` = no row follows (the text was chatter before a tool call, an empty reply, or a suppressed low-importance event): drop the ghost |

A `status` with state `idle` ends the run's typing indicator; drop any ghost bubble of that `run_id` still open (cancelled or failed runs).

## Approval policy (tool classification)

| Class | Examples | Behaviour |
|---|---|---|
| read | fetch emails, list issues, search, read_file | runs automatically |
| draft | create draft email, draft post, write_file in sandbox | runs; result shown |
| act | send email, post, create/merge PR, push, delete, pay, order | graph `interrupt()`s; approval row + `approval` message; resumes on decision |

## Events

- The first enabled rule with the same `event_type` whose `match` keys all equal the payload's values, and
  that has fired fewer than `max_per_hour` times in the last hour, handles the event (`events.status`:
  `routed` / `rate_limited` / `ignored`). It runs in `proj:<project_id>` or, without a project, `dm:<teammate_id>`.
- `email` events: the teammate scores importance 1-5 and only posts (and pushes) at 4 or more.
- `schedule` rules: `match.cron` is a 5-field cron evaluated in **UTC**, fired at most once per slot.

## Push (Expo)

The app registers its Expo push token in `push_tokens(token, owner_id, platform)`. The service sends
`POST https://exp.host/--/api/v2/push/send` with `[{to, title, body, data: {thread_id}, sound: "default"}]`
for approval requests and proactive teammate posts, and deletes tokens that come back `DeviceNotRegistered`.

## Models

Teammate `model` ids are `<provider>:<model>` with provider `openrouter`, `groq`, `gemini` or `mistral`,
e.g. `openrouter:nvidia/nemotron-3-super-120b-a12b:free`, `groq:openai/gpt-oss-120b`, `gemini:gemini-2.5-flash`.
A bare id (no known provider prefix) is an OpenRouter id. On 429 / 5xx / timeouts / provider errors a run
falls back through `LLM_FALLBACKS` (only providers with a key).

## Connectors

Teammates get Composio session meta tools (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`,
`COMPOSIO_MULTI_EXECUTE_TOOL`) scoped to their `allowed_toolkits`. Approval classification applies to each
app tool slug inside a multi-execute call; the approval row's `tool_name`/`draft` describe the inner tool
(for several inner tools, `draft = {tools: [...]}`).

## Environment

`agent-service/.env` (never committed): `SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SUPABASE_DB_URL,
OPENROUTER_API_KEY, GROQ_API_KEY?, GEMINI_API_KEY?, MISTRAL_API_KEY?, LLM_FALLBACKS?, DEFAULT_MODEL, ROUTER_MODEL,
COMPOSIO_API_KEY?, APP_URL, CORS_ORIGINS (http://localhost:8081 is always allowed), GITHUB_TOKEN?, SANDBOX_IMAGE?,
WORKSPACES_DIR?`. See `agent-service/.env.example`.

`app/.env` (never committed): `EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, EXPO_PUBLIC_AGENT_URL`.
