/**
 * Tests for FileService.processDroppedFiles upload failure reporting.
 *
 * Regresses the bug where non-size upload errors (network / 5xx) were silently
 * swallowed in WebUI / Docker, leaving the "Upload from device" UI with no
 * feedback at all. processDroppedFiles must now throw UploadFailedError so the
 * callers can surface a message and still attach the files that succeeded.
 */

import { describe, it, expect } from 'vitest';
import { FileService, UploadFailedError } from '@/renderer/services/FileService';

interface FakeOutcome {
  status: number;
  body: string;
}

// uploadFileViaHttp uses the global XMLHttpRequest, which the node test runtime
// does not provide. We inject a fake that consumes a queue of outcomes, one per
// upload call, in order.
let OUTCOMES: FakeOutcome[] = [];

class FakeXHR {
  status = 200;
  responseText = '';
  upload = { addEventListener: (_t: string, _cb: (() => void) | null) => {} };
  private loadCbs: Array<() => void> = [];
  open(): void {}
  // Uploads now attach CSRF headers; the node-env token resolves to '' so this
  // is a no-op here. The CSRF header assertions live in FileService.csrf.dom.test.ts.
  setRequestHeader(_name: string, _value: string): void {}
  addEventListener(type: string, cb: () => void): void {
    if (type === 'load') this.loadCbs.push(cb);
  }
  send(): void {
    const next = OUTCOMES.shift();
    if (next) {
      this.status = next.status;
      this.responseText = next.body;
    }
    for (const cb of this.loadCbs) cb();
  }
  abort(): void {}
}

async function runWithFakeXhr<T>(fn: () => Promise<T>): Promise<T> {
  const prev = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR as unknown;
  try {
    return await fn();
  } finally {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = prev;
  }
}

function makeFileList(files: File[]): FileList {
  return Object.assign([...files], {
    length: files.length,
    item: (i: number) => files[i] ?? null,
  }) as unknown as FileList;
}

const ok = (data: string): FakeOutcome => ({ status: 200, body: JSON.stringify({ success: true, data }) });
const fail = (): FakeOutcome => ({ status: 500, body: JSON.stringify({ success: false }) });

describe('FileService.processDroppedFiles upload failure reporting', () => {
  it('throws UploadFailedError when all uploads fail (no silent drop)', async () => {
    OUTCOMES = [fail(), fail()];
    await runWithFakeXhr(async () => {
      const list = makeFileList([
        new File(['x'], 'a.txt', { type: 'text/plain' }),
        new File(['y'], 'b.txt', { type: 'text/plain' }),
      ]);
      const err = await FileService.processDroppedFiles(list).catch((e) => e);
      expect(err).toBeInstanceOf(UploadFailedError);
      const e = err as UploadFailedError;
      expect(e.failed).toHaveLength(2);
      expect(e.processed).toHaveLength(0);
    });
  });

  it('returns uploaded files on success', async () => {
    OUTCOMES = [ok('/up/a.txt')];
    await runWithFakeXhr(async () => {
      const list = makeFileList([new File(['x'], 'a.txt', { type: 'text/plain' })]);
      const result = await FileService.processDroppedFiles(list);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/up/a.txt');
    });
  });

  it('carries partial successes when only some uploads fail', async () => {
    OUTCOMES = [ok('/up/ok.txt'), fail()];
    await runWithFakeXhr(async () => {
      const list = makeFileList([
        new File(['x'], 'ok.txt', { type: 'text/plain' }),
        new File(['y'], 'bad.txt', { type: 'text/plain' }),
      ]);
      const err = await FileService.processDroppedFiles(list).catch((e) => e);
      expect(err).toBeInstanceOf(UploadFailedError);
      const e = err as UploadFailedError;
      expect(e.processed).toHaveLength(1);
      expect(e.processed[0].path).toBe('/up/ok.txt');
      expect(e.failed).toHaveLength(1);
      expect(e.failed[0].name).toBe('bad.txt');
    });
  });
});
