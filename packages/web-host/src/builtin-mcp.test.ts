import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBuiltinMcpCatalog } from './builtin-mcp.js';

describe('resolveBuiltinMcpCatalog', () => {
  let resourcesPath = '';

  beforeEach(async () => {
    resourcesPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-builtin-mcp-'));
  });

  afterEach(async () => {
    await fs.rm(resourcesPath, { recursive: true, force: true });
  });

  async function writeSearxngScript(): Promise<string> {
    const script = path.join(resourcesPath, 'out', 'main', 'builtin-mcp-searxng.js');
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(script, '// stub');
    return script;
  }

  it('returns no servers when out/main/builtin-mcp-searxng.js is absent', () => {
    expect(resolveBuiltinMcpCatalog(resourcesPath, {})).toEqual({ servers: [] });
  });

  it('resolves searxng with an absolute script path and default endpoint', async () => {
    const script = await writeSearxngScript();

    const { servers } = resolveBuiltinMcpCatalog(resourcesPath, {});
    expect(servers).toHaveLength(1);

    const searxng = servers[0];
    expect(searxng.name).toBe('searxng');
    expect(searxng.builtin).toBe(true);
    expect(searxng.enabled).toBe(true);
    expect(searxng.transport).toEqual({
      type: 'stdio',
      command: 'node',
      args: [script],
      env: { AIONUI_SEARXNG_URL: 'http://localhost:3826' },
    });
    expect(JSON.parse(searxng.original_json)).toMatchObject({
      mcpServers: { searxng: { command: 'node', args: [script] } },
    });
  });

  it('honours AIONUI_SEARXNG_URL from the environment', async () => {
    await writeSearxngScript();

    const { servers } = resolveBuiltinMcpCatalog(resourcesPath, {
      AIONUI_SEARXNG_URL: 'http://searxng:3826',
    });
    expect(servers[0].transport.env).toEqual({ AIONUI_SEARXNG_URL: 'http://searxng:3826' });
  });
});
