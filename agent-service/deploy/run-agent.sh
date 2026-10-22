#!/usr/bin/env bash
# (Re)start the agent container on the home server with its sandbox wiring (see server-setup.sh).
# The tl-control network is joined before start, so the startup Docker check already sees the socket proxy.
set -euo pipefail
docker rm -f tubelight-agent >/dev/null 2>&1 || true
docker create --name tubelight-agent --restart unless-stopped -p 127.0.0.1:8787:8787 --env-file ~/tubelight/.env --memory 1700m \
  -v "$HOME/tubelight/data:$HOME/tubelight/data" -e WORKSPACES_DIR="$HOME/tubelight/data/workspaces" \
  -e DOCKER_HOST=tcp://tl-docker-proxy:2375 -e SANDBOX_NETWORK=tl-sandbox -e SANDBOX_PROXY=http://tl-egress-proxy:3128 \
  -e SANDBOX_UID="$(id -u)" -e BROWSER_NETWORK=tl-browser -e BROWSER_PROXY=http://tl-egress-proxy:3128 tubelight-agent >/dev/null
docker network connect tl-control tubelight-agent
docker network connect tl-browser tubelight-agent
docker start tubelight-agent >/dev/null
echo "agent started"
