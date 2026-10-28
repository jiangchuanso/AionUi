import type { WebHostOptions, WebHostHandle, AdminCliConfig } from './types.js';

export type { AppMetadata, BackendBinaryResolver, WebHostOptions, WebHostHandle, AdminCliConfig } from './types.js';
export { startStaticServer, stopStaticServer } from './static-server.js';
export type { StaticServerOptions, StaticServerHandle } from './static-server.js';
export { handleAdminApiRequest, isAdminApiPath } from './admin-api.js';
export {
  SYSTEM_ADMIN_USER_ID,
  cliFailureToAdminError,
  parseUserListOutput,
  runAioncoreUserCli,
  type AdminUser,
} from './admin-cli.js';

// Backend launcher exports (M4)
export {
  BackendStartupCancelledError,
  BackendLifecycleManager,
  buildSpawnArgs,
  buildSpawnEnv,
  findAvailablePort,
  startBackend,
  stopBackend,
} from './backend-launcher.js';
export type { BackendDirConfig, BackendLaunchOptions, BackendHandle, BackendStartOptions } from './backend-launcher.js';

/**
 * Start WebHost (main entry point).
 *
 * Orchestrates backend-launcher + static-server. web-host itself holds no
 * persistent configuration — callers (Electron main process, `bun run webui`
 * CLI) are responsible for resolving port / allowRemote from their own source
 * of truth (Electron ProcessConfig, CLI flags, env vars).
 */
export async function startWebHost(opts: WebHostOptions): Promise<WebHostHandle> {
  const { startBackend } = await import('./backend-launcher.js');
  const { startStaticServer } = await import('./static-server.js');

  // 1. Start backend (M4)
  let backendHandle;
  // Admin CLI wiring: needed by the /api/auth/admin/* API in static-server.
  // ownBackend can derive it here; useExistingBackend hosts pass it in opts.
  let adminCli: AdminCliConfig | undefined;
  if (opts.backend.kind === 'ownBackend') {
    // Standalone web deployments (web-cli tarball, docker, `bun run webui`)
    // run in webui identity mode: real login sessions, per-user data
    // isolation. The desktop app never reaches this branch.
    backendHandle = await startBackend({
      app: opts.app,
      resolveBackend: opts.backend.resolveBackend,
      dataDir: opts.dataDir,
      logDir: opts.logDir,
      dirs: opts.dirs,
      identity: opts.identity ?? 'webui',
    });
    adminCli =
      opts.adminCli ??
      (opts.dataDir
        ? {
            binaryPath: opts.backend.resolveBackend(),
            dataDir: opts.dataDir,
            ...(opts.logDir ? { logDir: opts.logDir } : {}),
          }
        : undefined);
  } else {
    // useExistingBackend: create a fake handle
    backendHandle = {
      port: opts.backend.port,
      stop: async () => {
        // no-op: external backend
      },
    };
    adminCli = opts.adminCli ?? opts.backend.adminCli;
  }

  let staticHandle;
  try {
    // 2. Start static-server (M5)
    staticHandle = await startStaticServer({
      staticDir: opts.staticDir,
      backendPort: backendHandle.port,
      port: opts.port,
      allowRemote: opts.allowRemote ?? false,
      ...(adminCli ? { adminCli } : {}),
    });
  } catch (err) {
    // If static-server fails, clean up backend
    await backendHandle.stop();
    throw err;
  }

  // 3. Return combined handle
  return {
    port: staticHandle.port,
    backendPort: backendHandle.port,
    url: staticHandle.url,
    localUrl: staticHandle.localUrl,
    networkUrl: staticHandle.networkUrl,
    lanIP: staticHandle.lanIP,
    async stop() {
      await staticHandle.stop();
      await backendHandle.stop();
    },
  };
}
