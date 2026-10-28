/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Regression: the multipart upload endpoint is state-changing, so aioncore's
// double-submit CSRF middleware (webui identity mode — standalone web / docker)
// answers it with `403 CSRF_INVALID` unless the request echoes the
// `aionui-csrf-token` cookie in `x-csrf-token`. Uploads went through raw
// XMLHttpRequest and never set the header, so every WebUI upload failed in
// production. The response is now also classified so the UI can tell the user
// their session token is stale instead of showing a bare 403.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileService, UPLOAD_CSRF_ERROR, UploadFailedError } from '@/renderer/services/FileService';

type FakeOutcome = { status: number; body: string };

let OUTCOMES: FakeOutcome[] = [];
let LAST_HEADERS: Record<string, string> = {};

class FakeXHR {
  status = 200;
  responseText = '';
  statusText = '';
  upload = { addEventListener: (_t: string, _cb: (() => void) | null) => {} };
  private loadCbs: Array<() => void> = [];
  open(): void {}
  setRequestHeader(name: string, value: string): void {
    LAST_HEADERS[name] = value;
  }
  addEventListener(type: string, cb: () => void): void {
    if (type === 'load') this.loadCbs.push(cb);
  }
  send(): void {
    const next = OUTCOMES.shift();
    if (next) {
      this.status = next.status;
      this.responseText = next.body;
      this.statusText = next.status === 403 ? 'Forbidden' : '';
    }
    for (const cb of this.loadCbs) cb();
  }
  abort(): void {}
}

function makeFileList(files: File[]): FileList {
  return Object.assign([...files], {
    length: files.length,
    item: (i: number) => files[i] ?? null,
  }) as unknown as FileList;
}

const ok = (data: string): FakeOutcome => ({ status: 200, body: JSON.stringify({ success: true, data }) });

describe('FileService upload CSRF handling', () => {
  beforeEach(() => {
    OUTCOMES = [];
    LAST_HEADERS = {};
    document.cookie = 'aionui-csrf-token=csrf-token-value';
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR as unknown;
  });

  afterEach(() => {
    document.cookie = 'aionui-csrf-token=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  });

  it('sends the double-submit header with the upload', async () => {
    OUTCOMES = [ok('/up/a.txt')];
    await FileService.processDroppedFiles(makeFileList([new File(['x'], 'a.txt', { type: 'text/plain' })]));
    expect(LAST_HEADERS['x-csrf-token']).toBe('csrf-token-value');
  });

  it('reports a CSRF rejection distinctly from a generic 403', async () => {
    OUTCOMES = [{ status: 403, body: JSON.stringify({ code: 'CSRF_INVALID', error: 'CSRF token validation failed' }) }];
    const error = await FileService.processDroppedFiles(
      makeFileList([new File(['x'], 'a.txt', { type: 'text/plain' })])
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UploadFailedError);
    expect((error as UploadFailedError).failed[0].message).toBe(UPLOAD_CSRF_ERROR);
  });

  it('keeps the status line for other 403s', async () => {
    OUTCOMES = [{ status: 403, body: JSON.stringify({ code: 'FORBIDDEN', error: 'Forbidden.' }) }];
    const error = await FileService.processDroppedFiles(
      makeFileList([new File(['x'], 'a.txt', { type: 'text/plain' })])
    ).catch((e: unknown) => e);

    expect((error as UploadFailedError).failed[0].message).toBe('Upload failed: 403 Forbidden');
  });
});
