import { describe, expect, it } from 'vitest';
import {
  buildSearchUrl,
  DEFAULT_BASE_URL,
  formatResult,
  formatScore,
  formatSummary,
  resolveBaseUrl,
} from '@process/resources/builtinMcp/searxngFormat';

describe('resolveBaseUrl', () => {
  it('falls back to the local endpoint when the variable is missing or empty', () => {
    expect(resolveBaseUrl(undefined)).toBe(DEFAULT_BASE_URL);
    expect(resolveBaseUrl('   ')).toBe(DEFAULT_BASE_URL);
  });

  it('trims whitespace and trailing slashes so paths stay absolute', () => {
    expect(resolveBaseUrl(' http://127.0.0.1:3826/ ')).toBe('http://127.0.0.1:3826');
  });
});

describe('buildSearchUrl', () => {
  it('sends every documented parameter', () => {
    const url = buildSearchUrl({
      baseUrl: 'http://127.0.0.1:3826',
      query: '发动机 -滑油',
      mode: 'exact',
      limit: 30,
      snippetMaxChars: 120,
      timeRange: 'month',
    });

    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('发动机 -滑油');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('mode')).toBe('exact');
    expect(url.searchParams.get('pagesize')).toBe('30');
    expect(url.searchParams.get('snippet_max_chars')).toBe('120');
    expect(url.searchParams.get('time_range')).toBe('month');
    // Never sent for the first page — the endpoint defaults to 1.
    expect(url.searchParams.has('pageno')).toBe(false);
  });

  it('omits optional parameters instead of sending empty values', () => {
    const url = buildSearchUrl({ baseUrl: 'http://127.0.0.1:3826', query: 'RAID', limit: 10 });

    expect(url.searchParams.has('mode')).toBe(false);
    expect(url.searchParams.has('snippet_max_chars')).toBe(false);
    expect(url.searchParams.has('time_range')).toBe(false);
    expect(url.searchParams.has('pageno')).toBe(false);
  });

  it('throws on a base URL that is not absolute', () => {
    expect(() => buildSearchUrl({ baseUrl: 'localhost:3826', query: 'x', limit: 10 })).toThrow();
  });
});

describe('formatScore', () => {
  it('splits the coverage band off the engine score', () => {
    expect(formatScore({ score: 2000001.25, band: 2 })).toBe('2 groups · BM25 1.25');
    expect(formatScore({ score: 1000003.5, band: 1 })).toBe('1 group · BM25 3.50');
  });

  it('keeps the bare score when no band was reported', () => {
    expect(formatScore({ score: 1.2345, band: 0 })).toBe('1.23');
    expect(formatScore({ score: 1.2345 })).toBe('1.23');
  });

  it('returns an empty string when the endpoint reported no score', () => {
    expect(formatScore({})).toBe('');
    expect(formatScore({ score: Number.NaN })).toBe('');
  });
});

describe('formatResult', () => {
  it('names the source file, score, chunk id and snippet of a hit', () => {
    const text = formatResult(
      {
        title: '3.2 润滑系统',
        url: 'doc://发动机手册.pdf#3-2',
        content: '滑油压力过低时…',
        chunk_id: 'doc:12',
        score: 2000002.5,
        band: 2,
        parsed_url: ['doc', '', '发动机手册.pdf', '', '', '3.2 润滑系统'],
      },
      4
    );

    expect(text).toContain('4. 3.2 润滑系统');
    expect(text).toContain('FILE: 发动机手册.pdf');
    expect(text).toContain('URL: doc://发动机手册.pdf#3-2');
    expect(text).toContain('SCORE: 2 groups · BM25 2.50');
    expect(text).toContain('ID: doc:12');
    expect(text).toContain('滑油压力过低时');
    // The title already is the section path, so repeating it adds nothing.
    expect(text).not.toContain('SECTION:');
  });

  it('shows the section when the title only carries the file name', () => {
    const text = formatResult(
      {
        title: '发动机手册.pdf',
        parsed_url: ['doc', '', '发动机手册.pdf', '', '', '3.2 润滑系统'],
      },
      1
    );

    expect(text).toContain('SECTION: 3.2 润滑系统');
    expect(text).not.toContain('FILE:');
    expect(text).not.toContain('SCORE:');
  });
});

describe('formatSummary', () => {
  it('reports the page window and how to continue', () => {
    const text = formatSummary({ query: 'RAID', total: 95, offset: 10, returned: 10 });

    expect(text).toBe('Found 95 result(s) for "RAID" (showing 11-20; pass offset=20 for more):');
  });

  it('flags broad queries when the strict count is smaller than the total', () => {
    const text = formatSummary({ query: '发动机 滑油', total: 420, strict: 3, offset: 0, returned: 3 });

    expect(text).toContain('showing 1-3');
    expect(text).toContain('strict matches: 3');
    expect(text).toContain('pass offset=3');
  });

  it('does not suggest another page when the last hit is on screen', () => {
    const text = formatSummary({ query: 'RAID', total: 12, offset: 10, returned: 2 });

    expect(text).toBe('Found 12 result(s) for "RAID" (showing 11-12):');
  });
});
