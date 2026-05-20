import type {
  AdminUserListResponse,
  AppSettingsResponse,
  GitHubAppAuthResponse,
  ServingEndpointsByTier,
  UpdateAppSettingsRequest,
  UpdateGitHubAppAuthRequest,
} from '@repo/types';
import { apiClient } from './api-client';

export const adminService = {
  getUsers: () => apiClient<AdminUserListResponse>('/api/admin/users'),

  updateUserRole: (userId: string, isAdmin: boolean) =>
    apiClient<{ success: true }>(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
      method: 'PUT',
      body: JSON.stringify({ is_admin: isAdmin }),
    }),

  getSettings: () => apiClient<AppSettingsResponse>('/api/admin/settings'),

  updateSettings: (settings: UpdateAppSettingsRequest) =>
    apiClient<AppSettingsResponse>('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    }),

  getGitHubAppAuth: () => apiClient<GitHubAppAuthResponse>('/api/admin/github-app-auth'),

  updateGitHubAppAuth: (settings: UpdateGitHubAppAuthRequest) =>
    apiClient<GitHubAppAuthResponse>('/api/admin/github-app-auth', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    }),

  getServingEndpoints: () => apiClient<ServingEndpointsByTier>('/api/models'),
};
