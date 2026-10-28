/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import { SWRConfig } from 'swr';

const { listUsersMock, createUserMock, setPasswordMock, setStatusMock, changeMyPasswordMock } = vi.hoisted(() => ({
  listUsersMock: vi.fn(),
  createUserMock: vi.fn(),
  setPasswordMock: vi.fn(),
  setStatusMock: vi.fn(),
  changeMyPasswordMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: vi.fn(() => false),
  resolveBackendAssetUrl: (url: string) => url,
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  userAdmin: {
    listUsers: { invoke: listUsersMock },
    createUser: { invoke: createUserMock },
    setPassword: { invoke: setPasswordMock },
    setStatus: { invoke: setStatusMock },
    changeMyPassword: { invoke: changeMyPasswordMock },
  },
  systemSettings: {
    get: { invoke: vi.fn(() => Promise.resolve(undefined)) },
    set: { invoke: vi.fn(() => Promise.resolve()) },
    languageChanged: { on: vi.fn(() => () => undefined) },
  },
  application: {
    systemInfo: { invoke: vi.fn(() => Promise.resolve({})) },
    updateSystemInfo: { invoke: vi.fn(() => Promise.resolve()) },
  },
}));

vi.mock('@/renderer/components/base/AionModal', () => ({
  default: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? <div role='dialog'>{children}</div> : null,
}));

vi.mock('@/renderer/components/base/AionScrollArea', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/settings/SettingsModal/settingsViewContext', () => ({
  useSettingsViewMode: () => 'page',
}));

// Arco's real Message renders into document.body asynchronously, which leaks
// "unhandled error" noise into the run once the tree unmounts. Stub it — the
// tests assert on it.
const { messageSuccessMock, messageErrorMock } = vi.hoisted(() => ({
  messageSuccessMock: vi.fn(),
  messageErrorMock: vi.fn(),
}));
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: {
      success: messageSuccessMock,
      error: messageErrorMock,
      warning: vi.fn(),
      info: vi.fn(),
    },
  };
});

/** Per-test: the signed-in user (null = browser mode, unauthenticated). */
let currentUser: { id: string; username: string } | null = {
  id: 'system_default_user',
  username: 'admin',
};

vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ user: currentUser, status: 'authenticated' }),
}));

import UserManagementModalContent from '@/renderer/components/settings/SettingsModal/contents/UserManagementModalContent';
import { isElectronDesktop } from '@/renderer/utils/platform';

/** Arco components need a ConfigProvider; SWR needs a cache scope. */
function renderWithProviders(ui: React.ReactElement): void {
  render(
    <ConfigProvider>
      <SWRConfig value={{ provider: () => new Map() }}>{ui}</SWRConfig>
    </ConfigProvider>
  );
}

const SAMPLE_USERS = [
  {
    id: 'system_default_user',
    username: 'admin',
    user_type: 'local',
    status: 'active' as const,
    created_at: 1755000000000,
    last_login: null,
  },
  {
    id: 'user_abc',
    username: 'alice',
    user_type: 'local',
    status: 'active' as const,
    created_at: 1755000001000,
    last_login: 1755000002000,
  },
];

describe('UserManagementModalContent', () => {
  beforeAll(() => {
    // Arco's responsive observe needs matchMedia, which jsdom does not ship.
    if (!window.matchMedia) {
      window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
    }
  });

  beforeEach(() => {
    currentUser = { id: 'system_default_user', username: 'admin' };
    listUsersMock.mockReset();
    createUserMock.mockReset();
    setPasswordMock.mockReset();
    setStatusMock.mockReset();
    changeMyPasswordMock.mockReset();
    messageSuccessMock.mockReset();
    messageErrorMock.mockReset();
    listUsersMock.mockResolvedValue(SAMPLE_USERS);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the change-my-password card for every signed-in user', async () => {
    renderWithProviders(<UserManagementModalContent />);
    expect(await screen.findByText('settings.users.changeMyPassword')).toBeInTheDocument();
  });

  it('lists users for the admin account', async () => {
    renderWithProviders(<UserManagementModalContent />);
    await waitFor(() => expect(listUsersMock).toHaveBeenCalled());
    expect(await screen.findByText('settings.users.management')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('shows the admin-only hint instead of the user table for non-admin users', async () => {
    currentUser = { id: 'user_abc', username: 'alice' };
    renderWithProviders(<UserManagementModalContent />);
    expect(await screen.findByText('settings.users.adminOnlyHint')).toBeInTheDocument();
    expect(screen.queryByText('settings.users.managementDesc')).not.toBeInTheDocument();
    // Non-admins must never trigger the admin-gated listing call.
    expect(listUsersMock).not.toHaveBeenCalled();
  });

  it('warns when the user list fails to load', async () => {
    listUsersMock.mockRejectedValue(new Error('boom'));
    renderWithProviders(<UserManagementModalContent />);
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalled());
    expect(messageErrorMock).toHaveBeenCalledWith('settings.users.loadFailed');
    expect(screen.queryByText('settings.users.unavailableHint')).not.toBeInTheDocument();
  });

  it('explains that user management is unavailable in local-mode deployments', async () => {
    const unavailable = Object.assign(new Error('unavailable'), {
      status: 501,
      code: 'ADMIN_CLI_UNAVAILABLE',
      backendMessage: 'local user management is unavailable in this deployment',
      name: 'BackendHttpError',
    });
    listUsersMock.mockRejectedValue(unavailable);
    renderWithProviders(<UserManagementModalContent />);
    expect(await screen.findByText('settings.users.unavailableHint')).toBeInTheDocument();
    // No error toast — the hint is the whole story.
    expect(messageErrorMock).not.toHaveBeenCalled();
    expect(screen.queryByText('settings.users.createUser')).not.toBeInTheDocument();
  });

  it('creates a user through the admin API', async () => {
    createUserMock.mockResolvedValue({
      id: 'user_new',
      username: 'bob',
      user_type: 'local',
      status: 'active',
      created_at: 1755000003000,
      last_login: null,
    });
    renderWithProviders(<UserManagementModalContent />);
    await waitFor(() => expect(listUsersMock).toHaveBeenCalled());

    await userEvent.click(screen.getByText('settings.users.createUser'));
    const dialog = await screen.findByRole('dialog');

    await userEvent.type(dialog.querySelector('input')!, 'bob');
    const inputs = dialog.querySelectorAll('input');
    await userEvent.type(inputs[1]!, 'BobsPassword1');
    await userEvent.type(inputs[2]!, 'BobsPassword1');
    await userEvent.click(within(dialog).getByText('settings.users.create'));

    await waitFor(() => expect(createUserMock).toHaveBeenCalledWith({ username: 'bob', password: 'BobsPassword1' }));
  });

  it('disables a user through the admin API after confirmation', async () => {
    setStatusMock.mockResolvedValue({ username: 'alice', status: 'disabled' });
    renderWithProviders(<UserManagementModalContent />);
    await waitFor(() => expect(listUsersMock).toHaveBeenCalled());

    await userEvent.click(screen.getAllByText('settings.users.disable')[0]!);
    const dialog = await screen.findByRole('dialog');
    // Confirm inside the modal (its button reuses the same label).
    await userEvent.click(within(dialog).getByText('settings.users.disable'));

    await waitFor(() => expect(setStatusMock).toHaveBeenCalledWith({ username: 'alice', status: 'disabled' }));
  });

  it('resets another user password through the admin API', async () => {
    setPasswordMock.mockResolvedValue(undefined);
    renderWithProviders(<UserManagementModalContent />);
    await waitFor(() => expect(listUsersMock).toHaveBeenCalled());

    // The reset button in alice's row (the admin row also has one).
    const aliceRow = screen.getByText('alice').closest('tr')!;
    await userEvent.click(within(aliceRow).getByText('settings.users.resetPassword'));
    const dialog = await screen.findByRole('dialog');
    const inputs = dialog.querySelectorAll('input');
    await userEvent.type(inputs[0]!, 'NewPassword1');
    await userEvent.type(inputs[1]!, 'NewPassword1');
    // Two submit buttons exist (password card + modal) — scope to the modal.
    await userEvent.click(within(dialog).getByText('settings.users.submit'));

    await waitFor(() => expect(setPasswordMock).toHaveBeenCalledWith({ username: 'alice', password: 'NewPassword1' }));
  });

  it('does not render the admin table on desktop (local identity mode)', async () => {
    vi.mocked(isElectronDesktop).mockReturnValueOnce(true);
    renderWithProviders(<UserManagementModalContent />);
    // Password card is always there; the admin card is suppressed.
    expect(await screen.findByText('settings.users.changeMyPassword')).toBeInTheDocument();
    expect(listUsersMock).not.toHaveBeenCalled();
    vi.mocked(isElectronDesktop).mockReturnValue(false);
  });
});
