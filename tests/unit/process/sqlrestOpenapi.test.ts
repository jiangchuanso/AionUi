import { describe, expect, it } from 'vitest';
import { isOpenApiDocument, parseOpenApiDocument, resolveConfig } from '@process/resources/builtinMcp/sqlrestFormat';

const config = resolveConfig({});

const swagger2 = {
  swagger: '2.0',
  basePath: '/api',
  paths: {
    '/user/list': {
      get: {
        summary: 'List users',
        parameters: [
          { name: 'page', in: 'query', type: 'integer', required: false, description: 'Page number' },
          { name: 'status', in: 'query', type: 'string', required: true, enum: ['on', 'off'] },
        ],
      },
      post: {
        summary: 'Create user',
        parameters: [
          {
            name: 'body',
            in: 'body',
            required: true,
            schema: { $ref: '#/definitions/UserInput' },
          },
        ],
      },
    },
    '/order/{id}': {
      get: { parameters: [{ name: 'id', in: 'path', type: 'integer', required: true }] },
    },
    '/actuator/health': { get: { summary: 'Framework endpoint' } },
    '/user/login': { post: { summary: 'Login endpoint' } },
  },
  definitions: {
    UserInput: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'User name' },
        age: { type: 'integer' },
      },
    },
  },
};

describe('isOpenApiDocument', () => {
  it('recognises a paths object and rejects unrelated payloads', () => {
    expect(isOpenApiDocument(swagger2)).toBe(true);
    expect(isOpenApiDocument({ swagger: '2.0' })).toBe(false);
    expect(isOpenApiDocument([{ name: 'default', location: '/v2/api-docs' }])).toBe(false);
  });
});

describe('parseOpenApiDocument (Swagger 2)', () => {
  it('only exposes documented API paths, not framework endpoints', () => {
    const specs = parseOpenApiDocument(swagger2, config);

    expect(specs).toHaveLength(3);
    expect(specs.map((spec) => spec.path)).toEqual(['user/list', 'user/list', 'order/{id}']);
    expect(specs.map((spec) => spec.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('maps query parameters with types, required flags and enums', () => {
    const get = parseOpenApiDocument(swagger2, config)[0];

    expect(get.params).toEqual([
      { name: 'page', location: 'query', type: 'integer', required: false, description: 'Page number' },
      { name: 'status', location: 'query', type: 'string', required: true, enum: ['on', 'off'] },
    ]);
    expect(get.description).toContain('List users');
    expect(get.description).toContain('(GET /api/user/list)');
    expect(get.name).toBe('sqlrest_user_list');
  });

  it('resolves body $refs into individual documented fields', () => {
    const post = parseOpenApiDocument(swagger2, config)[1];

    expect(post.body).toEqual([
      { name: 'name', location: 'body', type: 'string', required: true, description: 'User name' },
      { name: 'age', location: 'body', type: 'integer', required: false },
    ]);
  });

  it('records path placeholders and synthesises missing path parameters', () => {
    const order = parseOpenApiDocument(swagger2, config)[2];

    expect(order.pathVars).toEqual(['id']);
    expect(order.params).toEqual([{ name: 'id', location: 'path', type: 'integer', required: true }]);
  });
});

describe('parseOpenApiDocument (OpenAPI 3)', () => {
  const openapi3 = {
    openapi: '3.0.3',
    servers: [{ url: 'http://localhost:8091/api' }],
    paths: {
      '/api/order/query': {
        post: {
          summary: 'Query orders',
          parameters: [{ name: 'trace', in: 'header', schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/OrderQuery' } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        OrderQuery: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'integer' },
            tags: { type: 'array' },
          },
        },
      },
    },
  };

  it('uses servers[].url as the base path and reads requestBody', () => {
    const specs = parseOpenApiDocument(openapi3, config);

    expect(specs).toHaveLength(1);
    expect(specs[0].path).toBe('order/query');
    expect(specs[0].params).toEqual([]);
    expect(specs[0].body).toEqual([
      { name: 'id', location: 'body', type: 'integer', required: true },
      { name: 'tags', location: 'body', type: 'array', required: false },
    ]);
  });

  it('honours a custom path prefix', () => {
    expect(parseOpenApiDocument(openapi3, { ...config, pathPrefix: '/v2/' })).toEqual([]);
    expect(parseOpenApiDocument(openapi3, { ...config, pathPrefix: '/api/order/' })[0].path).toBe('query');
  });
});

describe('parseOpenApiDocument filtering', () => {
  it('still excludes framework paths when the prefix filter is disabled', () => {
    const document = {
      swagger: '2.0',
      paths: {
        '/health': { get: { summary: 'Business health' } },
        '/actuator/health': { get: {} },
        '/swagger-resources': { get: {} },
        '/v2/api-docs': { get: {} },
      },
    };

    expect(parseOpenApiDocument(document, { ...config, pathPrefix: '' }).map((spec) => spec.path)).toEqual(['health']);
  });

  it('returns nothing for a payload without paths', () => {
    expect(parseOpenApiDocument(null, config)).toEqual([]);
    expect(parseOpenApiDocument({ paths: 'nope' }, config)).toEqual([]);
  });
});
