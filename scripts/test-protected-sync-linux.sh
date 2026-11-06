#!/bin/sh
set -eu
# worktree をコンテナへマウントせず、node_modules の変更を防ぐ。
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
result=0
for version in 0.8.0 0.8.0-debian 0.12.0; do
  case "$version" in
    0.8.0*) checksum=957ad1149db9033db88e988b12bcebe349a445e1efc8a9b59ad2939a113d333a ;;
    0.12.0) checksum=9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314 ;;
  esac
  image="vk-protected-sync-test:$version"
  echo "Testing bubblewrap $version"
  if docker build --build-arg "BWRAP_VERSION=$version" --build-arg "BWRAP_SHA256=$checksum" -f "$repo/scripts/protected-sync-linux/Dockerfile" -t "$image" "$repo"; then
    # bubblewrap が独自の mount/user namespace を作るための隔離コンテナ。
    docker run --rm --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined "$image" || result=1
  else
    result=1
  fi
done
exit "$result"
