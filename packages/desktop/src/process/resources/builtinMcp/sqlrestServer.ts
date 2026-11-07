/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standalone MCP server for SQLREST (https://gitee.com/inrgihc/sqlrest).
 *
 * Runs as a stdio MCP server on the official MCP SDK. It enumerates every
 * *published* SQLREST API from the Manager node and registers each one as an
 * individual tool (arguments validated by zod), so a single MCP server can talk
 * to all the REST endpoints ("ports") that SQLREST generated. Calls are proxied
 * to the Gateway/Executor node and the JSON response is returned as text.
 *
 * When discovery is disabled or fails it falls back to a single generic
 * `sqlrest_call` tool that takes an explicit path, so any endpoint stays
 * reachable.
 *
 * Environment variables:
 *   SQLREST_API_BASE_URL    Base URL for executing APIs. Default http://localhost:8091/api
 *                           (the Gateway; use http://localhost:8092/api for the Executor).
 *   SQLREST_TOKEN           Bearer token for API auth (client token). Optional.
 *   SQLREST_MANAGER_URL     Manager base URL for enumerating APIs. Default http://localhost:8090.
 *                           Set it to an empty string to skip discovery entirely.
 *   SQLREST_MANAGER_TOKEN   Manager token (skips login). Optional.
 *   SQLREST_USERNAME        Manager login username. Default admin.
 *   SQLREST_PASSWORD        Manager login password. Default 123456.
 *   SQLREST_PAGE_SIZE       Page size for API enumeration. Default 1000.
 *   SQLREST_CACHE_SECONDS   Re-discovery interval for the tool list. Default 300.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  buildCallRequest,
  DEFAULT_TIMEOUT_MS,
  describeApi,
  formatResponseBody,
  GENERIC_TOOL_NAME,
  readApiPage,
  reserveToolName,
  resolveConfig,
  shouldFetchNextPage,
  type SqlrestApi,
  type SqlrestCallArgs,
  type SqlrestConfig,
  type SqlrestRequest,
} from './sqlrestFormat';

/** Safety cap so a misbehaving Manager cannot loop us forever. */
const MAX_PAGES = 50;

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

async function getManagerToken(config: SqlrestConfig): Promise<string> {
  if (config.managerToken) return config.managerToken;

  const res = await httpJson({
    url: `${config.managerUrl}/user/login`,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  if (!res.ok) throw new Error(`Manager login failed: HTTP ${res.status}`);

  const token = (res.data as { data?: unknown } | null)?.data;
  if (typeof token !== 'string' || !token) {
    throw new Error(`Manager login returned no token: ${formatResponseBody(res.data)}`);
  }
  return token;
}

async function listPublishedApis(config: SqlrestConfig, token: string): Promise<SqlrestApi[]> {
  const apis: SqlrestApi[] = [];
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await httpJson({
      url: `${config.managerUrl}/api/v1/assignment/search`,
      method: 'POST',
      headers,
      body: JSON.stringify({ page, size: config.pageSize, searchText: '' }),
    });
    if (!res.ok) throw new Error(`API search failed: HTTP ${res.status}`);

    const { apis: pageApis, total } = readApiPage(res.data);
    apis.push(...pageApis);
    if (!shouldFetchNextPage(apis.length, total, pageApis.length)) break;
  }

  return apis;
}

/** Argument shape shared by every discovered API tool: loose DSL inputs. */
function callArgShape() {
  return {
    params: z
      .record(z.unknown())
      .optional()
      .describe(
        'DSL/SQL input as key-value pairs; the keys are the parameter names the API defines. Sent as the query string for GET/HEAD and as the JSON body for writes.'
      ),
    body: z
      .record(z.unknown())
      .optional()
      .describe('JSON request body for writes (POST/PUT/DELETE). Takes precedence over params when both are given.'),
  };
}

async function callApi(config: SqlrestConfig, path: string, method: string, args: SqlrestCallArgs) {
  let request: SqlrestRequest;
  try {
    request = buildCallRequest(config, path, method, args);
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
        ...callArgShape(),
      },
    },
    async ({ path, method, params, body }) => callApi(config, path, method ?? 'GET', { params, body })
  );
}

/**
 * One discovery pass: logs into the Manager, enumerates published APIs and
 * registers the ones that are not known yet. Returns how many were added.
 */
async function discoverTools(server: McpServer, config: SqlrestConfig, taken: Set<string>): Promise<number> {
  try {
    const token = await getManagerToken(config);
    const apis = await listPublishedApis(config, token);

    let added = 0;
    for (const api of apis) {
      const spec = describeApi(api);
      if (!spec) continue;

      const name = reserveToolName(spec, taken);
      if (!name) continue;
      taken.add(name);

      server.registerTool(
        name,
        {
          description: spec.description,
          inputSchema: callArgShape(),
          annotations: { readOnlyHint: spec.method === 'GET' || spec.method === 'HEAD' },
        },
        async (args) => callApi(config, spec.path, spec.method, args)
      );
      added += 1;
    }

    if (added > 0) {
      log(`Registered ${added} published API tool(s) from the Manager (${apis.length} listed).`);
      // Tell a connected client the list grew; before connect() this is a no-op.
      if (server.isConnected()) server.sendToolListChanged();
    }
    return added;
  } catch (error) {
    log(`Discovery failed (${messageOf(error)}); keeping the generic ${GENERIC_TOOL_NAME} tool.`);
    return 0;
  }
}

async function main(): Promise<void> {
  const config = resolveConfig(process.env);
  const server = new McpServer({ name: 'sqlrest', version: '1.2.0' });
  const taken = new Set<string>();

  registerGenericTool(server, config, taken);

  if (config.managerUrl) {
    // Discover before connecting so tools/list is already complete on the first call.
    await discoverTools(server, config, taken);
  } else {
    log('SQLREST_MANAGER_URL is empty; only the generic tool is available.');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`SQLREST MCP server ready (${taken.size} tool(s)).`);

  if (config.managerUrl) {
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
