#!/bin/sh
set -eu
# worktree をコンテナへマウントせず、node_modules の変更を防ぐ。
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
result=0
for version in 0.8.0 0.12.0; do
  image="vk-protected-sync-test:$version"
  echo "Testing bubblewrap $version"
  if docker build --build-arg "BWRAP_VERSION=$version" -f "$repo/scripts/protected-sync-linux/Dockerfile" -t "$image" "$repo"; then
    # bubblewrap が独自の mount/user namespace を作るための隔離コンテナ。
    docker run --rm --privileged "$image" || result=1
  else
    result=1
  fi
done
exit "$result"
