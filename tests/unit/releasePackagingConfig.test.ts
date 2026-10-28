import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const projectRoot = resolve(__dirname, '../..');
const itWithBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0 ? it : it.skip;

function readProjectFile(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf8');
}

function yamlBlock(content: string, key: string): string {
  const startMatch = content.match(new RegExp(`^${key}:\\s*$`, 'm'));
  if (!startMatch || startMatch.index === undefined) return '';

  const blockStart = startMatch.index + startMatch[0].length;
  const rest = content.slice(blockStart);
  const nextTopLevelKey = rest.search(/^[a-zA-Z][a-zA-Z0-9]*:\s*$/m);
  return nextTopLevelKey === -1 ? rest : rest.slice(0, nextTopLevelKey);
}

type DownloadStubOptions = {
  /** Make the curl stub exit non-zero (simulates a download failure). */
  curlFail?: boolean;
  /** Make the `gh run download` stub exit non-zero. */
  ghFail?: boolean;
  /** Make the unzip integrity check (`-tqq`) fail. */
  unzipTestFail?: boolean;
};

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: 0o755 });
}

// Minimal PATH stubs so the download script can be exercised hermetically:
// `gh api` answers with a fixed artifact ID, `curl` writes a fake zip to the
// -o path, `unzip -tqq` passes (unless configured otherwise) and
// `unzip ... -d` creates a marker file, while `gh run download` extracts a
// marker file into <dir>/<name>. `sleep` is a no-op to keep retry backoffs
// from slowing the test down.
function createDownloadStubBin(dir: string, options: DownloadStubOptions = {}): void {
  const flags = [
    options.curlFail ? 'STUB_CURL_FAIL=1' : '',
    options.ghFail ? 'STUB_GH_FAIL=1' : '',
    options.unzipTestFail ? 'STUB_UNZIP_TEST_FAIL=1' : '',
  ]
    .filter(Boolean)
    .map((flag) => `export ${flag};`)
    .join('\n');

  writeExecutable(
    resolve(dir, 'gh'),
    `#!/usr/bin/env bash
${flags}
if [ "\${1:-}" = "api" ]; then
  echo "424242"
  exit 0
fi
if [ "\${1:-}" = "repo" ]; then
  echo "owner/repo"
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "download" ]; then
  if [ -n "\${STUB_GH_FAIL:-}" ]; then
    echo "gh: simulated download failure" >&2
    exit 1
  fi
  name=""
  outdir="."
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --dir) outdir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  mkdir -p "$outdir/$name"
  echo "from-gh" > "$outdir/$name/from-gh.txt"
  exit 0
fi
exit 1
`
  );

  writeExecutable(
    resolve(dir, 'curl'),
    `#!/usr/bin/env bash
${flags}
if [ -n "\${STUB_CURL_FAIL:-}" ]; then
  echo "curl: (22) The requested URL returned error: 403" >&2
  exit 22
fi
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H|--connect-timeout|--retry|--retry-delay|--retry-max-time) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$out" ]; then
  echo "fake-zip-bytes" > "$out"
fi
exit 0
`
  );

  writeExecutable(
    resolve(dir, 'unzip'),
    `#!/usr/bin/env bash
${flags}
if [ "\${1:-}" = "-tqq" ]; then
  if [ -n "\${STUB_UNZIP_TEST_FAIL:-}" ]; then
    echo "unzip: central directory not found" >&2
    exit 1
  fi
  exit 0
fi
dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) dest="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$dest" ]; then
  mkdir -p "$dest"
  echo "from-curl" > "$dest/from-curl.txt"
fi
exit 0
`
  );

  writeExecutable(resolve(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
}

function runDownloadScript(outDir: string, stubDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', ['scripts/download-release-artifacts.sh', '12345', outDir], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
      GH_TOKEN: 'stub-token',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_API_URL: 'https://api.example.invalid',
      ...extraEnv,
    },
  });
}

describe('release packaging configuration', () => {
  it('keeps mac zip artifacts enabled', () => {
    const config = readProjectFile('packages/desktop/electron-builder.yml');
    const macBlock = yamlBlock(config, 'mac');

    expect(macBlock).toContain('    - dmg');
    expect(macBlock).toContain('    - zip');
  });

  it('does not build Windows zip artifacts', () => {
    const config = readProjectFile('packages/desktop/electron-builder.yml');
    const winBlock = yamlBlock(config, 'win');

    expect(winBlock).toContain('    - nsis');
    expect(winBlock).not.toContain('    - zip');
  });

  it('uploads mac zip artifacts without a stale Windows zip glob', () => {
    const workflow = readProjectFile('.github/workflows/_build-reusable.yml');

    expect(workflow).toContain('out/AionUi-*-mac-*.zip');
    expect(workflow).not.toContain('out/AionUi-*-win32-*.zip');
  });

  it('retries mac prepackaged builds with both dmg and zip targets', () => {
    const script = readProjectFile('scripts/build-with-builder.js');

    expect(script).toMatch(/--mac\s+dmg\s+zip\s+--\$\{targetArch\}\s+--prepackaged/);
  });

  itWithBash('fails release asset preparation when a mac zip is missing', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'aionui-release-assets-'));
    const artifactsDir = resolve(tempDir, 'build-artifacts');
    const outputDir = resolve(tempDir, 'release-assets');

    try {
      const env = { ...process.env, MOCK_VERSION: '1.0.0' };
      const createResult = spawnSync('bash', ['scripts/create-mock-release-artifacts.sh', artifactsDir], {
        cwd: projectRoot,
        env,
        encoding: 'utf8',
      });
      expect(createResult.status).toBe(0);

      rmSync(resolve(artifactsDir, 'macos-build-arm64', 'AionUi-1.0.0-mac-arm64.zip'), { force: true });

      const prepareResult = spawnSync('bash', ['scripts/prepare-release-assets.sh', artifactsDir, outputDir], {
        cwd: projectRoot,
        env,
        encoding: 'utf8',
      });

      expect(prepareResult.status).not.toBe(0);
      expect(`${prepareResult.stdout}\n${prepareResult.stderr}`).toContain('Missing macOS zip artifact');
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  itWithBash('downloads release artifacts via redirect-following, retrying curl before the gh fallback', () => {
    const script = readProjectFile('scripts/download-release-artifacts.sh');

    // curl must follow the 302 redirect to signed blob storage and retry
    // through mid-stream connection resets — `gh run download` does neither,
    // which is what killed the v2.2.2 release across two full attempts.
    expect(script).toMatch(/curl\s+-sSL\b/);
    expect(script).toContain('--retry-all-errors');
    // gh stays available as a fallback, and its errors are no longer discarded.
    expect(script).toContain('gh run download');
    expect(script).not.toMatch(/gh run download[^\n]*2>\s*\/dev\/null/);
    // Zip integrity is verified before extraction (guards truncated bodies).
    expect(script).toContain('unzip -tqq');
  });

  itWithBash('downloads every release artifact via curl into <out>/<artifact-name>/', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'aionui-dl-curl-'));
    try {
      const stubDir = resolve(tempDir, 'stub');
      mkdirSync(stubDir, { recursive: true });
      createDownloadStubBin(stubDir);
      const outDir = resolve(tempDir, 'build-artifacts');

      const result = runDownloadScript(outDir, stubDir);

      expect(result.status).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('(curl)');
      expect(output).not.toContain('(gh fallback)');
      // Layout matches what prepare-release-assets.sh expects.
      expect(existsSync(resolve(outDir, 'macos-build-x64', 'from-curl.txt'))).toBe(true);
      expect(existsSync(resolve(outDir, 'install-web-script', 'from-curl.txt'))).toBe(true);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  itWithBash('falls back to gh run download when curl fails, surfacing the curl error', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'aionui-dl-gh-'));
    try {
      const stubDir = resolve(tempDir, 'stub');
      mkdirSync(stubDir, { recursive: true });
      createDownloadStubBin(stubDir, { curlFail: true });
      const outDir = resolve(tempDir, 'build-artifacts');

      const result = runDownloadScript(outDir, stubDir);

      expect(result.status).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('(gh fallback)');
      expect(existsSync(resolve(outDir, 'macos-build-x64', 'from-gh.txt'))).toBe(true);
      // The underlying curl error must be visible instead of going to /dev/null.
      expect(output).toContain('(22)');
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  itWithBash('rejects a failed zip integrity check and falls back to gh', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'aionui-dl-integrity-'));
    try {
      const stubDir = resolve(tempDir, 'stub');
      mkdirSync(stubDir, { recursive: true });
      createDownloadStubBin(stubDir, { unzipTestFail: true });
      const outDir = resolve(tempDir, 'build-artifacts');

      const result = runDownloadScript(outDir, stubDir);

      expect(result.status).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('zip integrity check failed');
      expect(output).toContain('(gh fallback)');
      expect(existsSync(resolve(outDir, 'macos-build-x64', 'from-gh.txt'))).toBe(true);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  itWithBash('fails with a visible error when both curl and gh fail', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'aionui-dl-both-'));
    try {
      const stubDir = resolve(tempDir, 'stub');
      mkdirSync(stubDir, { recursive: true });
      createDownloadStubBin(stubDir, { curlFail: true, ghFail: true });
      const outDir = resolve(tempDir, 'build-artifacts');

      const result = runDownloadScript(outDir, stubDir);

      expect(result.status).not.toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain("Failed to download artifact 'macos-build-arm64' after 10 attempts");
      // Real error output from both download paths is surfaced, not swallowed.
      expect(output).toContain('(22)');
      expect(output).toContain('simulated download failure');
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  itWithBash('exits with a usage error when RUN_ID is missing', () => {
    const result = spawnSync('bash', ['scripts/download-release-artifacts.sh'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('usage:');
  });

  itWithBash('exits with a clear error when no auth token is available', () => {
    const result = spawnSync('bash', ['scripts/download-release-artifacts.sh', '12345'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('GITHUB_TOKEN');
  });
});
