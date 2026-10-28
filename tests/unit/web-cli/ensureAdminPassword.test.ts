/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ensureAdminPassword,
  generateInitialPassword,
  type EnsureAdminPasswordDeps,
} from '../../../packages/web-cli/src/ensureAdminPassword.js';

type FetchCall = { url: string; init?: RequestInit };

const spawnState = vi.hoisted(() => ({
  exitCode: 0 as number | null,
  stderrText: '',
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:child_process');
  return {
    ...actual,
    spawn: (binaryPath: string, args: string[]) => {
      spawnState.calls.push({ binaryPath, args });
      const stdinChunks: string[] = [];
      const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
      const child = {
        stdin: { end: (chunk: string) => stdinChunks.push(chunk) },
        stderr: { on: (_ev: string, cb: (c: Buffer) => void) => cb(Buffer.from(spawnState.stderrText)) },
        on: (ev: string, cb: (...a: unknown[]) => void) => {
          (handlers[ev] ??= []).push(cb);
          return child;
        },
        kill: () => undefined,
      };
      spawnState.children.push({ child, stdinChunks });
      // Resolve on the next microtask so listeners registered after spawn attach first.
      queueMicrotask(() => {
        if (spawnState.exitCode === null) handlers.error?.forEach((cb) => cb(new Error('spawn failed')));
        else handlers.close?.forEach((cb) => cb(spawnState.exitCode));
      });
      return child;
    },
  };
});

/** Reset the hoisted spawn mock and return a view over what it captured. */
function vihoistedSpawn(): {
  calls: Array<{ binaryPath: string; args: string[] }>;
  exitCode: number | null;
  stderrText: string;
  stdin: string;
} {
  spawnState.calls = [];
  spawnState.children = [];
  spawnState.exitCode = 0;
  spawnState.stderrText = '';
  return {
    get calls() {
      return spawnState.calls;
    },
    get exitCode() {
      return spawnState.exitCode;
    },
    set exitCode(v: number | null) {
      spawnState.exitCode = v;
    },
    get stderrText() {
      return spawnState.stderrText;
    },
    set stderrText(v: string) {
      spawnState.stderrText = v;
    },
    get stdin() {
      return spawnState.children.map((c) => c.stdinChunks.join('')).join('');
    },
  };
}

function mockResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeDeps(opts: { handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>> }): {
  deps: EnsureAdminPasswordDeps;
  calls: FetchCall[];
  logs: string[];
  warns: string[];
  sleeps: number[];
} {
  const calls: FetchCall[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const sleeps: number[] = [];
  let nowVal = 0;
  let idx = 0;
  const deps: EnsureAdminPasswordDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      const handler = opts.handlers[idx] ?? opts.handlers[opts.handlers.length - 1];
      idx++;
      return handler(url, init);
    }) as typeof fetch,
    log: (msg) => logs.push(msg),
    warn: (msg) => warns.push(msg),
    sleep: async (ms) => {
      sleeps.push(ms);
      nowVal += ms;
    },
    now: () => nowVal,
  };
  return { deps, calls, logs, warns, sleeps };
}

describe('ensureAdminPassword', () => {
  it('seeds password on fresh install (needs_setup=true)', async () => {
    const { deps, calls, logs, warns } = makeDeps({
      handlers: [
        // /api/auth/status
        () => mockResponse(200, { needs_setup: true }),
        // POST /api/webui/reset-password
        () => mockResponse(200, { data: { new_password: 'SuperSecret123' } }),
        // /api/auth/internal/users/system
        () => mockResponse(200, { data: { username: 'admin' } }),
      ],
    });

    await ensureAdminPassword({ backendPort: 25808 }, deps);

    expect(calls[0].url).toBe('http://127.0.0.1:25808/api/auth/status');
    expect(calls[1].url).toBe('http://127.0.0.1:25808/api/webui/reset-password');
    expect(calls[1].init?.method).toBe('POST');
    expect(logs).toContain('[aionui-web] Generated initial admin password: SuperSecret123');
    expect(logs.some((m) => m.includes('Log in with username "admin"'))).toBe(true);
    expect(warns).toEqual([]);
  });

  it('accepts top-level new_password in reset-password response', async () => {
    const { deps, logs } = makeDeps({
      handlers: [
        () => mockResponse(200, { needs_setup: true }),
        () => mockResponse(200, { new_password: 'FromTopLevel' }),
        () => mockResponse(200, { data: { username: 'admin' } }),
      ],
    });

    await ensureAdminPassword({ backendPort: 25808 }, deps);

    expect(logs).toContain('[aionui-web] Generated initial admin password: FromTopLevel');
  });

  it('reads needs_setup from nested data field', async () => {
    const { deps, calls, logs } = makeDeps({
      handlers: [
        () => mockResponse(200, { data: { needs_setup: true } }),
        () => mockResponse(200, { data: { new_password: 'Nested' } }),
        () => mockResponse(200, { data: { username: 'custom-admin' } }),
      ],
    });

    await ensureAdminPassword({ backendPort: 25808 }, deps);

    expect(calls).toHaveLength(3);
    expect(logs.some((m) => m.includes('custom-admin'))).toBe(true);
  });

  it('no-op when admin already provisioned (needs_setup=false)', async () => {
    const { deps, calls, logs, warns } = makeDeps({
      handlers: [
        () => mockResponse(200, { needs_setup: false }),
        () => mockResponse(200, { data: { username: 'admin' } }),
      ],
    });

    await ensureAdminPassword({ backendPort: 25808 }, deps);

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('http://127.0.0.1:25808/api/auth/internal/users/system');
    expect(logs.some((m) => m.includes('resetpass'))).toBe(true);
    expect(logs.every((m) => !m.includes('Generated initial admin password'))).toBe(true);
    expect(warns).toEqual([]);
  });

  it('polls /api/auth/status until backend is ready', async () => {
    let statusAttempts = 0;
    const { deps, sleeps, logs } = makeDeps({
      handlers: [
        // First three fetches are all /api/auth/status: 2 failures then success.
        () => {
          statusAttempts++;
          throw new Error('connect ECONNREFUSED');
        },
        () => {
          statusAttempts++;
          throw new Error('connect ECONNREFUSED');
        },
        () => {
          statusAttempts++;
          return mockResponse(200, { needs_setup: true });
        },
        () => mockResponse(200, { data: { new_password: 'Pw' } }),
        () => mockResponse(200, { data: { username: 'admin' } }),
      ],
    });

    await ensureAdminPassword({ backendPort: 25808, statusTimeoutMs: 10_000, statusPollIntervalMs: 100 }, deps);

    expect(statusAttempts).toBe(3);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(logs.some((m) => m.includes('Generated initial admin password'))).toBe(true);
  });

  it('warns (not throws) when status never comes up within budget', async () => {
    const { deps, warns, logs } = makeDeps({
      handlers: [() => mockResponse(500, 'oops')],
    });

    await ensureAdminPassword({ backendPort: 25808, statusTimeoutMs: 1_000, statusPollIntervalMs: 250 }, deps);

    expect(warns.some((w) => w.includes('could not verify admin credentials'))).toBe(true);
    expect(logs).toEqual([]);
  });

  it('warns (not throws) when reset-password fails', async () => {
    const { deps, warns, logs } = makeDeps({
      handlers: [() => mockResponse(200, { needs_setup: true }), () => mockResponse(500, 'boom')],
    });

    await ensureAdminPassword({ backendPort: 25808 }, deps);

    expect(warns.some((w) => w.includes('/api/webui/reset-password returned 500'))).toBe(true);
    expect(logs).toEqual([]);
  });

  it('warns (not throws) when reset-password returns no password', async () => {
    const { deps, warns, logs } = makeDeps({
      handlers: [() => mockResponse(200, { needs_setup: true }), () => mockResponse(200, { data: {} })],
    });

    await ensureAdminPassword({ backendPort: 25808 }, deps);

    expect(warns.some((w) => w.includes('returned no new_password'))).toBe(true);
    expect(logs).toEqual([]);
  });

  it('falls back to "admin" username when system user lookup fails', async () => {
    const { deps, logs } = makeDeps({
      handlers: [
        () => mockResponse(200, { needs_setup: true }),
        () => mockResponse(200, { data: { new_password: 'Pw' } }),
        () => mockResponse(500, 'broken'),
      ],
    });

    await ensureAdminPassword({ backendPort: 25808 }, deps);

    expect(logs.some((m) => m.includes('Log in with username "admin"'))).toBe(true);
  });

  it('uses caller-supplied resetCommand in the "Forgot the password" hint', async () => {
    const { deps, logs } = makeDeps({
      handlers: [
        () => mockResponse(200, { needs_setup: false }),
        () => mockResponse(200, { data: { username: 'admin' } }),
      ],
    });

    await ensureAdminPassword({ backendPort: 25808, resetCommand: 'bun run resetpass' }, deps);

    expect(logs.some((m) => m.includes('bun run resetpass'))).toBe(true);
    expect(logs.every((m) => !m.includes('aionui-web resetpass'))).toBe(true);
  });

  it('defaults to `aionui-web resetpass` when resetCommand is not provided', async () => {
    const { deps, logs } = makeDeps({
      handlers: [
        () => mockResponse(200, { needs_setup: false }),
        () => mockResponse(200, { data: { username: 'admin' } }),
      ],
    });

    await ensureAdminPassword({ backendPort: 25808 }, deps);

    expect(logs.some((m) => m.includes('aionui-web resetpass'))).toBe(true);
  });

  it('propagates resetCommand into warn messages when reset-password fails', async () => {
    const { deps, warns } = makeDeps({
      handlers: [() => mockResponse(200, { needs_setup: true }), () => mockResponse(500, 'boom')],
    });

    await ensureAdminPassword({ backendPort: 25808, resetCommand: 'bun run resetpass' }, deps);

    expect(warns.some((w) => w.includes('bun run resetpass'))).toBe(true);
  });

  describe('webui identity mode (HTTP reset endpoint disabled)', () => {
    const cli = { binaryPath: '/bin/aioncore', dataDir: '/data' };

    it('falls back to the CLI after reset-password answers 403 and prints the seeded password', async () => {
      const spawnMock = vihoistedSpawn();
      const { deps, logs, warns } = makeDeps({
        handlers: [
          // /api/auth/status
          () => mockResponse(200, { needs_setup: true }),
          // POST /api/webui/reset-password — 403 in webui identity mode
          () => mockResponse(403, { error: 'This endpoint is only available in local mode' }),
          // /api/auth/internal/users/system
          () => mockResponse(200, { data: { username: 'admin' } }),
        ],
      });

      await ensureAdminPassword({ backendPort: 25808, cli, generatePassword: () => 'Cli-Seeded-Pw-1' }, deps);

      expect(spawnMock.calls).toHaveLength(1);
      expect(spawnMock.calls[0].binaryPath).toBe('/bin/aioncore');
      expect(spawnMock.calls[0].args).toEqual(['--data-dir', '/data', 'user', 'set-password', '--password-stdin']);
      expect(spawnMock.stdin).toContain('Cli-Seeded-Pw-1');
      expect(logs).toContain('[aionui-web] Generated initial admin password: Cli-Seeded-Pw-1');
      expect(logs.some((m) => m.includes('Log in with username "admin"'))).toBe(true);
      expect(warns).toEqual([]);
    });

    it('forwards logDir to the CLI when provided', async () => {
      const spawnMock = vihoistedSpawn();
      const { deps } = makeDeps({
        handlers: [
          () => mockResponse(200, { needs_setup: true }),
          () => mockResponse(403, ''),
          () => mockResponse(200, { data: { username: 'admin' } }),
        ],
      });

      await ensureAdminPassword(
        { backendPort: 25808, cli: { ...cli, logDir: '/logs' }, generatePassword: () => 'x' },
        deps
      );

      expect(spawnMock.calls[0].args).toContain('--log-dir');
      expect(spawnMock.calls[0].args).toContain('/logs');
    });

    it('warns without throwing when the CLI fails, so startup continues', async () => {
      const spawnMock = vihoistedSpawn();
      spawnMock.exitCode = 1;
      spawnMock.stderrText = 'CLI_USER_DATABASE_FAILED subcommand=user: database error';
      const { deps, logs, warns } = makeDeps({
        handlers: [() => mockResponse(200, { needs_setup: true }), () => mockResponse(403, '')],
      });

      await ensureAdminPassword({ backendPort: 25808, cli, generatePassword: () => 'x' }, deps);

      expect(logs.every((m) => !m.includes('Generated initial admin password'))).toBe(true);
      expect(warns.some((w) => w.includes('could not seed initial admin password via CLI'))).toBe(true);
    });

    it('warns when the CLI path is unavailable (no cli config supplied)', async () => {
      const { deps, warns } = makeDeps({
        handlers: [() => mockResponse(200, { needs_setup: true }), () => mockResponse(403, '')],
      });

      await ensureAdminPassword({ backendPort: 25808, generatePassword: () => 'x' }, deps);

      expect(warns.some((w) => w.includes('runs without local-mode endpoints'))).toBe(true);
    });

    it('does not run the CLI when reset-password fails for a non-403 reason', async () => {
      const spawnMock = vihoistedSpawn();
      const { deps, warns } = makeDeps({
        handlers: [() => mockResponse(200, { needs_setup: true }), () => mockResponse(500, 'boom')],
      });

      await ensureAdminPassword({ backendPort: 25808, cli, generatePassword: () => 'x' }, deps);

      expect(spawnMock.calls).toHaveLength(0);
      expect(warns.some((w) => w.includes('returned 500'))).toBe(true);
    });
  });

  describe('generateInitialPassword', () => {
    it('produces a password that satisfies the backend policy', () => {
      for (let i = 0; i < 20; i++) {
        const pw = generateInitialPassword();
        expect(pw.length).toBeGreaterThanOrEqual(8);
        expect(pw.length).toBeLessThanOrEqual(128);
        expect(/^[a-zA-Z0-9_-]+$/.test(pw)).toBe(true);
      }
    });

    it('does not repeat across calls', () => {
      const seen = new Set(Array.from({ length: 50 }, () => generateInitialPassword()));
      expect(seen.size).toBe(50);
    });
  });
});
