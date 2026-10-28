#!/usr/bin/env bash
#
# Bundle a compatible glibc next to the web-cli binaries so the produced
# web-linux-*.tar.gz runs on CentOS 8 / RHEL 8 / Rocky Linux 8 (glibc 2.28)
# even when the binaries were built against a newer glibc.
#
# Activation: only when a binary in CONTENT_DIR actually requires a newer glibc
# than 2.28. Otherwise this is a no-op and the artifact is left untouched.
#
# Mechanism (portable, no patchelf / no absolute interpreter needed):
#   1. Copy the build host's glibc runtime libs into CONTENT_DIR/lib/glibc.
#      The host glibc is guaranteed >= whatever the binaries were built against,
#      and glibc >= 2.28 runs fine on the CentOS 8 kernel (4.18).
#   2. Rename each affected binary X -> X.real and drop a POSIX-sh wrapper X that
#      execs the bundled dynamic loader with --library-path pointing at the
#      bundled glibc. Running the binary through the explicit loader (rather than
#      relying on the system loader) is what makes the newer glibc usable on an
#      older system. NSS (libnss_*) is copied so DNS resolution keeps working.
#
# Failure policy: best-effort. If anything here fails we print a warning and
# exit 0 so the artifact is never corrupted nor the build blocked. The Rocky
# Linux 8 smoke-test job in pack-web-cli.yml is the authoritative compatibility
# gate.

set -uo pipefail

CONTENT_DIR="${1:?usage: bundle-glibc.sh <content-dir> <arch>}"
ARCH="${2:?usage: bundle-glibc.sh <content-dir> <arch>}"   # arm64 | x64

GLIBC_DIR="$CONTENT_DIR/lib/glibc"

# arch -> loader soname
case "$ARCH" in
  arm64) LOADER="ld-linux-aarch64.so.1" ;;
  x64)   LOADER="ld-linux-x86-64.so.2" ;;
  *) echo "::warning::bundle-glibc: unsupported arch '$ARCH' — skipping"; exit 0 ;;
esac

# Highest GLIBC_x.yy version required by a binary, encoded as an integer
# (e.g. 2.28 -> 228, 2.39 -> 239). Prints nothing if none detected.
max_glibc() {
  local bin="$1"
  [ -f "$bin" ] || return 0
  command -v objdump >/dev/null 2>&1 || return 0
  objdump -T "$bin" 2>/dev/null \
    | grep -oE 'GLIBC_[0-9]+\.[0-9]+' \
    | sed -E 's/GLIBC_([0-9]+)\.([0-9]+)/\1\2/' \
    | sort -n | tail -n1
}

needs_bundle=0
for bin in "$CONTENT_DIR/aionui-web" "$CONTENT_DIR"/bundled-aioncore/*/aioncore; do
  [ -f "$bin" ] || continue
  v=$(max_glibc "$bin")
  if [ -n "$v" ] && [ "$v" -gt 228 ]; then
    echo "::notice::bundle-glibc: $(basename "$bin") requires glibc > 2.28 (detected ${v%??}.${v: -2})"
    needs_bundle=1
  fi
done

if [ "$needs_bundle" -eq 0 ]; then
  echo "✓ All binaries already compatible with glibc 2.28 — no glibc bundling needed"
  exit 0
fi

# Locate the host glibc directory via the loader's real path.
LOADER_REAL=$(readlink -f "/lib64/$LOADER" 2>/dev/null || readlink -f "/lib/$LOADER" 2>/dev/null)
if [ -z "$LOADER_REAL" ] || [ ! -f "$LOADER_REAL" ]; then
  echo "::warning::bundle-glibc: could not locate host loader '$LOADER' — skipping glibc bundling"
  exit 0
fi
HOST_LIBDIR="$(dirname "$LOADER_REAL")"
echo "Bundling glibc from host ($HOST_LIBDIR) into $GLIBC_DIR ..."

mkdir -p "$GLIBC_DIR"

# soname -> must resolve to a real file we copy, then recreate the soname link.
SONAMES="libc.so.6 libm.so.6 libpthread.so.0 libdl.so.2 librt.so.1 libresolv.so.2 \
         libutil.so.1 libnss_files.so.2 libnss_dns.so.2 libnss_compat.so.2 \
         libgcc_s.so.1 libstdc++.so.6"

# Search the glibc dir plus the usual multiarch/usrmerge locations so we find
# the file regardless of how the host splits /lib and /usr/lib.
LIB_SEARCH_DIRS="$HOST_LIBDIR /lib64 /lib /usr/lib64 /usr/lib"

resolve_and_copy() {
  local name="$1"
  local src=""
  local d
  for d in $LIB_SEARCH_DIRS; do
    if [ -e "$d/$name" ]; then src="$d/$name"; break; fi
  done
  if [ -z "$src" ]; then
    echo "::warning::bundle-glibc: $name not found in any of: $LIB_SEARCH_DIRS"
    return 0
  fi
  local real
  real=$(readlink -f "$src")
  cp -f "$real" "$GLIBC_DIR/" 2>/dev/null || { echo "::warning::bundle-glibc: failed to copy $real"; return 0; }
  ( cd "$GLIBC_DIR" && ln -sf "$(basename "$real")" "$name" )
}

for name in $SONAMES; do
  resolve_and_copy "$name"
done

# The loader is copied from its already-resolved real path (its soname may live
# in a different directory than HOST_LIBDIR), then the soname link is recreated.
cp -f "$LOADER_REAL" "$GLIBC_DIR/" 2>/dev/null
if [ -e "$LOADER_REAL" ] && [ -e "$GLIBC_DIR/$(basename "$LOADER_REAL")" ]; then
  ( cd "$GLIBC_DIR" && ln -sf "$(basename "$LOADER_REAL")" "$LOADER" )
fi

if [ ! -e "$GLIBC_DIR/$LOADER" ]; then
  echo "::warning::bundle-glibc: loader '$LOADER' missing after copy — aborting bundling"
  exit 0
fi

# Wrap each affected binary. The wrapper walks up from its own location to find
# lib/glibc (works whether the binary sits at the tarball root or under
# bundled-aioncore/<plat-arch>/), then execs the bundled loader with the
# bundled library path so the binary never touches the system glibc.
wrap_binary() {
  local bin="$1"
  [ -f "$bin" ] || return 0
  local real="$bin.real"
  local base_real
  base_real=$(basename "$real")
  # Idempotency: if the .real payload already exists this binary was wrapped on a
  # previous run — don't clobber the real binary with the wrapper.
  if [ -f "$real" ]; then
    echo "✓ $(basename "$bin") already wrapped — skipping"
    return 0
  fi
  mv "$bin" "$real"
  {
    printf '#!/bin/sh\n'
    printf '# Auto-generated by scripts/bundle-glibc.sh\n'
    printf '# Runs the binary against the bundled glibc so it works on systems\n'
    printf '# with an older system glibc (e.g. CentOS 8 / Rocky Linux 8).\n'
    printf '# Resolve symlinks: install-web.sh symlinks ~/.local/bin/aionui-web, so\n'
    printf '# $0 may point outside the tarball and would not find lib/glibc.\n'
    printf 'SELF="$0"\n'
    printf 'if command -v readlink >/dev/null 2>&1; then\n'
    printf '  SELF=$(readlink -f -- "$0" 2>/dev/null || echo "$0")\n'
    printf 'fi\n'
    printf 'DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)\n'
    printf 'GLIBC_DIR="$DIR"\n'
    printf 'while [ "$GLIBC_DIR" != "/" ]; do\n'
    printf '  if [ -d "$GLIBC_DIR/lib/glibc" ]; then break; fi\n'
    printf '  GLIBC_DIR=$(dirname "$GLIBC_DIR")\n'
    printf 'done\n'
    printf 'if [ ! -d "$GLIBC_DIR/lib/glibc" ]; then\n'
    printf '  echo "bundled glibc not found next to $SELF" >&2\n'
    printf '  exit 1\n'
    printf 'fi\n'
    printf '# Our root is the tarball dir (parent of lib/glibc); the binary reads\n'
    printf '# this because under the explicit loader process.execPath is the loader.\n'
    printf 'export AIONUI_WEB_ROOT="$GLIBC_DIR"\n'
    printf 'exec "$GLIBC_DIR/lib/glibc/%s" --library-path "$GLIBC_DIR/lib/glibc" "$DIR/%s" "$@"\n' "$LOADER" "$base_real"
  } > "$bin"
  chmod +x "$bin"
  echo "✓ wrapped $(basename "$bin") to use bundled glibc"
}

for bin in "$CONTENT_DIR/aionui-web" "$CONTENT_DIR"/bundled-aioncore/*/aioncore; do
  [ -f "$bin" ] || continue
  wrap_binary "$bin"
done

echo "✓ glibc bundle created at $GLIBC_DIR"
exit 0
