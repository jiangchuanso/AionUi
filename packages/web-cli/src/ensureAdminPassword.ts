/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * On first tarball launch, the aioncore's SQLite `users` table holds the
 * seeded `system_default_user` row with an empty password_hash. We probe
 * /api/auth/status; if `needs_setup === true`, generate and persist a random
 * password and print it to stdout so the user can log in.
 *
 * Two provisioning paths, tried in order:
 *
 *  1. HTTP — POST /api/webui/reset-password. Only available while the backend
 *     runs in LOCAL identity mode (`--local`), where the endpoint is not
 *     `ensure_local_mode`-gated. The desktop app's embedded backend is local.
 *  2. CLI — spawn the bundled `aioncore user set-password --password-stdin`
 *     against the same data dir. Works in every identity mode (it opens the
 *     SQLite file directly, never the HTTP server), so this is what standalone
 *     web / docker deployments — which run webui identity mode for per-user
 *     data isolation — rely on.
 *
 * Mirrors Electron's maybeSeedInitialPassword in
 * packages/desktop/src/process/bridge/webuiBridge.ts:52-77 and the Bun dev
 * helper in scripts/webui.ts — when either changes, keep this in sync.
 *
 * The printed format is load-bearing: scripts/smoke-test-web-cli.sh greps for
 * "Generated initial admin password: <pw>". Do not change it without updating
 * that script.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export type EnsureAdminPasswordDeps = {
  fetch: typeof fetch;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type EnsureAdminPasswordOptions = {
  /** 127.0.0.1 port where aioncore listens (from WebHostHandle.backendPort). */
  backendPort: number;
  /** Total wait budget for /api/auth/status coming up. Default: 15s. */
  statusTimeoutMs?: number;
  /** Poll interval between /api/auth/status attempts. Default: 500ms. */
  statusPollIntervalMs?: number;
  /**
   * Command to show in fallback hints ("Forgot the password? Run ..."). Varies
   * by launch context — packaged tarball = `aionui-web resetpass`, in-repo dev
   * = `bun run resetpass`. Defaults to the packaged form.
   */
  resetCommand?: string;
  /**
   * Bundled aioncore binary + data dir for the CLI provisioning path. Required
   * for webui-identity deployments (standalone web / docker), where the HTTP
   * reset endpoint is disabled. Omit and only the HTTP path is attempted.
   */
  cli?: { binaryPath: string; dataDir: string; logDir?: string };
  /** Injectable for tests; defaults to `randomBytes`-based generation. */
  generatePassword?: () => string;
};

type AuthStatus = {
  needs_setup?: boolean;
  data?: { needs_setup?: boolean };
};

type ResetPasswordResponse = {
  data?: { new_password?: string };
  new_password?: string;
};

type SystemUserResponse = {
  data?: { username?: string } | null;
};

async function waitForStatus(
  deps: EnsureAdminPasswordDeps,
  url: string,
  budgetMs: number,
  intervalMs: number
): Promise<AuthStatus> {
  const deadline = deps.now() + budgetMs;
  let lastErr: unknown = undefined;
  while (deps.now() < deadline) {
    try {
      const res = await deps.fetch(url);
      if (res.ok) {
        return (await res.json()) as AuthStatus;
      }
      lastErr = new Error(`/api/auth/status returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await deps.sleep(intervalMs);
  }
  throw lastErr instanceof Error ? lastErr : new Error('/api/auth/status did not come up in time');
}

async function fetchAdminUsername(deps: EnsureAdminPasswordDeps, backendPort: number): Promise<string> {
  try {
    const res = await deps.fetch(`http://127.0.0.1:${backendPort}/api/auth/internal/users/system`);
    if (!res.ok) return 'admin';
    const json = (await res.json()) as SystemUserResponse;
    return json.data?.username || 'admin';
  } catch {
    return 'admin';
  }
}

/** URL-safe random password satisfying the backend's validate_password rules. */
export function generateInitialPassword(): string {
  // 18 bytes -> 24 base64url chars; drop ambiguous look-alikes for terminal copy.
  return randomBytes(18)
    .toString('base64url')
    .replace(/[O0Il]/g, 'x')
    .slice(0, 24);
}

/**
 * `aioncore --data-dir <dir> user set-password --password-stdin` — the
 * upstream bootstrap path for self-hosted deployments. Reads the password
 * from stdin (never argv), applies the same validate + bcrypt hashing as the
 * HTTP path, and does not revoke live sessions (there are none at seed time).
 * Resolves false when the CLI fails (message is logged by the caller).
 */
export function setAdminPasswordViaCli(
  cli: NonNullable<EnsureAdminPasswordOptions['cli']>,
  password: string
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      cli.binaryPath,
      [
        '--data-dir',
        cli.dataDir,
        ...(cli.logDir ? ['--log-dir', cli.logDir] : []),
        'user',
        'set-password',
        '--password-stdin',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2048);
    });
    child.on('error', (error: Error) => {
      console.warn(`[aionui-web] aioncore user set-password failed to spawn: ${error.message}`);
      resolve(false);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      console.warn(`[aionui-web] aioncore user set-password exited ${code}: ${stderr.trim()}`);
      resolve(false);
    });
    child.stdin?.end(`${password}\n`);
  });
}

/**
 * Probe backend auth state. On fresh install, provision an admin password and
 * print the credentials. Never throws — any failure is warned and the caller
 * continues starting the server (user can still see the login page, they just
 * need to run resetpass manually).
 */
export async function ensureAdminPassword(
  opts: EnsureAdminPasswordOptions,
  deps: EnsureAdminPasswordDeps
): Promise<void> {
  const timeoutMs = opts.statusTimeoutMs ?? 15_000;
  const intervalMs = opts.statusPollIntervalMs ?? 500;
  const resetCmd = opts.resetCommand ?? 'aionui-web resetpass';
  const base = `http://127.0.0.1:${opts.backendPort}`;

  let status: AuthStatus;
  try {
    status = await waitForStatus(deps, `${base}/api/auth/status`, timeoutMs, intervalMs);
  } catch (err) {
    deps.warn(`[aionui-web] could not verify admin credentials: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const needsSetup = status.needs_setup ?? status.data?.needs_setup ?? false;

  if (!needsSetup) {
    const username = await fetchAdminUsername(deps, opts.backendPort);
    deps.log(`[aionui-web] Log in with username "${username}". Forgot the password? Run \`${resetCmd}\`.`);
    return;
  }

  const newPassword = (opts.generatePassword ?? generateInitialPassword)();

  // Path 1: HTTP reset endpoint (local identity mode only).
  try {
    const resetRes = await deps.fetch(`${base}/api/webui/reset-password`, { method: 'POST' });
    if (resetRes.ok) {
      const payload = (await resetRes.json()) as ResetPasswordResponse;
      const password = payload.data?.new_password ?? payload.new_password;
      if (password) {
        const username = await fetchAdminUsername(deps, opts.backendPort);
        deps.log(`[aionui-web] Generated initial admin password: ${password}`);
        deps.log(`[aionui-web] Log in with username "${username}" and change it from the UI.`);
        return;
      }
      deps.warn(`[aionui-web] /api/webui/reset-password returned no new_password — run \`${resetCmd}\``);
      return;
    }
    // 403 Forbidden = webui identity mode, where the endpoint is local-gated.
    // Fall through to the CLI path below.
    if (resetRes.status !== 403) {
      deps.warn(`[aionui-web] /api/webui/reset-password returned ${resetRes.status} — run \`${resetCmd}\``);
      return;
    }
  } catch (err) {
    deps.warn(
      `[aionui-web] /api/webui/reset-password request failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // Path 2: CLI against the same data dir (works in every identity mode).
  if (!opts.cli) {
    deps.warn(`[aionui-web] backend runs without local-mode endpoints; run \`${resetCmd}\``);
    return;
  }
  const seeded = await setAdminPasswordViaCli(opts.cli, newPassword);
  if (!seeded) {
    deps.warn(`[aionui-web] could not seed initial admin password via CLI — run \`${resetCmd}\``);
    return;
  }
  const username = await fetchAdminUsername(deps, opts.backendPort);
  deps.log(`[aionui-web] Generated initial admin password: ${newPassword}`);
  deps.log(`[aionui-web] Log in with username "${username}" and change it from the UI.`);
}
