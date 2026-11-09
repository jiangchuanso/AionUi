#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { prepareAioncore } = require('../packages/shared-scripts/src/prepare-aioncore.js');
const { resolveAioncoreRepo, resolveAioncoreVersion } = require('./resolveAioncoreVersion.js');

const projectRoot = path.resolve(__dirname, '..');
const platform = process.env.PACK_PLATFORM || process.platform;
const arch = process.env.PACK_ARCH || process.arch;
const version = require('../package.json').version;

// Normalize platform/arch names for tarball filename
const platformMap = { darwin: 'darwin', linux: 'linux', win32: 'win' };
const archMap = { arm64: 'arm64', x64: 'x86_64', ia32: 'x86' };
const normalizedPlatform = platformMap[platform] || platform;
const normalizedArch = archMap[arch] || arch;

const tarballName = `aionui-web-${version}-${normalizedPlatform}-${normalizedArch}.tar.gz`;
const distDir = path.join(projectRoot, 'dist-web-cli');
const tarballPath = path.join(distDir, tarballName);

console.log(`Packing web-cli for ${platform}-${arch}...`);

// 1. Prepare bundled-aioncore
console.log('1. Preparing aioncore...');
prepareAioncore({
  projectRoot,
  platform,
  arch,
  version: resolveAioncoreVersion(projectRoot),
  repo: resolveAioncoreRepo(projectRoot),
});

// 2. Create staging dir
console.log('3. Creating staging dir...');
const stagingDir = path.join(distDir, 'staging');
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

const tarballContentDir = path.join(stagingDir, 'aionui-web');
fs.mkdirSync(tarballContentDir, { recursive: true });

// 4. Compile web-cli into a standalone executable with bun
// Produces a single binary (~100MB) that bundles bun runtime + all deps, so
// the tarball has no node_modules and the user needs no Node installation.
console.log('4. Compiling web-cli into standalone executable...');
// Map our platform/arch to bun's --target naming
const bunTargetPlatform = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform] || platform;
const bunTargetArch = { arm64: 'arm64', x64: 'x64', ia32: 'x64' }[arch] || arch;
const bunTarget = `bun-${bunTargetPlatform}-${bunTargetArch}`;
const executableName = platform === 'win32' ? 'aionui-web.exe' : 'aionui-web';
const executablePath = path.join(tarballContentDir, executableName);
const webCliEntry = path.join(projectRoot, 'packages/web-cli/src/index.ts');
execSync(`bun build --compile --target=${bunTarget} --outfile="${executablePath}" "${webCliEntry}"`, {
  cwd: projectRoot,
  stdio: 'inherit',
});
console.log(`  → ${executablePath}`);

// 5. Copy package.json with repo-root version stamped in (for runtime lookup)
// The source packages/web-cli/package.json is pinned to "0.0.0" as a workspace
// package and never gets bumped; stamping the real repo version here lets
// `aionui-web version` match the tarball filename.
const srcPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'packages/web-cli/package.json'), 'utf8'));
srcPkg.version = version;
fs.writeFileSync(path.join(tarballContentDir, 'package.json'), JSON.stringify(srcPkg, null, 2) + '\n');

// 6. Copy static files (SPA) from desktop renderer build output
// Note: electron-vite writes to the repo-root `out/`, NOT packages/desktop/out/
console.log('6. Copying static files...');
const rendererOutDir = path.join(projectRoot, 'out/renderer');
const staticDest = path.join(tarballContentDir, 'static');
if (fs.existsSync(rendererOutDir)) {
  fs.cpSync(rendererOutDir, staticDest, { recursive: true });
} else {
  throw new Error(`Desktop renderer output not found at ${rendererOutDir}. Run bunx electron-vite build first.`);
}

// 6b. Ship the standalone MCP server script (SearXNG search).
// They are NOT registered automatically (users add them via Settings → Tools →
// JSON import, see README). Emitted by scripts/build-mcp-servers.js into
// out/main/ during the electron-vite main build; the tarball keeps the same
// relative path (`<root>/out/main/builtin-mcp-*.js`) users are told to reference.
console.log('6b. Copying builtin MCP server scripts...');
// electron-vite only runs its MCP build plugin in development mode, so a plain
// `electron-vite build` (production, used by CI) never emits out/main/builtin-mcp-*.js.
// Bundle them here so the tarball does not depend on how the renderer/main build was invoked
// (scripts/build-with-builder.js does the same after its desktop build).
execSync(`node "${path.join(projectRoot, 'scripts/build-mcp-servers.js')}"`, {
  cwd: projectRoot,
  stdio: 'inherit',
});
const mcpScriptDest = path.join(tarballContentDir, 'out/main');
fs.mkdirSync(mcpScriptDest, { recursive: true });
for (const scriptName of ['builtin-mcp-searxng.js']) {
  const mcpScriptSrc = path.join(projectRoot, 'out/main', scriptName);
  if (!fs.existsSync(mcpScriptSrc)) {
    throw new Error(
      `Builtin MCP script not found at ${mcpScriptSrc}. ` +
        'Run bunx electron-vite build first (scripts/build-mcp-servers.js emits it).'
    );
  }
  fs.cpSync(mcpScriptSrc, path.join(mcpScriptDest, scriptName));
}
// Ship the CommonJS pin so the script isn't misparsed as ESM under the web-host
// root package.json ("type": "module"). Emitted by scripts/build-mcp-servers.js.
const mcpPkgSrc = path.join(projectRoot, 'out/main/package.json');
if (fs.existsSync(mcpPkgSrc)) {
  fs.cpSync(mcpPkgSrc, path.join(mcpScriptDest, 'package.json'));
}

// 7. Copy bundled-aioncore
const backendSrc = path.join(projectRoot, 'resources/bundled-aioncore', `${platform}-${arch}`);
const backendDest = path.join(tarballContentDir, 'bundled-aioncore', `${platform}-${arch}`);
if (!fs.existsSync(backendSrc)) {
  throw new Error(`Backend bundle dir missing at ${backendSrc}. Ensure prepareAioncore succeeded.`);
}
fs.mkdirSync(path.dirname(backendDest), { recursive: true });
fs.cpSync(backendSrc, backendDest, { recursive: true });

// 7b. glibc 2.28 compatibility for Linux targets (CentOS 8 / Rocky 8).
// If the bun binary or the bundled aioncore require a newer glibc than 2.28,
// bundle the host glibc and wrap the binaries so they run on glibc 2.28.
// Best-effort: a failure here only warns and never blocks the build.
if (platform === 'linux') {
  const bundleScript = path.join(projectRoot, 'scripts', 'bundle-glibc.sh');
  try {
    execSync(`bash "${bundleScript}" "${tarballContentDir}" "${arch}"`, {
      cwd: projectRoot,
      stdio: 'inherit',
    });
  } catch (err) {
    console.warn(`glibc bundling step failed (non-fatal): ${err}`);
  }
}

// 8. Create tarball
fs.mkdirSync(distDir, { recursive: true });
execSync(`tar -czf ${path.basename(tarballPath)} -C ${stagingDir} aionui-web`, {
  cwd: path.dirname(tarballPath),
  stdio: 'inherit',
});

console.log(`✅ Tarball created: ${tarballPath}`);

// 9. Generate SHA256 checksum (cross-platform: use Node's crypto, not `shasum`)
const checksumPath = `${tarballPath}.sha256`;
const hash = crypto.createHash('sha256');
hash.update(fs.readFileSync(tarballPath));
const digest = hash.digest('hex');
// Match shasum format: "<hash>  <filename>\n"
fs.writeFileSync(checksumPath, `${digest}  ${path.basename(tarballPath)}\n`);
console.log(`✅ Checksum created: ${checksumPath}`);

console.log('Done!');
