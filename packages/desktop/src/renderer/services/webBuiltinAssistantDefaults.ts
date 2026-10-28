/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import { isElectronDesktop } from '@/renderer/utils/platform';

/**
 * Per-user, one-shot completion flag. The WebUI has no local config file, so it
 * lives in the backend client-settings store (per account, survives device
 * switches). Same key name as the desktop main-process migration.
 */
const FLAG = 'migration.builtinAllEnabled_v1' as const;

let inFlight: Promise<void> | null = null;

/**
 * WebUI-only counterpart of the desktop `enableAllBuiltinAssistantsAndSkills`
 * migration: on a user's first authenticated load, enable every built-in
 * assistant and clear its disabled built-in skill list so a freshly provisioned
 * account starts with all built-ins on. The flag is then persisted, so later
 * user changes (disabling an assistant/skill) stick across restarts.
 *
 * No-op on desktop (the main-process migration handles it) and best-effort:
 * failures are logged and retried on the next load without blocking the UI.
 */
export function ensureWebBuiltinAssistantDefaults(): Promise<void> {
  if (isElectronDesktop()) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = run()
    .catch((error) => {
      console.warn('[AionUi] web built-in assistant defaults bootstrap failed:', error);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function run(): Promise<void> {
  await configService.initialize();
  if (configService.get(FLAG)) return;

  // Let a failure here bubble to the caller's catch → not flagged, retried later.
  const assistants = await ipcBridge.assistants.list.invoke();
  const builtins = assistants.filter((assistant) => assistant.source === 'builtin');

  for (const assistant of builtins) {
    const needsEnable = assistant.enabled !== true;
    const needsSkillReset = (assistant.disabled_builtin_skills?.length ?? 0) > 0;
    if (!needsEnable && !needsSkillReset) continue;

    try {
      if (needsEnable) {
        await ipcBridge.assistants.setState.invoke({ id: assistant.id, enabled: true });
      }
      if (needsSkillReset) {
        await ipcBridge.assistants.update.invoke({ id: assistant.id, disabled_builtin_skills: [] });
      }
    } catch (error) {
      console.warn(`[AionUi] Failed to enable built-in assistant '${assistant.id}' (web):`, error);
    }
  }

  await configService.set(FLAG, true);
}
