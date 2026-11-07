#!/usr/bin/env node
/**
 * Standalone MCP server for SQLREST (https://gitee.com/inrgihc/sqlrest).
 *
 * Runs as a stdio MCP server (no external dependencies) so it can be added to
 * any MCP client (e.g. AionUi) by pointing an MCP server command at:
 *
 *   node /absolute/path/to/sqlrest-mcp.js
 *
 * It enumerates every *published* SQLREST API from the Manager node and exposes
 * each one as an individual MCP tool, so a single MCP server can talk to all the
 * REST endpoints ("ports") that SQLREST generated. Calls are proxied to the
 * Gateway/Executor node and the JSON response is returned as text.
 *
 * When Manager credentials are not provided it falls back to a single generic
 * `sqlrest_call` tool that takes an explicit path, so you can still reach any
 * endpoint manually.
 *
 * Environment variables:
 *   SQLREST_API_BASE_URL    Base URL for executing APIs. Default http://localhost:8091/api
 *                           (the Gateway; use http://localhost:8092/api for the Executor).
 *   SQLREST_TOKEN           Bearer token for API auth (client token). Optional.
 *   SQLREST_MANAGER_URL     Manager base URL for enumerating APIs. Default http://localhost:8090.
 *   SQLREST_MANAGER_TOKEN   Manager token (skips login). Optional.
 *   SQLREST_USERNAME        Manager login username. Default admin.
 *   SQLREST_PASSWORD        Manager login password. Default 123456.
 *   SQLREST_PAGE_SIZE       Page size for API enumeration. Default 1000.
 *   SQLREST_CACHE_SECONDS   How long the enumerated tool list is cached. Default 300.
 */

'use strict';

const DEFAULT_API_BASE_URL = 'http://localhost:8091/api';
const DEFAULT_MANAGER_URL = 'http://localhost:8090';
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_CACHE_SECONDS = 300;

const config = {
  apiBaseUrl: (process.env.SQLREST_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, ''),
  token: process.env.SQLREST_TOKEN || '',
  managerUrl: (process.env.SQLREST_MANAGER_URL || DEFAULT_MANAGER_URL).replace(/\/+$/, ''),
  managerToken: process.env.SQLREST_MANAGER_TOKEN || '',
  username: process.env.SQLREST_USERNAME || 'admin',
  password: process.env.SQLREST_PASSWORD || '123456',
  pageSize: Number(process.env.SQLREST_PAGE_SIZE) || DEFAULT_PAGE_SIZE,
  cacheSeconds: Number(process.env.SQLREST_CACHE_SECONDS) || DEFAULT_CACHE_SECONDS,
};

const REQUEST_TIMEOUT_MS = 20000;

function log(message) {
  process.stderr.write(`[SqlrestMCP] ${message}\n`);
}

async function httpJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
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

async function getManagerToken() {
  if (config.managerToken) return config.managerToken;
  const res = await httpJson(`${config.managerUrl}/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  if (!res.ok) {
    throw new Error(`Manager login failed: HTTP ${res.status}`);
  }
  const token = res.data && res.data.data;
  if (!token) {
    throw new Error(`Manager login returned no token: ${JSON.stringify(res.data)}`);
  }
  return token;
}

async function listPublishedApis(token) {
  const apis = [];
  let page = 1;
  const size = config.pageSize;
  for (;;) {
    const res = await httpJson(`${config.managerUrl}/api/v1/assignment/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ page, size, searchText: '' }),
    });
    if (!res.ok) {
      throw new Error(`API search failed: HTTP ${res.status}`);
    }
    const pageData = res.data && res.data.data;
    if (Array.isArray(pageData)) {
      apis.push(...pageData);
    }
    const pagination = res.data && res.data.pagination;
    const total = pagination && typeof pagination.total === 'number' ? pagination.total : apis.length;
    if (!Array.isArray(pageData) || apis.length >= total || pageData.length === 0) {
      break;
    }
    page += 1;
  }
  return apis;
}

function sanitizeToolName(path) {
  const cleaned = String(path).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `sqlrest_${cleaned || 'api'}`;
}

function buildApiTool(api) {
  const method = (api.method || 'GET').toUpperCase();
  const path = String(api.path || '').replace(/^\/+/, '');
  const name = sanitizeToolName(path);
  const description = [api.name, api.description, `(${method} /api/${path})`]
    .filter(Boolean)
    .join(' — ');
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        params: {
          type: 'object',
          additionalProperties: true,
          description:
            'SQL/DSL 入参键值对，键名对应接口定义的参数名。GET 时作为 query 参数，POST/PUT 时作为 JSON 请求体。',
        },
        body: {
          type: 'object',
          additionalProperties: true,
          description: 'POST/PUT 时的 JSON 请求体（用于对象型参数），优先级高于 params。',
        },
      },
      required: [],
    },
    _meta: { path, method },
  };
}

function buildGenericTool() {
  return {
    name: 'sqlrest_call',
    description:
      '调用任意一个 SQLREST 已发布接口。需要提供接口路径（不含 /api 前缀），例如 user/list。' +
      '可用 params 传键值对（GET 为 query，POST/PUT 为 JSON 体），或用 body 传 JSON 请求体。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '接口路径，不含 /api 前缀，例如 user/list 或 order/query。',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE'],
          description: 'HTTP 方法，默认 GET。',
        },
        params: {
          type: 'object',
          additionalProperties: true,
          description: '入参键值对。',
        },
        body: {
          type: 'object',
          additionalProperties: true,
          description: 'JSON 请求体，优先级高于 params。',
        },
      },
      required: ['path'],
    },
    _meta: { path: null, method: 'GET' },
  };
}

let toolsCache = null;
let toolsCacheAt = 0;
let toolsLoadPromise = null;

async function loadTools() {
  const now = Date.now();
  if (toolsCache && now - toolsCacheAt < config.cacheSeconds * 1000) {
    return toolsCache;
  }
  // Guard against concurrent loads (e.g. tools/list racing tools/call) so the
  // Manager is only queried once.
  if (toolsLoadPromise) return toolsLoadPromise;

  const run = async () => {
    const generic = buildGenericTool();
    let tools = [generic];
    let enumerated = false;

    try {
      const hasManager =
        !!config.managerToken || (config.username && config.password && config.managerUrl);
      if (hasManager) {
        const token = await getManagerToken();
        const apis = await listPublishedApis(token);
        if (apis.length > 0) {
          const seen = new Set();
          for (const api of apis) {
            const tool = buildApiTool(api);
            if (seen.has(tool.name)) continue;
            seen.add(tool.name);
            tools.push(tool);
          }
          enumerated = true;
          log(`Enumerated ${apis.length} published API(s) from Manager.`);
        }
      } else {
        log('No Manager credentials provided; using generic sqlrest_call tool only.');
      }
    } catch (err) {
      log(`Enumeration failed (${(err && err.message) || err}); keeping generic tool.`);
    }

    if (!enumerated) {
      tools = [generic];
    }

    toolsCache = tools;
    toolsCacheAt = Date.now();
    return tools;
  };

  toolsLoadPromise = run().finally(() => {
    toolsLoadPromise = null;
  });
  return toolsLoadPromise;
}

function toQueryString(params) {
  if (!params || typeof params !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const v = typeof value === 'object' ? JSON.stringify(value) : String(value);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

async function callSqlrest(path, method, args) {
  const cleanPath = String(path || '').replace(/^\/+/, '');
  let url = `${config.apiBaseUrl}/${cleanPath}`;
  const upperMethod = (method || 'GET').toUpperCase();

  const headers = {};
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  let body;
  if (upperMethod === 'GET' || upperMethod === 'HEAD') {
    const qs = toQueryString(args.params);
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  } else {
    headers['Content-Type'] = 'application/json';
    const payload = args.body && typeof args.body === 'object' ? args.body : args.params;
    body = payload ? JSON.stringify(payload) : undefined;
  }

  const res = await httpJson(url, { method: upperMethod, headers, body });
  const text =
    typeof res.data === 'string'
      ? res.data
      : JSON.stringify(res.data, null, 2);
  if (!res.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: `SQLREST 调用失败: HTTP ${res.status}\n${text}` }],
    };
  }
  return {
    content: [{ type: 'text', text }],
  };
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio transport (JSON-RPC, newline-delimited).
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handleRequest(message) {
  const id = message.id;
  const method = message.method;
  const params = message.params || {};

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sqlrest', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
    case 'tools/ls': {
      const tools = await loadTools();
      const cleaned = tools.map(({ _meta, ...rest }) => rest);
      return { tools: cleaned };
    }
    case 'tools/call': {
      const toolName = params.name;
      const args = params.arguments || {};
      const tools = await loadTools();
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) {
        return {
          isError: true,
          content: [{ type: 'text', text: `未知工具: ${toolName}` }],
        };
      }
      try {
        if (tool._meta.path) {
          return await callSqlrest(tool._meta.path, tool._meta.method, args);
        }
        return await callSqlrest(args.path, args.method || 'GET', args);
      } catch (err) {
        const messageText = err && err.message ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `SQLREST 调用异常: ${messageText}` }],
        };
      }
    }
    case 'resources/list':
    case 'prompts/list':
      return { resources: [], prompts: [] };
    default:
      if (id !== undefined && id !== null) {
        return {
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      }
      return null;
  }
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      handleRequest(message)
        .then((result) => {
          if (result === null) return;
          if (result && result.error) {
            send({ jsonrpc: '2.0', id: message.id, error: result.error });
          } else {
            send({ jsonrpc: '2.0', id: message.id, result });
          }
        })
        .catch((err) => {
          const messageText = err && err.message ? err.message : String(err);
          if (message.id !== undefined && message.id !== null) {
            send({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32603, message: messageText },
            });
          }
        });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  log('SQLREST MCP server started (stdio).');
}

main();
