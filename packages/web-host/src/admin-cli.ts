/**
 * Offline local-account management via the bundled aioncore CLI.
 *
 * Why the CLI and not HTTP: aioncore gates its user-management endpoints
 * (`/api/auth/internal/users*`, `/api/webui/*`) behind `ensure_local_mode`,
 * so in webui identity mode — the mode every web/docker deployment runs in
 * for per-user data isolation — they answer 403. The `aioncore user ...`
 * subcommands are the upstream-supported control path for exactly this
 * situation ("bootstrap path for self-hosted WebUi deployments", see
 * AionCore crates/aionui-app/src/commands/cmd_user.rs): short-lived, they
 * open the data-dir SQLite directly (WAL, so a running server coexists) and
 * never start the HTTP server.
 *
 * This module is the single seam between web-host and that CLI: spawn,
 * parse, map errors. It holds no HTTP concerns — see admin-api.ts.
 */

import { spawn } from 'node:child_process';
import type { AdminCliConfig } from './types.js';

/** The always-seeded admin row (aionui-db ensure_system_user). */
export const SYSTEM_ADMIN_USER_ID = 'system_default_user';

/** Matches `CLI_USER_ALREADY_EXISTS subcommand=user: ...` boundary lines. */
const CLI_ERROR_CODE_PATTERN = /^([A-Z][A-Z0-9_]+)\s/;

const CLI_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export type AdminUser = {
  id: string;
  username: string;
  user_type: string;
  status: 'active' | 'disabled';
  created_at: number;
  last_login: number | null;
};

export type CliRunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
};

/** The narrow slice of ChildProcess the CLI runner depends on. */
export type SpawnedProcess = {
  stdout: { on: (event: 'data', cb: (chunk: Buffer) => void) => void } | null;
  stderr: { on: (event: 'data', cb: (chunk: Buffer) => void) => void } | null;
  stdin: { end: (chunk?: string) => void } | null;
  on: (event: 'error' | 'close', cb: (arg: unknown) => void) => void;
  kill: (signal: string) => void;
};

export type SpawnFn = (command: string, args: string[], options: { stdio: unknown[] }) => SpawnedProcess;

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args, options as Parameters<typeof spawn>[2]) as unknown as SpawnedProcess;

/**
 * The spawn seam — the only place this module touches the OS. Tests override
 * it to drive the CLI logic without a real aioncore binary (and without the
 * shell-shim quirks Windows adds when spawning script files).
 */
let spawnProcess: SpawnFn = defaultSpawn;

/** Override the process spawner. Pass null to restore the default. */
export function setAdminCliSpawn(fn: SpawnFn | null): void {
  spawnProcess = fn ?? defaultSpawn;
}

export class AdminCliError extends Error {
  readonly httpStatus: number;
  readonly code: string;

  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.name = 'AdminCliError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/**
 * Run `aioncore --data-dir <dir> user <args...>` with optional stdin.
 * Resolves with the raw outcome; never throws for a non-zero exit (callers
 * map failures via {@link cliFailureToAdminError}).
 */
export function runAioncoreUserCli(config: AdminCliConfig, args: string[], stdin?: string): Promise<CliRunResult> {
  return new Promise<CliRunResult>((resolve) => {
    let settled = false;
    const finish = (result: CliRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawnProcess(
      config.binaryPath,
      ['--data-dir', config.dataDir, ...(config.logDir ? ['--log-dir', config.logDir] : []), 'user', ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, code: null, stdout: '', stderr: 'aioncore user CLI timed out' });
    }, CLI_TIMEOUT_MS);
    timer.unref?.();

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });

    if (stdin !== undefined) {
      child.stdin?.end(stdin.endsWith('\n') ? stdin : `${stdin}\n`);
    } else {
      child.stdin?.end();
    }

    child.on('error', (error: Error) => {
      finish({ ok: false, code: null, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code: unknown) => {
      const exitCode = typeof code === 'number' ? code : null;
      finish({ ok: exitCode === 0, code: exitCode, stdout, stderr });
    });
  });
}

function appendCapped(current: string, chunk: Buffer): string {
  return (current + chunk.toString()).slice(-MAX_OUTPUT_BYTES);
}

/**
 * Parse `aioncore user list` output.
 *
 * Format (AionCore cmd_user.rs format_user_lines): a header line plus one
 * fixed-width row per user — `{:<24}  {:<8}  {:<20}  {:<9}  {:<14}  {}` for
 * ID / TYPE / USERNAME / STATUS / CREATED_MS / LAST_LOGIN_MS. Splitting on
 * runs of 2+ spaces stays correct even when a value overflows its column
 * width, because the literal two-space separator is always present.
 * Returns [] for empty / header-only / unparseable output.
 */
export function parseUserListOutput(stdout: string): AdminUser[] {
  const users: AdminUser[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/ {2,}/).filter((field) => field.length > 0);
    if (fields.length < 6) continue;
    const [id, userType, username, status, createdAt, lastLogin] = fields;
    // Skip the header row (and anything that is not a data row).
    if (id === 'ID' || !/^\d+$/.test(createdAt)) continue;
    users.push({
      id,
      username: username === '-' ? '' : username,
      user_type: userType,
      status: status === 'disabled' ? 'disabled' : 'active',
      created_at: Number(createdAt),
      last_login: lastLogin && lastLogin !== '-' && /^\d+$/.test(lastLogin) ? Number(lastLogin) : null,
    });
  }
  return users;
}

/**
 * Map a failed CLI run onto an HTTP-shaped error. The CLI renders boundary
 * failures as a single stable stderr line led by the code token
 * (`CLI_USER_ALREADY_EXISTS subcommand=user: ...`), which is what we match.
 */
export function cliFailureToAdminError(result: CliRunResult): AdminCliError {
  const firstLine = result.stderr.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const match = CLI_ERROR_CODE_PATTERN.exec(firstLine.trim());
  const code = match?.[1] ?? 'CLI_USER_FAILED';
  const message = firstLine.trim() || 'aioncore user command failed';

  switch (code) {
    case 'CLI_USER_INPUT_INVALID':
      return new AdminCliError(400, code, message);
    case 'CLI_USER_ALREADY_EXISTS':
      return new AdminCliError(409, code, message);
    case 'CLI_USER_NOT_FOUND':
      return new AdminCliError(404, code, message);
    default:
      return new AdminCliError(500, code, message);
  }
}
