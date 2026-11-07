import { describe, expect, it } from 'vitest';
import {
  buildCallRequest,
  DEFAULT_API_BASE_URL,
  DEFAULT_CACHE_SECONDS,
  DEFAULT_MANAGER_URL,
  DEFAULT_PAGE_SIZE,
  describeApi,
  formatResponseBody,
  GENERIC_TOOL_NAME,
  readApiPage,
  reserveToolName,
  resolveConfig,
  sanitizeToolName,
  shouldFetchNextPage,
  toQueryString,
  type ApiToolSpec,
  type SqlrestConfig,
} from '@process/resources/builtinMcp/sqlrestFormat';

const baseConfig: SqlrestConfig = resolveConfig({});

describe('resolveConfig', () => {
  it('falls back to the local SQLREST ports when nothing is set', () => {
    expect(baseConfig.apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(baseConfig.managerUrl).toBe(DEFAULT_MANAGER_URL);
    expect(baseConfig.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(baseConfig.cacheSeconds).toBe(DEFAULT_CACHE_SECONDS);
    expect(baseConfig.username).toBe('admin');
    expect(baseConfig.password).toBe('123456');
    expect(baseConfig.token).toBe('');
  });

  it('trims whitespace and trailing slashes so paths stay absolute', () => {
    const config = resolveConfig({
      SQLREST_API_BASE_URL: ' http://127.0.0.1:8092/api/ ',
      SQLREST_MANAGER_URL: 'http://127.0.0.1:8090//',
    });

    expect(config.apiBaseUrl).toBe('http://127.0.0.1:8092/api');
    expect(config.managerUrl).toBe('http://127.0.0.1:8090');
  });

  it('treats an explicitly empty manager URL as "discovery disabled"', () => {
    expect(resolveConfig({ SQLREST_MANAGER_URL: '' }).managerUrl).toBe('');
    expect(resolveConfig({ SQLREST_MANAGER_URL: '   ' }).managerUrl).toBe('');
  });

  it('ignores unusable numbers instead of producing NaN', () => {
    const config = resolveConfig({ SQLREST_PAGE_SIZE: 'lots', SQLREST_CACHE_SECONDS: '0' });

    expect(config.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(config.cacheSeconds).toBe(DEFAULT_CACHE_SECONDS);
  });
});

describe('sanitizeToolName', () => {
  it('turns a slash-delimited path into a prefixed snake_case name', () => {
    expect(sanitizeToolName('user/list')).toBe('sqlrest_user_list');
    expect(sanitizeToolName('/order/query-by-id/')).toBe('sqlrest_order_query_by_id');
  });

  it('falls back to a stable name for paths without ASCII characters', () => {
    expect(sanitizeToolName('订单/查询')).toBe('sqlrest_api');
    // Reserved for the generic fallback, and used as the empty-path default.
    expect(GENERIC_TOOL_NAME).toBe('sqlrest_call');
  });
});

describe('describeApi', () => {
  it('normalises path, method and description', () => {
    const spec = describeApi({ name: 'User list', description: 'list users', path: '/user/list', method: 'post' });

    expect(spec).toEqual({
      name: 'sqlrest_user_list',
      description: 'User list — list users — (POST /api/user/list)',
      path: 'user/list',
      method: 'POST',
    });
  });

  it('defaults the method to GET and drops records without a path', () => {
    expect(describeApi({ path: 'user/list' })?.method).toBe('GET');
    expect(describeApi({ name: 'orphan' })).toBeNull();
    expect(describeApi({ path: '///' })).toBeNull();
  });
});

describe('reserveToolName', () => {
  const spec: ApiToolSpec = { name: 'sqlrest_user_list', description: '', path: 'user/list', method: 'POST' };

  it('uses the path-derived name while it is free', () => {
    expect(reserveToolName(spec, new Set())).toBe('sqlrest_user_list');
  });

  it('suffixes the method when GET and POST share a path', () => {
    expect(reserveToolName(spec, new Set(['sqlrest_user_list']))).toBe('sqlrest_user_list_post');
  });

  it('gives up once both candidates are taken', () => {
    expect(reserveToolName(spec, new Set(['sqlrest_user_list', 'sqlrest_user_list_post']))).toBeNull();
  });
});

describe('toQueryString', () => {
  it('encodes values and skips empty ones', () => {
    expect(toQueryString({ id: 7, name: '张三', missing: undefined, empty: null })).toBe(
      `id=7&name=${encodeURIComponent('张三')}`
    );
  });

  it('serialises nested objects instead of dropping them', () => {
    expect(toQueryString({ filter: { a: 1 } })).toBe(`filter=${encodeURIComponent('{"a":1}')}`);
  });

  it('returns an empty string without params', () => {
    expect(toQueryString()).toBe('');
  });
});

describe('buildCallRequest', () => {
  it('appends params as a query string for GET and adds the bearer token', () => {
    const request = buildCallRequest({ ...baseConfig, token: 'abc' }, '/user/list', 'get', { params: { page: 2 } });

    expect(request.url).toBe('http://localhost:8091/api/user/list?page=2');
    expect(request.method).toBe('GET');
    expect(request.body).toBeUndefined();
    expect(request.headers.Authorization).toBe('Bearer abc');
    expect(request.headers.Accept).toBe('application/json');
  });

  it('omits the query string when there are no params', () => {
    expect(buildCallRequest(baseConfig, 'user/list', 'GET').url).toBe('http://localhost:8091/api/user/list');
  });

  it('sends body as JSON for writes and lets it override params', () => {
    const request = buildCallRequest(baseConfig, 'order/query', 'POST', {
      params: { ignored: 1 },
      body: { id: 9 },
    });

    expect(request.method).toBe('POST');
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(request.body).toBe('{"id":9}');
  });

  it('falls back to params for writes and omits the body when both are empty', () => {
    expect(buildCallRequest(baseConfig, 'order/query', 'POST', { params: { id: 3 } }).body).toBe('{"id":3}');
    expect(buildCallRequest(baseConfig, 'order/query', 'PUT').body).toBeUndefined();
  });

  it('does not leak the bearer token when none is configured', () => {
    expect(buildCallRequest(baseConfig, 'user/list', 'GET').headers.Authorization).toBeUndefined();
  });
});

describe('readApiPage', () => {
  it('unwraps the Manager envelope and its pagination total', () => {
    expect(readApiPage({ data: [{ path: 'a/b' }], pagination: { total: 42 } })).toEqual({
      apis: [{ path: 'a/b' }],
      total: 42,
    });
  });

  it('falls back to the page length when pagination is missing', () => {
    expect(readApiPage({ data: [{ path: 'a/b' }, { path: 'c/d' }] })).toEqual({
      apis: [{ path: 'a/b' }, { path: 'c/d' }],
      total: 2,
    });
  });

  it('returns an empty page for unexpected payloads', () => {
    expect(readApiPage(null)).toEqual({ apis: [], total: 0 });
    expect(readApiPage({ data: 'nope' }).apis).toEqual([]);
  });
});

describe('shouldFetchNextPage', () => {
  it('continues while rows are missing', () => {
    expect(shouldFetchNextPage(1000, 2500, 1000)).toBe(true);
  });

  it('stops on the last page or an empty page', () => {
    expect(shouldFetchNextPage(2500, 2500, 500)).toBe(false);
    expect(shouldFetchNextPage(0, 10, 0)).toBe(false);
  });
});

describe('formatResponseBody', () => {
  it('passes plain text through unchanged', () => {
    expect(formatResponseBody('plain text')).toBe('plain text');
  });

  it('pretty-prints JSON payloads and blanks out empty ones', () => {
    expect(formatResponseBody({ code: 200 })).toBe('{\n  "code": 200\n}');
    expect(formatResponseBody(null)).toBe('');
    expect(formatResponseBody(undefined)).toBe('');
  });
});
