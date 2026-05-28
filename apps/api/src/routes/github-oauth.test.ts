import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import requestDecoratorPlugin from '../plugins/request-decorator.js';

const {
  mockCompleteGitHubOAuthCallback,
  mockCreateGitHubOAuthAuthorizationUrl,
  mockDeleteGitHubOAuthStateByState,
  mockGetGitHubOAuthAuthorizationStatus,
  mockRevokeGitHubOAuthAuthorization,
} = vi.hoisted(() => ({
  mockCompleteGitHubOAuthCallback: vi.fn(),
  mockCreateGitHubOAuthAuthorizationUrl: vi.fn(),
  mockDeleteGitHubOAuthStateByState: vi.fn(),
  mockGetGitHubOAuthAuthorizationStatus: vi.fn(),
  mockRevokeGitHubOAuthAuthorization: vi.fn(),
}));

vi.mock('../services/github-oauth.service.js', () => ({
  GitHubOAuthError: class GitHubOAuthError extends Error {},
  GitHubOAuthNotConfiguredError: class GitHubOAuthNotConfiguredError extends Error {},
  completeGitHubOAuthCallback: mockCompleteGitHubOAuthCallback,
  createGitHubOAuthAuthorizationUrl: mockCreateGitHubOAuthAuthorizationUrl,
  deleteGitHubOAuthStateByState: mockDeleteGitHubOAuthStateByState,
  getGitHubOAuthAuthorizationStatus: mockGetGitHubOAuthAuthorizationStatus,
  revokeGitHubOAuthAuthorization: mockRevokeGitHubOAuthAuthorization,
}));

import githubOAuthRoute from './github-oauth.js';

const TEST_USER_HEADERS = {
  'x-forwarded-user': 'test-user-id',
  'x-forwarded-preferred-username': 'Test User',
  'x-forwarded-email': 'test@example.com',
  'x-forwarded-host': 'ccbricks.example.com',
  'x-forwarded-proto': 'https',
};

describe('github oauth route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify({ logger: false });
    app.decorate('config', {
      DATABRICKS_APP_URL: '',
      DATABRICKS_HOST: 'workspace.example.com',
      NODE_ENV: 'development',
    } as FastifyInstance['config']);
    await app.register(requestDecoratorPlugin);
    await app.register(githubOAuthRoute, { prefix: '/api' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('redirects authorize requests with the OAuth callback redirect URI', async () => {
    mockCreateGitHubOAuthAuthorizationUrl.mockResolvedValue(
      'https://github.com/login/oauth/authorize'
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/github/oauth/authorize?redirect_after=/settings',
      headers: TEST_USER_HEADERS,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://github.com/login/oauth/authorize');
    expect(mockCreateGitHubOAuthAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-id',
        redirectUri: 'https://ccbricks.example.com/api/github/oauth/callback',
        redirectAfter: '/settings',
      })
    );
  });

  it('rejects unsafe redirect_after paths before storing OAuth state', async () => {
    mockCreateGitHubOAuthAuthorizationUrl.mockResolvedValue(
      'https://github.com/login/oauth/authorize'
    );

    await app.inject({
      method: 'GET',
      url: '/api/github/oauth/authorize?redirect_after=https://evil.example.com',
      headers: TEST_USER_HEADERS,
    });

    expect(mockCreateGitHubOAuthAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ redirectAfter: '/settings' })
    );
  });

  it('uses DATABRICKS_APP_URL for production OAuth callback redirect URI', async () => {
    app.config.NODE_ENV = 'production';
    app.config.DATABRICKS_APP_URL = 'https://ccbricks-dev-1444828305810485.aws.databricksapps.com';
    mockCreateGitHubOAuthAuthorizationUrl.mockResolvedValue(
      'https://github.com/login/oauth/authorize'
    );

    await app.inject({
      method: 'GET',
      url: '/api/github/oauth/authorize?redirect_after=/settings',
      headers: TEST_USER_HEADERS,
    });

    expect(mockCreateGitHubOAuthAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri:
          'https://ccbricks-dev-1444828305810485.aws.databricksapps.com/api/github/oauth/callback',
      })
    );
  });

  it('validates callback state through the current Databricks user context', async () => {
    mockCompleteGitHubOAuthCallback.mockResolvedValue('/settings');

    const response = await app.inject({
      method: 'GET',
      url: '/api/github/oauth/callback?code=abc&state=state-1',
      headers: TEST_USER_HEADERS,
    });

    expect(response.statusCode).toBe(302);
    expect(mockCompleteGitHubOAuthCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-id',
        code: 'abc',
        state: 'state-1',
        redirectUri: 'https://ccbricks.example.com/api/github/oauth/callback',
      })
    );
  });
});
