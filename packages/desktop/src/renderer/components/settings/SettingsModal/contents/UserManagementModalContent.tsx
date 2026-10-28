/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * 用户管理设置内容 / User management settings content
 *
 * Two independent capabilities, both local to this deployment (no cloud
 * account involved):
 *
 *  1. 修改我的密码 — every signed-in user changes their own password through
 *     the backend's authenticated `/api/auth/change-password` (requires the
 *     current password; rotates the JWT secret, so all sessions are dropped).
 *  2. 用户管理 — the seeded admin (`system_default_user`) creates, disables
 *     and re-passes other local accounts through web-host's
 *     `/api/auth/admin/*` API. Each account gets its own isolated
 *     conversations, projects and settings — that is the whole point of
 *     running the web backend in webui identity mode.
 *
 * Desktop (local identity mode) has a single implicit user, so the panel is
 * only reachable from browser deployments; it still renders a short note
 * there instead of an empty shell.
 */

import { userAdmin, type IAdminUser } from '@/common/adapter/ipcBridge';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { useAuth } from '@/renderer/hooks/context/AuthContext';
import { isElectronDesktop } from '@/renderer/utils/platform';
import AionModal from '@/renderer/components/base/AionModal';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { Button, Form, Input, Message, Table, Tag } from '@arco-design/web-react';
import { Plus, Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTime } from '@/renderer/services/i18n/format';
import { useSettingsViewMode } from '../settingsViewContext';

/** The always-seeded admin account id (aionui-db ensure_system_user). */
const SYSTEM_ADMIN_USER_ID = 'system_default_user';

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const USERNAME_MIN = 3;
const USERNAME_MAX = 32;
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Mirrors aionui-auth validation::validate_password (same rules the CLI applies). */
function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN) return 'tooShort';
  if (password.length > PASSWORD_MAX) return 'tooLong';
  return null;
}

/** Mirrors aionui-auth validation::validate_username. */
function validateUsername(username: string): string | null {
  if (username.length < USERNAME_MIN) return 'usernameTooShort';
  if (username.length > USERNAME_MAX) return 'usernameTooLong';
  if (!USERNAME_PATTERN.test(username)) return 'usernameFormatError';
  if (/^[-_]|[-_]$/.test(username)) return 'usernameEdgeError';
  return null;
}

/** Extract the backend's human message from a failed admin request. */
function backendErrorMessage(error: unknown): string | null {
  if (isBackendHttpError(error)) return error.backendMessage || null;
  return null;
}

/**
 * 修改我的密码卡片 / Change-my-password card
 */
const ChangeMyPasswordCard: React.FC = () => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (values: { currentPassword: string; newPassword: string; confirmPassword: string }) => {
    const invalid = validatePassword(values.newPassword);
    if (invalid) {
      Message.error(t(`settings.users.${invalid}`));
      return;
    }
    if (values.newPassword !== values.confirmPassword) {
      Message.error(t('settings.users.passwordMismatch'));
      return;
    }
    setLoading(true);
    try {
      await userAdmin.changeMyPassword.invoke({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      form.resetFields();
      // The backend rotates the JWT secret, invalidating this session — send
      // the user back to the login page rather than letting the next request
      // 401 into a confusing half-state.
      Message.success(t('settings.users.passwordChangedRelogin'));
      window.setTimeout(() => {
        window.location.assign('/login');
      }, 1200);
    } catch (error) {
      const backend = backendErrorMessage(error);
      Message.error(backend ?? t('settings.users.passwordChangeFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className='rd-12px bg-fill-2 p-16px'>
      <div className='text-15px font-500 text-t-primary'>{t('settings.users.changeMyPassword')}</div>
      <div className='text-12px text-t-tertiary mt-4px'>{t('settings.users.changeMyPasswordDesc')}</div>
      <Form form={form} layout='vertical' className='mt-12px' onSubmit={handleSubmit}>
        <Form.Item field='currentPassword' label={t('settings.users.currentPassword')} rules={[{ required: true }]}>
          <Input.Password
            autoComplete='current-password'
            placeholder={t('settings.users.currentPasswordPlaceholder')}
          />
        </Form.Item>
        <Form.Item field='newPassword' label={t('settings.users.newPassword')} rules={[{ required: true }]}>
          <Input.Password autoComplete='new-password' placeholder={t('settings.users.newPasswordPlaceholder')} />
        </Form.Item>
        <Form.Item field='confirmPassword' label={t('settings.users.confirmPassword')} rules={[{ required: true }]}>
          <Input.Password autoComplete='new-password' placeholder={t('settings.users.confirmPasswordPlaceholder')} />
        </Form.Item>
        <Button type='primary' htmlType='submit' loading={loading}>
          {t('settings.users.submit')}
        </Button>
      </Form>
    </div>
  );
};

/**
 * 创建用户弹窗 / Create-user modal
 */
const CreateUserModal: React.FC<{ visible: boolean; onCancel: () => void; onCreated: () => void }> = ({
  visible,
  onCancel,
  onCreated,
}) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (values: { username: string; password: string; confirmPassword: string }) => {
    const usernameError = validateUsername(values.username.trim());
    if (usernameError) {
      Message.error(t(`settings.users.${usernameError}`));
      return;
    }
    const passwordError = validatePassword(values.password);
    if (passwordError) {
      Message.error(t(`settings.users.${passwordError}`));
      return;
    }
    if (values.password !== values.confirmPassword) {
      Message.error(t('settings.users.passwordMismatch'));
      return;
    }
    setLoading(true);
    try {
      await userAdmin.createUser.invoke({ username: values.username.trim(), password: values.password });
      Message.success(t('settings.users.userCreated'));
      form.resetFields();
      onCreated();
    } catch (error) {
      const backend = backendErrorMessage(error);
      Message.error(backend ?? t('settings.users.userCreateFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AionModal visible={visible} onCancel={onCancel} footer={null} title={t('settings.users.createUser')}>
      <AionScrollArea className='h-full text-14px text-t-primary'>
        <Form form={form} layout='vertical' onSubmit={handleSubmit}>
          <Form.Item field='username' label={t('settings.users.username')} rules={[{ required: true }]}>
            <Input placeholder={t('settings.users.usernamePlaceholder')} autoComplete='off' />
          </Form.Item>
          <Form.Item field='password' label={t('settings.users.initialPassword')} rules={[{ required: true }]}>
            <Input.Password autoComplete='new-password' placeholder={t('settings.users.newPasswordPlaceholder')} />
          </Form.Item>
          <Form.Item field='confirmPassword' label={t('settings.users.confirmPassword')} rules={[{ required: true }]}>
            <Input.Password autoComplete='new-password' placeholder={t('settings.users.confirmPasswordPlaceholder')} />
          </Form.Item>
          <div className='flex justify-end gap-8px'>
            <Button onClick={onCancel}>{t('common.cancel')}</Button>
            <Button type='primary' htmlType='submit' loading={loading}>
              {t('settings.users.create')}
            </Button>
          </div>
        </Form>
      </AionScrollArea>
    </AionModal>
  );
};

/**
 * 重置他人密码弹窗 / Reset-another-user's-password modal
 */
const ResetPasswordModal: React.FC<{ user: IAdminUser | null; onCancel: () => void; onDone: () => void }> = ({
  user,
  onCancel,
  onDone,
}) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    form.resetFields();
  }, [form, user]);

  const handleSubmit = async (values: { password: string; confirmPassword: string }) => {
    const passwordError = validatePassword(values.password);
    if (passwordError) {
      Message.error(t(`settings.users.${passwordError}`));
      return;
    }
    if (values.password !== values.confirmPassword) {
      Message.error(t('settings.users.passwordMismatch'));
      return;
    }
    if (!user) return;
    setLoading(true);
    try {
      await userAdmin.setPassword.invoke({ username: user.username, password: values.password });
      Message.success(t('settings.users.passwordResetSuccess'));
      onDone();
    } catch (error) {
      const backend = backendErrorMessage(error);
      Message.error(backend ?? t('settings.users.passwordResetFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AionModal
      visible={Boolean(user)}
      onCancel={onCancel}
      footer={null}
      title={t('settings.users.resetPasswordTitle', { username: user?.username ?? '' })}
    >
      <AionScrollArea className='h-full text-14px text-t-primary'>
        <Form form={form} layout='vertical' onSubmit={handleSubmit}>
          <Form.Item field='password' label={t('settings.users.newPassword')} rules={[{ required: true }]}>
            <Input.Password autoComplete='new-password' placeholder={t('settings.users.newPasswordPlaceholder')} />
          </Form.Item>
          <Form.Item field='confirmPassword' label={t('settings.users.confirmPassword')} rules={[{ required: true }]}>
            <Input.Password autoComplete='new-password' placeholder={t('settings.users.confirmPasswordPlaceholder')} />
          </Form.Item>
          <div className='flex justify-end gap-8px'>
            <Button onClick={onCancel}>{t('common.cancel')}</Button>
            <Button type='primary' htmlType='submit' loading={loading}>
              {t('settings.users.submit')}
            </Button>
          </div>
        </Form>
      </AionScrollArea>
    </AionModal>
  );
};

/**
 * 启用/禁用确认弹窗 / Enable-disable confirmation modal
 */
const StatusConfirmModal: React.FC<{
  user: IAdminUser | null;
  next: 'active' | 'disabled';
  onCancel: () => void;
  onConfirm: () => void;
  loading: boolean;
}> = ({ user, next, onCancel, onConfirm, loading }) => {
  const { t } = useTranslation();
  return (
    <AionModal
      visible={Boolean(user)}
      onCancel={onCancel}
      footer={null}
      title={t(next === 'disabled' ? 'settings.users.disableConfirmTitle' : 'settings.users.enableConfirmTitle')}
    >
      <AionScrollArea className='h-full text-14px text-t-primary'>
        <div>
          {t(next === 'disabled' ? 'settings.users.disableConfirm' : 'settings.users.enableConfirm', {
            username: user?.username ?? '',
          })}
        </div>
        <div className='mt-16px flex justify-end gap-8px'>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button
            type='primary'
            status={next === 'disabled' ? 'warning' : 'success'}
            loading={loading}
            onClick={onConfirm}
          >
            {t(next === 'disabled' ? 'settings.users.disable' : 'settings.users.enable')}
          </Button>
        </div>
      </AionScrollArea>
    </AionModal>
  );
};

/**
 * 用户管理卡片（仅管理员）/ User-management card (admin only)
 */
const UserAdminCard: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [users, setUsers] = useState<IAdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [resetTarget, setResetTarget] = useState<IAdminUser | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ user: IAdminUser; next: 'active' | 'disabled' } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const list = await userAdmin.listUsers.invoke();
      setUsers(list);
      setUnavailable(false);
      setLoaded(true);
    } catch (error) {
      // 501 = web-host has no aioncore CLI wired (desktop WebUI shares the
      // desktop's local-mode backend, so per-account isolation does not apply
      // there). Say that instead of pretending the list is empty.
      if (isBackendHttpError(error) && error.code === 'ADMIN_CLI_UNAVAILABLE') {
        setUnavailable(true);
        setLoaded(true);
      } else {
        const backend = backendErrorMessage(error);
        Message.error(backend ?? t('settings.users.loadFailed'));
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Load lazily on first render so the page does not fire an admin-gated
  // request for non-admin users.
  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const handleToggleStatus = async (user: IAdminUser, next: 'active' | 'disabled') => {
    setActionLoading(user.username);
    try {
      await userAdmin.setStatus.invoke({ username: user.username, status: next });
      Message.success(next === 'disabled' ? t('settings.users.userDisabled') : t('settings.users.userEnabled'));
      await loadUsers();
    } catch (error) {
      const backend = backendErrorMessage(error);
      Message.error(backend ?? t('settings.users.statusChangeFailed'));
    } finally {
      setActionLoading(null);
    }
  };

  const columns = useMemo(
    () => [
      {
        title: t('settings.users.username'),
        dataIndex: 'username',
        render: (value: string, record: IAdminUser) => (
          <span className='flex items-center gap-8px'>
            <span className='text-t-primary'>{value}</span>
            {record.id === SYSTEM_ADMIN_USER_ID && (
              <Tag size='small' color='arcoblue'>
                {t('settings.users.adminTag')}
              </Tag>
            )}
            {record.status === 'disabled' && (
              <Tag size='small' color='red'>
                {t('settings.users.statusDisabled')}
              </Tag>
            )}
          </span>
        ),
      },
      {
        title: t('settings.users.createdAt'),
        dataIndex: 'created_at',
        render: (value: number) => (
          <span className='text-t-secondary text-12px'>{formatTime(value, i18n.language, { dateStyle: 'short' })}</span>
        ),
      },
      {
        title: t('settings.users.lastLogin'),
        dataIndex: 'last_login',
        render: (value: number | null) => (
          <span className='text-t-secondary text-12px'>
            {value ? formatTime(value, i18n.language, { dateStyle: 'short' }) : '-'}
          </span>
        ),
      },
      {
        title: t('settings.users.actions'),
        dataIndex: 'op',
        render: (_: unknown, record: IAdminUser) => (
          <div className='flex items-center gap-8px'>
            <Button size='mini' type='text' onClick={() => setResetTarget(record)}>
              {t('settings.users.resetPassword')}
            </Button>
            {record.id === SYSTEM_ADMIN_USER_ID ? null : (
              <Button
                size='mini'
                type='text'
                status={record.status === 'active' ? 'warning' : 'success'}
                loading={actionLoading === record.username}
                onClick={() =>
                  setStatusTarget({ user: record, next: record.status === 'active' ? 'disabled' : 'active' })
                }
              >
                {t(record.status === 'active' ? 'settings.users.disable' : 'settings.users.enable')}
              </Button>
            )}
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, i18n, actionLoading]
  );

  // Desktop WebUI shares the desktop app's local-mode backend (single embedded
  // user, no per-account isolation), and frontend-only deployments have no
  // aioncore CLI at all. Both report ADMIN_CLI_UNAVAILABLE — be explicit.
  if (unavailable) {
    return (
      <div className='rd-12px bg-fill-2 p-16px'>
        <div className='text-15px font-500 text-t-primary'>{t('settings.users.management')}</div>
        <div className='text-12px text-t-tertiary mt-4px'>{t('settings.users.unavailableHint')}</div>
      </div>
    );
  }

  if (loaded && users.length === 0 && !loading) {
    // Defensive: the admin account always exists server-side.
    return null;
  }

  return (
    <div className='rd-12px bg-fill-2 p-16px'>
      <div className='flex items-center justify-between'>
        <div>
          <div className='text-15px font-500 text-t-primary'>{t('settings.users.management')}</div>
          <div className='text-12px text-t-tertiary mt-4px'>{t('settings.users.managementDesc')}</div>
        </div>
        <div className='flex items-center gap-8px'>
          <Button size='small' type='text' loading={loading} onClick={() => void loadUsers()}>
            <Refresh theme='outline' size='14' />
          </Button>
          <Button size='small' type='primary' onClick={() => setCreateVisible(true)}>
            <Plus theme='outline' size='14' />
            <span className='ms-4px'>{t('settings.users.createUser')}</span>
          </Button>
        </div>
      </div>
      <div className='mt-12px'>
        <Table
          rowKey='id'
          loading={loading}
          columns={columns}
          data={users}
          pagination={false}
          size='small'
          noDataElement={
            <div className='py-16px text-center text-12px text-t-tertiary'>{t('settings.users.empty')}</div>
          }
        />
      </div>
      <CreateUserModal
        visible={createVisible}
        onCancel={() => setCreateVisible(false)}
        onCreated={() => {
          setCreateVisible(false);
          void loadUsers();
        }}
      />
      <ResetPasswordModal
        user={resetTarget}
        onCancel={() => setResetTarget(null)}
        onDone={() => {
          setResetTarget(null);
          void loadUsers();
        }}
      />
      <StatusConfirmModal
        user={statusTarget?.user ?? null}
        next={statusTarget?.next ?? 'disabled'}
        loading={actionLoading !== null}
        onCancel={() => setStatusTarget(null)}
        onConfirm={() => {
          const target = statusTarget;
          if (!target) return;
          setStatusTarget(null);
          void handleToggleStatus(target.user, target.next);
        }}
      />
    </div>
  );
};

/**
 * 用户管理设置内容组件 / User management settings content component
 */
const UserManagementModalContent: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isDesktop = isElectronDesktop();
  useSettingsViewMode();

  // The seeded admin is the only account allowed to manage users. Desktop
  // runs a single implicit local user, so there is nothing to manage there.
  const canManageUsers = !isDesktop && user?.id === SYSTEM_ADMIN_USER_ID;

  return (
    <div className='flex flex-col gap-16px'>
      <ChangeMyPasswordCard />
      {canManageUsers ? (
        <UserAdminCard />
      ) : (
        <div className='rd-12px bg-fill-2 p-16px'>
          <div className='text-15px font-500 text-t-primary'>{t('settings.users.management')}</div>
          <div className='text-12px text-t-tertiary mt-4px'>{t('settings.users.adminOnlyHint')}</div>
        </div>
      )}
    </div>
  );
};

export default UserManagementModalContent;
