import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const { prepareAioncore, resolveAioncoreRepo } = require('../../../packages/shared-scripts/src/prepare-aioncore');

const posixFakeToolchainIt = process.platform === 'win32' ? it.skip : it;

function writeExecutable(filePath: string, contents: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

/**
 * Fake network/extract toolchain: every curl invocation is appended to
 * $FAKE_CURL_LOG so the test can assert which repository was downloaded from.
 */
function createFakeToolchain(root: string) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });

  writeExecutable(
    join(binDir, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
out=''
for arg in "$@"; do
  if [[ "$arg" == https://* ]]; then
    printf '%s\\n' "$arg" >> "$FAKE_CURL_LOG"
  fi
  if [[ "$arg" == '-o' ]]; then out=''; fi
done
prev=''
for arg in "$@"; do
  if [[ "$prev" == '-o' ]]; then out="$arg"; fi
  prev="$arg"
done
if [[ -n "$out" ]]; then
  mkdir -p "$(dirname "$out")"
  printf 'archive' > "$out"
fi
`
  );

  writeExecutable(
    join(binDir, 'tar'),
    `#!/usr/bin/env bash
set -euo pipefail
out=''
prev=''
for arg in "$@"; do
  if [[ "$prev" == '-C' ]]; then out="$arg"; fi
  prev="$arg"
done
mkdir -p "$out"
cat > "$out/aioncore" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$out/aioncore"
`
  );

  return binDir;
}

afterEach(() => {
  delete process.env.AIONUI_BACKEND_REPO;
  rmSync(join(tmpdir(), 'aioncore-prepare', 'v0.1.46'), { recursive: true, force: true });
});

describe('prepare-aioncore repository source', () => {
  it('defaults to the upstream repository', () => {
    expect(resolveAioncoreRepo()).toEqual({ owner: 'iOfficeAI', repo: 'AionCore' });
  });

  it('prefers the explicit option over the environment override', () => {
    process.env.AIONUI_BACKEND_REPO = 'from-env/AionCore';
    expect(resolveAioncoreRepo('from-option/AionCore')).toEqual({ owner: 'from-option', repo: 'AionCore' });
  });

  it('falls back to the environment override when no option is given', () => {
    process.env.AIONUI_BACKEND_REPO = 'jiangchuanso/AionCore';
    expect(resolveAioncoreRepo()).toEqual({ owner: 'jiangchuanso', repo: 'AionCore' });
  });

  it('ignores malformed slugs and falls back to the upstream default', () => {
    expect(resolveAioncoreRepo('not-a-slug')).toEqual({ owner: 'iOfficeAI', repo: 'AionCore' });
    expect(resolveAioncoreRepo('owner/repo/extra')).toEqual({ owner: 'iOfficeAI', repo: 'AionCore' });
  });

  posixFakeToolchainIt('downloads release assets from the configured repository', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aionui-repo-source-'));
    const fakeBin = createFakeToolchain(tmp);
    const curlLog = join(tmp, 'curl.log');
    const previousPath = process.env.PATH;
    const previousLog = process.env.FAKE_CURL_LOG;
    process.env.PATH = `${fakeBin}${delimiter}${previousPath || ''}`;
    process.env.FAKE_CURL_LOG = curlLog;

    try {
      // The fake binary produces no managed-resources manifest, so packaging
      // fails at the contract gate — the download URL is what we assert on.
      expect(() =>
        prepareAioncore({
          projectRoot: join(tmp, 'project'),
          platform: 'linux',
          arch: 'x64',
          version: 'v0.1.46',
          repo: 'jiangchuanso/AionCore',
        })
      ).toThrow(/managed-resources\/manifest\.json/);

      expect(existsSync(curlLog)).toBe(true);
      expect(readFileSync(curlLog, 'utf-8')).toContain(
        'https://github.com/jiangchuanso/AionCore/releases/download/v0.1.46/aioncore-v0.1.46-x86_64-unknown-linux-gnu.tar.gz'
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.FAKE_CURL_LOG;
      else process.env.FAKE_CURL_LOG = previousLog;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
