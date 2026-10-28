/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// aioncore's double-submit CSRF check runs in webui identity mode (standalone
// web / docker) and rejects every state-changing request whose `x-csrf-token`
// header does not echo the readable `aionui-csrf-token` cookie. These tests pin
// the helpers every transport must use — a transport that forgets them fails
// with a flat `403 CSRF_INVALID` in production (uploads, settings writes).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_CSRF_HEADER,
  applyCsrfHeadersToXhr,
  buildStateChangingHeaders,
  isCsrfRejection,
  resolveCoreCsrfToken,
} from '@/common/adapter/csrf';

const clearCsrfCookie = (): void => {
  document.cookie = 'aionui-csrf-token=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
};

afterEach(() => {
  clearCsrfCookie();
});

describe('resolveCoreCsrfToken', () => {
  it('returns the cookie value when the backend has set it', () => {
    document.cookie = 'aionui-csrf-token=abc123';
    expect(resolveCoreCsrfToken()).toBe('abc123');
  });

  it('returns an empty string when the cookie is absent', () => {
    clearCsrfCookie();
    expect(resolveCoreCsrfToken()).toBe('');
  });
});

describe('buildStateChangingHeaders', () => {
  it('omits the header when no token is available (desktop local mode)', () => {
    clearCsrfCookie();
    expect(buildStateChangingHeaders()).not.toHaveProperty(CORE_CSRF_HEADER);
  });

  it('echoes the token and keeps caller-supplied headers', () => {
    document.cookie = 'aionui-csrf-token=abc123';
    expect(buildStateChangingHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
      [CORE_CSRF_HEADER]: 'abc123',
    });
  });
});

describe('isCsrfRejection', () => {
  it('detects the backend CSRF error envelope on 403', () => {
    expect(isCsrfRejection(403, { code: 'CSRF_INVALID', error: 'CSRF token validation failed' })).toBe(true);
  });

  it('ignores other 403s and other statuses', () => {
    expect(isCsrfRejection(403, { code: 'FORBIDDEN' })).toBe(false);
    expect(isCsrfRejection(401, { code: 'CSRF_INVALID' })).toBe(false);
    expect(isCsrfRejection(403, 'CSRF token validation failed')).toBe(false);
  });
});

describe('applyCsrfHeadersToXhr', () => {
  it('sets one header per CSRF entry (multipart transports)', () => {
    document.cookie = 'aionui-csrf-token=abc123';
    const setRequestHeader = vi.fn();
    applyCsrfHeadersToXhr({ setRequestHeader });
    expect(setRequestHeader).toHaveBeenCalledWith(CORE_CSRF_HEADER, 'abc123');
  });

  it('sets nothing without a token', () => {
    clearCsrfCookie();
    const setRequestHeader = vi.fn();
    applyCsrfHeadersToXhr({ setRequestHeader });
    expect(setRequestHeader).not.toHaveBeenCalled();
  });
});
