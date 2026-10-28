/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSession } from '@/common/adapter/sessionRefresh';

type WindowWithPort = { __backendPort?: number };

describe('refreshSession (WebUI session refresh)', () => {
  beforeEach(() => {
    // Browser mode: real DOM (jsdom) with no Electron preload port.
    delete (window as WindowWithPort).__backendPort;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as WindowWithPort).__backendPort;
  });

  it('POSTs /api/auth/refresh as JSON and resolves true on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSession()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/refresh');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    // The backend's refresh handler takes a JSON body extractor, so a bodyless
    // POST is answered with 415 and every session dies on access-cookie expiry.
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.body).toBe('{}');
  });

  it('sends no x-csrf-token header when the CSRF cookie is absent', async () => {
    document.cookie = 'aionui-csrf-token=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSession()).resolves.toBe(true);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers ?? {}).not.toHaveProperty('x-csrf-token');
  });

  it('sends the x-csrf-token double-submit header when the CSRF cookie is present', async () => {
    // The backend sets this cookie on its first response; standalone web /
    // docker deployments (webui identity mode) enforce the check on POST too.
    document.cookie = 'aionui-csrf-token=abc123';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSession()).resolves.toBe(true);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({ 'x-csrf-token': 'abc123' });
  });

  it('resolves false when the refresh token is also expired (non-ok response)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(refreshSession()).resolves.toBe(false);
  });

  it('resolves false (never throws) on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(refreshSession()).resolves.toBe(false);
  });

  it('single-flights concurrent callers into one POST, then refreshes anew afterwards', async () => {
    let resolveFetch: (value: { ok: boolean }) => void = () => {};
    const pending = new Promise<{ ok: boolean }>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const first = refreshSession();
    const second = refreshSession();
    // Both callers share the same in-flight request.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true });
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    // In-flight promise cleared after settling — a later call refreshes again.
    await expect(refreshSession()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is a no-op (no fetch) outside WebUI browser mode', async () => {
    (window as WindowWithPort).__backendPort = 13400;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSession()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
