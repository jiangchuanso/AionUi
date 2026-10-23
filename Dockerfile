# syntax=docker/dockerfile:1
#
# AionUi WebUI — self-contained server image (linux/amd64 + linux/arm64).
#
# Everything the WebUI needs at runtime is baked in:
#   - aionui-web     standalone bun-compiled server binary (no Node install needed)
#   - aioncore       bundled backend (SQLite storage + ACP agents)
#   - static/        SPA renderer build (no-login build: no aionui.com account)
#   - officecli      Office preview component, PRE-INSTALLED on PATH
#
# No login to any aionui website account is required, and a custom model API
# (bring-your-own-key) is configured in the UI after startup. Customer data
# never leaves the customer's own environment: UI state stays in the browser's
# localStorage, conversations live in the /data volume of the customer's own
# container, and model API calls go straight to the provider the customer
# configured.
#
# Build context must contain the packed web-cli tarball produced by
# scripts/pack-web-cli.js (CI publishes it as the web-cli-linux-{x64,arm64}
# artifacts):
#
#   mkdir -p dist-docker/context
#   cp dist-web-cli/aionui-web-<version>-linux-<x86_64|arm64>.tar.gz \
#      dist-docker/context/aionui-web.tar.gz
#   docker build -f Dockerfile \
#     --build-arg WEB_CLI_TARBALL=aionui-web.tar.gz \
#     -t aionui:<version> dist-docker/context
#
# Run (fresh named volume inherits the correct ownership):
#
#   docker run -d --name aionui -p 3000:3000 -v aionui-data:/data aionui:<version>
#
# Host bind mounts must be writable by uid 10001:
#   sudo chown -R 10001:10001 /path/on/host

# ---------------------------------------------------------------------------
# Stage 1: fetch the officecli binary for the target architecture.
# officecli is a self-contained .NET binary that aborts on startup without
# ICU — which is why the runtime stage installs libicu (see comment there).
# The checksum is verified against the release's SHA256SUMS.
# ---------------------------------------------------------------------------
ARG OFFICECLI_VERSION=v1.0.158

FROM debian:bookworm-slim AS officecli
ARG TARGETARCH
ARG OFFICECLI_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) officecli_arch='x64' ;; \
      arm64) officecli_arch='arm64' ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    base_url="https://github.com/iOfficeAI/OfficeCLI/releases/download/${OFFICECLI_VERSION}"; \
    asset="officecli-linux-${officecli_arch}"; \
    curl -fsSL -o "/tmp/${asset}" "${base_url}/${asset}"; \
    curl -fsSL -o /tmp/SHA256SUMS "${base_url}/SHA256SUMS"; \
    expected=$(grep -F "${asset}" /tmp/SHA256SUMS | awk '{print $1}' | head -n1); \
    test -n "$expected"; \
    actual=$(sha256sum "/tmp/${asset}" | awk '{print $1}'); \
    test "$expected" = "$actual"; \
    install -m 0755 "/tmp/${asset}" /officecli

# ---------------------------------------------------------------------------
# Stage 2: runtime image.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# libicu-dev: officecli (.NET) aborts on startup without ICU, and Debian base
# images don't ship it. libicu-dev is version-agnostic so it keeps resolving
# the right libicuNN when the base image bumps Debian releases. (Its
# libicu72 dependency also pulls libstdc++6/libgcc-s1, which the bun-compiled
# server binary may need.)
# ca-certificates: outbound HTTPS to the customer's own model API endpoints.
# curl: HEALTHCHECK probe.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libicu-dev ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# officecli, pre-installed on PATH — the backend finds it without installing.
COPY --from=officecli /officecli /usr/local/bin/officecli

# The packed web-cli tarball, staged into the build context (see header).
# Extracts to aionui-web/{aionui-web,static/,bundled-aioncore/}.
ARG WEB_CLI_TARBALL=aionui-web.tar.gz
COPY "${WEB_CLI_TARBALL}" /tmp/aionui-web.tar.gz
RUN set -eux; \
    mkdir -p /app; \
    tar -xzf /tmp/aionui-web.tar.gz -C /app; \
    rm -f /tmp/aionui-web.tar.gz; \
    chmod 0755 /app/aionui-web/aionui-web; \
    /app/aionui-web/aionui-web version

# Runtime configuration (override with -e / docker run env):
#   -e PORT=8080              listen port
#   -e AIONUI_ALLOW_REMOTE    bind 0.0.0.0 instead of 127.0.0.1
#   -e AIONUI_DATA_DIR        SQLite data location (mount a volume here)
ENV PORT=3000 \
    AIONUI_ALLOW_REMOTE=true \
    AIONUI_OPEN_BROWSER=0 \
    AIONUI_DATA_DIR=/data \
    AIONUI_LOG_DIR=/data/logs \
    HOME=/home/aionui

# Run unprivileged; /data is the only writable path the server needs.
RUN set -eux; \
    useradd --system --create-home --uid 10001 aionui; \
    mkdir -p /data; \
    chown -R aionui:aionui /data

USER aionui
WORKDIR /app/aionui-web

# SQLite database + logs — mount with: -v aionui-data:/data
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/" > /dev/null || exit 1

ENTRYPOINT ["/app/aionui-web/aionui-web"]
CMD ["start", "--remote", "--no-open"]
