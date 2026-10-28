/**
 * Tests for the aioncore-CLI admin seam: output parsing and error mapping.
 * Spawning itself is exercised through web-host's admin-api integration
 * tests; here we keep the pure transforms, which is where the format
 * assumptions live.
 */

import { describe, it, expect } from 'vitest';
import { cliFailureToAdminError, parseUserListOutput, AdminCliError } from './admin-cli.js';

/**
 * Fixture built with the exact Rust format string from AionCore
 * cmd_user.rs `format_user_lines`: `{:<24}  {:<8}  {:<20}  {:<9}  {:<14}  {}`.
 * Constructed the same way here so the test fails loudly if the real format
 * ever drifts from this padding assumption.
 */
const REAL_LIST_OUTPUT = (() => {
  const pad = (value: string, width: number) => value.padEnd(width, ' ');
  const header = [
    pad('ID', 24),
    pad('TYPE', 8),
    pad('USERNAME', 20),
    pad('STATUS', 9),
    pad('CREATED_MS', 14),
    'LAST_LOGIN_MS',
  ].join('  ');
  const rows: Array<[string, string, string, string, number, number | null]> = [
    ['system_default_user', 'local', 'admin', 'active', 1755000000000, null],
    ['user_abc123', 'local', 'alice', 'disabled', 1755000001000, 1755000002000],
  ];
  return [
    header,
    ...rows.map(([id, type, username, status, createdAt, lastLogin]) =>
      [
        pad(id, 24),
        pad(type, 8),
        pad(username, 20),
        pad(status, 9),
        pad(String(createdAt), 14),
        lastLogin === null ? '-' : String(lastLogin),
      ].join('  ')
    ),
  ].join('\n');
})();

describe('parseUserListOutput', () => {
  it('parses the real aioncore user list format', () => {
    const users = parseUserListOutput(REAL_LIST_OUTPUT);

    expect(users).toHaveLength(2);
    expect(users[0]).toEqual({
      id: 'system_default_user',
      username: 'admin',
      user_type: 'local',
      status: 'active',
      created_at: 1755000000000,
      last_login: null,
    });
    expect(users[1]).toEqual({
      id: 'user_abc123',
      username: 'alice',
      user_type: 'local',
      status: 'disabled',
      created_at: 1755000001000,
      last_login: 1755000002000,
    });
  });

  it('skips the header row', () => {
    expect(parseUserListOutput(REAL_LIST_OUTPUT).some((u) => u.id === 'ID')).toBe(false);
  });

  it('returns [] for header-only / empty output', () => {
    expect(parseUserListOutput('')).toEqual([]);
    expect(parseUserListOutput('   \n\n')).toEqual([]);
    expect(
      parseUserListOutput(
        'ID                        TYPE     USERNAME              STATUS   CREATED_MS      LAST_LOGIN_MS'
      )
    ).toEqual([]);
  });

  it('handles CRLF line endings (Windows)', () => {
    const users = parseUserListOutput(REAL_LIST_OUTPUT.replace(/\n/g, '\r\n'));
    expect(users).toHaveLength(2);
  });

  it('tolerates values that overflow their column width', () => {
    // A username longer than the {:<20} field pushes later columns right, but
    // the two-space separators survive — splitting must still work.
    const pad = (value: string, width: number) => value.padEnd(width, ' ');
    const longName = 'a'.repeat(30);
    const stdout = [
      [
        pad('ID', 24),
        pad('TYPE', 8),
        pad('USERNAME', 20),
        pad('STATUS', 9),
        pad('CREATED_MS', 14),
        'LAST_LOGIN_MS',
      ].join('  '),
      [
        pad('system_default_user', 24),
        pad('local', 8),
        pad('admin', 20),
        pad('active', 9),
        pad('1755000000000', 14),
        '-',
      ].join('  '),
      // No padding at all on the overflowing username — raw two-space joins only.
      ['user_longname123', 'local', longName, 'active', '1755000003000', '1755000004000'].join('  '),
    ].join('\n');

    const users = parseUserListOutput(stdout);
    expect(users).toHaveLength(2);
    expect(users[1]?.username).toBe(longName);
    expect(users[1]?.created_at).toBe(1755000003000);
    expect(users[1]?.last_login).toBe(1755000004000);
  });

  it('maps "-" placeholders to empty username / null last_login', () => {
    const pad = (value: string, width: number) => value.padEnd(width, ' ');
    const stdout = [
      [
        pad('ID', 24),
        pad('TYPE', 8),
        pad('USERNAME', 20),
        pad('STATUS', 9),
        pad('CREATED_MS', 14),
        'LAST_LOGIN_MS',
      ].join('  '),
      [pad('user_external', 24), pad('aionpro', 8), pad('-', 20), pad('active', 9), pad('1755000005000', 14), '-'].join(
        '  '
      ),
    ].join('\n');
    const [user] = parseUserListOutput(stdout);
    expect(user?.username).toBe('');
    expect(user?.last_login).toBeNull();
  });

  it('ignores malformed rows instead of throwing', () => {
    const stdout = `${REAL_LIST_OUTPUT}\ngarbage row\nanother  bad one`;
    expect(parseUserListOutput(stdout)).toHaveLength(2);
  });
});

describe('cliFailureToAdminError', () => {
  it('maps CLI_USER_ALREADY_EXISTS to 409', () => {
    const error = cliFailureToAdminError({
      ok: false,
      code: 2,
      stdout: '',
      stderr: 'CLI_USER_ALREADY_EXISTS subcommand=user: a local user named alice already exists',
    });
    expect(error).toBeInstanceOf(AdminCliError);
    expect(error.httpStatus).toBe(409);
    expect(error.code).toBe('CLI_USER_ALREADY_EXISTS');
    expect(error.message).toContain('alice');
  });

  it('maps CLI_USER_NOT_FOUND to 404', () => {
    const error = cliFailureToAdminError({
      ok: false,
      code: 2,
      stdout: '',
      stderr: 'CLI_USER_NOT_FOUND subcommand=user: no local user named ghost',
    });
    expect(error.httpStatus).toBe(404);
  });

  it('maps CLI_USER_INPUT_INVALID to 400', () => {
    const error = cliFailureToAdminError({
      ok: false,
      code: 2,
      stdout: '',
      stderr: 'CLI_USER_INPUT_INVALID subcommand=user: invalid username: bad name',
    });
    expect(error.httpStatus).toBe(400);
  });

  it('maps database/hash failures to 500', () => {
    for (const code of ['CLI_USER_DATABASE_FAILED', 'CLI_USER_HASH_FAILED']) {
      const error = cliFailureToAdminError({ ok: false, code: 1, stdout: '', stderr: `${code} subcommand=user: boom` });
      expect(error.httpStatus).toBe(500);
    }
  });

  it('falls back to 500 for unknown codes and for empty stderr', () => {
    const unknown = cliFailureToAdminError({
      ok: false,
      code: 70,
      stdout: '',
      stderr: 'WEIRD_CODE subcommand=user: ?',
    });
    expect(unknown.httpStatus).toBe(500);

    const empty = cliFailureToAdminError({ ok: false, code: null, stdout: '', stderr: '' });
    expect(empty.httpStatus).toBe(500);
    expect(empty.message).toBe('aioncore user command failed');
  });

  it('reads the boundary code from the first non-empty stderr line', () => {
    const error = cliFailureToAdminError({
      ok: false,
      code: 2,
      stdout: '',
      stderr: '\n\nCLI_USER_NOT_FOUND subcommand=user: no such user\ntrailing noise',
    });
    expect(error.httpStatus).toBe(404);
  });
});
