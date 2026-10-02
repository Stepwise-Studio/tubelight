#!/usr/bin/env bash
# One-time (idempotent) setup on the home server for teammate sandboxes. Run as the docker-group user, no sudo:
#   bash ~/tubelight/deploy/server-setup.sh
# - tl-control: internal network where the agent reaches the Docker socket proxy (containers + exec only).
# - tl-sandbox: internal network for sandboxes; their only way out is tl-egress-proxy (squid), which refuses
#   private and local addresses (router, LAN devices, the server itself).
# - ~/tubelight/data: workspaces and repo copies, bind-mounted into the agent at the same path, because the
#   Docker daemon resolves sandbox mounts on the host.
set -euo pipefail
cd "$(dirname "$0")"
docker network inspect tl-control >/dev/null 2>&1 || docker network create --internal tl-control
docker network inspect tl-sandbox >/dev/null 2>&1 || docker network create --internal tl-sandbox
docker network inspect tl-egress >/dev/null 2>&1 || docker network create tl-egress

docker rm -f tl-docker-proxy >/dev/null 2>&1 || true
docker run -d --name tl-docker-proxy --restart unless-stopped --network tl-control \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e CONTAINERS=1 -e POST=1 -e EXEC=1 -e IMAGES=1 -e INFO=0 -e NETWORKS=0 -e VOLUMES=0 -e BUILD=0 -e SWARM=0 \
  -e SYSTEM=0 -e SECRETS=0 -e PLUGINS=0 -e AUTH=0 -e DELETE=1 \
  ghcr.io/tecnativa/docker-socket-proxy:latest >/dev/null

docker rm -f tl-egress-proxy >/dev/null 2>&1 || true
docker run -d --name tl-egress-proxy --restart unless-stopped --network tl-egress --memory 128m \
  -v "$PWD/squid.conf:/etc/squid/squid.conf:ro" ubuntu/squid:latest >/dev/null
docker network connect tl-sandbox tl-egress-proxy

mkdir -p ~/tubelight/data/workspaces ~/tubelight/data/repos
echo "ok: networks, socket proxy and egress proxy are up"
