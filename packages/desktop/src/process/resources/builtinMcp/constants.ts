/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Keep this constant local to avoid pulling in common/config/storage side effects
// when the built-in MCP server boots in a standalone stdio process.
export const BUILTIN_IMAGE_GEN_ID = 'builtin-image-gen';
export const BUILTIN_IMAGE_GEN_NAME = 'aionui-image-generation';
export const BUILTIN_IMAGE_GEN_LEGACY_NAMES = ['AionUi Image Generation', BUILTIN_IMAGE_GEN_ID] as const;

export function isBuiltinImageGenName(name?: string | null): boolean {
  if (!name) return false;
  return (
    name === BUILTIN_IMAGE_GEN_NAME ||
    BUILTIN_IMAGE_GEN_LEGACY_NAMES.includes(name as (typeof BUILTIN_IMAGE_GEN_LEGACY_NAMES)[number])
  );
}

export function isBuiltinImageGenTransport(transport?: {
  type?: string;
  command?: string;
  args?: string[] | null;
}): boolean {
  if (!transport || transport.type !== 'stdio' || transport.command !== 'node') {
    return false;
  }

  return (transport.args || []).some((arg) => typeof arg === 'string' && arg.includes('builtin-mcp-image-gen.js'));
}

/** Stable ID / registered name of the built-in SearXNG-compatible search MCP server. */
export const BUILTIN_SEARXNG_ID = 'builtin-searxng';
export const BUILTIN_SEARXNG_NAME = 'searxng';

/** Entry script name (without `.js`) emitted by `scripts/build-mcp-servers.js`. */
export const BUILTIN_SEARXNG_SCRIPT = 'builtin-mcp-searxng';

/** Default local SearXNG-compatible endpoint and the env var used to override it. */
export const DEFAULT_SEARXNG_URL = 'http://localhost:3826';
export const SEARXNG_URL_ENV_KEY = 'AIONUI_SEARXNG_URL';

export function isBuiltinSearxngName(name?: string | null): boolean {
  return name === BUILTIN_SEARXNG_NAME || name === BUILTIN_SEARXNG_ID;
}

export function isBuiltinSearxngTransport(transport?: {
  type?: string;
  command?: string;
  args?: string[] | null;
}): boolean {
  if (!transport || transport.type !== 'stdio' || transport.command !== 'node') {
    return false;
  }

  return (transport.args || []).some((arg) => typeof arg === 'string' && arg.includes('builtin-mcp-searxng.js'));
}
