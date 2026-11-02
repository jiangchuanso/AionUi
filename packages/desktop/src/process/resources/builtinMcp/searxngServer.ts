/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server for SearXNG-compatible search.
 *
 * Runs as a standalone stdio process spawned by the MCP client. The search
 * endpoint is resolved from `AIONUI_SEARXNG_URL` at startup (defaults to the
 * local document-retrieval service on port 3826), so the same compiled script
 * works after installation without being rebuilt.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DEFAULT_BASE_URL = 'http://localhost:3826';
const REQUEST_TIMEOUT_MS = 15000;

function resolveBaseUrl(): string {
  const raw = (process.env.AIONUI_SEARXNG_URL || DEFAULT_BASE_URL).trim();
  return raw.replace(/\/+$/, '');
}

type SearxngResult = {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
  engine?: string;
  /** Stable chunk id ("doc:index") — dedupes hits that share a URL/section. */
  chunk_id?: string;
  /** Engine score; higher is better and matches the returned order. */
  score?: number;
};

function formatResult(result: SearxngResult, index: number): string {
  const title = (result.title || '(untitled)').trim();
  const url = (result.url || '').trim();
  const snippet = (result.content || result.snippet || '').trim();
  const lines = [`${index}. ${title}`];
  if (url) lines.push(`   URL: ${url}`);
  if (result.chunk_id) lines.push(`   ID: ${result.chunk_id}`);
  if (snippet) lines.push(`   ${snippet}`);
  return lines.join('\n');
}

function errorResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

async function main() {
  const server = new McpServer({
    name: 'searxng',
    version: '1.0.0',
  });

  server.tool(
    'web_search',
    `Search a SearXNG-compatible endpoint and return ranked results with titles, URLs and snippets.

Use this tool whenever the user asks to look something up, find references, or search documents/knowledge that is not already in the conversation.

Query syntax (mirrors the endpoint's parser):
- Boolean: AND (or &&), OR (or ||), NOT. Adjacent terms are AND-ed. Parentheses group sub-expressions.
- Quoted phrases: "exact phrase" (order-sensitive).
- Exclusion: a leading - (or full-width －) excludes a term, e.g. 发动机 -滑油.
- Field filters: filetype:pdf (alias ext:docx) restricts by file type; intitle:keyword restricts to section headings.
- Full-width delimiters （） and “” are accepted; an uppercase operator between two CJK characters is split out (e.g. 发动机OR滑油).
- + and - inside a term are NOT operators, so RAID-3260-10i and C++ stay searchable.

Notes:
- The endpoint defaults to a local SearXNG-compatible service, so results reflect that service's index.
- number_of_results is the total hit count (not the page size). strict_count is the number matching ALL conditions — when it is much smaller than number_of_results the query is broad, so switch to exact mode or tighten it.`,
    {
      query: z
        .string()
        .describe(
          'Search keywords. Supports AND (&&), OR (||), NOT, "quoted phrases", parentheses, a leading - exclusion (e.g. 发动机 -滑油), and field filters filetype:/ext:/intitle:.'
        ),
      mode: z
        .enum(['hybrid', 'exact', 'phrase'])
        .optional()
        .describe(
          'Search mode. hybrid (default) balances coverage and relevance; exact enforces every condition; phrase treats the whole query as one phrase.'
        ),
      top_k: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .describe('Maximum number of results to return (1-20). Defaults to 10.'),
      snippet_max_chars: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Maximum snippet length in characters. 0 means full text. Defaults to the endpoint value (300).'),
    },
    async ({ query, mode, top_k, snippet_max_chars }) => {
      const baseUrl = resolveBaseUrl();

      let url: URL;
      try {
        url = new URL('/search', baseUrl);
      } catch {
        return errorResult(`Invalid SearXNG endpoint URL: "${baseUrl}"`);
      }

      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      if (mode) url.searchParams.set('mode', mode);
      url.searchParams.set('pagesize', String(top_k ?? 10));
      if (snippet_max_chars !== undefined) {
        url.searchParams.set('snippet_max_chars', String(snippet_max_chars));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          return errorResult(`SearXNG search failed: HTTP ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as {
          results?: SearxngResult[];
          number_of_results?: number;
          strict_count?: number | null;
        };
        const results = Array.isArray(data.results) ? data.results : [];

        if (results.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No results found for "${query}".` }],
          };
        }

        const total = typeof data.number_of_results === 'number' ? data.number_of_results : results.length;
        const strict = typeof data.strict_count === 'number' ? data.strict_count : undefined;
        const breadth =
          strict !== undefined && strict < total
            ? ` [strict matches: ${strict}; query is broad — use exact mode or tighten it]`
            : '';
        const body = results.map((result, index) => formatResult(result, index + 1)).join('\n\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${total} result(s) for "${query}" (showing ${results.length})${breadth}:\n\n${body}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to reach the SearXNG endpoint at ${baseUrl}: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[SearxngMCP] Fatal error:', error);
  process.exit(1);
});
