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
# Per-artifact download strategy (changed after the v2.2.2 incident):
#   1. curl against the artifacts API zip endpoint. The API answers with a 302
#      redirect to signed blob storage; `-L` follows it and
#      `--retry-all-errors` rides out mid-stream connection resets.
#      `gh run download` has NO retry for those resets and dies with
#      "error writing zip archive: ... connection was forcibly closed by the
#      remote host" — which is exactly how v2.2.2 failed twice in a row
#      (10/10 attempts on macos-build-x64, ~533 MB). The artifact blob itself
#      was intact; only gh's download path was unreliable.
#   2. `gh run download` as a fallback.
# Both paths extract into $OUT_DIR/<artifact-name>/, the layout
# prepare-release-assets.sh expects. Failures always print the underlying
# error output — nothing is discarded with 2>/dev/null — so the next incident
# is diagnosable from the CI log alone.
#
# Usage:
#   GITHUB_TOKEN=... bash scripts/download-release-artifacts.sh <RUN_ID> [OUT_DIR]
#
# Default OUT_DIR is build-artifacts, matching the path the prepare script reads.

set -uo pipefail

RUN_ID="${1:?usage: download-release-artifacts.sh <RUN_ID> [OUT_DIR]}"
OUT_DIR="${2:-build-artifacts}"

# Both `gh` and curl need an auth token; surface a clear error if neither is set.
if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "::error::GITHUB_TOKEN (or GH_TOKEN) is required to download artifacts" >&2
  exit 1
fi

# Prefer GH_TOKEN, fall back to GITHUB_TOKEN (the workflow step exports the
# latter); export whichever is present so `gh` and curl are both authenticated.
if [ -n "${GH_TOKEN:-}" ]; then
  export GH_TOKEN
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  export GH_TOKEN="$GITHUB_TOKEN"
fi

# API base / repository slug: provided by GitHub Actions; the fallbacks keep
# the script usable in local/manual runs.
API_URL="${GITHUB_API_URL:-https://api.github.com}"
REPO="${GITHUB_REPOSITORY:-}"
if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
fi
if [ -z "$REPO" ]; then
  echo "::error::Cannot determine repository slug (GITHUB_REPOSITORY unset and 'gh repo view' failed)" >&2
  exit 1
fi

MAX_RETRIES=10

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

# The curl path needs unzip for integrity checking and extraction; without it
# we rely on the gh fallback alone.
HAVE_UNZIP=0
command -v unzip >/dev/null 2>&1 && HAVE_UNZIP=1

# Resolve an artifact name to its numeric ID via the run's artifact list.
resolve_artifact_id() {
  local name="$1"
  gh api --paginate "repos/${REPO}/actions/runs/${RUN_ID}/artifacts" \
    --jq ".artifacts[] | select(.name == \"${name}\") | .id" 2>/dev/null | head -n 1
}

# Primary download path: curl the API zip endpoint, following the 302 redirect
# to signed blob storage, verify the zip, and extract into $OUT_DIR/<name>/.
download_with_curl() {
  local name="$1" artifact_id="$2" errlog="$3"
  local zip_path="$OUT_DIR/.${name}.zip.part"
  local dest="$OUT_DIR/${name}"

  rm -rf "$dest" "$zip_path"
  mkdir -p "$dest"

  # -L: follow the 302 to blob storage. Without it you save the redirect
  #     response body instead of the zip (the historical "tiny non-zip body /
  #     End-of-central-directory signature not found" failure).
  # --retry-all-errors: retry through mid-stream connection resets, which
  #     `gh run download` treats as fatal and never retries.
  # --speed-limit/--speed-time: abort a stalled transfer so --retry can kick in.
  if ! curl -sSL --fail --connect-timeout 30 \
      --retry 5 --retry-delay 5 --retry-max-time 900 --retry-all-errors \
      --speed-limit 1024 --speed-time 60 \
      -H "Authorization: Bearer ${GH_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -o "$zip_path" \
      "${API_URL}/repos/${REPO}/actions/artifacts/${artifact_id}/zip" 2>>"$errlog"; then
    echo "curl: failed to download '$name'" >>"$errlog"
    rm -f "$zip_path"
    return 1
  fi

  # Reject truncated / non-zip bodies before extracting.
  if ! unzip -tqq "$zip_path" >/dev/null 2>>"$errlog"; then
    echo "curl: zip integrity check failed for '$name'" >>"$errlog"
    rm -f "$zip_path"
    return 1
  fi

  unzip -qq -o "$zip_path" -d "$dest" 2>>"$errlog"
  rm -f "$zip_path"

  # Extraction must have produced files.
  if [ -z "$(ls -A "$dest" 2>/dev/null)" ]; then
    echo "curl: extraction of '$name' produced no files" >>"$errlog"
    return 1
  fi
  return 0
}

for name in "${ARTIFACT_NAMES[@]}"; do
  echo "==> Downloading artifact: $name"
  artifact_id=$(resolve_artifact_id "$name")
  if [ -z "$artifact_id" ]; then
    echo "::warning::Could not resolve artifact ID for '$name' via API; relying on gh fallback"
  fi

  success=0
  for attempt in $(seq 1 "$MAX_RETRIES"); do
    errlog=$(mktemp)

    if [ "$HAVE_UNZIP" -eq 1 ] && [ -n "$artifact_id" ] \
       && download_with_curl "$name" "$artifact_id" "$errlog"; then
      echo "✓ $name -> $OUT_DIR/$name (curl)"
      success=1
      rm -f "$errlog"
      break
    fi

    # Fallback: gh run download. It follows the storage redirect correctly but
    # cannot retry a mid-stream connection reset, hence the curl-first order.
    rm -rf "$OUT_DIR/${name}"
    if gh run download "$RUN_ID" --name "$name" --dir "$OUT_DIR" 2>>"$errlog" \
       && [ -n "$(ls -A "$OUT_DIR/${name}" 2>/dev/null)" ]; then
      echo "✓ $name -> $OUT_DIR/$name (gh fallback)"
      success=1
      rm -f "$errlog"
      break
    fi
    echo "gh run download: failed for '$name'" >>"$errlog"

    # Surface the real error — never discard it. The v2.2.2 release failed
    # blind because gh's "connection forcibly closed" was sent to /dev/null.
    echo "::warning::Download of '$name' failed (attempt $attempt/$MAX_RETRIES); error output:"
    sed 's/^/    /' "$errlog" >&2
    rm -f "$errlog"
    sleep $((attempt * 5))
  done

  if [ "$success" -ne 1 ]; then
    echo "::error::Failed to download artifact '$name' after $MAX_RETRIES attempts"
    exit 1
  fi
done

echo ""
echo "==> All release artifacts downloaded into $OUT_DIR"
