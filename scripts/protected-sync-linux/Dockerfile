FROM node:22-trixie
ARG BWRAP_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends git meson ninja-build pkg-config libcap-dev curl ca-certificates build-essential && rm -rf /var/lib/apt/lists/*
# 両バージョンを同じ環境でビルドし、ホストの依存パッケージを使わない。
RUN curl -fsSL "https://github.com/containers/bubblewrap/releases/download/v${BWRAP_VERSION}/bubblewrap-${BWRAP_VERSION}.tar.xz" -o /tmp/bwrap.tar.xz \
 && mkdir /tmp/bwrap && tar -xf /tmp/bwrap.tar.xz -C /tmp/bwrap --strip-components=1 \
 && meson setup /tmp/bwrap/build /tmp/bwrap --prefix=/usr \
 && ninja -C /tmp/bwrap/build install && rm -rf /tmp/bwrap /tmp/bwrap.tar.xz
WORKDIR /test
ENV BWRAP_VERSION=${BWRAP_VERSION}
COPY main.js ./main.js
COPY scripts/protected-sync-mutations.js ./scripts/protected-sync-mutations.js
COPY utils ./utils
COPY tests ./tests
# 実機テストが skip で成功したように見えることを防ぐ。
CMD ["sh", "-ec", "bwrap --version; git version; node -e \"const expected=process.env.BWRAP_VERSION!=='0.8.0'; if(require('./utils/codexTaskOps').getProtectedSyncCapabilities().available!==expected)process.exit(1)\"; node --test tests/protectedSync.test.js"]
