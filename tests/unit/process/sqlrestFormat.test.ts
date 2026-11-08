import { describe, expect, it } from 'vitest';
import {
  buildCallRequest,
  DEFAULT_API_BASE_URL,
  DEFAULT_CACHE_SECONDS,
  discoveryUrls,
  formatResponseBody,
  GENERIC_TOOL_NAME,
  isSameOrigin,
  readSwaggerResources,
  readSwaggerUiUrls,
  reserveToolName,
  resolveConfig,
  resolveDocumentUrl,
  sanitizeToolName,
  toQueryString,
  type ApiToolSpec,
  type SqlrestConfig,
} from '@process/resources/builtinMcp/sqlrestFormat';

const baseConfig: SqlrestConfig = resolveConfig({});

describe('resolveConfig', () => {
  it('falls back to the local Gateway and keeps discovery on that origin', () => {
    expect(baseConfig.apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(baseConfig.discoveryOrigin).toBe('http://localhost:8091');
    expect(baseConfig.pathPrefix).toBe('/api/');
    expect(baseConfig.cacheSeconds).toBe(DEFAULT_CACHE_SECONDS);
    expect(baseConfig.discoveryEnabled).toBe(true);
    expect(baseConfig.allowCrossOrigin).toBe(false);
    expect(baseConfig.token).toBe('');
  });

  it('has no Manager credential fields at all', () => {
    expect(Object.keys(baseConfig)).not.toContain('managerUrl');
    expect(Object.keys(baseConfig)).not.toContain('managerToken');
    expect(Object.keys(baseConfig)).not.toContain('username');
    expect(Object.keys(baseConfig)).not.toContain('password');
  });

  it('ignores retired Manager variables even when they are still in the config', () => {
    const config = resolveConfig({
      SQLREST_MANAGER_URL: 'http://legacy:8090',
      SQLREST_USERNAME: 'admin',
      SQLREST_PASSWORD: 'secret',
      SQLREST_MANAGER_TOKEN: 'admin-token',
    });

    expect(JSON.stringify(config)).not.toContain('legacy');
    expect(JSON.stringify(config)).not.toContain('secret');
    expect(JSON.stringify(config)).not.toContain('admin');
  });

  it('supports an explicit document URL, prefix override and opt-outs', () => {
    const config = resolveConfig({
      SQLREST_OPENAPI_URL: 'http://127.0.0.1:8091/custom/docs.json',
      SQLREST_OPENAPI_PATH_PREFIX: 'v2/api',
      SQLREST_OPENAPI_DISABLE: '1',
      SQLREST_OPENAPI_ALLOW_CROSS_ORIGIN: 'true',
    });

    expect(config.openapiUrl).toBe('http://127.0.0.1:8091/custom/docs.json');
    expect(config.pathPrefix).toBe('/v2/api/');
    expect(config.discoveryEnabled).toBe(false);
    expect(config.allowCrossOrigin).toBe(true);
  });

  it('treats an empty prefix as "no prefix filter"', () => {
    expect(resolveConfig({ SQLREST_OPENAPI_PATH_PREFIX: '' }).pathPrefix).toBe('');
  });
});

describe('discoveryUrls', () => {
  it('probes the standard Gateway locations on the configured origin', () => {
    const urls = discoveryUrls(baseConfig);

    expect(urls[0]).toBe('http://localhost:8091/v3/api-docs');
    expect(urls).toContain('http://localhost:8091/v2/api-docs');
    expect(urls).toContain('http://localhost:8091/swagger-resources');
    expect(urls).toContain('http://localhost:8091/apidoc/index.html');
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('puts an explicit document URL first', () => {
    const config = resolveConfig({ SQLREST_OPENAPI_URL: 'http://localhost:8091/my-docs.json' });
    expect(discoveryUrls(config)[0]).toBe('http://localhost:8091/my-docs.json');
  });

  it('drops cross-origin candidates unless explicitly allowed', () => {
    const config = resolveConfig({ SQLREST_OPENAPI_URL: 'http://elsewhere.example/v3/api-docs' });

    expect(discoveryUrls(config)).not.toContain('http://elsewhere.example/v3/api-docs');
    expect(discoveryUrls({ ...config, allowCrossOrigin: true })[0]).toBe('http://elsewhere.example/v3/api-docs');
  });
});

describe('resolveDocumentUrl', () => {
  it('resolves relative locations against the Gateway origin', () => {
    expect(resolveDocumentUrl('/v2/api-docs?group=default', baseConfig)).toBe(
      'http://localhost:8091/v2/api-docs?group=default'
    );
  });

  it('refuses links to another origin and non-http schemes', () => {
    expect(resolveDocumentUrl('http://elsewhere.example/v2/api-docs', baseConfig)).toBeNull();
    expect(resolveDocumentUrl('file:///etc/passwd', baseConfig)).toBeNull();
    expect(resolveDocumentUrl('', baseConfig)).toBeNull();
  });

  it('recognises same-origin URLs', () => {
    expect(isSameOrigin('http://localhost:8091/apidoc/index.html', 'http://localhost:8091')).toBe(true);
    expect(isSameOrigin('http://elsewhere.example/v2/api-docs', 'http://localhost:8091')).toBe(false);
  });
});

describe('readSwaggerResources', () => {
  it('turns grouped locations into document URLs', () => {
    expect(
      readSwaggerResources(
        [
          { name: 'default', location: '/v2/api-docs?group=a', url: '/v2/api-docs?group=a' },
          { name: 'other', url: '/v3/api-docs' },
        ],
        baseConfig
      )
    ).toEqual(['http://localhost:8091/v2/api-docs?group=a', 'http://localhost:8091/v3/api-docs']);
  });

  it('never follows a cross-origin location embedded in the response', () => {
    expect(readSwaggerResources([{ location: 'http://elsewhere.example/v2/api-docs' }], baseConfig)).toEqual([]);
  });
});

describe('readSwaggerUiUrls', () => {
  it('extracts url, urls[] and configUrl from a Swagger UI page', () => {
    const html = `
      SwaggerUIBundle({ url: "/v2/api-docs", dom_id: "#swagger" });
      configUrl: "/v3/api-docs/swagger-config";
      urls: [{url: "/apidoc/group-a.json", name: "A"}];
    `;

    expect(readSwaggerUiUrls(html, baseConfig)).toEqual([
      'http://localhost:8091/v2/api-docs',
      'http://localhost:8091/v3/api-docs/swagger-config',
      'http://localhost:8091/apidoc/group-a.json',
    ]);
  });
});

describe('sanitizeToolName', () => {
  it('turns a slash-delimited path into a prefixed snake_case name', () => {
    expect(sanitizeToolName('user/list')).toBe('sqlrest_user_list');
    expect(sanitizeToolName('/order/query-by-id/')).toBe('sqlrest_order_query_by_id');
  });

  it('falls back to a stable name for paths without ASCII characters', () => {
    expect(sanitizeToolName('订单/查询')).toBe('sqlrest_api');
    expect(GENERIC_TOOL_NAME).toBe('sqlrest_call');
  });
});

describe('reserveToolName', () => {
  const spec: ApiToolSpec = {
    name: 'sqlrest_user_list',
    description: '',
    path: 'user/list',
    method: 'POST',
    pathVars: [],
    params: [],
    body: [],
  };

  it('uses the path-derived name while it is free', () => {
    expect(reserveToolName(spec, new Set())).toBe('sqlrest_user_list');
  });

  it('suffixes the method when GET and POST share a path, then gives up', () => {
    expect(reserveToolName(spec, new Set(['sqlrest_user_list']))).toBe('sqlrest_user_list_post');
    expect(reserveToolName(spec, new Set(['sqlrest_user_list', 'sqlrest_user_list_post']))).toBeNull();
  });
});

describe('toQueryString', () => {
  it('encodes values and skips empty ones', () => {
    expect(toQueryString({ id: 7, name: '张三', missing: undefined, empty: null })).toBe(
      `id=7&name=${encodeURIComponent('张三')}`
    );
  });

  it('serialises nested objects and returns an empty string without params', () => {
    expect(toQueryString({ filter: { a: 1 } })).toBe(`filter=${encodeURIComponent('{"a":1}')}`);
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
  });

  it('sends body as JSON for writes and lets it override params', () => {
    const request = buildCallRequest(baseConfig, 'order/query', 'POST', {
      params: { ignored: 1 },
      body: { id: 9 },
    });

    expect(request.headers['Content-Type']).toBe('application/json');
    expect(request.body).toBe('{"id":9}');
  });

  it('fills path placeholders and removes those keys from the query', () => {
    const request = buildCallRequest(baseConfig, 'order/{id}/items', 'GET', { params: { id: 'a b', page: 2 } }, ['id']);

    expect(request.url).toBe('http://localhost:8091/api/order/a%20b/items?page=2');
  });

  it('rejects missing or unresolved path parameters', () => {
    expect(() => buildCallRequest(baseConfig, 'order/{id}', 'GET', {}, ['id'])).toThrow(/Missing path parameter/);
    expect(() => buildCallRequest(baseConfig, 'order/{id}', 'GET', { params: { id: 1 } })).toThrow(
      /Unresolved path parameter/
    );
  });

  it('does not leak the bearer token when none is configured', () => {
    expect(buildCallRequest(baseConfig, 'user/list', 'GET').headers.Authorization).toBeUndefined();
  });
});

describe('formatResponseBody', () => {
  it('passes plain text through and pretty-prints JSON payloads', () => {
    expect(formatResponseBody('plain text')).toBe('plain text');
    expect(formatResponseBody({ code: 200 })).toBe('{\n  "code": 200\n}');
    expect(formatResponseBody(null)).toBe('');
  });
});
