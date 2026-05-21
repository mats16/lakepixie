import type {
  AdminUserListResponse,
  AppSettingsResponse,
  GitHubAppAuthResponse,
  ServingEndpointsByTier,
  TelemetryCatalogListResponse,
  TelemetrySchemaListResponse,
  TelemetrySetupRequest,
  TelemetrySetupResponse,
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

  getTelemetryCatalogs: () =>
    apiClient<TelemetryCatalogListResponse>('/api/admin/telemetry/catalogs'),

  getTelemetrySchemas: (catalogName: string) => {
    const query = new URLSearchParams({ catalog_name: catalogName });
    return apiClient<TelemetrySchemaListResponse>(`/api/admin/telemetry/schemas?${query}`);
  },

  setupTelemetry: (settings: TelemetrySetupRequest) =>
    apiClient<TelemetrySetupResponse>('/api/admin/telemetry/setup', {
      method: 'POST',
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
