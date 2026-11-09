import { describe, expect, it } from 'vitest';

import { parseMcpJsonImport } from '@/renderer/pages/settings/ToolsSettings/mcpJsonImport';

describe('parseMcpJsonImport', () => {
  it('rejects a bare server object instead of treating its fields as server names', () => {
    const result = parseMcpJsonImport({
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
    });

    expect(result).toEqual({
      isValid: false,
      errorKey: 'settings.mcpJsonBareServerError',
    });
  });

  it('parses mcpServers stdio configs', () => {
    const result = parseMcpJsonImport({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp'],
        },
      },
    });

    expect(result).toEqual({
      isValid: true,
      servers: [
        {
          name: 'playwright',
          description: 'Imported from JSON',
          transport: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@playwright/mcp'],
            env: {},
          },
          originalConfig: {
            command: 'npx',
            args: ['-y', '@playwright/mcp'],
          },
        },
      ],
    });
  });

  it('normalizes string stdio args in array transport configs', () => {
    const result = parseMcpJsonImport([
      {
        name: 'report',
        transport: {
          type: 'stdio',
          command: 'python',
          args: 'D:\\PJ-MCP\\report_mcp_server.py',
        },
      },
    ]);

    expect(result).toEqual({
      isValid: true,
      servers: [
        {
          name: 'report',
          description: 'Imported from JSON',
          transport: {
            type: 'stdio',
            command: 'python',
            args: ['D:\\PJ-MCP\\report_mcp_server.py'],
            env: {},
          },
          originalConfig: {
            transport: {
              type: 'stdio',
              command: 'python',
              args: 'D:\\PJ-MCP\\report_mcp_server.py',
            },
          },
        },
      ],
    });
  });

  it('maps streamable_http to http for the backend contract', () => {
    const result = parseMcpJsonImport({
      mcpServers: {
        docs: {
          type: 'streamable_http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' },
        },
      },
    });

    expect(result).toEqual({
      isValid: true,
      servers: [
        {
          name: 'docs',
          description: 'Imported from JSON',
          transport: {
            type: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer token' },
          },
          originalConfig: {
            type: 'streamable_http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer token' },
          },
        },
      ],
    });
  });

  it('rejects http configs without a URL', () => {
    const result = parseMcpJsonImport({
      mcpServers: {
        broken: {
          type: 'http',
        },
      },
    });

    expect(result).toEqual({
      isValid: false,
      errorKey: 'settings.mcpJsonUrlRequiredError',
    });
  });

  it('parses the native SQLREST MCP SSE endpoint with its token query intact', () => {
    const url = 'http://127.0.0.1:8090/mcp/sse?token=5f3a9c0e1b2d4a6f8e0c3b7d91a2e4f60';
    const result = parseMcpJsonImport({
      mcpServers: { sqlrest: { type: 'sse', url } },
    });

    expect(result).toEqual({
      isValid: true,
      servers: [
        {
          name: 'sqlrest',
          description: 'Imported from JSON',
          transport: { type: 'sse', url, headers: undefined },
          originalConfig: { type: 'sse', url },
        },
      ],
    });
  });
});
