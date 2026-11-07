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
import { buildSearchUrl, formatResult, formatSummary, resolveBaseUrl, type SearxngResult } from './searxngFormat';

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_TOP_K = 10;
const MAX_OFFSET = 200;

function errorResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

async function main() {
  const server = new McpServer({
    name: 'searxng',
    version: '1.1.0',
  });

  server.tool(
    'web_search',
    `Search a SearXNG-compatible endpoint and return ranked results with titles, source files, URLs and snippets.

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
- number_of_results is the total hit count (not the page size). strict_count is the number matching ALL conditions — when it is much smaller than number_of_results the query is broad, so switch to exact mode or tighten it.
- Each hit reports its FILE (the indexed document), a stable ID (same id = same chunk, use it to avoid repeating a hit across turns) and SCORE, where "N groups · BM25 x" means the hit covered N query term groups and x is the BM25 value inside that coverage band.
- Paging: top_k caps one page (max 20); pass offset to continue from the next hit.`,
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
        .describe(`Maximum number of results to return on this page (1-20). Defaults to ${DEFAULT_TOP_K}.`),
      offset: z
        .number()
        .int()
        .nonnegative()
        .max(MAX_OFFSET)
        .optional()
        .describe(
          `Number of leading hits to skip (0-${MAX_OFFSET}). Use total from a previous page to decide whether to continue. Defaults to 0.`
        ),
      snippet_max_chars: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Maximum snippet length in characters. 0 means full text. Defaults to the endpoint value (300).'),
      time_range: z
        .enum(['day', 'week', 'month', 'year'])
        .optional()
        .describe('Only return hits from files modified within this range (day/week/month/year).'),
    },
    async ({ query, mode, top_k, offset, snippet_max_chars, time_range }) => {
      const baseUrl = resolveBaseUrl(process.env.AIONUI_SEARXNG_URL);
      const topK = top_k ?? DEFAULT_TOP_K;
      const skip = offset ?? 0;

      let url: URL;
      try {
        url = buildSearchUrl({
          baseUrl,
          query,
          mode,
          // The endpoint pages from row 1, so ask for everything up to this page
          // and slice locally — that keeps `offset + top_k` semantics exact even
          // when `offset` is not a multiple of `top_k`.
          limit: skip + topK,
          snippetMaxChars: snippet_max_chars,
          timeRange: time_range,
        });
      } catch {
        return errorResult(`Invalid SearXNG endpoint URL: "${baseUrl}"`);
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
        const total = typeof data.number_of_results === 'number' ? data.number_of_results : results.length;

        if (results.length === 0) {
          const text =
            skip > 0
              ? `No results at offset ${skip} for "${query}" (total ${total}).`
              : `No results found for "${query}".`;
          return { content: [{ type: 'text' as const, text }] };
        }

        const page = results.slice(skip, skip + topK);
        const strict = typeof data.strict_count === 'number' ? data.strict_count : undefined;

        if (page.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No results at offset ${skip} for "${query}" (total ${total}).` }],
          };
        }

        const body = page.map((result, index) => formatResult(result, skip + index + 1)).join('\n\n');
        const summary = formatSummary({ query, total, strict, offset: skip, returned: page.length });

        return {
          content: [{ type: 'text' as const, text: `${summary}\n\n${body}` }],
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
