/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CSRF double-submit helpers for the aioncore HTTP API.
 *
 * aioncore enforces a double-submit check (`x-csrf-token` header must equal the
 * readable `aionui-csrf-token` cookie) on every state-changing request whenever
 * it runs in `webui` identity mode — the mode standalone web / docker
 * deployments use for per-user data isolation. The desktop app talks to a
 * local-mode backend that has no CSRF layer, no cookie and therefore no header.
 *
 * Every transport that issues a non-GET request must attach these headers:
 *   - `httpRequest` (fetch, JSON)            → httpBridge.ts
 *   - `POST /api/auth/refresh` (fetch)       → sessionRefresh.ts
 *   - `POST /api/fs/upload` (XHR, multipart) → FileService.ts
 *   - `POST /api/stt` (XHR, multipart)       → SpeechToTextService.ts
 *   - `PUT /api/settings/client` (fetch)     → common/config/configService.ts
 * A transport that forgets them gets a flat `403 CSRF_INVALID` for every write,
 * which is what made uploads and settings writes fail in production.
 *
 * Kept as a leaf module (no imports) so both the HTTP bridge and the refresh
 * primitive can share it without creating an import cycle.
 */

/** Cookie the backend's CSRF middleware sets; mirrors aionui-auth csrf.rs. */
export const CSRF_COOKIE_NAME = 'aionui-csrf-token';

/** Header name for the double-submit token. */
export const CORE_CSRF_HEADER = 'x-csrf-token';

/** Backend error code returned when the double-submit check fails. */
export const CSRF_INVALID_CODE = 'CSRF_INVALID';

/**
 * Read a cookie value from `document.cookie` (browser mode only).
 * Returns '' when absent — the desktop renderer has no such cookie.
 */
function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  for (const part of document.cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

/**
 * Resolve the Core CSRF double-submit token for the current context.
 *
 * The cookie is set by the backend on its first response and is deliberately
 * NOT HttpOnly so the SPA can echo it back in the header. Returns '' outside
 * browser mode or before any backend response has set the cookie; callers then
 * omit the header, which is correct for the desktop's local-mode backend.
 */
export function resolveCoreCsrfToken(): string {
  return readCookie(CSRF_COOKIE_NAME);
}

/** True when the backend rejected a request because of the CSRF check. */
export function isCsrfRejection(status: number, body: unknown): boolean {
  if (status !== 403) return false;
  if (!body || typeof body !== 'object') return false;
  return (body as { code?: unknown }).code === CSRF_INVALID_CODE;
}

/** Headers to attach to a state-changing request, including CSRF when present. */
export function buildStateChangingHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const csrfToken = resolveCoreCsrfToken();
  if (csrfToken) {
    headers[CORE_CSRF_HEADER] = csrfToken;
  }
  return headers;
}

/**
 * Mirror of {@link buildStateChangingHeaders} for XMLHttpRequest transports,
 * which need one `setRequestHeader` call per entry. Must be called after
 * `open()` and before `send()`.
 */
export function applyCsrfHeadersToXhr(xhr: Pick<XMLHttpRequest, 'setRequestHeader'>): void {
  for (const [name, value] of Object.entries(buildStateChangingHeaders())) {
    xhr.setRequestHeader(name, value);
  }
}
