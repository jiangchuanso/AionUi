#!/usr/bin/env node
/**
 * Build builtin MCP server scripts as fully self-contained CJS bundles.
 *
 * electron-vite's externalizeDepsPlugin leaves all npm packages as require()
 * calls, which works for Electron's main process (ASAR virtual FS patches
 * require()) but fails when an external `node` process runs the script from
 * app.asar.unpacked — there is no ASAR support there.
 *
 * This script uses esbuild's programmatic API (instead of CLI flags) to avoid
 * shell-quoting issues with special characters in --define values.
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs/promises');

const ROOT = path.resolve(__dirname, '..');

const SHARED_OPTIONS = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  loader: { '.wasm': 'empty' },
};

async function main() {
  await Promise.all([
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-image-gen.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/browserServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-browser.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/searxngServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-searxng.js'),
    }),
  ]);

  // Pin out/main to CommonJS. The web-host deployment's root package.json sets
  // "type": "module", which would otherwise make Node parse these CJS bundles as
  // ESM and crash with "require is not defined". A local package.json with
  // type:commonjs makes Node use the nearest package.json up the directory tree,
  // so the original .js paths keep working without renaming to .cjs.
  // Harmless for desktop, whose main bundle in out/main is also CJS.
  await fs.writeFile(
    path.join(ROOT, 'out/main/package.json'),
    JSON.stringify({ type: 'commonjs' }, null, 2) + '\n'
  );
}

main().catch((err) => {
  console.error('MCP server build failed:', err);
  process.exit(1);
});
