import { startWebHost, startStaticServer } from '@aionui/web-host';
import type { WebHostHandle, StaticServerHandle } from '@aionui/web-host';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowserUrl, shouldAutoOpenBrowser } from './browser.js';
import { ensureAdminPassword, generateInitialPassword, setAdminPasswordViaCli } from './ensureAdminPassword.js';

// tarball layout:
//   aionui-web/
//   ├── aionui-web              ← bun-compiled standalone binary (process.execPath)
//   ├── package.json             ← for runtime version lookup
//   ├── bundled-aioncore/<plat-arch>/aioncore[.exe]
//   └── static/                  ← SPA assets
//
// Under `bun build --compile`, import.meta.url resolves to a virtual /$bunfs/
// path, NOT the real tarball location — we MUST use process.execPath to find
// sibling files. In dev (tsx/node), process.execPath is the node/bun binary,
// so fall back to import.meta.url there.
function resolveCliRoot(): string {
  // When the binary is launched through a wrapper that bundles a newer glibc
  // (see scripts/bundle-glibc.sh), /proc/self/exe — and therefore
  // process.execPath — points at the dynamic loader, NOT at aionui-web. The
  // wrapper exports AIONUI_WEB_ROOT so we can still find static/ and
  // bundled-aioncore/ next to the tarball root.
  const envRoot = process.env.AIONUI_WEB_ROOT;
  if (envRoot) {
    return path.resolve(envRoot);
  }
  // Heuristic: if the executable path ends in "aionui-web" or "aionui-web.exe",
  // treat it as the packaged single-file binary and return its directory.
  const exe = process.execPath;
  const exeName = path.basename(exe).toLowerCase();
  if (exeName === 'aionui-web' || exeName === 'aionui-web.exe') {
    return path.dirname(exe);
  }
  // Dev mode (tsx/node/bun running from source): use import.meta.url
  const __filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(__filename), '..');
}

const cliRoot = resolveCliRoot();

// `isPackaged` mirrors AppMetadata.isPackaged: true when running as the
// bun-compiled single-file binary inside a release tarball. Only the
// resetpass hint text varies by mode today.
//
// Note on macOS quarantine: we tried stripping `com.apple.quarantine` from
// cliRoot at process start, but Gatekeeper refuses exec _before_ our code
// runs, so the first launch still fails. Users must either run
// `xattr -dr com.apple.quarantine <path>` manually or use `install-web.sh`,
// which does it for them. Until we sign + notarize, there is nothing the
// binary itself can do about first-launch quarantine.
const isPackaged = (() => {
  // Set by the glibc-bundling wrapper (scripts/bundle-glibc.sh): the binary runs
  // under an explicit dynamic loader, so process.execPath is the loader, not
  // aionui-web — but it is still a packaged release tarball.
  if (process.env.AIONUI_WEB_ROOT) {
    return true;
  }
  const exeName = path.basename(process.execPath).toLowerCase();
  return exeName === 'aionui-web' || exeName === 'aionui-web.exe';
})();

const BACKEND_BINARY = process.platform === 'win32' ? 'aioncore.exe' : 'aioncore';
const DEFAULT_PORT = 25808;
const RESET_COMMAND = isPackaged ? 'aionui-web resetpass' : 'bun run resetpass';

let currentHandle: WebHostHandle | StaticServerHandle | null = null;

function parseArgs(argv: string[]): { command: string; flags: Map<string, string | true> } {
  const [command = 'start', ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    // Support both `--port 3000` and `--port=3000`. Without the `=` form
    // `--remote=0.0.0.0` was stored under the literal key "remote=0.0.0.0", so
    // `--remote` looked absent and the server silently stayed loopback-only.
    const eq = token.indexOf('=');
    if (eq > 2) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

function resolveBackendBinary(flags: Map<string, string | true>): string {
  const override = flags.get('backend-bin');
  if (typeof override === 'string') return path.resolve(override);
  const envOverride = process.env.AIONUI_BACKEND_BIN;
  if (envOverride) return path.resolve(envOverride);
  const platArch = `${process.platform}-${process.arch}`;
  const bundled = path.join(cliRoot, 'bundled-aioncore', platArch, BACKEND_BINARY);
  return bundled;
}

function resolveStaticDir(flags: Map<string, string | true>): string {
  const override = flags.get('static-dir');
  if (typeof override === 'string') return path.resolve(override);
  return path.join(cliRoot, 'static');
}

function resolveDataDir(flags: Map<string, string | true>): string {
  const override = flags.get('data-dir');
  if (typeof override === 'string') return path.resolve(override);
  const envOverride = process.env.AIONUI_DATA_DIR;
  if (envOverride) return path.resolve(envOverride);
  return path.join(os.homedir(), '.aionui-web');
}

function resolveLogDir(flags: Map<string, string | true>, dataDir: string): string {
  const override = flags.get('log-dir');
  if (typeof override === 'string') return path.resolve(override);
  const envOverride = process.env.AIONUI_LOG_DIR;
  if (envOverride) return path.resolve(envOverride);
  return path.join(dataDir, 'logs');
}

function resolvePort(flags: Map<string, string | true>): number {
  const cli = flags.get('port');
  if (typeof cli === 'string' && /^\d+$/.test(cli)) return Number(cli);
  const env = process.env.AIONUI_PORT ?? process.env.PORT;
  if (env && /^\d+$/.test(env)) return Number(env);
  return DEFAULT_PORT;
}

function resolveAllowRemote(flags: Map<string, string | true>): boolean {
  if (flags.has('remote')) return true;
  const env = process.env.AIONUI_ALLOW_REMOTE ?? process.env.AIONUI_REMOTE;
  if (!env) return false;
  return ['1', 'true', 'yes', 'on'].includes(env.trim().toLowerCase());
}

/**
 * Print the "how do I reach this from another device" lines.
 *
 * `networkUrl` is the best LAN IPv4 web-host could detect. Two cases used to be
 * confusing in production:
 *  - `--remote 0.0.0.0` printed no hint about the bind address at all, so it
 *    looked like the flag had no effect;
 *  - the detected IP could be a container bridge (e.g. docker0 `172.17.0.1`),
 *    which is unreachable from other machines.
 * Printing the bind address plus an explicit fallback keeps the banner honest.
 */
function logNetworkHint(networkUrl: string | undefined, allowRemote: boolean, port: number): void {
  if (networkUrl) {
    console.log(`  Network: ${networkUrl}`);
  } else if (allowRemote) {
    console.log(`  Network: unavailable — no LAN IPv4 detected; use http://<host-ip>:${port}`);
  }
  if (allowRemote) {
    console.log(`  Bind   : 0.0.0.0:${port} (accepting remote connections)`);
  }
}

function readPackageVersion(): string {
  try {
    const pkgPath = path.join(cliRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function runStart(flags: Map<string, string | true>): Promise<void> {
  const backendBin = resolveBackendBinary(flags);
  const staticDir = resolveStaticDir(flags);
  const dataDir = resolveDataDir(flags);
  fs.mkdirSync(dataDir, { recursive: true });
  const logDir = resolveLogDir(flags, dataDir);
  fs.mkdirSync(logDir, { recursive: true });
  const port = resolvePort(flags);
  const allowRemote = resolveAllowRemote(flags);
  const version = readPackageVersion();
  const autoOpenBrowser = shouldAutoOpenBrowser({
    allowRemote,
    env: process.env,
    openFlag: flags.has('open'),
    noOpenFlag: flags.has('no-open'),
  });

  if (!fs.existsSync(staticDir)) {
    console.error(`[aionui-web] static dir not found: ${staticDir}`);
    console.error(`  hint: pass --static-dir <path> pointing to the SPA build output`);
    process.exit(1);
  }

  console.log(`[aionui-web] version    : ${version}`);
  console.log(`[aionui-web] data dir   : ${dataDir}`);
  console.log(`[aionui-web] log dir    : ${logDir}`);
  console.log(`[aionui-web] static dir : ${staticDir}`);
  console.log(`[aionui-web] backend bin: ${backendBin}`);
  console.log(`[aionui-web] launching  : port=${port} allowRemote=${allowRemote}`);

  const backendAvailable = fs.existsSync(backendBin);

  if (!backendAvailable) {
    // Graceful degradation: serve the SPA shell without spawning backend.
    // API calls from the browser will 502/ECONNREFUSED — frontend is expected
    // to surface this to the user (e.g. "backend missing" banner).
    console.warn('');
    console.warn('⚠️  Backend binary not found — starting in FRONTEND-ONLY mode.');
    console.warn(`   Missing: ${backendBin}`);
    console.warn('   The web UI will load but API calls will fail until a backend is available.');
    console.warn('   To enable backend: download aioncore and set AIONUI_BACKEND_BIN.');
    console.warn('');

    const handle = await startStaticServer({
      staticDir,
      backendPort: 0, // invalid port → API proxy will fail cleanly
      port,
      allowRemote,
    });
    currentHandle = handle;

    console.log('');
    console.log('AionUi WebUI (frontend only) is ready');
    console.log(`  Local  : ${handle.localUrl}`);
    logNetworkHint(handle.networkUrl, allowRemote, handle.port);
    if (autoOpenBrowser) {
      const openResult = openBrowserUrl(handle.localUrl);
      if (openResult.ok) {
        console.log(`[aionui-web] opened ${handle.localUrl} in your browser.`);
      } else {
        console.warn(`[aionui-web] could not open the browser automatically: ${openResult.reason}`);
      }
    }
    console.log('');
    console.log('Press Ctrl+C to stop.');
  } else {
    const handle = await startWebHost({
      app: {
        version,
        isPackaged: true,
        resourcesPath: cliRoot,
        userDataPath: dataDir,
      },
      staticDir,
      port,
      allowRemote,
      dataDir,
      logDir,
      dirs: {
        cacheDir: dataDir,
        workDir: dataDir,
        logDir,
      },
      backend: {
        kind: 'ownBackend',
        resolveBackend: () => backendBin,
      },
    });

    currentHandle = handle;

    console.log('');
    console.log('AionUi WebUI is ready');
    console.log(`  Local  : ${handle.localUrl}`);
    logNetworkHint(handle.networkUrl, allowRemote, handle.port);

    // First-launch bootstrap: if SQLite has no admin password yet, seed one and
    // print plaintext credentials. Failure must not abort startup — the user can
    // always fall back to running resetpass manually.
    // The backend runs in webui identity mode here, so the HTTP reset endpoint
    // is local-mode-gated (403); the CLI path does the actual seeding.
    await ensureAdminPassword(
      { backendPort: handle.backendPort, resetCommand: RESET_COMMAND, cli: { binaryPath: backendBin, dataDir } },
      {
        fetch: (...args) => fetch(...args),
        log: (msg) => console.log(msg),
        warn: (msg) => console.warn(msg),
        sleep: (ms) => delay(ms),
        now: () => Date.now(),
      }
    );

    if (autoOpenBrowser) {
      const openResult = openBrowserUrl(handle.localUrl);
      if (openResult.ok) {
        console.log(`[aionui-web] opened ${handle.localUrl} in your browser.`);
      } else {
        console.warn(`[aionui-web] could not open the browser automatically: ${openResult.reason}`);
      }
    }

    console.log('');
    console.log('Press Ctrl+C to stop.');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[aionui-web] received ${signal}, stopping...`);
    try {
      if (currentHandle) await currentHandle.stop();
    } catch (err) {
      console.error('[aionui-web] stop failed:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * `aionui-web resetpass` — set a new admin password and print it.
 *
 * Uses the aioncore `user set-password` CLI directly against the data dir:
 * it works in every identity mode (the HTTP /api/webui/reset-password
 * endpoint is local-mode-gated and standalone web runs webui mode), needs no
 * server, and shares the exact validate + bcrypt logic with the running
 * backend. Same data-dir resolution as `start`, so it targets whichever DB
 * the user normally runs against.
 */
async function runResetPassword(flags: Map<string, string | true>): Promise<void> {
  const backendBin = resolveBackendBinary(flags);
  if (!fs.existsSync(backendBin)) {
    console.error(`[aionui-web] backend binary not found: ${backendBin}`);
    console.error('  hint: pass --backend-bin <path> or set AIONUI_BACKEND_BIN');
    process.exit(1);
  }
  const dataDir = resolveDataDir(flags);
  fs.mkdirSync(dataDir, { recursive: true });
  const logDir = resolveLogDir(flags, dataDir);

  console.log(`[aionui-web] resetting admin password in ${dataDir}`);

  const newPassword = generateInitialPassword();
  const ok = await setAdminPasswordViaCli({ binaryPath: backendBin, dataDir, logDir }, newPassword);
  if (!ok) {
    console.error('[aionui-web] aioncore user set-password failed (see stderr above)');
    process.exit(1);
  }
  console.log('[aionui-web] username: admin');
  console.log(`[aionui-web] new password: ${newPassword}`);
  // Upstream's set_local_password deliberately does NOT bump session_generation,
  // so already-signed-in sessions keep working until they expire. Say so rather
  // than promising a revocation we don't perform.
  console.log('[aionui-web] note: live sessions are not revoked — restart the server to force re-login.');
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === '--version' || command === 'version' || command === '-v') {
    console.log(readPackageVersion());
    return;
  }

  if (command === '--help' || command === 'help' || command === '-h') {
    console.log(`Usage: aionui-web <command> [options]

Commands:
  start              Start the WebUI (default)
  resetpass          Reset the admin password and print the new one
  version            Print version
  help               Show this help

Options for start:
  --port <n>              Listen port (default: ${DEFAULT_PORT})
  --remote                Bind 0.0.0.0 instead of 127.0.0.1
  --open                  Force opening the local URL in a browser
  --no-open               Disable automatic browser opening
  --data-dir <path>       Override data dir (default: ~/.aionui-web)
  --log-dir <path>        Override log dir (default: <data-dir>/logs)
  --static-dir <path>     Override static assets dir
  --backend-bin <path>    Override backend binary path

Options for resetpass:
  --data-dir <path>       Which data dir to reset (default: ~/.aionui-web)
  --backend-bin <path>    Override backend binary path

Environment variables:
  AIONUI_PORT, AIONUI_ALLOW_REMOTE, AIONUI_DATA_DIR, AIONUI_LOG_DIR,
  AIONUI_BACKEND_BIN, AIONUI_OPEN_BROWSER
`);
    return;
  }

  if (command === 'resetpass') {
    await runResetPassword(flags);
    return;
  }

  if (command !== 'start') {
    console.error(`Unknown command: ${command}`);
    console.error('Usage: aionui-web [start|resetpass|version|help]');
    process.exit(1);
  }

  await runStart(flags);
}

main().catch((err: Error) => {
  console.error('[aionui-web] fatal:', err.message);
  if (currentHandle) void currentHandle.stop().catch(() => undefined);
  process.exit(1);
});
