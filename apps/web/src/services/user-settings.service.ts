import type { UpdateUserSettingsRequest, UserSettingsResponse } from '@repo/types';
import { apiClient } from './api-client';

export const userSettingsService = {
  getSettings: () => apiClient<UserSettingsResponse>('/api/user/settings'),

  updateSettings: (settings: UpdateUserSettingsRequest) =>
    apiClient<UserSettingsResponse>('/api/user/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    }),
};
