import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import requestDecoratorPlugin from '../plugins/request-decorator.js';

const {
  mockCreateGitHubAppPullRequest,
  mockGetGitHubAppPullRequest,
  mockGetGitHubAppRepositoryBranch,
  mockListGitHubAppPullRequests,
  mockListGitHubAppRepositoryBranches,
  mockListGitHubAppRepositories,
} = vi.hoisted(() => ({
  mockCreateGitHubAppPullRequest: vi.fn(),
  mockGetGitHubAppPullRequest: vi.fn(),
  mockGetGitHubAppRepositoryBranch: vi.fn(),
  mockListGitHubAppPullRequests: vi.fn(),
  mockListGitHubAppRepositoryBranches: vi.fn(),
  mockListGitHubAppRepositories: vi.fn(),
}));

vi.mock('../services/github-app-auth.service.js', () => ({
  GitHubAppAuthError: class GitHubAppAuthError extends Error {
    constructor(
      message: string,
      public readonly details?: unknown
    ) {
      super(message);
      this.name = 'GitHubAppAuthError';
    }
  },
  GitHubAppAuthNotConfiguredError: class GitHubAppAuthNotConfiguredError extends Error {},
  createGitHubAppPullRequest: mockCreateGitHubAppPullRequest,
  getGitHubAppPullRequest: mockGetGitHubAppPullRequest,
  getGitHubAppRepositoryBranch: mockGetGitHubAppRepositoryBranch,
  listGitHubAppPullRequests: mockListGitHubAppPullRequests,
  listGitHubAppRepositoryBranches: mockListGitHubAppRepositoryBranches,
  listGitHubAppRepositories: mockListGitHubAppRepositories,
}));

import gitRepositoriesRoute from './git-repositories.js';
import { GitHubAppAuthError } from '../services/github-app-auth.service.js';

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
    mockListGitHubAppRepositories.mockResolvedValue([
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
    expect(mockListGitHubAppRepositories).toHaveBeenCalledWith(expect.anything(), 'widget');
    expect(oldResponse.statusCode).toBe(404);
  });

  it('decodes slash-containing branch names for branch detail', async () => {
    mockGetGitHubAppRepositoryBranch.mockResolvedValue({
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
    expect(mockGetGitHubAppRepositoryBranch).toHaveBeenCalledWith(
      expect.anything(),
      'acme/widgets',
      'ccbricks/test'
    );
  });

  it('returns branch detail errors with GitHub details for debugging', async () => {
    mockGetGitHubAppRepositoryBranch.mockRejectedValue(
      new GitHubAppAuthError('GitHub API returned 404', { message: 'Branch not found' })
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
    mockListGitHubAppPullRequests.mockResolvedValue([
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
    expect(mockListGitHubAppPullRequests).toHaveBeenCalledWith(expect.anything(), 'acme/widgets', {
      head: 'acme:ccbricks/test',
      base: 'main',
      state: 'open',
    });
  });

  it('uses pull_number when fetching pull request details', async () => {
    mockGetGitHubAppPullRequest.mockResolvedValue({
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
    expect(mockGetGitHubAppPullRequest).toHaveBeenCalledWith(expect.anything(), 'acme/widgets', 4);
  });

  it('creates pull requests with GitHub-shaped request fields', async () => {
    mockCreateGitHubAppPullRequest.mockResolvedValue({
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
    expect(mockCreateGitHubAppPullRequest).toHaveBeenCalledWith(expect.anything(), 'acme/widgets', {
      title: 'Update widgets',
      body: 'Generated PR body',
      head: 'acme:ccbricks/test',
      base: 'main',
      draft: true,
    });
  });
});
