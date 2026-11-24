/**
 * Chat attachments are filtered by their leading bytes before upload. A packed
 * PE keeps its MZ header even when renamed, and a ZIP is not necessarily a
 * docx — the filter must catch the first without rejecting the second.
 */

import { describe, expect, it, vi } from 'vitest';
import { verifyFileSignature } from '@/renderer/utils/file/fileType';

const fileOf = (name: string, header: readonly number[] | string): File => {
  const bytes = typeof header === 'string' ? new TextEncoder().encode(header) : new Uint8Array(header);
  return new File([bytes], name);
};

const ZIP = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('renamed executables are rejected whatever the extension says', () => {
  it('rejects a packed Windows binary named as an Office document', async () => {
    // UPX / ASPack / Themida keep the MZ DOS header after packing.
    await expect(verifyFileSignature(fileOf('report.docx', [0x4d, 0x5a, 0x90, 0x00]))).resolves.toEqual({
      ok: false,
      reason: 'executable',
    });
  });

  it('rejects an ELF renamed to a PDF', async () => {
    await expect(
      verifyFileSignature(fileOf('manual.pdf', [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]))
    ).resolves.toEqual({ ok: false, reason: 'executable' });
  });

  it('rejects an executable even when the claimed extension has no signature', async () => {
    // `.txt` normally passes through because text carries no magic bytes; the
    // executable blacklist must still win here.
    await expect(
      verifyFileSignature(fileOf('notes.txt', [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]))
    ).resolves.toEqual({ ok: false, reason: 'executable' });
  });

  it('rejects WebAssembly renamed to an image', async () => {
    await expect(verifyFileSignature(fileOf('chart.png', [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00]))).resolves.toEqual({
      ok: false,
      reason: 'executable',
    });
  });
});

describe('a signed extension must match the bytes', () => {
  it('accepts a real PDF', async () => {
    await expect(verifyFileSignature(fileOf('paper.pdf', '%PDF-1.7\n'))).resolves.toEqual({ ok: true });
  });

  it('accepts a real docx because it is a ZIP', async () => {
    // Distinguishing docx/xlsx/pptx needs the ZIP central directory; treating
    // them as one ZIP family is deliberate so normal Office files are not lost.
    await expect(verifyFileSignature(fileOf('report.docx', ZIP))).resolves.toEqual({ ok: true });
  });

  it('rejects a JPEG renamed to a document', async () => {
    await expect(verifyFileSignature(fileOf('report.docx', JPEG))).resolves.toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects a ZIP renamed to an image', async () => {
    await expect(verifyFileSignature(fileOf('picture.png', ZIP))).resolves.toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('accepts a WebP named .wav because both share the RIFF family', async () => {
    const riffWebp = [0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
    await expect(verifyFileSignature(fileOf('clip.wav', riffWebp))).resolves.toEqual({ ok: true });
  });

  it('matches an uppercase extension', async () => {
    await expect(verifyFileSignature(fileOf('LOGO.PNG', PNG))).resolves.toEqual({ ok: true });
  });

  it('rejects an empty file that claims to be a PNG', async () => {
    await expect(verifyFileSignature(fileOf('empty.png', ''))).resolves.toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('formats without a signature are left to the extension', () => {
  it('accepts plain text', async () => {
    await expect(verifyFileSignature(fileOf('notes.txt', 'just words'))).resolves.toEqual({ ok: true });
  });

  it('accepts an unknown extension', async () => {
    await expect(verifyFileSignature(fileOf('data.weird', ZIP))).resolves.toEqual({ ok: true });
  });

  it('does not block when the header cannot be read', async () => {
    const file = fileOf('a.png', PNG);
    vi.spyOn(file, 'slice').mockImplementation(() => {
      throw new Error('arrayBuffer unavailable');
    });
    await expect(verifyFileSignature(file)).resolves.toEqual({ ok: true });
  });
});
