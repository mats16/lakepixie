import { describe, expect, it } from 'vitest';
import {
  __testing,
  deleteGitHubOAuthStateByState,
  parseGitHubRepository,
  toGitHubRepositoryFullName,
} from './github-oauth.service.js';
import type { FastifyInstance } from 'fastify';

describe('github-oauth.service', () => {
  it('creates RFC 7636 S256 PKCE code challenges', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    expect(__testing.createCodeChallenge(verifier)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });

  it('normalizes GitHub repository identifiers without accepting other hosts', () => {
    expect(parseGitHubRepository('https://github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
    expect(toGitHubRepositoryFullName('acme/widgets')).toBe('acme/widgets');
    expect(() => parseGitHubRepository('https://gitlab.com/acme/widgets')).toThrow(
      'Only HTTPS GitHub repository URLs are supported'
    );
  });

  it('formats pull request head filters with the repository owner prefix', () => {
    expect(__testing.normalizePullRequestListHead('acme', 'feature-x')).toBe('acme:feature-x');
    expect(__testing.normalizePullRequestListHead('fork', 'alice:feature-x')).toBe(
      'alice:feature-x'
    );
  });

  it('does not open async admin transactions for SQLite cleanup queries', async () => {
    let whereCalled = false;
    const db = {
      delete: () => ({
        where: () => {
          whereCalled = true;
          return Promise.resolve();
        },
      }),
      transaction: () => {
        throw new Error('SQLite transaction should not be used');
      },
    };
    const fastify = {
      db,
      isSqlite: true,
    } as unknown as FastifyInstance;

    await expect(deleteGitHubOAuthStateByState(fastify, 'state-1')).resolves.toBeUndefined();
    expect(whereCalled).toBe(true);
  });

  it('propagates SQLite cleanup query failures from async Drizzle calls', async () => {
    const dbError = new Error('delete failed');
    const db = {
      delete: () => ({
        where: () => Promise.reject(dbError),
      }),
      transaction: () => {
        throw new Error('SQLite transaction should not be used');
      },
    };
    const fastify = {
      db,
      isSqlite: true,
    } as unknown as FastifyInstance;

    await expect(deleteGitHubOAuthStateByState(fastify, 'state-1')).rejects.toThrow(
      'delete failed'
    );
  });
});
