import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mockGetValidGitHubUserAccessToken = vi.hoisted(() => vi.fn());

vi.mock('./github-oauth.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./github-oauth.service.js')>();
  return {
    ...actual,
    getValidGitHubUserAccessToken: mockGetValidGitHubUserAccessToken,
  };
});

import {
  __testing,
  registerGitCredential,
  resolveGitCredentialRequest,
} from './git-credential.service.js';

describe('git-credential.service', () => {
  const fastify = {} as FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    __testing.registeredCredentials.clear();
    mockGetValidGitHubUserAccessToken.mockResolvedValue('ghu_user_token');
  });

  it('returns a Git credential only for the registered GitHub repository', async () => {
    const registration = registerGitCredential('user-1', 'https://github.com/acme/widgets.git');

    const output = await resolveGitCredentialRequest(
      fastify,
      registration.bearerToken,
      ['protocol=https', 'host=github.com', 'path=acme/widgets.git', '', ''].join('\n')
    );

    expect(output).toContain('username=x-access-token');
    expect(output).toContain('password=ghu_user_token');
    expect(mockGetValidGitHubUserAccessToken).toHaveBeenCalledWith(fastify, 'user-1');
  });

  it('refuses non-GitHub hosts and mismatched repository paths', async () => {
    const registration = registerGitCredential('user-1', 'https://github.com/acme/widgets.git');

    await expect(
      resolveGitCredentialRequest(
        fastify,
        registration.bearerToken,
        ['protocol=https', 'host=gitlab.com', 'path=acme/widgets.git', '', ''].join('\n')
      )
    ).resolves.toBe('');

    await expect(
      resolveGitCredentialRequest(
        fastify,
        registration.bearerToken,
        ['protocol=https', 'host=github.com', 'path=acme/other.git', '', ''].join('\n')
      )
    ).resolves.toBe('');
  });

  it('does not resolve credentials after a registration is revoked', async () => {
    const registration = registerGitCredential('user-1', 'https://github.com/acme/widgets.git');
    expect(__testing.revokeGitCredential(registration.bearerToken)).toBe(true);

    await expect(
      resolveGitCredentialRequest(
        fastify,
        registration.bearerToken,
        ['protocol=https', 'host=github.com', 'path=acme/widgets.git', '', ''].join('\n')
      )
    ).resolves.toBe('');
    expect(mockGetValidGitHubUserAccessToken).not.toHaveBeenCalled();
  });
});
