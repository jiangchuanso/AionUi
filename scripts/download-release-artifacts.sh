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

# `gh run download` needs an auth token; surface a clear error if neither is set.
if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "::error::GITHUB_TOKEN (or GH_TOKEN) is required to download artifacts" >&2
  exit 1
fi

MAX_RETRIES=10

# `gh` needs an auth token. Prefer GH_TOKEN, fall back to GITHUB_TOKEN (the
# step exports GITHUB_TOKEN); export whichever is present so `gh run download`
# is authenticated.
if [ -n "${GH_TOKEN:-}" ]; then
  export GH_TOKEN
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  export GH_TOKEN="$GITHUB_TOKEN"
fi

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

# Why `gh run download` instead of hand-rolled `curl` against the artifacts
# API zip endpoint: for v4/v6 artifacts the API returns a 302 redirect to
# signed blob storage, and large artifacts (e.g. the ~560MB macos DMG zip)
# were reliably coming back as a tiny non-zip body via curl — unzip then fails
# with "End-of-central-directory signature not found" and the release dies.
# `gh run download` resolves by name and follows the storage redirect properly,
# extracting directly into $OUT_DIR/$name/.
for name in "${ARTIFACT_NAMES[@]}"; do
  echo "==> Downloading artifact: $name"
  success=0
  for attempt in $(seq 1 "$MAX_RETRIES"); do
    if gh run download "$RUN_ID" --name "$name" --dir "$OUT_DIR" 2>/dev/null; then
      echo "✓ $name -> $OUT_DIR/$name"
      success=1
      break
    fi
    echo "::warning::Download of '$name' failed (attempt $attempt/$MAX_RETRIES); retrying in $((attempt * 5))s"
    sleep $((attempt * 5))
  done

  if [ "$success" -ne 1 ]; then
    echo "::error::Failed to download artifact '$name' after $MAX_RETRIES attempts"
    exit 1
  fi
done

echo ""
echo "==> All release artifacts downloaded into $OUT_DIR"
