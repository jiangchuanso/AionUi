/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import UserManagementModalContent from '@/renderer/components/settings/SettingsModal/contents/UserManagementModalContent';
import SettingsPageWrapper from './components/SettingsPageWrapper';

const UserManagementSettings: React.FC = () => {
  return (
    <SettingsPageWrapper>
      <UserManagementModalContent />
    </SettingsPageWrapper>
  );
};

export default UserManagementSettings;
