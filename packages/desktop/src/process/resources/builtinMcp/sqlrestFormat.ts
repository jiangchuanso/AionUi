/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers behind the SQLREST MCP server: config resolution, OpenAPI
 * discovery, tool specs and proxied request building. Kept apart from the stdio
 * server so the behaviour can be unit-tested without spawning an MCP process.
 *
 * Security: discovery is read-only and unauthenticated. This module deliberately
 * has no Manager URL, username, password or admin token — the only credential is
 * the client token, and it is attached solely to API execution requests.
 */

export const DEFAULT_API_BASE_URL = 'http://localhost:8091/api';
export const DEFAULT_CACHE_SECONDS = 300;
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;
export const DEFAULT_PATH_PREFIX = '/api/';
export const MAX_DISCOVERY_DOCUMENTS = 12;
export const MAX_DISCOVERY_ATTEMPTS = 20;

/** Tool name reserved by the generic fallback; discovered APIs never shadow it. */
export const GENERIC_TOOL_NAME = 'sqlrest_call';

/**
 * Common Swagger/OpenAPI document locations on the Gateway. The JSON endpoint
 * varies between springfox, springdoc and custom builds, so probe them all.
 */
export const DISCOVERY_CANDIDATE_PATHS = [
  '/v3/api-docs',
  '/v2/api-docs',
  '/apidoc/v3/api-docs',
  '/apidoc/v2/api-docs',
  '/openapi.json',
  '/swagger-resources',
  '/apidoc/index.html',
];

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head']);

type JsonObject = Record<string, unknown>;

export type SqlrestEnv = Record<string, string | undefined>;

export type SqlrestConfig = {
  /** Gateway/Executor base URL that published APIs are proxied to. */
  apiBaseUrl: string;
  /** Client token forwarded as `Authorization: Bearer` on execution only. */
  token: string;
  /** Explicit OpenAPI/Swagger JSON URL; probed before the built-in candidates. */
  openapiUrl: string;
  /** Origin of the Gateway; discovery stays on this origin by default. */
  discoveryOrigin: string | null;
  /** Only paths containing this prefix become tools; empty accepts all API paths. */
  pathPrefix: string;
  /** Opt-in for documents hosted on a different origin (never sent the token). */
  allowCrossOrigin: boolean;
  /** Set to disable all discovery requests and expose only the generic tool. */
  discoveryEnabled: boolean;
  /** Re-discovery interval for the tool list. */
  cacheSeconds: number;
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

export type ParamType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';

/** Pure, serialisable description of one documented argument. */
export type ParamSpec = {
  name: string;
  location: 'query' | 'path' | 'body';
  type: ParamType;
  required: boolean;
  description?: string;
  enum?: string[];
};

/** One documented API reduced to what the MCP tool registration needs. */
export type ApiToolSpec = {
  name: string;
  description: string;
  /** Path relative to apiBaseUrl; may contain `{id}` placeholders. */
  path: string;
  method: string;
  pathVars: string[];
  params: ParamSpec[];
  body: ParamSpec[];
};

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function readInt(raw: string | undefined, fallback: number, min: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.floor(value);
}

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function normalisePrefix(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_PATH_PREFIX;
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

export function resolveConfig(env: SqlrestEnv): SqlrestConfig {
  const apiBaseUrl = stripTrailingSlashes((env.SQLREST_API_BASE_URL ?? '').trim() || DEFAULT_API_BASE_URL);
  const flag = (env.SQLREST_OPENAPI_ALLOW_CROSS_ORIGIN ?? '').trim().toLowerCase();
  const disable = (env.SQLREST_OPENAPI_DISABLE ?? '').trim().toLowerCase();

  return {
    apiBaseUrl,
    token: (env.SQLREST_TOKEN ?? '').trim(),
    openapiUrl: (env.SQLREST_OPENAPI_URL ?? '').trim(),
    discoveryOrigin: originOf(apiBaseUrl),
    pathPrefix: normalisePrefix(env.SQLREST_OPENAPI_PATH_PREFIX),
    allowCrossOrigin: flag === '1' || flag === 'true',
    discoveryEnabled: disable !== '1' && disable !== 'true',
    cacheSeconds: readInt(env.SQLREST_CACHE_SECONDS, DEFAULT_CACHE_SECONDS, 1),
  };
}

/** Whether `raw` points at the same origin as the configured Gateway. */
export function isSameOrigin(raw: string, origin: string | null): boolean {
  const target = originOf(raw);
  return target !== null && target === origin;
}

/**
 * Resolves a document URL found inside `/swagger-resources` or the Swagger UI
 * HTML. Cross-origin links are dropped unless explicitly allowed, so a crafted
 * document cannot redirect discovery to an arbitrary host.
 */
export function resolveDocumentUrl(raw: string, config: SqlrestConfig): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed, config.discoveryOrigin ?? undefined);
    if (!config.allowCrossOrigin && config.discoveryOrigin && url.origin !== config.discoveryOrigin) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Probe list: an explicit URL first, then the standard Gateway locations. */
export function discoveryUrls(config: SqlrestConfig): string[] {
  const origin = config.discoveryOrigin;
  const candidates: string[] = [];
  if (config.openapiUrl) candidates.push(config.openapiUrl);
  if (origin) {
    for (const path of DISCOVERY_CANDIDATE_PATHS) candidates.push(`${origin}${path}`);
  }

  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const url of candidates) {
    const absolute = resolveDocumentUrl(url, config);
    if (!absolute || (!config.allowCrossOrigin && origin && !isSameOrigin(absolute, origin))) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    resolved.push(absolute);
  }
  return resolved;
}

/** `/swagger-resources` returns a list of grouped document locations. */
export function readSwaggerResources(payload: unknown, config: SqlrestConfig): string[] {
  const entries = Array.isArray(payload) ? payload : asArray(asObject(payload)?.data);
  const urls: string[] = [];
  for (const entry of entries) {
    const item = asObject(entry);
    const location = asString(item?.location) || asString(item?.url) || asString(item?.path);
    const resolved = resolveDocumentUrl(location, config);
    if (resolved) urls.push(resolved);
  }
  return [...new Set(urls)];
}

/**
 * Extracts the `url` / `urls[]` / `configUrl` values from a Swagger UI page.
 * Only used as a last resort when no JSON candidate responded.
 */
export function readSwaggerUiUrls(html: string, config: SqlrestConfig): string[] {
  const urls: string[] = [];
  const add = (raw: string | undefined) => {
    const resolved = resolveDocumentUrl(raw ?? '', config);
    if (resolved) urls.push(resolved);
  };

  for (const match of html.matchAll(/(?:url|location|configUrl)\s*[:=]\s*["']([^"']+)["']/gi)) {
    add(match[1]);
  }
  for (const match of html.matchAll(/\burls\s*[:=]\s*\[([^\]]*)\]/gi)) {
    for (const inner of match[1].matchAll(/["']([^"']*(?:api-docs|openapi|\.json)[^"']*)["']/gi)) {
      add(inner[1]);
    }
  }
  return [...new Set(urls)];
}

export function isOpenApiDocument(payload: unknown): boolean {
  return asObject(asObject(payload)?.paths) !== null;
}

function firstServerPath(root: JsonObject): string {
  for (const server of asArray(root.servers)) {
    const url = asString(asObject(server)?.url);
    if (!url) continue;
    try {
      return new URL(url, 'http://localhost').pathname;
    } catch {
      // Not a URL — fall through to the next server.
    }
  }
  return '';
}

function joinPaths(basePath: string, rawPath: string): string {
  const base = stripTrailingSlashes(basePath.startsWith('/') ? basePath : `/${basePath}`);
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (!base || path === base || path.startsWith(`${base}/`)) return path;
  return `${base}${path}`;
}

/** Paths that belong to the framework itself, never to SQLREST's API surface. */
function isManagementPath(path: string): boolean {
  return /(^|\/)(actuator|error|swagger-resources|swagger-ui|apidoc|webjars|user\/login|v2\/api-docs|v3\/api-docs|favicon\.ico)(\/|$)/i.test(
    path
  );
}

function pathForTool(fullPath: string, config: SqlrestConfig): string | null {
  if (isManagementPath(fullPath)) return null;
  if (config.pathPrefix) {
    const index = fullPath.indexOf(config.pathPrefix);
    if (index < 0) return null;
    return fullPath.slice(index + config.pathPrefix.length).replace(/^\/+/, '');
  }
  return fullPath.replace(/^\/+/, '');
}

const KNOWN_TYPES = new Set<ParamType>(['string', 'integer', 'number', 'boolean', 'array', 'object']);

function normaliseType(raw: string, schema: JsonObject): ParamType {
  const value = raw.toLowerCase();
  if (value === 'int' || value === 'long' || value === 'short') return 'integer';
  if (value === 'float' || value === 'double' || value === 'decimal') return 'number';
  if (KNOWN_TYPES.has(value as ParamType)) return value as ParamType;
  if (!value && asObject(schema.properties)) return 'object';
  return 'unknown';
}

/** Resolves local `$ref`s into `components.schemas` / `definitions`. */
function resolveSchema(schema: unknown, root: JsonObject, depth = 0): JsonObject {
  const obj = asObject(schema);
  if (!obj || depth > 3) return {};
  const ref = asString(obj.$ref);
  if (!ref.startsWith('#/')) return obj;

  let current: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    current = asObject(current)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  const resolved = asObject(current);
  return resolved ? resolveSchema(resolved, root, depth + 1) : {};
}

function toParamSpec(
  name: string,
  rawSchema: unknown,
  root: JsonObject,
  required: boolean,
  location: ParamSpec['location']
): ParamSpec {
  const schema = resolveSchema(rawSchema, root);
  const enumValues = asArray(schema.enum).filter((item): item is string => typeof item === 'string');
  const description = asString(schema.description) || undefined;
  return {
    name,
    location,
    type: normaliseType(asString(schema.type), schema),
    required,
    ...(description ? { description } : {}),
    ...(enumValues.length ? { enum: enumValues } : {}),
  };
}

function readSchemaProperties(schema: unknown, root: JsonObject, into: ParamSpec[]): void {
  const resolved = resolveSchema(schema, root);
  const properties = asObject(resolved.properties);
  if (!properties) return;
  const required = new Set(stringArray(resolved.required));
  for (const [name, property] of Object.entries(properties)) {
    into.push(toParamSpec(name, property, root, required.has(name), 'body'));
  }
}

function readParameters(
  rawParameters: unknown[],
  operation: JsonObject,
  root: JsonObject
): { params: ParamSpec[]; body: ParamSpec[] } {
  const params: ParamSpec[] = [];
  const body: ParamSpec[] = [];

  for (const raw of rawParameters) {
    const parameter = asObject(raw);
    if (!parameter) continue;
    const name = asString(parameter.name);
    const location = asString(parameter.in).toLowerCase();
    const required = parameter.required === true;

    if (location === 'body' || location === 'formdata') {
      readSchemaProperties(parameter.schema ?? parameter, root, body);
    } else if (name && (location === 'query' || location === 'path')) {
      params.push(toParamSpec(name, parameter.schema ?? parameter, root, required, location));
    }
  }

  // OpenAPI 3 puts JSON bodies on requestBody rather than on a parameter.
  const requestBody = asObject(operation.requestBody);
  const content = asObject(requestBody?.content);
  const jsonContent = asObject(content?.['application/json']) ?? asObject(content?.['application/*+json']);
  if (jsonContent) readSchemaProperties(jsonContent.schema, root, body);

  return { params, body };
}

/**
 * Converts a Swagger 2 / OpenAPI 3 document into tool specs. Only operations
 * under `pathPrefix` are exposed; framework endpoints are always excluded.
 */
export function parseOpenApiDocument(payload: unknown, config: SqlrestConfig): ApiToolSpec[] {
  const root = asObject(payload);
  const paths = asObject(root?.paths);
  if (!root || !paths) return [];

  const basePath = joinPaths(asString(root.basePath) || firstServerPath(root), '/');
  const specs: ApiToolSpec[] = [];

  for (const [rawPath, pathItemValue] of Object.entries(paths)) {
    const pathItem = asObject(pathItemValue);
    if (!pathItem) continue;
    const fullPath = joinPaths(basePath, rawPath);
    const path = pathForTool(fullPath, config);
    if (!path) continue;

    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const operation = asObject(operationValue) ?? {};
      const { params, body } = readParameters(
        [...asArray(pathItem.parameters), ...asArray(operation.parameters)],
        operation,
        root
      );
      const pathVars = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      for (const variable of pathVars) {
        if (!params.some((param) => param.name === variable)) {
          params.push({ name: variable, location: 'path', type: 'string', required: true });
        }
      }

      const summary = asString(operation.summary) || asString(operation.description) || asString(operation.operationId);
      const signature = [...params, ...body]
        .map((param) => `${param.name}:${param.type}${param.required ? '' : '?'}`)
        .join(', ');
      const description = [summary, signature ? `params(${signature})` : '', `(${method.toUpperCase()} ${fullPath})`]
        .filter(Boolean)
        .join(' — ');

      specs.push({
        name: sanitizeToolName(path),
        description,
        path,
        method: method.toUpperCase(),
        pathVars,
        params,
        body,
      });
    }
  }

  return specs;
}

export function sanitizeToolName(path: string): string {
  const cleaned = String(path)
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `sqlrest_${cleaned || 'api'}`;
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

/**
 * Builds the proxied call. Path template values are taken from `params` and
 * removed from the query/body; GET/HEAD use the query string, writes use JSON.
 */
export function buildCallRequest(
  config: SqlrestConfig,
  path: string,
  method: string,
  args: SqlrestCallArgs = {},
  pathVars: string[] = []
): SqlrestRequest {
  const remaining = { ...(args.params ?? {}) };
  const replacements: Record<string, string> = {};
  for (const variable of pathVars) {
    const value = remaining[variable];
    if (value === undefined || value === null) throw new Error(`Missing path parameter "${variable}"`);
    replacements[variable] = encodeURIComponent(String(value));
    delete remaining[variable];
  }

  const cleanPath = String(path || '')
    .replace(/^\/+/, '')
    .replace(/\{([^}]+)\}/g, (match, variable: string) => replacements[variable] ?? match);
  if (/\{[^}]*\}/.test(cleanPath)) {
    throw new Error(`Unresolved path parameter in "${cleanPath}"`);
  }

  const upperMethod = (method || 'GET').toUpperCase();
  let url = `${config.apiBaseUrl}/${cleanPath}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  if (upperMethod === 'GET' || upperMethod === 'HEAD') {
    const query = toQueryString(remaining);
    if (query) url += (url.includes('?') ? '&' : '?') + query;
    return { url, method: upperMethod, headers };
  }

  headers['Content-Type'] = 'application/json';
  const payload = args.body && typeof args.body === 'object' ? args.body : remaining;
  return {
    url,
    method: upperMethod,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  };
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
