/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PreviewContentType } from '@/common/types/office/preview';

interface FileTypeInfo {
  contentType: PreviewContentType;
  editable: boolean;
  language: string;
}

// 扩展名到类型的直接映射 / Direct extension to type mapping
//
// ⚠️ Must stay in step with `FILE_EXTENSION_MAP` in
// `pages/conversation/Preview/fileUtils.ts`. They are two implementations of the
// same judgement serving different entry points (this one: diff cards / message
// file changes; that one: explorer + local-file links), so a mapping that lands in
// only one makes the same file open differently depending on where it was clicked.
/**
 * Exported for the consistency test that checks this table against
 * `FILE_EXTENSION_MAP`. Read it for the key set only — resolution must go through
 * {@link getFileTypeInfo} so the fallback applies.
 */
export const EXTENSION_MAP: Record<string, FileTypeInfo> = {
  // Markdown
  md: { contentType: 'markdown', editable: true, language: 'markdown' },
  markdown: { contentType: 'markdown', editable: true, language: 'markdown' },
  mdown: { contentType: 'markdown', editable: true, language: 'markdown' },
  mkd: { contentType: 'markdown', editable: true, language: 'markdown' },
  // HTML
  html: { contentType: 'html', editable: true, language: 'html' },
  htm: { contentType: 'html', editable: true, language: 'html' },
  // Diff
  diff: { contentType: 'diff', editable: false, language: 'diff' },
  patch: { contentType: 'diff', editable: false, language: 'diff' },
  // PDF
  pdf: { contentType: 'pdf', editable: false, language: 'pdf' },
  // Office — only the OOXML formats officecli actually renders
  pptx: { contentType: 'ppt', editable: false, language: 'ppt' },
  docx: { contentType: 'word', editable: false, language: 'word' },
  xlsx: { contentType: 'excel', editable: false, language: 'excel' },
  // CSV is plain text (and officecli rejects it), so it renders as text
  csv: { contentType: 'csv', editable: true, language: 'csv' },
  // Identifiable but unrenderable: legacy Office binaries, ODF, macro-enabled
  // Office (officecli's watch path takes only pptx/docx/xlsx), and HEIC (no HEVC
  // decoder in Chromium). See FILE_EXTENSION_MAP for the full reasoning.
  doc: { contentType: 'unsupported', editable: false, language: 'doc' },
  xls: { contentType: 'unsupported', editable: false, language: 'xls' },
  ppt: { contentType: 'unsupported', editable: false, language: 'ppt' },
  odt: { contentType: 'unsupported', editable: false, language: 'odt' },
  ods: { contentType: 'unsupported', editable: false, language: 'ods' },
  odp: { contentType: 'unsupported', editable: false, language: 'odp' },
  docm: { contentType: 'unsupported', editable: false, language: 'docm' },
  xlsm: { contentType: 'unsupported', editable: false, language: 'xlsm' },
  pptm: { contentType: 'unsupported', editable: false, language: 'pptm' },
  heic: { contentType: 'unsupported', editable: false, language: 'heic' },
  // Image
  png: { contentType: 'image', editable: false, language: 'image' },
  jpg: { contentType: 'image', editable: false, language: 'image' },
  jpeg: { contentType: 'image', editable: false, language: 'image' },
  gif: { contentType: 'image', editable: false, language: 'image' },
  bmp: { contentType: 'image', editable: false, language: 'image' },
  webp: { contentType: 'image', editable: false, language: 'image' },
  svg: { contentType: 'image', editable: false, language: 'image' },
  ico: { contentType: 'image', editable: false, language: 'image' },
  tif: { contentType: 'image', editable: false, language: 'image' },
  tiff: { contentType: 'image', editable: false, language: 'image' },
  avif: { contentType: 'image', editable: false, language: 'image' },
};

/**
 * 根据文件名推断内容类型及是否可编辑
 * Determine preview content type and editability from file name
 */
export const getFileTypeInfo = (file_name: string): FileTypeInfo => {
  const ext = file_name.toLowerCase().split('.').pop() || '';
  return EXTENSION_MAP[ext] || { contentType: 'code', editable: true, language: ext || 'text' };
};

// Signature-based pre-upload filter for chat attachments.
//
// The extension alone cannot distinguish a real document from a renamed
// executable: a UPX / ASPack / Themida packed PE still starts with `MZ`, and a
// `.docx` that is actually a JPEG sails through an extension-only check. Only
// the first 64 bytes are read — enough for every signature below, and cheap
// even for large attachments.
//
// Two cases are rejected:
//   1. the bytes are an executable image, whatever the file is named;
//   2. the claimed extension has a known signature but the bytes do not match.
//
// Signature-less formats (plain text, Markdown, source code, CSV, ...) are left
// alone: there is nothing to compare, so the extension stays the source of
// truth there. A matching signature is not a safety guarantee — a crafted file
// can carry a valid header — this is a filter, not a sandbox.

type SignatureFamily = {
  readonly extensions: readonly string[];
  readonly matches: (bytes: Uint8Array) => boolean;
};

const ascii = (value: string): number[] => [...value].map((char) => char.charCodeAt(0));

const hasPrefix = (bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean => {
  if (bytes.length < offset + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[offset + i] !== prefix[i]) return false;
  }
  return true;
};

const hasAsciiPrefix = (bytes: Uint8Array, value: string, offset = 0): boolean =>
  hasPrefix(bytes, ascii(value), offset);

/**
 * Executable images are rejected regardless of the claimed extension. Packed
 * Windows binaries keep their MZ DOS header; ELF, Mach-O and WASM are equally
 * unmistakable. Java class files (`CAFEBABE`) are deliberately not treated as
 * Mach-O fat binaries to avoid rejecting a legitimate `.class` attachment.
 */
const EXECUTABLE_SIGNATURES: readonly (readonly number[])[] = [
  [0x4d, 0x5a], // MZ
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O, both endiannesses
  [0x00, 0x61, 0x73, 0x6d], // WASM
];

/**
 * Families group extensions that share one header, so a WebP named `.wav` is
 * not rejected merely because both are RIFF containers. Distinguishing docx /
 * xlsx / pptx would require reading the ZIP central directory, which is out of
 * scope for a 64-byte read; they are accepted as "a ZIP" and still catch an EXE
 * masquerading as an Office document.
 */
const SIGNATURE_FAMILIES: readonly SignatureFamily[] = [
  { extensions: ['pdf'], matches: (b) => hasAsciiPrefix(b, '%PDF-') },
  { extensions: ['png'], matches: (b) => hasPrefix(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { extensions: ['jpg', 'jpeg'], matches: (b) => hasPrefix(b, [0xff, 0xd8, 0xff]) },
  { extensions: ['gif'], matches: (b) => hasAsciiPrefix(b, 'GIF8') },
  { extensions: ['bmp'], matches: (b) => hasAsciiPrefix(b, 'BM') },
  {
    extensions: ['webp', 'wav', 'avi'],
    matches: (b) =>
      hasAsciiPrefix(b, 'RIFF') &&
      (hasAsciiPrefix(b, 'WEBP', 8) || hasAsciiPrefix(b, 'WAVE', 8) || hasAsciiPrefix(b, 'AVI ', 8)),
  },
  { extensions: ['ico'], matches: (b) => hasPrefix(b, [0x00, 0x00, 0x01, 0x00]) },
  {
    extensions: ['tif', 'tiff'],
    matches: (b) => hasPrefix(b, [0x49, 0x49, 0x2a, 0x00]) || hasPrefix(b, [0x4d, 0x4d, 0x00, 0x2a]),
  },
  // MP4 / M4A / HEIC / AVIF all carry `ftyp` at offset 4.
  { extensions: ['mp4', 'm4a', 'mov', 'heic', 'heif', 'avif'], matches: (b) => hasAsciiPrefix(b, 'ftyp', 4) },
  {
    extensions: ['zip', 'docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'odt', 'ods', 'odp'],
    matches: (b) =>
      hasPrefix(b, [0x50, 0x4b, 0x03, 0x04]) ||
      hasPrefix(b, [0x50, 0x4b, 0x05, 0x06]) ||
      hasPrefix(b, [0x50, 0x4b, 0x07, 0x08]),
  },
  { extensions: ['gz', 'tgz'], matches: (b) => hasPrefix(b, [0x1f, 0x8b]) },
  { extensions: ['7z'], matches: (b) => hasPrefix(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { extensions: ['rar'], matches: (b) => hasAsciiPrefix(b, 'Rar!\x1a\x07') },
  {
    extensions: ['mp3'],
    matches: (b) =>
      hasAsciiPrefix(b, 'ID3') ||
      hasPrefix(b, [0xff, 0xfb]) ||
      hasPrefix(b, [0xff, 0xf3]) ||
      hasPrefix(b, [0xff, 0xf2]),
  },
  { extensions: ['ogg'], matches: (b) => hasAsciiPrefix(b, 'OggS') },
  { extensions: ['flac'], matches: (b) => hasAsciiPrefix(b, 'fLaC') },
  { extensions: ['webm', 'mkv'], matches: (b) => hasPrefix(b, [0x1a, 0x45, 0xdf, 0xa3]) },
  // Legacy Office binaries (doc/xls/ppt) share the compound-file header with MSI.
  {
    extensions: ['doc', 'xls', 'ppt', 'msi', 'msg'],
    matches: (b) => hasPrefix(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  },
];

export type SignatureCheck = {
  readonly ok: boolean;
  readonly reason?: 'executable' | 'mismatch';
};

/**
 * Check the leading bytes of an attachment against its claimed extension.
 *
 * Smooths over the cases where a filter must not block a legitimate file:
 * signature-less formats pass through, as does a failed slice read (some
 * environments do not expose `Blob.arrayBuffer` on every File-like object).
 *
 * @param file The attachment about to be uploaded.
 */
export async function verifyFileSignature(file: File): Promise<SignatureCheck> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  } catch {
    return { ok: true };
  }

  if (EXECUTABLE_SIGNATURES.some((signature) => hasPrefix(bytes, signature))) {
    return { ok: false, reason: 'executable' };
  }

  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const family = SIGNATURE_FAMILIES.find((candidate) => candidate.extensions.includes(ext));
  if (!family) return { ok: true };

  return family.matches(bytes) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
