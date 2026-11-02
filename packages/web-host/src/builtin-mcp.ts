/**
 * Built-in MCP server catalog exposed to the WebUI renderer.
 *
 * WebUI deployments (webui / webcli / docker) have no Electron main process, so
 * the desktop's `runBackendMigrations` never runs there and no built-in MCP
 * server is ever registered. Instead the renderer runs a per-user one-shot
 * bootstrap (`ensureWebBuiltinMcpDefaults`) that registers these servers
 * through the normal `/api/mcp/*` API.
 *
 * This module is the web-host side of that contract. It resolves the on-disk
 * absolute path of the bundled searxng entry script — emitted by
 * `scripts/build-mcp-servers.js` into `out/main/` during `bun run package` — so
 * the browser can hand aioncore a path it can actually spawn. The script is part
 * of the shipped build output; no extra copy step is needed.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

export type BuiltinMcpStdioTransport = {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type BuiltinMcpServerSpec = {
  name: string;
  description?: string;
  enabled: boolean;
  builtin: boolean;
  transport: BuiltinMcpStdioTransport;
  original_json: string;
};

export type BuiltinMcpCatalog = {
  servers: BuiltinMcpServerSpec[];
};

/** Must match the desktop migration's BUILTIN_SEARXNG_NAME. */
const BUILTIN_SEARXNG_NAME = 'searxng';
/** Emitted by scripts/build-mcp-servers.js. */
const BUILTIN_SEARXNG_SCRIPT = 'builtin-mcp-searxng.js';
/** Fallback when the operator hasn't pointed the backend at a real instance. */
const DEFAULT_SEARXNG_URL = 'http://localhost:3826';

/**
 * Resolve the built-in MCP servers aioncore can spawn on this host.
 *
 * `resourcesPath` is the directory that contains `out/main/` (the repo root for
 * `bun run webui`, or the packaged app resources dir). Absent scripts are
 * silently skipped so a partial deployment never hands the backend a dead path.
 */
export function resolveBuiltinMcpCatalog(
  resourcesPath: string,
  env: NodeJS.ProcessEnv = process.env
): BuiltinMcpCatalog {
  const servers: BuiltinMcpServerSpec[] = [];

  const searxngScript = path.join(resourcesPath, 'out', 'main', BUILTIN_SEARXNG_SCRIPT);
  if (existsSync(searxngScript)) {
    const searxngUrl = (env.AIONUI_SEARXNG_URL || '').trim() || DEFAULT_SEARXNG_URL;
    const config = {
      command: 'node',
      args: [searxngScript],
      env: { AIONUI_SEARXNG_URL: searxngUrl },
    };
    servers.push({
      name: BUILTIN_SEARXNG_NAME,
      description: 'Default MCP server: searxng-compatible web search',
      enabled: true,
      builtin: true,
      transport: {
        type: 'stdio',
        command: config.command,
        args: config.args,
        env: config.env,
      },
      original_json: JSON.stringify({ mcpServers: { [BUILTIN_SEARXNG_NAME]: config } }, null, 2),
    });
  }

  return { servers };
}
