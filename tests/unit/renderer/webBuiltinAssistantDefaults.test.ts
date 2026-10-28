/**
 * Tests for the WebUI one-shot "enable all built-in assistants/skills" bootstrap.
 *
 * Mirrors the desktop main-process migration but runs in the renderer after
 * authentication and stores its completion flag in the per-user backend
 * client-settings store.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listMock, setStateMock, updateMock, getMock, setFlagMock, initMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  setStateMock: vi.fn(),
  updateMock: vi.fn(),
  getMock: vi.fn(),
  setFlagMock: vi.fn(),
  initMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: {
      list: { invoke: listMock },
      setState: { invoke: setStateMock },
      update: { invoke: updateMock },
    },
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: { initialize: initMock, get: getMock, set: setFlagMock },
}));

// Run the WebUI branch (not the desktop no-op).
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => false }));

import { ensureWebBuiltinAssistantDefaults } from '@/renderer/services/webBuiltinAssistantDefaults';

type FakeAssistant = {
  id: string;
  source: string;
  enabled: boolean;
  disabled_builtin_skills: string[];
};

const mk = (id: string, source: string, enabled: boolean, disabled: string[] = []): FakeAssistant => ({
  id,
  source,
  enabled,
  disabled_builtin_skills: disabled,
});

describe('ensureWebBuiltinAssistantDefaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initMock.mockResolvedValue(undefined);
    setFlagMock.mockResolvedValue(undefined);
    setStateMock.mockResolvedValue(undefined);
    updateMock.mockResolvedValue(undefined);
  });

  it('skips entirely when the completion flag is already set', async () => {
    getMock.mockReturnValue(true);

    await ensureWebBuiltinAssistantDefaults();

    expect(listMock).not.toHaveBeenCalled();
    expect(setFlagMock).not.toHaveBeenCalled();
  });

  it('enables disabled built-ins, clears their disabled skills, and persists the flag', async () => {
    getMock.mockReturnValue(undefined);
    listMock.mockResolvedValue([
      mk('b-off', 'builtin', false, ['skill-x']),
      mk('b-on', 'builtin', true),
      mk('u-1', 'user', false),
    ]);

    await ensureWebBuiltinAssistantDefaults();

    expect(setStateMock).toHaveBeenCalledTimes(1);
    expect(setStateMock).toHaveBeenCalledWith({ id: 'b-off', enabled: true });
    // disabled skill list is cleared for the builtin that had one
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({ id: 'b-off', disabled_builtin_skills: [] });
    // enabled builtins and non-builtins are left untouched
    expect(setStateMock).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'b-on' }));
    expect(setStateMock).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'u-1' }));
    expect(setFlagMock).toHaveBeenCalledWith('migration.builtinAllEnabled_v1', true);
  });

  it('does not persist the flag when listing assistants fails (retried next load)', async () => {
    getMock.mockReturnValue(undefined);
    listMock.mockRejectedValue(new Error('offline'));

    await expect(ensureWebBuiltinAssistantDefaults()).resolves.toBeUndefined();
    expect(setFlagMock).not.toHaveBeenCalled();
  });
});
