# Tubelight sandbox for developer/tester teammates: lean (the home server has 3 GB RAM), no browser.
# Build on the server: docker build -t tubelight-sandbox agent-service/sandbox
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-pip python3-venv ripgrep jq curl \
 && npm install -g pnpm \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system safe.directory '*' \
 && git config --system user.name 'Tubelight Teammate' \
 && git config --system user.email 'teammate@tubelight.local' \
 && git config --system init.defaultBranch main

ENV PIP_BREAK_SYSTEM_PACKAGES=1 npm_config_update_notifier=false
WORKDIR /workspace
CMD ["sleep", "600"]
