#!/bin/sh
# Snoofy lives in its own repo (github.com/Stepwise-Studio/snoofy, checked out at ~/snoofy). Tubelight carries a
# copy in agent-service/runner/snoofy, because the runner downloads Snoofy's files from the Tubelight server.
# Work on Snoofy in ~/snoofy (commit and push there), then run this to bring that commit into Tubelight.
set -e
src=${SNOOFY:-$HOME/snoofy}
dst=$(cd "$(dirname "$0")/../runner/snoofy" && pwd)
git -C "$src" diff --quiet HEAD || { echo "$src has uncommitted changes: commit them first."; exit 1; }
rsync -a --delete --exclude .git --exclude __pycache__ "$src"/ "$dst"/
rev=$(git -C "$src" rev-parse --short HEAD)
if git -C "$dst" diff --quiet HEAD -- . && [ -z "$(git -C "$dst" status --porcelain -- .)" ]; then
    echo "Tubelight already has Snoofy $rev."
else
    echo "Copied Snoofy $rev. Commit it in Tubelight as: Snoofy $rev: <what changed>"
fi
