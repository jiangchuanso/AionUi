/**
 * `/api/auth/admin/*` — local user management for the WebUI.
 *
 * Implemented by web-host (NOT proxied to aioncore): the backend's own
 * user-management endpoints are gated to local mode inside aioncore and 403
 * in webui identity mode, so this API shells out to the bundled
 * `aioncore user ...` CLI instead (see admin-cli.ts).
 *
 * Security: every request must carry a session cookie belonging to the
 * seeded admin (`system_default_user`). The check goes through the backend's
 * own `/api/auth/user` so it honours the real session (expiry, revocation,
 * password rotation) instead of trusting anything from the browser. The
 * internal endpoints have no auth middleware upstream, so without this gate
 * anyone who can reach the port could create accounts or reset the admin
 * password.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SYSTEM_ADMIN_USER_ID,
  cliFailureToAdminError,
  parseUserListOutput,
  runAioncoreUserCli,
  type AdminUser,
} from './admin-cli.js';
import type { AdminCliConfig } from './types.js';

const ADMIN_API_PREFIX = '/api/auth/admin/';
const MAX_BODY_BYTES = 64 * 1024;

export type AdminApiContext = {
  backendPort: number;
  adminCli?: AdminCliConfig;
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { success: false, error: message, code });
}

function pathOf(req: IncomingMessage): string {
  return (req.url ?? '').split('?')[0];
}

/** True when this request targets the admin API (before the /api/* proxy). */
export function isAdminApiPath(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith(ADMIN_API_PREFIX);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask the backend who this cookie belongs to. Fails closed: any transport
 * error, non-OK status, or non-admin identity denies the request.
 */
async function isAdminSession(req: IncomingMessage, backendPort: number): Promise<boolean> {
  const cookie = req.headers.cookie;
  if (!cookie) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/auth/user`, {
      headers: { cookie },
    });
    if (!response.ok) return false;
    const json = (await response.json()) as { success?: boolean; user?: { id?: string } };
    return json?.success === true && json?.user?.id === SYSTEM_ADMIN_USER_ID;
  } catch {
    return false;
  }
}

function requireString(body: Record<string, unknown> | undefined, field: string): string | null {
  const value = body?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reject usernames that could be misparsed as a CLI flag (leading `-`) or that
 * carry control characters. Usernames are forwarded as argv elements to the
 * `aioncore user` CLI; a value such as `--data-dir` must never reach it as a
 * flag. Kept intentionally permissive otherwise so any username the backend
 * accepts (including non-ASCII) still works.
 */
function isSafeUsername(name: string): boolean {
  if (name.length === 0 || name.length > 128 || name.startsWith('-')) return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function parseCreatedUser(stdout: string, username: string): AdminUser {
  // "Created user alice (id=user_abc123)."
  const match = /Created user \S+ \(id=(\S+)\)\./.exec(stdout);
  return {
    id: match?.[1] ?? '',
    username,
    user_type: 'local',
    status: 'active',
    created_at: Date.now(),
    last_login: null,
  };
}

async function handleList(ctx: AdminApiContext, res: ServerResponse): Promise<void> {
  const result = await runAioncoreUserCli(ctx.adminCli!, ['list']);
  if (!result.ok) {
    const error = cliFailureToAdminError(result);
    sendError(res, error.httpStatus, error.code, error.message);
    return;
  }
  sendJson(res, 200, { success: true, data: parseUserListOutput(result.stdout) });
}

async function handleCreate(ctx: AdminApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const username = requireString(body, 'username');
  const password = requireString(body, 'password');
  if (!username || !password) {
    sendError(res, 400, 'INVALID_INPUT', 'username and password are required');
    return;
  }
  if (!isSafeUsername(username)) {
    sendError(res, 400, 'INVALID_INPUT', 'invalid username');
    return;
  }
  const result = await runAioncoreUserCli(
    ctx.adminCli!,
    ['create', '--username', username, '--password-stdin'],
    password
  );
  if (!result.ok) {
    const error = cliFailureToAdminError(result);
    sendError(res, error.httpStatus, error.code, error.message);
    return;
  }
  sendJson(res, 200, { success: true, data: parseCreatedUser(result.stdout, username) });
}

async function handleSetPassword(
  ctx: AdminApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  username: string
): Promise<void> {
  const body = await readJsonBody(req);
  const password = requireString(body, 'password');
  if (!password) {
    sendError(res, 400, 'INVALID_INPUT', 'password is required');
    return;
  }
  const result = await runAioncoreUserCli(
    ctx.adminCli!,
    ['set-password', '--username', username, '--password-stdin'],
    password
  );
  if (!result.ok) {
    const error = cliFailureToAdminError(result);
    sendError(res, error.httpStatus, error.code, error.message);
    return;
  }
  sendJson(res, 200, { success: true, data: null });
}

async function handleSetStatus(
  ctx: AdminApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  username: string
): Promise<void> {
  const body = await readJsonBody(req);
  const status = body?.status;
  if (status !== 'active' && status !== 'disabled') {
    sendError(res, 400, 'INVALID_INPUT', 'status must be "active" or "disabled"');
    return;
  }
  const result = await runAioncoreUserCli(ctx.adminCli!, [
    status === 'disabled' ? 'disable' : 'enable',
    '--username',
    username,
  ]);
  if (!result.ok) {
    const error = cliFailureToAdminError(result);
    sendError(res, error.httpStatus, error.code, error.message);
    return;
  }
  sendJson(res, 200, { success: true, data: { username, status } });
}

/**
 * Entry point for the static server: gate, route, respond. Returns false when
 * the request is not an admin API request (caller keeps its normal routing).
 */
export async function handleAdminApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminApiContext
): Promise<boolean> {
  if (!isAdminApiPath(req.url)) return false;

  const respond = (status: number, code: string, message: string): void => {
    if (!res.headersSent) sendError(res, status, code, message);
  };

  if (req.method !== 'GET' && req.method !== 'POST') {
    req.resume();
    respond(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
    return true;
  }

  // Any body a GET happens to carry must still be drained, otherwise the
  // socket stalls and keep-alive connections hang.
  if (req.method === 'GET') req.resume();

  if (!ctx.adminCli) {
    respond(501, 'ADMIN_CLI_UNAVAILABLE', 'local user management is unavailable in this deployment');
    return true;
  }

  if (!(await isAdminSession(req, ctx.backendPort))) {
    respond(403, 'ADMIN_REQUIRED', 'only the admin account can manage users');
    return true;
  }

  const path = pathOf(req);
  try {
    if (path === `${ADMIN_API_PREFIX}users`) {
      if (req.method === 'GET') {
        await handleList(ctx, res);
      } else {
        await handleCreate(ctx, req, res);
      }
      return true;
    }

    const actionMatch = /^\/api\/auth\/admin\/users\/([^/]+)\/(password|status)$/.exec(path);
    if (actionMatch && req.method === 'POST') {
      let username: string;
      try {
        username = decodeURIComponent(actionMatch[1]!);
      } catch {
        respond(400, 'INVALID_INPUT', 'invalid username');
        return true;
      }
      if (!isSafeUsername(username)) {
        respond(400, 'INVALID_INPUT', 'invalid username');
        return true;
      }
      if (actionMatch[2] === 'password') {
        await handleSetPassword(ctx, req, res, username);
      } else {
        await handleSetStatus(ctx, req, res, username);
      }
      return true;
    }

    respond(404, 'NOT_FOUND', 'unknown admin endpoint');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'admin request failed';
    console.error('[admin-api] request failed:', message);
    respond(500, 'INTERNAL_ERROR', 'internal error');
    return true;
  }
}
