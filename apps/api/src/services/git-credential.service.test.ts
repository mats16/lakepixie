import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import * as sqliteSchema from '../db/schema.sqlite.js';

const mockGetValidGitHubUserAccessToken = vi.hoisted(() => vi.fn());

vi.mock('./github-oauth.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./github-oauth.service.js')>();
  return {
    ...actual,
    getValidGitHubUserAccessToken: mockGetValidGitHubUserAccessToken,
  };
});

import {
  registerGitCredential,
  resolveGitCredentialRequest,
  revokeGitCredential,
} from './git-credential.service.js';
import { GitHubOAuthExpiredError } from './github-oauth.service.js';

describe('git-credential.service', () => {
  let sqlite: Database.Database;
  let fastify: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetValidGitHubUserAccessToken.mockResolvedValue('ghu_user_token');
    sqlite = new Database(':memory:');
    const db = drizzleSqlite({ client: sqlite, schema: sqliteSchema });
    db.run(sql`CREATE TABLE users (id TEXT PRIMARY KEY)`);
    db.run(sql`
      CREATE TABLE git_credential_registrations (
        bearer_token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        repo_full_name TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.run(sql`INSERT INTO users (id) VALUES ('user-1')`);
    fastify = { db } as unknown as FastifyInstance;
  });

  afterEach(() => {
    sqlite.close();
  });

  it('returns a Git credential only for the registered GitHub repository', async () => {
    const registration = await registerGitCredential(
      fastify,
      'user-1',
      'https://github.com/acme/widgets.git'
    );

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
    const registration = await registerGitCredential(
      fastify,
      'user-1',
      'https://github.com/acme/widgets.git'
    );

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
    const registration = await registerGitCredential(
      fastify,
      'user-1',
      'https://github.com/acme/widgets.git'
    );
    await revokeGitCredential(fastify, registration.bearerToken);

    await expect(
      resolveGitCredentialRequest(
        fastify,
        registration.bearerToken,
        ['protocol=https', 'host=github.com', 'path=acme/widgets.git', '', ''].join('\n')
      )
    ).resolves.toBe('');
    expect(mockGetValidGitHubUserAccessToken).not.toHaveBeenCalled();
  });

  it('returns empty credentials when GitHub authorization cannot provide a token', async () => {
    const registration = await registerGitCredential(
      fastify,
      'user-1',
      'https://github.com/acme/widgets.git'
    );
    mockGetValidGitHubUserAccessToken.mockRejectedValueOnce(new GitHubOAuthExpiredError());

    await expect(
      resolveGitCredentialRequest(
        fastify,
        registration.bearerToken,
        ['protocol=https', 'host=github.com', 'path=acme/widgets.git', '', ''].join('\n')
      )
    ).resolves.toBe('');
  });
});
