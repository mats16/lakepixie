import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const mockGetSecret = vi.hoisted(() => vi.fn());
const mockGetGitHubAppIdSetting = vi.hoisted(() => vi.fn());
const mockUpdateGitHubAppIdSetting = vi.hoisted(() => vi.fn());

vi.mock('./databricks-secrets.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./databricks-secrets.service.js')>();
  return {
    ...actual,
    getSecret: mockGetSecret,
  };
});

vi.mock('./admin.service.js', () => ({
  getGitHubAppIdSetting: mockGetGitHubAppIdSetting,
  updateGitHubAppIdSetting: mockUpdateGitHubAppIdSetting,
}));

import {
  __testing,
  createGitHubAppJwt,
  listGitHubAppRepositoryBranches,
  listGitHubAppRepositories,
} from './github-app-auth.service.js';

function decodeBase64UrlJson(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf-8')) as Record<string, unknown>;
}

describe('github-app-auth.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing.clearGitHubAppCaches();
    mockGetGitHubAppIdSetting.mockResolvedValue(null);
    mockUpdateGitHubAppIdSetting.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses DATABRICKS_APP_NAME as the secret scope and falls back locally', () => {
    const withAppName = {
      config: { DATABRICKS_APP_NAME: 'ccbricks-prod' },
    } as FastifyInstance;
    const withoutAppName = {
      config: { DATABRICKS_APP_NAME: '' },
    } as FastifyInstance;

    expect(__testing.getGitHubAppSecretScope(withAppName)).toBe('ccbricks-prod');
    expect(__testing.getGitHubAppSecretScope(withoutAppName)).toBe('ccbricks-local');
  });

  it('parses HTTPS GitHub repository URLs and full names', () => {
    expect(__testing.parseGitHubRepository('https://github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
    expect(__testing.toGitHubRepositoryFullName('acme/widgets')).toBe('acme/widgets');
    expect(() => __testing.parseGitHubRepository('https://gitlab.com/acme/widgets')).toThrow(
      'Only HTTPS GitHub repository URLs are supported'
    );
  });

  it('creates a verifiable GitHub App JWT without external dependencies', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const jwt = createGitHubAppJwt('123456', privatePem, Date.UTC(2026, 0, 1, 0, 0, 0));
    const [header, payload, signature] = jwt.split('.');

    expect(decodeBase64UrlJson(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeBase64UrlJson(payload)).toMatchObject({ iss: '123456' });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true);
  });

  it('lists repositories visible to the GitHub App installation and filters locally', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];

    mockGetGitHubAppIdSetting.mockResolvedValue('123456');
    mockGetSecret.mockImplementation(
      (_fastify: FastifyInstance, _scope: string, key: string): Promise<string> =>
        key === 'github-app-private-key' ? Promise.resolve(privatePem) : Promise.resolve('')
    );

    const mockFetch = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url =
          typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          method: init?.method ?? 'GET',
          authorization: headers.get('authorization'),
          body,
        });

        if (url.startsWith('https://api.github.com/app/installations?')) {
          return new Response(JSON.stringify([{ id: 42 }]), { status: 200 });
        }

        if (url === 'https://api.github.com/app/installations/42/access_tokens') {
          return new Response(
            JSON.stringify({
              token: 'installation-token',
              expires_at: '2026-01-01T01:00:00Z',
            }),
            { status: 200 }
          );
        }

        if (url.startsWith('https://api.github.com/installation/repositories?')) {
          return new Response(
            JSON.stringify({
              repositories: [
                {
                  full_name: 'acme/widgets',
                  html_url: 'https://github.com/acme/widgets',
                },
                {
                  full_name: 'acme/service',
                  html_url: 'https://github.com/acme/service',
                },
              ],
            }),
            { status: 200 }
          );
        }

        return new Response(JSON.stringify({ message: 'unexpected request' }), { status: 500 });
      }
    );
    vi.stubGlobal('fetch', mockFetch);

    const fastify = {
      config: { DATABRICKS_APP_NAME: 'ccbricks-dev' },
    } as FastifyInstance;

    await expect(listGitHubAppRepositories(fastify, 'widget')).resolves.toEqual([
      {
        full_name: 'acme/widgets',
        url: 'https://github.com/acme/widgets',
      },
    ]);
    await expect(listGitHubAppRepositories(fastify, 'service')).resolves.toEqual([
      {
        full_name: 'acme/service',
        url: 'https://github.com/acme/service',
      },
    ]);

    expect(requests).toEqual([
      expect.objectContaining({
        url: 'https://api.github.com/app/installations?per_page=100&page=1',
        method: 'GET',
      }),
      expect.objectContaining({
        url: 'https://api.github.com/app/installations/42/access_tokens',
        method: 'POST',
        body: { permissions: { contents: 'read' } },
      }),
      expect.objectContaining({
        url: 'https://api.github.com/installation/repositories?per_page=100&page=1',
        method: 'GET',
        authorization: 'Bearer installation-token',
      }),
    ]);
  });

  it('lists branches for a repository through a scoped installation token', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];

    mockGetGitHubAppIdSetting.mockResolvedValue('123456');
    mockGetSecret.mockImplementation(
      (_fastify: FastifyInstance, _scope: string, key: string): Promise<string> =>
        key === 'github-app-private-key' ? Promise.resolve(privatePem) : Promise.resolve('')
    );

    const mockFetch = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url =
          typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          method: init?.method ?? 'GET',
          authorization: headers.get('authorization'),
          body,
        });

        if (url === 'https://api.github.com/repos/acme/widgets/installation') {
          return new Response(JSON.stringify({ id: 42 }), { status: 200 });
        }

        if (url === 'https://api.github.com/app/installations/42/access_tokens') {
          return new Response(
            JSON.stringify({
              token: 'installation-token',
              expires_at: '2026-01-01T01:00:00Z',
            }),
            { status: 200 }
          );
        }

        if (url.startsWith('https://api.github.com/repos/acme/widgets/branches?')) {
          return new Response(
            JSON.stringify([
              { name: 'main', protected: true },
              { name: 'release/v1', protected: false },
            ]),
            { status: 200 }
          );
        }

        return new Response(JSON.stringify({ message: 'unexpected request' }), { status: 500 });
      }
    );
    vi.stubGlobal('fetch', mockFetch);

    const fastify = {
      config: { DATABRICKS_APP_NAME: 'ccbricks-dev' },
    } as FastifyInstance;

    await expect(listGitHubAppRepositoryBranches(fastify, 'acme/widgets')).resolves.toEqual([
      { name: 'main', protected: true },
      { name: 'release/v1', protected: false },
    ]);
    await expect(listGitHubAppRepositoryBranches(fastify, 'acme/widgets')).resolves.toEqual([
      { name: 'main', protected: true },
      { name: 'release/v1', protected: false },
    ]);

    expect(requests).toEqual([
      expect.objectContaining({
        url: 'https://api.github.com/repos/acme/widgets/installation',
        method: 'GET',
      }),
      expect.objectContaining({
        url: 'https://api.github.com/app/installations/42/access_tokens',
        method: 'POST',
        body: { permissions: { contents: 'read' }, repositories: ['widgets'] },
      }),
      expect.objectContaining({
        url: 'https://api.github.com/repos/acme/widgets/branches?per_page=100&page=1',
        method: 'GET',
        authorization: 'Bearer installation-token',
      }),
    ]);
  });
});
