# Tubelight

AI teammates app. Native Expo app (never a web wrapper) + Python agent service + Supabase.
User cares about: token efficiency (don't spawn background agents unless asked), smooth native feel,
no AI slop, Stepwise UI look, squircles, free LLMs only.

## Map
- `docs/CONTRACT.md` — API, realtime, schema rules. `docs/DESIGN.md` — design rules. Read the relevant section only.
- `supabase/migrations/*.sql` — applied via Management API (project `cudfcguivwrhdtvljhgc`, PAT in memory/ask user; Supabase MCP can't see this account).
- `agent-service/` FastAPI + LangGraph. `app/graph.py` (teammate nodes, gate→wait(interrupt)→tools; approvals, `ask_user`, `connect_app` share approvals table via `kind`), `tools.py` (tool build/classify), `runs.py` (background runs, lock per thread, watchdog), `llm.py` (providers: groq default, openrouter, gemini, mistral, cloudflare; optional CF AI Gateway), `live.py` (Gemini Live voice: persona + single-use token; the phone connects straight to Gemini, app work goes through `run_task` → a hidden `voice_task` chat message), `files.py` (attachments → text), `learn.py` (post-run learning pass → memory: person/commitment/preference/lesson/fact with `about`, `due`, `done`), `main.py` (routes). Tests: `.venv/bin/pytest -q` (fake LLM + fake DB).
- `app/` Expo SDK 57, Expo Router in `src/app/`. Design system `src/ui/` (import from `@/ui`, see `src/ui/README.md`), theme `src/theme/` (tokens, `motion.ts` = transitions.dev tokens), data `src/lib/` (`workspace.tsx` global state, `use-thread.ts` thread realtime, `api.ts`, `supabase.ts`, `types.ts`). Chat UI `src/components/chat/`. Vendored libraries.dev RN ports `src/vendor/` (eslint-ignored; keep "Tubelight patch" comments).

## Run (all local; phone = Galaxy S21 FE over USB, adb serial RZCW40ZL54A)
- The desktop app crashes often and kills child processes (even setsid). Run long things as user units:
  `systemd-run --user --unit=tl-svc|tl-metro|tl-release ...` (see git log / previous units; `systemctl --user status tl-*`, `reset-failed` before reuse).
  Keep tool calls short: no sleeps over ~15s, downscale phone screenshots before reading.
- Service: `cd agent-service && setsid .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8787 &` (`kill -USR1 <pid>` dumps stacks).
- Metro: `cd app && setsid npx expo start --dev-client --port 8081 --localhost &`, then `adb reverse tcp:8081 tcp:8081; adb reverse tcp:8787 tcp:8787`.
- Release APK: the laptop has ~4 GB free (the user's other apps); builds get OOM-killed unless capped:
  `systemd-run --user --unit=tl-release --working-directory=$PWD/android -E JAVA_HOME=... -E NODE_OPTIONS=--max-old-space-size=1536 ./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=1 -Dorg.gradle.jvmargs=-Xmx1536m`.
- Models: Gemini is primary (`DEFAULT_MODEL=gemini:gemini-3.8-flash`, fallbacks 3.5 Flash-Lite → Groq → Cloudflare → OpenRouter). 3.8 Flash's free tier is only 20 requests a day (`gemini-flash-latest` is an alias sharing that quota); `llm._Transport` notes every 429 and `chat_model` skips a model until it resets (`_cool`). Gemini 3 needs thought signatures on past tool calls; `llm._GeminiSignatures` adds Google's documented placeholder. Voice: `app/modules/live-audio` (local Expo module, Android) + `src/components/voice/voice-mode.tsx`.
- Groq free tier = 8k tokens per minute per model: every request (instructions + tools + history) must fit. Composio tool schemas are trimmed (`connectors._lean`), earlier tool results shrink (`graph.shrink_old_results`), Groq history budget `llm.GROQ_HISTORY_BUDGET`; Cloudflare `@cf/openai/gpt-oss-120b` is the overflow fallback. Cloudflare models flagged `require_workers_paid` are hidden and skipped.
- Native rebuild only after adding native deps: `cd app/android && JAVA_HOME=~/.local/share/jdk/jdk-17* ./gradlew app:assembleDebug -PreactNativeArchitectures=arm64-v8a` (JDK 25 breaks CMake). `android/` is generated (CNG); if missing: `CI=1 npx expo prebuild -p android`, then `echo "sdk.dir=$HOME/Android/Sdk" > android/local.properties`.
- adb: `~/Android/Sdk/platform-tools/adb`. Screenshot: `adb exec-out screencap -p > f.png` (black = phone locked). Deep link: `adb shell am start -a android.intent.action.VIEW -d "tubelight://chat/<threadId>" studio.stepwise.tubelight`.
- Checks before done: `cd app && npx tsc --noEmit && npx expo lint`; `cd agent-service && .venv/bin/pytest -q`.

## Deploy (home server)
- Backend runs on the user's home server `akhil@192.168.0.6` (Ubuntu 24.04, Core 2 Duo, 3 GB, wired Ethernet ens33 (the RTL8188F USB Wi-Fi dongle uploads at ~0.04 Mbit/s: never rely on it); SSH key auth; user in `docker` group, no sudo for us).
  Container `tubelight-agent` (`--restart unless-stopped -p 127.0.0.1:8787:8787 --env-file ~/tubelight/.env --memory 1700m`), `EMBEDDINGS=cloudflare` (no AVX, little RAM). Postiz stack (compose project `snoofy`) is stopped with restart=no at the user's request; `files-webdav` must stay up.
- Public URL `https://tubelight.stepwise.studio` via the existing remote-managed tunnel `snoofy-home` (systemd cloudflared on the server). App `.env` `EXPO_PUBLIC_AGENT_URL` points there. Gradle doesn't see `.env` changes: after editing it, `rm -rf android/app/build/generated/{assets,res}/react` before `assembleRelease`, then verify with `unzip -p <apk> assets/index.android.bundle | strings | grep stepwise`.
- Code-only redeploy (fast, ~20 KB): ship `app/` + `teammates/` as a thin layer: tar a temp dir with
  `Dockerfile` = `FROM tubelight-agent` / `COPY app /srv/app` / `COPY teammates /srv/teammates`, pipe it to
  `ssh akhil@192.168.0.6 docker build -t tubelight-agent -`, then `docker rm -f` + the `docker run` above.
  NumPy/fastembed can't load on this CPU (no SSE4.2): never switch it back to local embeddings.
  The laptop's local service (`tl-svc`) must stay stopped while the server runs (both would fire schedules).
- Full redeploy (new deps): `cd agent-service && docker build -t tubelight-agent . && docker save tubelight-agent | gzip -1 | ssh akhil@192.168.0.6 docker load` (slow Wi-Fi, ~10 min; run as a systemd user unit), then re-run the container.

## Rules
- Secrets live only in `agent-service/.env`, `app/.env`, `.env.test` (all gitignored). Never print or commit them.
- Commit after each coherent chunk, with the Co-Authored-By line.
- Avatars are static DiceBear Notionists SVGs (`src/ui/avatar.tsx`, cached per seed+colour); `avatar_shape` = `face:<seed>` or a legacy shape name (then the name is the seed). No avatar animation: the user dislikes it.
- `npx expo install <pkg>` only; a new native dep means a dev-client rebuild.
- Reanimated gotcha (release builds only): a view whose resting state is only reached by animating a shared value can snap back to its first-render style on a later React commit. Make the rendered/initial state the resting one (entering/exiting layout animations, offsets that rest at 0); never animate views you've already unmounted. Verify overlay/animation changes on a release APK, not just the dev client.
- Android/Yoga gotcha: a horizontal ScrollView (tables, code) inside a shrink-to-fit container (a chat bubble with `alignItems: flex-start` parents) inflates it to thousands of px. Give such containers a definite width (`hasWideBlock` in message-row).
- UI iteration: use the dev client + Metro (`tl-metro`) with fast refresh instead of release builds; open it via `tubelight://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081`. Stop Metro before release builds (memory).
- Full-height sheets (new teammate/project) render in `SheetsHost` above the navigator via `openSheet()`, not as transparent-modal routes (Android's native stack drew the tabs over them).
