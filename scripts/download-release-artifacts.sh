#!/usr/bin/env bash
# download-release-artifacts.sh
#
# Resilient per-artifact downloader for the "Create Release" job.
#
# Why this exists: `actions/download-artifact@v7` with no `name` downloads ALL
# artifacts of the run concurrently and aborts the whole step the moment ANY
# single artifact fails its (fixed, 5x) retry budget — without telling you which
# one. It also pulls in the auto-generated `.dockerbuild` metadata artifacts that
# the release never consumes. This script downloads only the artifacts the
# release actually needs, one at a time, each with its own generous retry loop
# and backoff, so a transient/storage blip on one big artifact no longer kills
# the entire release and the failing artifact name is surfaced clearly.
#
# Usage:
#   GITHUB_TOKEN=... bash scripts/download-release-artifacts.sh <RUN_ID> [OUT_DIR]
#
# Default OUT_DIR is build-artifacts, matching the path the prepare script reads.

set -uo pipefail

RUN_ID="${1:?usage: download-release-artifacts.sh <RUN_ID> [OUT_DIR]}"
OUT_DIR="${2:-build-artifacts}"

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN is required (set it in the step env)}"

MAX_RETRIES=10
API_BASE="https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/artifacts"

# Only the artifacts the release pipeline actually consumes. The two
# `*.dockerbuild` metadata artifacts produced by docker/build-push-action are
# intentionally excluded — they are never read by prepare-release-assets.sh.
ARTIFACT_NAMES=(
  macos-build-arm64
  macos-build-x64
  windows-build-arm64
  windows-build-x64
  linux-build-arm64
  linux-build-x64
  web-cli-darwin-arm64
  web-cli-darwin-x64
  web-cli-linux-arm64
  web-cli-linux-x64
  web-cli-win32-x64
  docker-image-linux-amd64
  docker-image-linux-arm64
  install-web-script
)

mkdir -p "$OUT_DIR"

resolve_id() {
  local name="$1"
  # Capture the full id list first to avoid SIGPIPE from `head` closing the pipe
  # early (which would make `jq` return non-zero under pipefail).
  local ids
  ids=$(curl -sS -H "Authorization: Bearer ${TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "${API_BASE}?per_page=100" \
    | jq -r --arg n "$name" '.artifacts[]? | select(.name == $n) | .id' 2>/dev/null || true)
  printf '%s\n' "$ids" | head -n 1
}

for name in "${ARTIFACT_NAMES[@]}"; do
  echo "==> Resolving artifact id: $name"
  aid=""
  for attempt in $(seq 1 "$MAX_RETRIES"); do
    aid=$(resolve_id "$name")
    if [ -n "$aid" ]; then break; fi
    echo "::warning::Could not resolve $name (attempt $attempt/$MAX_RETRIES); retrying in 5s"
    sleep 5
  done
  if [ -z "$aid" ]; then
    echo "::error::Artifact '$name' not found in run $RUN_ID"
    exit 1
  fi

  success=0
  for attempt in $(seq 1 "$MAX_RETRIES"); do
    tmp=$(mktemp -d)
    if curl -sSL -H "Authorization: Bearer ${TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "${API_BASE%/*}/artifacts/${aid}/zip" \
      -o "$tmp/art.zip" && [ -s "$tmp/art.zip" ]; then
      mkdir -p "$OUT_DIR/$name"
      if unzip -o -q "$tmp/art.zip" -d "$OUT_DIR/$name"; then
        echo "✓ $name -> $OUT_DIR/$name"
        success=1
        rm -rf "$tmp"
        break
      fi
    fi
    echo "::warning::Download/extract of '$name' failed (attempt $attempt/$MAX_RETRIES); retrying in $((attempt * 5))s"
    rm -rf "$tmp"
    sleep $((attempt * 5))
  done

  if [ "$success" -ne 1 ]; then
    echo "::error::Failed to download artifact '$name' after $MAX_RETRIES attempts"
    exit 1
  fi
done

echo ""
echo "==> All release artifacts downloaded into $OUT_DIR"
