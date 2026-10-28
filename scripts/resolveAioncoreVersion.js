/**
 * Resolve the aioncore version tag to download for packaging.
 *
 * Order:
 *   1. AIONUI_BACKEND_VERSION env (ad-hoc override, e.g. CI dispatch input)
 *   2. "aioncoreVersion" field in repo-root package.json (the pin)
 *   3. 'latest' (GitHub API releases/latest; non-reproducible fallback)
 *
 * Keep this file tiny and dependency-free — it's required from both
 * scripts/prepareAioncore.js and scripts/pack-web-cli.js before
 * any project-level install has necessarily completed.
 */

const fs = require('fs');
const path = require('path');

function resolveAioncoreVersion(projectRoot) {
  const envOverride = process.env.AIONUI_BACKEND_VERSION;
  if (envOverride && envOverride.trim()) {
    return envOverride.trim();
  }

  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg && typeof pkg.aioncoreVersion === 'string' && pkg.aioncoreVersion.trim()) {
      return pkg.aioncoreVersion.trim();
    }
  } catch {
    // fall through
  }

  return 'latest';
}

/**
 * Resolve the GitHub repository (owner/repo) that hosts the aioncore assets.
 *
 * Order:
 *   1. AIONUI_BACKEND_REPO env (ad-hoc override, e.g. CI dispatch input)
 *   2. "aioncoreRepo" field in repo-root package.json (the fork pin)
 *   3. 'iOfficeAI/AionCore' (upstream default)
 */
function resolveAioncoreRepo(projectRoot) {
  const envOverride = process.env.AIONUI_BACKEND_REPO;
  if (envOverride && envOverride.trim()) {
    return envOverride.trim();
  }

  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg && typeof pkg.aioncoreRepo === 'string' && pkg.aioncoreRepo.trim()) {
      return pkg.aioncoreRepo.trim();
    }
  } catch {
    // fall through
  }

  return 'iOfficeAI/AionCore';
}

module.exports = { resolveAioncoreRepo, resolveAioncoreVersion };
