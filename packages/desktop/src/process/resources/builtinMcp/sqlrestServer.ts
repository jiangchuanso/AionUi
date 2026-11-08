/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standalone MCP server for SQLREST (https://gitee.com/inrgihc/sqlrest).
 *
 * Runs as a stdio MCP server on the official MCP SDK. Tool discovery reads the
 * Gateway's public Swagger/OpenAPI document and turns each documented operation
 * into a tool with a zod schema built from its parameters. No Manager URL,
 * login, admin token or password is used anywhere: document requests are
 * unauthenticated GETs that stay on the Gateway origin by default.
 *
 * Discovery URL candidates are probed in order (springdoc, springfox, custom
 * apidoc, `/swagger-resources`, `/apidoc/index.html`), or you can pin one with
 * SQLREST_OPENAPI_URL. If no document is reachable only `sqlrest_call` is
 * exposed, so every endpoint remains callable by explicit path.
 *
 * Environment variables:
 *   SQLREST_API_BASE_URL               Execution base URL. Default http://localhost:8091/api
 *                                      (the Gateway; use :8092/api for the Executor).
 *   SQLREST_TOKEN                      Client token for API auth. Optional; never sent during discovery.
 *   SQLREST_OPENAPI_URL                Explicit Swagger/OpenAPI JSON URL. Optional.
 *   SQLREST_OPENAPI_PATH_PREFIX        Only expose paths containing this prefix. Default /api/.
 *   SQLREST_OPENAPI_ALLOW_CROSS_ORIGIN Set to 1 to allow documents on another origin. Default off.
 *   SQLREST_OPENAPI_DISABLE            Set to 1 to skip discovery entirely. Default off.
 *   SQLREST_CACHE_SECONDS              Re-discovery interval. Default 300.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  buildCallRequest,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  discoveryUrls,
  formatResponseBody,
  GENERIC_TOOL_NAME,
  isOpenApiDocument,
  MAX_DISCOVERY_ATTEMPTS,
  MAX_DISCOVERY_DOCUMENTS,
  parseOpenApiDocument,
  readSwaggerResources,
  readSwaggerUiUrls,
  reserveToolName,
  resolveConfig,
  type ApiToolSpec,
  type ParamSpec,
  type SqlrestCallArgs,
  type SqlrestConfig,
  type SqlrestRequest,
} from './sqlrestFormat';

/** Upper bound on the whole startup probe, so a slow Gateway cannot hang MCP init. */
const DISCOVERY_DEADLINE_MS = 15000;

/** Group-index endpoints are only worth probing when no document was found. */
const DOCUMENT_INDEX_PATHS = ['/swagger-resources', '/apidoc/index.html'];

function log(message: string): void {
  process.stderr.write(`[SqlrestMCP] ${message}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

type HttpResponse = { ok: boolean; status: number; data: unknown };

type DocumentResponse = { text: string } | null;

/**
 * Read-only document fetch. Deliberately sends no Authorization header, never
 * follows a redirect (a redirect could leave the trusted origin), and has a
 * short timeout so probing many candidates stays cheap.
 */
async function fetchDocument(url: string): Promise<DocumentResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json, text/html, */*' },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) return null;
    if (!response.ok) return null;
    return { text: await response.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Executes a proxied API call; this is the only request that carries the token. */
async function httpJson(request: SqlrestRequest): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walks the probe list. A `/swagger-resources` response or a Swagger UI page
 * yields more candidate URLs, which are queued and fetched the same way.
 */
async function collectDocuments(config: SqlrestConfig): Promise<unknown[]> {
  const documents: unknown[] = [];
  const queue = discoveryUrls(config);
  const seen = new Set<string>();
  const deadline = Date.now() + DISCOVERY_DEADLINE_MS;

  let attempts = 0;
  let viaIndex = false;
  while (queue.length > 0 && attempts < MAX_DISCOVERY_ATTEMPTS && documents.length < MAX_DISCOVERY_DOCUMENTS) {
    const url = queue.shift();
    if (!url || seen.has(url) || Date.now() > deadline) break;
    seen.add(url);
    attempts += 1;

    // A group index can point at more documents, but probing it after we already
    // have a valid document only widens the request surface for no benefit.
    if (documents.length > 0 && DOCUMENT_INDEX_PATHS.some((path) => url.endsWith(path))) continue;

    const response = await fetchDocument(url);
    if (!response) continue;

    let payload: unknown;
    try {
      payload = JSON.parse(response.text);
    } catch {
      const extras = readSwaggerUiUrls(response.text, config);
      viaIndex = viaIndex || extras.length > 0;
      for (const extra of extras) {
        if (!seen.has(extra)) queue.push(extra);
      }
      continue;
    }

    if (isOpenApiDocument(payload)) {
      documents.push(payload);
      // One document is enough unless a group index pointed us at several.
      if (!viaIndex) break;
    } else {
      const extras = readSwaggerResources(payload, config);
      viaIndex = viaIndex || extras.length > 0;
      for (const extra of extras) {
        if (!seen.has(extra)) queue.push(extra);
      }
    }
  }

  return documents;
}

function toZod(parameter: ParamSpec): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (parameter.type) {
    case 'integer':
      schema = z.number().int();
      break;
    case 'number':
      schema = z.number();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'array':
      schema = z.array(z.unknown());
      break;
    case 'object':
      schema = z.record(z.unknown());
      break;
    case 'string':
      schema = parameter.enum?.length ? z.enum(parameter.enum as [string, ...string[]]) : z.string();
      break;
    default:
      schema = z.unknown();
  }
  if (parameter.description) schema = schema.describe(parameter.description);
  return parameter.required ? schema : schema.optional();
}

/** Builds a tool-specific zod shape from the documented parameters. */
function parameterSchema(parameters: ParamSpec[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const parameter of parameters) shape[parameter.name] = toZod(parameter);
  // passthrough() keeps undocumented SQLREST DSL arguments working.
  return z.object(shape).passthrough();
}

function callArgShape(spec: ApiToolSpec) {
  return {
    params: parameterSchema(spec.params)
      .optional()
      .describe('Documented query/path parameters. Path placeholders are filled from these values.'),
    body: parameterSchema(spec.body)
      .optional()
      .describe('Documented JSON request body fields; takes precedence over params for write methods.'),
  };
}

function genericArgShape() {
  return {
    params: z
      .record(z.unknown())
      .optional()
      .describe('Input as key-value pairs (query string for GET, JSON body for writes).'),
    body: z.record(z.unknown()).optional().describe('Explicit JSON request body for writes.'),
  };
}

async function callApi(
  config: SqlrestConfig,
  path: string,
  method: string,
  args: SqlrestCallArgs,
  pathVars: string[] = []
) {
  let request: SqlrestRequest;
  try {
    request = buildCallRequest(config, path, method, args, pathVars);
  } catch (error) {
    return errorResult(`Could not build the SQLREST request for "${path}": ${messageOf(error)}`);
  }

  try {
    const res = await httpJson(request);
    const text = formatResponseBody(res.data);
    if (!res.ok) {
      return errorResult(`SQLREST call failed: HTTP ${res.status}${text ? `\n${text}` : ''}`);
    }
    return { content: [{ type: 'text' as const, text: text || '(empty response)' }] };
  } catch (error) {
    return errorResult(`Failed to reach SQLREST at ${request.url}: ${messageOf(error)}`);
  }
}

function registerGenericTool(server: McpServer, config: SqlrestConfig, taken: Set<string>): void {
  taken.add(GENERIC_TOOL_NAME);
  server.registerTool(
    GENERIC_TOOL_NAME,
    {
      description: `Call any published SQLREST API by path (without the /api prefix), e.g. user/list.
Pass params as key-value pairs (query string for GET, JSON body for writes) or body for an explicit JSON payload.`,
      inputSchema: {
        path: z.string().min(1).describe('API path without the /api prefix, e.g. user/list or order/query.'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().describe('HTTP method. Defaults to GET.'),
        ...genericArgShape(),
      },
    },
    async ({ path, method, params, body }) => callApi(config, path, method ?? 'GET', { params, body })
  );
}

/** One discovery pass; returns how many new tools were registered. */
async function discoverTools(server: McpServer, config: SqlrestConfig, taken: Set<string>): Promise<number> {
  const documents = await collectDocuments(config);
  if (documents.length === 0) {
    log('No Swagger/OpenAPI document reachable; only the generic tool is available.');
    return 0;
  }

  const specs = documents.flatMap((document) => parseOpenApiDocument(document, config));
  let added = 0;
  for (const spec of specs) {
    const name = reserveToolName(spec, taken);
    if (!name) continue;
    taken.add(name);

    server.registerTool(
      name,
      {
        description: spec.description,
        inputSchema: callArgShape(spec),
        annotations: { readOnlyHint: spec.method === 'GET' || spec.method === 'HEAD' },
      },
      async (args) => callApi(config, spec.path, spec.method, args, spec.pathVars)
    );
    added += 1;
  }

  log(`Registered ${added} documented API tool(s) from ${documents.length} document(s).`);
  if (added > 0 && server.isConnected()) server.sendToolListChanged();
  return added;
}

async function main(): Promise<void> {
  const config = resolveConfig(process.env);
  const server = new McpServer({ name: 'sqlrest', version: '1.3.0' });
  const taken = new Set<string>();

  registerGenericTool(server, config, taken);
  log('Discovery is unauthenticated and read-only; no Manager credentials are used.');

  if (config.discoveryEnabled) {
    try {
      // Discover before connecting so tools/list is already complete on the first call.
      await discoverTools(server, config, taken);
    } catch (error) {
      log(`Discovery failed (${messageOf(error)}); keeping the generic ${GENERIC_TOOL_NAME} tool.`);
    }
  } else {
    log('Discovery disabled; only the generic tool is available.');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`SQLREST MCP server ready (${taken.size} tool(s)).`);

  if (config.discoveryEnabled) {
    // Pick up APIs published after startup without requiring a restart.
    setInterval(() => {
      void discoverTools(server, config, taken);
    }, config.cacheSeconds * 1000);
  }

  // The interval above would otherwise keep the process alive after the client
  // closes the pipe; exiting on stdin end mirrors the transport's own teardown.
  process.stdin.on('end', () => process.exit(0));
}

main().catch((error) => {
  log(`Fatal error: ${messageOf(error)}`);
  process.exit(1);
});
