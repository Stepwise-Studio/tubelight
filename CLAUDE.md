# Tubelight

AI teammates app. Native Expo app (never a web wrapper) + Python agent service + Supabase.
User cares about: token efficiency (don't spawn background agents unless asked), smooth native feel,
no AI slop, Stepwise UI look, squircles, free LLMs only.

## Map
- `docs/CONTRACT.md` — API, realtime, schema rules. `docs/DESIGN.md` — design rules. Read the relevant section only.
- `supabase/migrations/*.sql` — applied via Management API (project `cudfcguivwrhdtvljhgc`, PAT in memory/ask user; Supabase MCP can't see this account).
- `agent-service/` FastAPI + LangGraph. `app/graph.py` (teammate nodes, gate→wait(interrupt)→tools; approvals, `ask_user`, `connect_app` share approvals table via `kind`), `tools.py` (tool build/classify), `runs.py` (background runs, lock per thread, watchdog), `llm.py` (providers: groq default, openrouter, gemini, mistral, cloudflare; optional CF AI Gateway), `voice.py` (Groq Whisper/Orpheus), `files.py` (attachments → text), `main.py` (routes). Tests: `.venv/bin/pytest -q` (fake LLM + fake DB).
- `app/` Expo SDK 57, Expo Router in `src/app/`. Design system `src/ui/` (import from `@/ui`, see `src/ui/README.md`), theme `src/theme/` (tokens, `motion.ts` = transitions.dev tokens), data `src/lib/` (`workspace.tsx` global state, `use-thread.ts` thread realtime, `api.ts`, `supabase.ts`, `types.ts`). Chat UI `src/components/chat/`. Vendored libraries.dev RN ports `src/vendor/` (eslint-ignored; keep "Tubelight patch" comments).

## Run (all local; phone = Galaxy S21 FE over USB, adb serial RZCW40ZL54A)
- The desktop app crashes often and kills child processes (even setsid). Run long things as user units:
  `systemd-run --user --unit=tl-svc|tl-metro|tl-release ...` (see git log / previous units; `systemctl --user status tl-*`, `reset-failed` before reuse).
  Keep tool calls short: no sleeps over ~15s, downscale phone screenshots before reading.
- Service: `cd agent-service && setsid .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8787 &` (`kill -USR1 <pid>` dumps stacks).
- Metro: `cd app && setsid npx expo start --dev-client --port 8081 --localhost &`, then `adb reverse tcp:8081 tcp:8081; adb reverse tcp:8787 tcp:8787`.
- Native rebuild only after adding native deps: `cd app/android && JAVA_HOME=~/.local/share/jdk/jdk-17* ./gradlew app:assembleDebug -PreactNativeArchitectures=arm64-v8a` (JDK 25 breaks CMake). `android/` is generated (CNG); if missing: `CI=1 npx expo prebuild -p android`, then `echo "sdk.dir=$HOME/Android/Sdk" > android/local.properties`.
- adb: `~/Android/Sdk/platform-tools/adb`. Screenshot: `adb exec-out screencap -p > f.png` (black = phone locked). Deep link: `adb shell am start -a android.intent.action.VIEW -d "tubelight://chat/<threadId>" studio.stepwise.tubelight`.
- Checks before done: `cd app && npx tsc --noEmit && npx expo lint`; `cd agent-service && .venv/bin/pytest -q`.

## Deploy (home server)
- Backend runs on the user's home server `akhil@192.168.0.4` (Ubuntu 24.04, Core 2 Duo, 3 GB; SSH key auth; user in `docker` group, no sudo for us).
  Container `tubelight-agent` (`--restart unless-stopped -p 127.0.0.1:8787:8787 --env-file ~/tubelight/.env --memory 1700m`), `EMBEDDINGS=cloudflare` (no AVX, little RAM). Postiz stack (compose project `snoofy`) is stopped with restart=no at the user's request; `files-webdav` must stay up.
- Public URL `https://tubelight.stepwise.studio` via the existing remote-managed tunnel `snoofy-home` (systemd cloudflared on the server). App `.env` `EXPO_PUBLIC_AGENT_URL` points there. Gradle doesn't see `.env` changes: after editing it, `rm -rf android/app/build/generated/{assets,res}/react` before `assembleRelease`, then verify with `unzip -p <apk> assets/index.android.bundle | strings | grep stepwise`.
- Redeploy: `cd agent-service && docker build -t tubelight-agent . && docker save tubelight-agent | gzip -1 | ssh akhil@192.168.0.4 docker load` (slow Wi-Fi, ~10 min; run as a systemd user unit), then re-run the container.

## Rules
- Secrets live only in `agent-service/.env`, `app/.env`, `.env.test` (all gitignored). Never print or commit them.
- Commit after each coherent chunk, with the Co-Authored-By line.
- Avatars (Skia) are frozen unless working or `live`: keep it that way for performance.
- `npx expo install <pkg>` only; a new native dep means a dev-client rebuild.
