import type { GitHubOAuthAuthorizationResponse } from '@repo/types';
import { apiClient } from './api-client';

export const githubOAuthService = {
  getAuthorization: () =>
    apiClient<GitHubOAuthAuthorizationResponse>('/api/github/oauth/authorization'),

  getAuthorizeUrl: (redirectAfter: string) => {
    const query = new URLSearchParams({ redirect_after: redirectAfter });
    return `/api/github/oauth/authorize?${query}`;
  },

  revoke: () =>
    apiClient<{ success: true }>('/api/github/oauth/revoke', {
      method: 'POST',
    }),
};
