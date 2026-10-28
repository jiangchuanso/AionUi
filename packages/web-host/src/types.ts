// Core types for @aionui/web-host (M3 interface contract, locked for M4-M8)

/**
 * App metadata injected by host environment (Electron or Node)
 */
export type AppMetadata = {
  version: string;
  isPackaged: boolean;
  resourcesPath: string;
  userDataPath: string;
};

/**
 * Backend binary resolver function injected by host environment
 */
export type BackendBinaryResolver = () => string;

/**
 * aioncore identity mode for a spawned backend.
 *
 * - `local` — single embedded user, no authentication (desktop app mode).
 * - `webui` — real per-user sessions; every request is attributed to the
 *   signed-in user, giving multi-account data isolation (web / docker mode).
 */
export type BackendIdentityMode = 'local' | 'webui';

/**
 * How to reach the bundled aioncore binary for offline account management.
 *
 * The HTTP user-management endpoints (`/api/auth/internal/*`) are gated to
 * local mode inside aioncore and answer 403 in webui mode, so the admin API
 * served by web-host shells out to the `aioncore user ...` CLI against the
 * same data dir instead.
 */
export type AdminCliConfig = {
  /** Absolute path to the aioncore binary. */
  binaryPath: string;
  /** Data dir holding aionui-backend.db (the `--data-dir` the server uses). */
  dataDir: string;
  /** Optional log dir forwarded to the CLI (keeps logs next to the server's). */
  logDir?: string;
};

/**
 * System dirs exported to the backend via AIONUI_{CACHE,WORK,LOG}_DIR env.
 * Backend surfaces these on `/api/system/info`. Omit and the backend inherits
 * process.env, which may carry stale values from the parent shell — better to
 * be explicit.
 */
export type BackendSystemDirs = {
  cacheDir: string;
  workDir: string;
  logDir: string;
};

/**
 * Options for starting WebHost
 */
export type WebHostOptions = {
  app: AppMetadata;
  staticDir: string;
  port?: number;
  allowRemote?: boolean;
  dataDir?: string;
  logDir?: string;
  dirs?: BackendSystemDirs;
  /**
   * aioncore identity mode for a backend this WebHost spawns itself
   * (`ownBackend`). Defaults to `'webui'` — every ownBackend caller is a
   * standalone web deployment, and webui mode is what makes per-account
   * isolation work. Ignored for `useExistingBackend`.
   */
  identity?: BackendIdentityMode;
  backend:
    | { kind: 'ownBackend'; resolveBackend: BackendBinaryResolver }
    | ({ kind: 'useExistingBackend'; port: number } & { adminCli?: AdminCliConfig });
  /**
   * Admin CLI wiring for the `/api/auth/admin/*` user-management API. When
   * omitted with `ownBackend`, it is derived automatically from
   * `resolveBackend()` + `dataDir`. `useExistingBackend` hosts (desktop WebUI)
   * must pass it explicitly — web-host cannot see the desktop's binary path.
   */
  adminCli?: AdminCliConfig;
};

/**
 * Handle returned by startWebHost
 */
export type WebHostHandle = {
  port: number;
  backendPort: number;
  url: string;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  stop: () => Promise<void>;
};
