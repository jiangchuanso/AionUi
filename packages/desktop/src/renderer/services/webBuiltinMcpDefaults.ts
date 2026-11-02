/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mcpService } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import { BUILTIN_SEARXNG_MCP_NAME } from '@/common/config/constants';
import type { IMcpServer } from '@/common/config/storage';
import { ensureBackendMcpCatalog, toBackendMcpPayload } from '@/renderer/hooks/mcp/catalog';
import { isElectronDesktop } from '@/renderer/utils/platform';

/**
 * Per-user, one-shot completion flag. The WebUI has no local config file, so it
 * lives in the backend client-settings store (per account, survives device
 * switches). Distinct from the assistant/skill flag so the two can be rolled
 * out independently.
 */
const FLAG = 'migration.builtinMcpSearxng_v1' as const;

/** The shape `/api/webhost/builtin-mcp` returns (web-host side resolves the path). */
type BuiltinMcpServerSpec = Pick<IMcpServer, 'name' | 'description' | 'transport' | 'original_json' | 'builtin'> & {
  enabled?: boolean;
};

let inFlight: Promise<void> | null = null;

const isBuiltinSearxng = (server: Pick<IMcpServer, 'name' | 'builtin'>): boolean =>
  server.builtin === true && server.name.trim().toLowerCase() === BUILTIN_SEARXNG_MCP_NAME;

/**
 * WebUI-only counterpart of the desktop `ensureBootstrapMcpServersInDb`
 * migration: on a user's first authenticated load, register the built-in searxng
 * MCP server under that account.
 *
 * Why the renderer and not web-host: in webui identity mode MCP records are
 * strictly per-user, and every `/api/mcp/*` call needs the signed-in session +
 * CSRF token. web-host boots before anyone logs in, so it cannot own this. The
 * renderer already holds the session, and the same pattern is used for the
 * built-in assistant bootstrap (`ensureWebBuiltinAssistantDefaults`).
 *
 * No-op on desktop (the main-process migration handles it) and best-effort:
 * failures are logged and retried on the next load without blocking the UI.
 */
export function ensureWebBuiltinMcpDefaults(): Promise<void> {
  if (isElectronDesktop()) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = run()
    .catch((error) => {
      console.warn('[AionUi] web built-in MCP defaults bootstrap failed:', error);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function run(): Promise<void> {
  await configService.initialize();
  if (configService.get(FLAG)) return;

  // Skip if this account already has the server (user added it manually, or a
  // previous load registered it before the flag got persisted).
  const { allServers } = await ensureBackendMcpCatalog();
  if (!allServers.some(isBuiltinSearxng)) {
    const catalog = await fetchBuiltinMcpCatalog();
    const searxng = catalog.filter(isBuiltinSearxng);
    if (searxng.length > 0) {
      await mcpService.batchImportServers.invoke({
        servers: searxng.map((server) => ({
          ...toBackendMcpPayload(server),
          enabled: server.enabled ?? true,
        })),
      });
    }
  }

  await configService.set(FLAG, true);
}

async function fetchBuiltinMcpCatalog(): Promise<BuiltinMcpServerSpec[]> {
  const res = await fetch('/api/webhost/builtin-mcp', { credentials: 'include' });
  if (!res.ok) throw new Error(`/api/webhost/builtin-mcp responded ${res.status}`);
  const json = (await res.json()) as { servers?: BuiltinMcpServerSpec[] };
  return Array.isArray(json.servers) ? json.servers : [];
}
