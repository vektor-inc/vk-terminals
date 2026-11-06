FROM node:22-trixie
ARG BWRAP_VERSION
ARG BWRAP_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends git meson ninja-build pkg-config libcap-dev curl ca-certificates build-essential patch && rm -rf /var/lib/apt/lists/*
# 各バージョンを同じ環境でビルドし、ホストの依存パッケージを使わない。
RUN set -eu; version="${BWRAP_VERSION%-debian}" && curl -fsSL "https://github.com/containers/bubblewrap/releases/download/v${version}/bubblewrap-${version}.tar.xz" -o /tmp/bwrap.tar.xz \
 && echo "${BWRAP_SHA256}  /tmp/bwrap.tar.xz" | sha256sum -c - \
 && mkdir /tmp/bwrap && tar -xf /tmp/bwrap.tar.xz -C /tmp/bwrap --strip-components=1 \
 && if [ "$BWRAP_VERSION" = "0.8.0-debian" ]; then \
      curl -fsSL 'https://deb.debian.org/debian/pool/main/b/bubblewrap/bubblewrap_0.8.0-2+deb12u1.debian.tar.xz' -o /tmp/debian.tar.xz && \
      echo '37917e8abdd6df1d1118f089e9cf1f9374e1b5bb21c8a70d7de4e9b5dfb10f6d  /tmp/debian.tar.xz' | sha256sum -c - && \
      tar -xf /tmp/debian.tar.xz -C /tmp/bwrap && \
      cd /tmp/bwrap && while read -r patch; do case "$patch" in ''|\#*) continue;; esac; patch -p1 < "debian/patches/$patch" || exit 1; done < debian/patches/series || exit 1; \
    fi \
 && meson setup /tmp/bwrap/build /tmp/bwrap --prefix=/usr \
 && ninja -C /tmp/bwrap/build install && rm -rf /tmp/bwrap /tmp/bwrap.tar.xz
WORKDIR /test
ENV BWRAP_VERSION=${BWRAP_VERSION}
USER node
COPY --chown=node:node main.js ./main.js
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node utils ./utils
COPY --chown=node:node tests ./tests
# 実機テストが skip で成功したように見えることを防ぐ。
CMD ["sh", "-ec", "bwrap --version; git version; node -e \"const expected=process.env.BWRAP_VERSION!=='0.8.0'; if(require('./utils/codexTaskOps').getProtectedSyncCapabilities().available!==expected)process.exit(1)\"; VK_PROTECTED_SYNC_RACE_ATTEMPTS=150 node --test tests/protectedSync.test.js"]
