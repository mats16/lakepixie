import type { GitHubOAuthAuthorizationResponse } from '@repo/types';
import { apiClient } from './api-client';

export const githubOAuthService = {
  getAuthorization: () =>
    apiClient<GitHubOAuthAuthorizationResponse>('/api/github/oauth/authorization'),

  revoke: () =>
    apiClient<{ success: true }>('/api/github/oauth/revoke', {
      method: 'POST',
    }),
};
