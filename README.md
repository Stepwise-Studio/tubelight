# Tubelight

AI teammates you talk to like people. A native Expo app (Android first) and a Python agent service: each teammate
has a role, a face, its own chats and tools, and they share one memory of your world. Built on free LLM tiers only.

## What it does

- **Teammates and group chats.** Direct chats (several per teammate) and project groups. In a group, one director
  call decides who's being addressed, who speaks and in what order.
- **They act, with approval where it matters.** 1,500+ apps through Composio (Gmail, Calendar, GitHub, Linear,
  Slack…), web search, and documents (PDF, Word, Excel, PowerPoint). They can also use your phone (alarms, calls,
  texts, apps through accessibility) and your own computers (a paired runner: files, commands in a sandbox,
  driving desktop apps). Anything risky waits for Approve / Reject, in the chat or from the notification.
- **Follow-ups and automations.** "Circle back at 4", standing instructions on a schedule or an app event, nudges,
  and silent checks.
- **Voice.** Real-time voice mode (Gemini Live), an assistant on the side button, and an optional call stand-in that
  answers calls for you.
- **Your files and day.** A Vault with native viewers (PDF, Office, images, video), and Orbit: to-dos, a calendar
  built from the phone's own calendars, alarms and reminders.
- **Memory you can see and talk to.** See below.

## Memory

One memory of your world, shared by every teammate, voice and the phone. The design, with citations, is in
[`docs/memory-v3.html`](docs/memory-v3.html).

- **Episodes → entities → facts → profiles.** What was said is kept word for word. People, organisations, projects,
  places and chapters of your life become entities. Each fact quotes the words it came from (the server checks the
  quote), says how much to trust its source (you over teammates over emails and apps), and has two timelines: when
  it was true and when it was learned. Changed facts are closed, wrong ones retracted, never silently overwritten.
- **A salience gate decides what's worth keeping.** A free filter drops chatter and device commands. The extractor
  rates each candidate fact's importance and how long it will last. A fitted logistic gate turns that, novelty, trust
  and repetition into the chance you'll need it later: keep, hold tentatively (fades unless it comes up again), or
  skip. Held-out evaluation: 91% of important moments kept, no junk stored, calibration error 0.02.
- **Recall by association.** Facts strengthen with use and fade with time (ACT-R). Entities are linked by how much
  more often they come up together than chance (PPMI). Recall spreads activation from what a moment names
  (Personalized PageRank), so asking about "the demo" also brings the person who asked for it.
- **Talk to it.** The Memory teammate takes your story, says what it learned and why it believes something, and lets
  you confirm, correct, forget or merge. It asks only what it's least sure of, at most two questions a conversation.
  Your answers retrain the gate.
- **See it.** Memory → Map draws it from those same numbers: size is importance, brightness is how readily it comes
  to mind, lines are links, colours are groups. Tap one and play how recall spreads from it.
- **Private by construction.** A teammate speaking to a caller only gets facts about that caller, never sensitive
  ones; this is enforced in the query, not the prompt.

## How it fits together

```
app/             Expo SDK 57 app (Expo Router, Reanimated, Skia), its own design system in src/ui
agent-service/   FastAPI + LangGraph: teammates, tools, memory, voice, phone and computer bridges
supabase/        Postgres schema (migrations), auth, realtime
docs/            CONTRACT.md (API and realtime), DESIGN.md (design rules), memory-v3.html (memory paper)
```

The app talks to Supabase for auth, data and realtime, and to the agent service for runs, tools and memory. The
service keeps LangGraph checkpoints, its store and memory tables in a `langgraph` schema in the same Postgres.

Models are free tiers only: Gemini Flash-Lite by default, then Groq, Cloudflare Workers AI and OpenRouter as
fallbacks, with per-teammate choice and a usage screen.

## Run it locally

Service (details in [`agent-service/README.md`](agent-service/README.md)):

```bash
cd agent-service
uv venv .venv && uv pip install -p .venv -r requirements.txt
cp .env.example .env          # Supabase keys and at least one model key
.venv/bin/uvicorn app.main:app --port 8787
```

App (details in [`app/README.md`](app/README.md)):

```bash
cd app
npm install
npx expo run:android          # a development build; then `npx expo start --dev-client`
```

Point the app at the service with `EXPO_PUBLIC_AGENT_URL` in `app/.env`.

## Tests and evaluations

```bash
cd agent-service && .venv/bin/pytest -q        # fake LLM + fake DB; memory tests need TL_TEST_PG (see below)
cd app && npx tsc --noEmit && npx expo lint
```

Memory tests and evaluations use a scratch Postgres with pgvector:

```bash
docker run -d --rm --name tl-memtest -p 127.0.0.1:54329:5432 -e POSTGRES_PASSWORD=t pgvector/pgvector:pg17
docker exec tl-memtest psql -U postgres -c 'create extension vector'
export TL_TEST_PG=postgresql://postgres:t@127.0.0.1:54329/postgres
.venv/bin/python -m evals.memory v2           # question answering over dated chats, calls and emails
.venv/bin/python -m evals.gate run test        # what memory keeps vs what it should (then: evals.gate fit)
```

Other evals: `evals/floor.py` (group-chat routing), `evals/keeper.py` (chat briefs and follow-ups),
`evals/automations.py`, `evals/genui.py`. They call real models, so they're not part of `pytest`.

## Secrets

Keys live only in `agent-service/.env`, `app/.env` and `.env.test`, all gitignored. `agent-service/.env.example`
lists every setting with placeholders.
