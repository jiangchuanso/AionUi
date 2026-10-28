/**
 * Tests for the /api/auth/admin/* API: admin gating, routing, CLI argument
 * construction and error mapping. The aioncore binary is faked at the spawn
 * seam (setAdminCliSpawn) so no real process is created — argv and stdin are
 * captured in-process, which also keeps the test OS-independent.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { handleAdminApiRequest, isAdminApiPath } from './admin-api.js';
import { setAdminCliSpawn, type SpawnFn, type SpawnedProcess } from './admin-cli.js';

/** One recorded fake-process invocation. */
type RecordedCall = { command: string; args: string[]; stdin: string };

let calls: RecordedCall[] = [];
/** Per-test: exit code / stderr the fake aioncore answers with. */
let fakeExit = { code: 0, stderr: '', stdout: '' };

const fakeSpawn: SpawnFn = (command, args) => {
  const stdinChunks: string[] = [];
  const handlers: Record<string, Array<(arg: unknown) => void>> = {};
  const record: RecordedCall = { command, args, stdin: '' };
  const child: SpawnedProcess = {
    stdout: { on: (_ev, cb) => setImmediate(() => cb(Buffer.from(fakeExit.stdout))) },
    stderr: { on: (_ev, cb) => setImmediate(() => cb(Buffer.from(fakeExit.stderr))) },
    stdin: {
      end: (chunk?: string) => {
        if (chunk) stdinChunks.push(chunk);
        record.stdin = stdinChunks.join('');
        setImmediate(() => handlers.close?.forEach((cb) => cb(fakeExit.code)));
      },
    },
    on: (ev, cb) => {
      (handlers[ev] ??= []).push(cb);
    },
    kill: () => undefined,
  };
  calls.push(record);
  return child;
};

/** Minimal IncomingMessage fake: async-iterable body, like the real stream. */
function makeReq(url: string, method: string, headers: Record<string, string>, body?: unknown): http.IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = new EventEmitter() as unknown as http.IncomingMessage;
  Object.assign(req, {
    url,
    method,
    headers,
    // Real IncomingMessage is a Readable; handlers drain unconsumed bodies.
    resume: () => req,
    destroy: () => req,
  });
  (req as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[Symbol.asyncIterator] =
    async function* () {
      for (const chunk of payload) yield chunk;
    };
  return req;
}

/** Minimal ServerResponse fake capturing status + body. */
function makeRes(): http.ServerResponse & { result: { status: number; body: string } } {
  const result = { status: 0, body: '' };
  const res = {
    result,
    headersSent: false,
    writeHead(status: number) {
      result.status = status;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      if (chunk) result.body += chunk;
      return this;
    },
    write(chunk: string) {
      result.body += chunk;
      return true;
    },
    destroy() {
      return this;
    },
  };
  return res as unknown as http.ServerResponse & { result: { status: number; body: string } };
}

function json<T>(res: { result: { body: string } }): T {
  return JSON.parse(res.result.body) as T;
}

let backend: http.Server | null = null;
let backendPort = 0;
/** Per-test: what the fake backend's /api/auth/user answers. */
let authUserResponse: { status: number; body: unknown } = {
  status: 200,
  body: { success: true, user: { id: 'system_default_user' } },
};

async function callApi(
  url: string,
  init: { method?: string; body?: unknown; cookie?: string } = {}
): Promise<{ status: number; json: <T>() => T }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.cookie) headers.cookie = init.cookie;
  const req = makeReq(url, init.method ?? 'GET', headers, init.body);
  const res = makeRes();
  const handled = await handleAdminApiRequest(req, res, {
    backendPort,
    adminCli: { binaryPath: '/fake/aioncore', dataDir: '/fake/data', logDir: '/fake/logs' },
  });
  expect(handled).toBe(true);
  return { status: res.result.status, json: <T>() => json<T>(res) };
}

const ADMIN_COOKIE = 'aionui-session=fake';

describe('isAdminApiPath', () => {
  test('matches only the admin prefix', () => {
    expect(isAdminApiPath('/api/auth/admin/users')).toBe(true);
    expect(isAdminApiPath('/api/auth/admin/users/a/password')).toBe(true);
    expect(isAdminApiPath('/api/auth/user')).toBe(false);
    expect(isAdminApiPath('/api/auth/internal/users')).toBe(false);
    expect(isAdminApiPath(undefined)).toBe(false);
  });
});

describe('admin api handler', () => {
  beforeAll(async () => {
    // Fake aioncore serving only /api/auth/user (the admin gate).
    backend = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/auth/user')) {
        res.writeHead(authUserResponse.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(authUserResponse.body));
        return;
      }
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((resolve) => backend!.listen(0, '127.0.0.1', () => resolve()));
    backendPort = (backend!.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => backend?.close(() => resolve()));
  });

  beforeEach(() => {
    calls = [];
    fakeExit = { code: 0, stderr: '', stdout: '' };
    authUserResponse = { status: 200, body: { success: true, user: { id: 'system_default_user' } } };
    setAdminCliSpawn(fakeSpawn);
  });

  test('lists users through the CLI with data + log dirs forwarded', async () => {
    const res = await callApi('/api/auth/admin/users', { cookie: ADMIN_COOKIE });
    expect(res.status).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(true);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('/fake/aioncore');
    expect(call.args).toEqual(['--data-dir', '/fake/data', '--log-dir', '/fake/logs', 'user', 'list']);
    expect(call.stdin).toBe('');
  });

  test('create passes the username to the CLI and the password on stdin', async () => {
    const res = await callApi('/api/auth/admin/users', {
      method: 'POST',
      body: { username: 'alice', password: 'Sup3rSecret!' },
      cookie: ADMIN_COOKIE,
    });
    expect(res.status).toBe(200);
    expect(res.json<{ data: { username: string } }>().data.username).toBe('alice');

    const call = calls[0]!;
    expect(call.args).toContain('create');
    expect(call.args[call.args.indexOf('--username') + 1]).toBe('alice');
    expect(call.args).toContain('--password-stdin');
    // The password travels on stdin, never on argv.
    expect(call.args.join(' ')).not.toContain('Sup3rSecret!');
    expect(call.stdin).toBe('Sup3rSecret!\n');
  });

  test('password action routes to set-password with the password on stdin', async () => {
    const res = await callApi('/api/auth/admin/users/alice/password', {
      method: 'POST',
      body: { password: 'AnotherOne1!' },
      cookie: ADMIN_COOKIE,
    });
    expect(res.status).toBe(200);

    const call = calls[0]!;
    expect(call.args).toContain('set-password');
    expect(call.args[call.args.indexOf('--username') + 1]).toBe('alice');
    expect(call.stdin).toBe('AnotherOne1!\n');
  });

  test('status action routes to disable/enable', async () => {
    const disable = await callApi('/api/auth/admin/users/alice/status', {
      method: 'POST',
      body: { status: 'disabled' },
      cookie: ADMIN_COOKIE,
    });
    expect(disable.status).toBe(200);
    expect(disable.json<{ data: { status: string } }>().data.status).toBe('disabled');
    expect(calls[0]!.args).toContain('disable');
    expect(calls[0]!.args[calls[0]!.args.indexOf('--username') + 1]).toBe('alice');

    calls = [];
    const enable = await callApi('/api/auth/admin/users/alice/status', {
      method: 'POST',
      body: { status: 'active' },
      cookie: ADMIN_COOKIE,
    });
    expect(enable.status).toBe(200);
    expect(calls[0]!.args).toContain('enable');
  });

  test('decodes URL-encoded usernames', async () => {
    const res = await callApi('/api/auth/admin/users/a%2Fb/status', {
      method: 'POST',
      body: { status: 'disabled' },
      cookie: ADMIN_COOKIE,
    });
    expect(res.status).toBe(200);
    expect(calls[0]!.args[calls[0]!.args.indexOf('--username') + 1]).toBe('a/b');
  });

  test('returns the parsed user list from the CLI stdout', async () => {
    fakeExit.stdout = [
      'ID                        TYPE     USERNAME              STATUS     CREATED_MS      LAST_LOGIN_MS',
      'system_default_user       local    admin                 active     1755000000000   -',
    ].join('\n');
    const res = await callApi('/api/auth/admin/users', { cookie: ADMIN_COOKIE });
    expect(res.status).toBe(200);
    const users = res.json<{ data: Array<{ id: string; username: string }> }>().data;
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe('system_default_user');
    expect(users[0]?.username).toBe('admin');
  });

  test('rejects non-admin sessions with 403 without spawning the CLI', async () => {
    authUserResponse = { status: 200, body: { success: true, user: { id: 'user_somebody_else' } } };
    const res = await callApi('/api/auth/admin/users', { cookie: ADMIN_COOKIE });
    expect(res.status).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('ADMIN_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  test('rejects requests without a session cookie with 403', async () => {
    const res = await callApi('/api/auth/admin/users');
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('rejects with 403 when the backend rejects the session (401)', async () => {
    authUserResponse = { status: 401, body: { success: false } };
    const res = await callApi('/api/auth/admin/users', { cookie: 'aionui-session=expired' });
    expect(res.status).toBe(403);
  });

  test('rejects with 403 when the backend is unreachable (fail closed)', async () => {
    const req = makeReq('/api/auth/admin/users', 'GET', { cookie: ADMIN_COOKIE }, undefined);
    const res = makeRes();
    // Port 1 is not listening — the gate's fetch throws and must deny.
    await handleAdminApiRequest(req, res, {
      backendPort: 1,
      adminCli: { binaryPath: '/fake/aioncore', dataDir: '/fake/data' },
    });
    expect(res.result.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('validates request bodies before spawning the CLI', async () => {
    const missingPassword = await callApi('/api/auth/admin/users', {
      method: 'POST',
      body: { username: 'alice' },
      cookie: ADMIN_COOKIE,
    });
    expect(missingPassword.status).toBe(400);

    const badStatus = await callApi('/api/auth/admin/users/alice/status', {
      method: 'POST',
      body: { status: 'bogus' },
      cookie: ADMIN_COOKIE,
    });
    expect(badStatus.status).toBe(400);

    const badMethod = await callApi('/api/auth/admin/users', { method: 'PUT', cookie: ADMIN_COOKIE });
    expect(badMethod.status).toBe(405);

    const unknown = await callApi('/api/auth/admin/unknown', { cookie: ADMIN_COOKIE });
    expect(unknown.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test('rejects usernames that look like CLI flags (no argv injection)', async () => {
    const res = await callApi('/api/auth/admin/users', {
      method: 'POST',
      body: { username: '--data-dir', password: 'whatever12' },
      cookie: ADMIN_COOKIE,
    });
    expect(res.status).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  test('maps a CLI conflict onto 409', async () => {
    fakeExit = {
      code: 2,
      stdout: '',
      stderr: 'CLI_USER_ALREADY_EXISTS subcommand=user: a local user named alice already exists',
    };
    const res = await callApi('/api/auth/admin/users', {
      method: 'POST',
      body: { username: 'alice', password: 'whatever12' },
      cookie: ADMIN_COOKIE,
    });
    expect(res.status).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('CLI_USER_ALREADY_EXISTS');
  });

  test('maps a missing user onto 404', async () => {
    fakeExit = { code: 2, stdout: '', stderr: 'CLI_USER_NOT_FOUND subcommand=user: no local user named ghost' };
    const res = await callApi('/api/auth/admin/users/ghost/password', {
      method: 'POST',
      body: { password: 'whatever12' },
      cookie: ADMIN_COOKIE,
    });
    expect(res.status).toBe(404);
  });

  test('maps an unknown CLI failure onto 500', async () => {
    fakeExit = { code: 1, stdout: '', stderr: 'CLI_USER_DATABASE_FAILED subcommand=user: database error' };
    const res = await callApi('/api/auth/admin/users', {
      method: 'POST',
      body: { username: 'alice', password: 'whatever12' },
      cookie: ADMIN_COOKIE,
    });
    expect(res.status).toBe(500);
  });

  test('answers 501 when no admin CLI is configured', async () => {
    const req = makeReq('/api/auth/admin/users', 'GET', { cookie: ADMIN_COOKIE }, undefined);
    const res = makeRes();
    await handleAdminApiRequest(req, res, { backendPort });
    expect(res.result.status).toBe(501);
    expect(json<{ code: string }>(res).code).toBe('ADMIN_CLI_UNAVAILABLE');
  });

  test('leaves non-admin paths untouched (returns false)', async () => {
    const req = makeReq('/api/auth/user', 'GET', { cookie: ADMIN_COOKIE }, undefined);
    const res = makeRes();
    const handled = await handleAdminApiRequest(req, res, { backendPort });
    expect(handled).toBe(false);
    expect(res.result.status).toBe(0);
  });
});
