import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import requestDecoratorPlugin from '../plugins/request-decorator.js';

const {
  mockCreateGitHubUserPullRequest,
  mockGetGitHubUserPullRequest,
  mockGetGitHubUserRepositoryBranch,
  mockListGitHubUserPullRequests,
  mockListGitHubUserRepositoryBranches,
  mockListGitHubUserRepositories,
} = vi.hoisted(() => ({
  mockCreateGitHubUserPullRequest: vi.fn(),
  mockGetGitHubUserPullRequest: vi.fn(),
  mockGetGitHubUserRepositoryBranch: vi.fn(),
  mockListGitHubUserPullRequests: vi.fn(),
  mockListGitHubUserRepositoryBranches: vi.fn(),
  mockListGitHubUserRepositories: vi.fn(),
}));

vi.mock('../services/github-oauth.service.js', () => ({
  GitHubOAuthError: class GitHubOAuthError extends Error {
    constructor(
      message: string,
      public readonly details?: unknown
    ) {
      super(message);
      this.name = 'GitHubOAuthError';
    }
  },
  GitHubOAuthAuthorizationRequiredError: class GitHubOAuthAuthorizationRequiredError extends Error {},
  GitHubOAuthExpiredError: class GitHubOAuthExpiredError extends Error {},
  GitHubOAuthNotConfiguredError: class GitHubOAuthNotConfiguredError extends Error {},
  createGitHubUserPullRequest: mockCreateGitHubUserPullRequest,
  getGitHubUserPullRequest: mockGetGitHubUserPullRequest,
  getGitHubUserRepositoryBranch: mockGetGitHubUserRepositoryBranch,
  listGitHubUserPullRequests: mockListGitHubUserPullRequests,
  listGitHubUserRepositories: mockListGitHubUserRepositories,
  listGitHubUserRepositoryBranches: mockListGitHubUserRepositoryBranches,
  normalizePullRequestCreateHead: (owner: string, head: string) =>
    head.startsWith(`${owner}:`) ? head.slice(owner.length + 1) : head,
}));

import gitRepositoriesRoute from './git-repositories.js';
import {
  GitHubOAuthAuthorizationRequiredError,
  GitHubOAuthError,
  GitHubOAuthNotConfiguredError,
} from '../services/github-oauth.service.js';

const TEST_USER_HEADERS = {
  'x-forwarded-user': 'test-user-id',
  'x-forwarded-preferred-username': 'Test User',
  'x-forwarded-email': 'test@example.com',
};

describe('git repositories route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify({ logger: false });
    await app.register(requestDecoratorPlugin);
    await app.register(gitRepositoriesRoute, { prefix: '/api' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists repositories from /api/repos and does not expose the old route', async () => {
    mockListGitHubUserRepositories.mockResolvedValue([
      { full_name: 'acme/widgets', url: 'https://github.com/acme/widgets' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/repos?q=widget',
      headers: TEST_USER_HEADERS,
    });
    const oldResponse = await app.inject({
      method: 'GET',
      url: '/api/repositories?q=widget',
      headers: TEST_USER_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      repositories: [{ full_name: 'acme/widgets', url: 'https://github.com/acme/widgets' }],
    });
    expect(mockListGitHubUserRepositories).toHaveBeenCalledWith(
      expect.anything(),
      'test-user-id',
      'widget'
    );
    expect(oldResponse.statusCode).toBe(404);
  });

  it('requires user GitHub authorization for repository listing', async () => {
    mockListGitHubUserRepositories.mockRejectedValue(new GitHubOAuthAuthorizationRequiredError());

    const response = await app.inject({
      method: 'GET',
      url: '/api/repos',
      headers: TEST_USER_HEADERS,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: 'GitHubAuthorizationRequired',
      statusCode: 401,
    });
  });

  it('returns 503 when GitHub OAuth is not configured', async () => {
    mockListGitHubUserRepositories.mockRejectedValue(new GitHubOAuthNotConfiguredError());

    const response = await app.inject({
      method: 'GET',
      url: '/api/repos',
      headers: TEST_USER_HEADERS,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: 'GitHubOAuthNotConfigured',
      statusCode: 503,
    });
  });

  it('decodes slash-containing branch names for branch detail', async () => {
    mockGetGitHubUserRepositoryBranch.mockResolvedValue({
      name: 'ccbricks/test',
      html_url: 'https://github.com/acme/widgets/tree/ccbricks%2Ftest',
      compare: null,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/repos/acme/widgets/branches/${encodeURIComponent('ccbricks/test')}?base=main`,
      headers: TEST_USER_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(mockGetGitHubUserRepositoryBranch).toHaveBeenCalledWith(
      expect.anything(),
      'test-user-id',
      'acme/widgets',
      'ccbricks/test'
    );
  });

  it('returns branch detail errors with GitHub details for debugging', async () => {
    mockGetGitHubUserRepositoryBranch.mockRejectedValue(
      new GitHubOAuthError('GitHub API returned 404', { message: 'Branch not found' })
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/repos/acme/widgets/branches/${encodeURIComponent('ccbricks/test')}?base=main`,
      headers: TEST_USER_HEADERS,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: 'GitHub repository branch unavailable',
      details: { message: 'Branch not found' },
      statusCode: 502,
    });
  });

  it('passes head, base, and state through to pull request search', async () => {
    mockListGitHubUserPullRequests.mockResolvedValue([
      {
        number: 4,
        title: 'Update widgets',
        state: 'open',
        draft: false,
        merged: false,
        html_url: 'https://github.com/acme/widgets/pull/4',
        head: { ref: 'ccbricks/test', label: 'acme:ccbricks/test' },
        base: { ref: 'main', label: 'acme:main' },
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/repos/acme/widgets/pulls?head=${encodeURIComponent('acme:ccbricks/test')}&base=main&state=open`,
      headers: TEST_USER_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ pulls: [{ number: 4 }] });
    expect(mockListGitHubUserPullRequests).toHaveBeenCalledWith(
      expect.anything(),
      'test-user-id',
      'acme/widgets',
      {
        head: 'acme:ccbricks/test',
        base: 'main',
        state: 'open',
      }
    );
  });

  it('uses pull_number when fetching pull request details', async () => {
    mockGetGitHubUserPullRequest.mockResolvedValue({
      number: 4,
      title: 'Update widgets',
      state: 'open',
      draft: false,
      merged: false,
      html_url: 'https://github.com/acme/widgets/pull/4',
      head: { ref: 'ccbricks/test', label: 'acme:ccbricks/test' },
      base: { ref: 'main', label: 'acme:main' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/repos/acme/widgets/pulls/4',
      headers: TEST_USER_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(mockGetGitHubUserPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      'test-user-id',
      'acme/widgets',
      4
    );
  });

  it('creates pull requests with GitHub-shaped request fields', async () => {
    mockCreateGitHubUserPullRequest.mockResolvedValue({
      number: 5,
      title: 'Update widgets',
      state: 'open',
      draft: true,
      merged: false,
      html_url: 'https://github.com/acme/widgets/pull/5',
      head: { ref: 'ccbricks/test', label: 'acme:ccbricks/test' },
      base: { ref: 'main', label: 'acme:main' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/repos/acme/widgets/pulls',
      headers: TEST_USER_HEADERS,
      payload: {
        title: 'Update widgets',
        body: 'Generated PR body',
        head: 'acme:ccbricks/test',
        base: 'main',
        draft: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ number: 5, draft: true });
    expect(mockCreateGitHubUserPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      'test-user-id',
      'acme/widgets',
      {
        title: 'Update widgets',
        body: 'Generated PR body',
        head: 'acme:ccbricks/test',
        base: 'main',
        draft: true,
      }
    );
  });
});
