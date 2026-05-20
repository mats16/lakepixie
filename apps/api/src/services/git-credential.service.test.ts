import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mockGetGitHubAppInstallationToken = vi.hoisted(() => vi.fn());

vi.mock('./github-app-auth.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./github-app-auth.service.js')>();
  return {
    ...actual,
    getGitHubAppInstallationToken: mockGetGitHubAppInstallationToken,
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
    mockGetGitHubAppInstallationToken.mockResolvedValue('ghs_installation_token');
  });

  it('returns a Git credential only for the registered GitHub repository', async () => {
    const registration = registerGitCredential('https://github.com/acme/widgets.git', 'write');

    const output = await resolveGitCredentialRequest(
      fastify,
      registration.bearerToken,
      ['protocol=https', 'host=github.com', 'path=acme/widgets.git', '', ''].join('\n')
    );

    expect(output).toContain('username=x-access-token');
    expect(output).toContain('password=ghs_installation_token');
    expect(mockGetGitHubAppInstallationToken).toHaveBeenCalledWith(
      fastify,
      'acme/widgets',
      'write'
    );
  });

  it('refuses non-GitHub hosts and mismatched repository paths', async () => {
    const registration = registerGitCredential('https://github.com/acme/widgets.git', 'write');

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
});
