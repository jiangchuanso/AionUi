/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers behind the SQLREST MCP server: config resolution, tool naming,
 * request building and Manager response parsing. Kept apart from the stdio
 * server so the behaviour can be unit-tested without spawning an MCP process.
 */

export const DEFAULT_API_BASE_URL = 'http://localhost:8091/api';
export const DEFAULT_MANAGER_URL = 'http://localhost:8090';
export const DEFAULT_USERNAME = 'admin';
export const DEFAULT_PASSWORD = '123456';
export const DEFAULT_PAGE_SIZE = 1000;
export const DEFAULT_CACHE_SECONDS = 300;
export const DEFAULT_TIMEOUT_MS = 20000;

/** Tool name reserved by the generic fallback; published APIs never shadow it. */
export const GENERIC_TOOL_NAME = 'sqlrest_call';

export type SqlrestEnv = Record<string, string | undefined>;

export type SqlrestConfig = {
  /** Gateway/Executor base URL that published APIs are proxied to. */
  apiBaseUrl: string;
  /** Client token forwarded as `Authorization: Bearer`. */
  token: string;
  /** Manager base URL; an empty string disables API discovery. */
  managerUrl: string;
  /** Manager token — when set, login is skipped. */
  managerToken: string;
  username: string;
  password: string;
  /** Page size used while enumerating published APIs. */
  pageSize: number;
  /** How long discovered API tools are trusted before a re-discovery pass. */
  cacheSeconds: number;
};

export type SqlrestApi = {
  id?: string | number;
  name?: string;
  description?: string;
  path?: string;
  method?: string;
};

export type SqlrestCallArgs = {
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

export type SqlrestRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

/** One discovered API reduced to what the MCP tool registration needs. */
export type ApiToolSpec = {
  name: string;
  description: string;
  /** Path without the leading slash, so it can be appended to the base URL. */
  path: string;
  method: string;
};

export type ApiPage = {
  apis: SqlrestApi[];
  /** Total row count reported by the Manager; falls back to the page length. */
  total: number;
};

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function readInt(raw: string | undefined, fallback: number, min: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.floor(value);
}

export function resolveConfig(env: SqlrestEnv): SqlrestConfig {
  // An explicitly empty SQLREST_MANAGER_URL opts out of discovery, so treat
  // "missing" and "empty" differently instead of falling back on `||`.
  const managerUrl =
    env.SQLREST_MANAGER_URL === undefined
      ? DEFAULT_MANAGER_URL
      : stripTrailingSlashes((env.SQLREST_MANAGER_URL ?? '').trim());

  return {
    apiBaseUrl: stripTrailingSlashes((env.SQLREST_API_BASE_URL ?? '').trim() || DEFAULT_API_BASE_URL),
    token: (env.SQLREST_TOKEN ?? '').trim(),
    managerUrl,
    managerToken: (env.SQLREST_MANAGER_TOKEN ?? '').trim(),
    username: (env.SQLREST_USERNAME ?? '').trim() || DEFAULT_USERNAME,
    password: env.SQLREST_PASSWORD || DEFAULT_PASSWORD,
    pageSize: readInt(env.SQLREST_PAGE_SIZE, DEFAULT_PAGE_SIZE, 1),
    cacheSeconds: readInt(env.SQLREST_CACHE_SECONDS, DEFAULT_CACHE_SECONDS, 1),
  };
}

export function sanitizeToolName(path: string): string {
  const cleaned = String(path)
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `sqlrest_${cleaned || 'api'}`;
}

/**
 * Reads the subset of a Manager assignment record that matters here. Returns
 * `null` for records without a path — they cannot be called.
 */
export function describeApi(api: SqlrestApi): ApiToolSpec | null {
  const path = String(api.path ?? '')
    .replace(/^\/+/, '')
    .trim();
  if (!path) return null;

  const method = String(api.method || 'GET').toUpperCase();
  const description = [api.name, api.description, `(${method} /api/${path})`].filter(Boolean).join(' — ');
  return { name: sanitizeToolName(path), description, path, method };
}

/**
 * Picks the tool name for a spec: the path-derived name normally, the
 * method-suffixed one when two methods share a path, `null` when both are taken.
 */
export function reserveToolName(spec: ApiToolSpec, taken: ReadonlySet<string>): string | null {
  if (!taken.has(spec.name)) return spec.name;
  const suffixed = `${spec.name}_${spec.method.toLowerCase()}`;
  return taken.has(suffixed) ? null : suffixed;
}

export function toQueryString(params?: Record<string, unknown>): string {
  if (!params || typeof params !== 'object') return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(serialized)}`);
  }
  return parts.join('&');
}

/** Builds the proxied call: GET/HEAD use the query string, writes use a JSON body. */
export function buildCallRequest(
  config: SqlrestConfig,
  path: string,
  method: string,
  args: SqlrestCallArgs = {}
): SqlrestRequest {
  const cleanPath = String(path || '').replace(/^\/+/, '');
  const upperMethod = (method || 'GET').toUpperCase();
  let url = `${config.apiBaseUrl}/${cleanPath}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  if (upperMethod === 'GET' || upperMethod === 'HEAD') {
    const query = toQueryString(args.params);
    if (query) url += (url.includes('?') ? '&' : '?') + query;
    return { url, method: upperMethod, headers };
  }

  headers['Content-Type'] = 'application/json';
  const payload = args.body && typeof args.body === 'object' ? args.body : args.params;
  return {
    url,
    method: upperMethod,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  };
}

/** Unwraps `{ data: [...], pagination: { total } }` into a page of APIs. */
export function readApiPage(payload: unknown): ApiPage {
  const root = (payload ?? {}) as { data?: unknown; pagination?: { total?: unknown } | null };
  const apis = Array.isArray(root.data) ? (root.data as SqlrestApi[]) : [];
  const rawTotal = root.pagination?.total;
  const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : apis.length;
  return { apis, total };
}

export function shouldFetchNextPage(collected: number, total: number, pageLength: number): boolean {
  return pageLength > 0 && collected < total;
}

/** Pretty-prints a response body; non-JSON payloads are returned verbatim. */
export function formatResponseBody(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === null || data === undefined) return '';
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}
