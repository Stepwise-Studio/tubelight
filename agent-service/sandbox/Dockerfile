# Tubelight sandbox for developer/tester teammates.
# Build: docker build -t tubelight-sandbox agent-service/sandbox
FROM mcr.microsoft.com/playwright/python:v1.55.0-noble

# Playwright image already has python3 + browser deps. Add node, git and common tooling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates ripgrep jq \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g pnpm \
 && pip install --no-cache-dir --break-system-packages pytest \
 && rm -rf /var/lib/apt/lists/*

# Containers run as the host uid with HOME=/tmp; make sure git trusts the mounted workdir.
RUN git config --system safe.directory '*' \
 && git config --system user.name 'Tubelight Teammate' \
 && git config --system user.email 'teammate@tubelight.local'

WORKDIR /workspace
CMD ["sleep", "600"]
