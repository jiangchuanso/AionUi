/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers behind the built-in SearXNG MCP server: endpoint resolution,
 * request URL building and result formatting. Kept apart from the stdio server
 * so the behaviour can be unit-tested without spawning an MCP process.
 */

export const DEFAULT_BASE_URL = 'http://localhost:3826';

/**
 * The endpoint scores `matched term groups × COVERAGE_UNIT + BM25`, so
 * `band === score // COVERAGE_UNIT` and the BM25 part is the remainder.
 */
const COVERAGE_UNIT = 1e6;

export type SearxngResult = {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
  engine?: string;
  /** Stable chunk id ("doc:index") — dedupes hits that share a URL/section. */
  chunk_id?: string;
  /** Engine score; higher is better and matches the returned order. */
  score?: number;
  /** Number of matched query term groups (0 when the engine reported none). */
  band?: number;
  /** `["doc", "", docName, "", "", sectionPath]` — the source file of the hit. */
  parsed_url?: string[];
};

export type SearchUrlRequest = {
  baseUrl: string;
  query: string;
  mode?: string;
  /** Rows to ask for: `offset + top_k` — the endpoint always pages from row 1. */
  limit: number;
  /** 1-based page; only sent when greater than 1. */
  pageno?: number;
  snippetMaxChars?: number;
  /** `day` / `week` / `month` / `year` — the endpoint filters by file mtime. */
  timeRange?: string;
};

export type ResultSummary = {
  query: string;
  /** Total hit count, independent of the page that was fetched. */
  total: number;
  /** Hits matching every condition; smaller than `total` means a broad query. */
  strict?: number;
  offset: number;
  returned: number;
};

export function resolveBaseUrl(raw?: string | null): string {
  const value = (raw ?? '').trim() || DEFAULT_BASE_URL;
  return value.replace(/\/+$/, '');
}

/** Throws when the base URL is not an absolute URL. */
export function buildSearchUrl(request: SearchUrlRequest): URL {
  const url = new URL('/search', request.baseUrl);
  url.searchParams.set('q', request.query);
  url.searchParams.set('format', 'json');
  if (request.mode) url.searchParams.set('mode', request.mode);
  if (request.pageno !== undefined && request.pageno > 1) url.searchParams.set('pageno', String(request.pageno));
  if (request.timeRange) url.searchParams.set('time_range', request.timeRange);
  url.searchParams.set('pagesize', String(request.limit));
  if (request.snippetMaxChars !== undefined) {
    url.searchParams.set('snippet_max_chars', String(request.snippetMaxChars));
  }
  return url;
}

function docNameOf(result: SearxngResult): string {
  return (result.parsed_url?.[2] || '').trim();
}

function sectionPathOf(result: SearxngResult): string {
  return (result.parsed_url?.[5] || '').trim();
}

/** `"2 groups · BM25 1.23"` for banded hits, the bare score otherwise. */
export function formatScore(result: SearxngResult): string {
  const score = result.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) return '';
  const band = typeof result.band === 'number' && result.band > 0 ? Math.floor(result.band) : 0;
  if (band > 0) {
    const bm25 = Math.max(0, score - band * COVERAGE_UNIT);
    return `${band} group${band === 1 ? '' : 's'} · BM25 ${bm25.toFixed(2)}`;
  }
  return score.toFixed(2);
}

/** `position` is the global rank, so paging keeps the numbering continuous. */
export function formatResult(result: SearxngResult, position: number): string {
  const title = (result.title || '(untitled)').trim();
  const url = (result.url || '').trim();
  const snippet = (result.content || result.snippet || '').trim();
  const docName = docNameOf(result);
  const sectionPath = sectionPathOf(result);

  const lines = [`${position}. ${title}`];
  // `title` is the section path (or the file name when the hit has no section),
  // so the file is only extra information when it differs.
  if (docName && docName !== title) lines.push(`   FILE: ${docName}`);
  if (sectionPath && sectionPath !== title) lines.push(`   SECTION: ${sectionPath}`);
  if (url) lines.push(`   URL: ${url}`);
  const score = formatScore(result);
  if (score) lines.push(`   SCORE: ${score}`);
  if (result.chunk_id) lines.push(`   ID: ${result.chunk_id}`);
  if (snippet) lines.push(`   ${snippet}`);
  return lines.join('\n');
}

export function formatSummary(summary: ResultSummary): string {
  const { query, total, strict, offset, returned } = summary;
  const range = returned > 0 ? `showing ${offset + 1}-${offset + returned}` : 'no hits on this page';
  const breadth =
    strict !== undefined && strict < total
      ? `; strict matches: ${strict} — query is broad, use exact mode or tighten it`
      : '';
  const next = offset + returned < total ? `; pass offset=${offset + returned} for more` : '';
  return `Found ${total} result(s) for "${query}" (${range}${breadth}${next}):`;
}
