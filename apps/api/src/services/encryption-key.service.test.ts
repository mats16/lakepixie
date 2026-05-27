import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const secretStore = vi.hoisted(() => new Map<string, string>());

vi.mock('./databricks-secrets.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./databricks-secrets.service.js')>();

  return {
    ...actual,
    getSecret: vi.fn(async (_fastify: FastifyInstance, scope: string, key: string) => {
      const value = secretStore.get(`${scope}:${key}`);
      if (value === undefined) throw new actual.DatabricksSecretNotFoundError(scope, key);
      return value;
    }),
    putSecret: vi.fn(
      async (_fastify: FastifyInstance, scope: string, key: string, value: string) => {
        secretStore.set(`${scope}:${key}`, value);
      }
    ),
    deleteSecret: vi.fn(async (_fastify: FastifyInstance, scope: string, key: string) => {
      secretStore.delete(`${scope}:${key}`);
    }),
  };
});

import {
  __testing,
  decryptSecret,
  encryptSecret,
  getActiveEncryptionKey,
  getAppSecretScope,
} from './encryption-key.service.js';

describe('encryption-key.service', () => {
  const fastify = {
    config: { DATABRICKS_APP_NAME: 'ccbricks-test' },
    isSqlite: true,
  } as FastifyInstance;

  beforeEach(() => {
    secretStore.clear();
  });

  it('bootstraps the active encryption key in Databricks Secrets when missing', async () => {
    const key = await getActiveEncryptionKey(fastify);
    const scope = getAppSecretScope(fastify);

    expect(key.version).toBe(__testing.INITIAL_KEY_VERSION);
    expect(key.key).toHaveLength(32);
    expect(secretStore.get(`${scope}:${__testing.ACTIVE_KEY_VERSION_SECRET_KEY}`)).toBe(
      __testing.INITIAL_KEY_VERSION
    );
    expect(
      secretStore.get(
        `${scope}:${__testing.getEncryptionKeySecretKey(__testing.INITIAL_KEY_VERSION)}`
      )
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('encrypts secrets with the active key version and decrypts them by row version', async () => {
    const encrypted = await encryptSecret(fastify, 'ghu_token');

    expect(encrypted.keyVersion).toBe(__testing.INITIAL_KEY_VERSION);
    await expect(decryptSecret(fastify, encrypted)).resolves.toBe('ghu_token');
  });
});
