import type { FastifyInstance } from 'fastify';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  DatabricksSecretNotFoundError,
  deleteSecret,
  getSecret,
  listSecretKeys,
  putSecret,
} from './databricks-secrets.service.js';

const INITIAL_KEY_VERSION = '1';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const ACTIVE_KEY_VERSION_SECRET_KEY = 'encryption-active-key-version';
const ENCRYPTION_KEY_SECRET_PREFIX = 'encryption-key-v';
const ENCRYPTION_LOCK_KEY = 51_403_014;

interface EncryptionKey {
  version: string;
  key: Buffer;
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
}

class AsyncMutex {
  private current = Promise.resolve();

  async run<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.current;
    let release!: () => void;
    this.current = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

const processEncryptionKeyMutex = new AsyncMutex();

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

export function getAppSecretScope(fastify: FastifyInstance): string {
  const appName = fastify.config.DATABRICKS_APP_NAME.trim();
  return appName || 'ccbricks-local';
}

function getEncryptionKeySecretKey(version: string): string {
  return `${ENCRYPTION_KEY_SECRET_PREFIX}${version}`;
}

function generateRawKey(): string {
  return randomBytes(KEY_LENGTH_BYTES).toString('hex');
}

function parseEncryptionKeyVersion(secretKey: string): string | null {
  if (!secretKey.startsWith(ENCRYPTION_KEY_SECRET_PREFIX)) return null;
  const version = secretKey.slice(ENCRYPTION_KEY_SECRET_PREFIX.length).trim();
  return version || null;
}

function compareEncryptionKeyVersions(a: string, b: string): number {
  const numericA = Number(a);
  const numericB = Number(b);
  if (Number.isFinite(numericA) && Number.isFinite(numericB)) {
    return numericA - numericB;
  }
  return a.localeCompare(b);
}

function parseRawKey(value: string, version: string): Buffer {
  const trimmed = value.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new EncryptionKeyError(`Encryption key version ${version} is not a 32-byte hex key`);
  }
  return Buffer.from(trimmed, 'hex');
}

async function getEncryptionKeyByVersionUnlocked(
  fastify: FastifyInstance,
  version: string
): Promise<EncryptionKey> {
  const scope = getAppSecretScope(fastify);
  const rawKey = await getSecret(fastify, scope, getEncryptionKeySecretKey(version));
  return { version, key: parseRawKey(rawKey, version) };
}

async function bootstrapInitialEncryptionKey(fastify: FastifyInstance): Promise<EncryptionKey> {
  const scope = getAppSecretScope(fastify);

  const existingVersions = (await listSecretKeys(fastify, scope))
    .map(parseEncryptionKeyVersion)
    .filter((version): version is string => version !== null)
    .sort(compareEncryptionKeyVersions);
  const newestExistingVersion = existingVersions.at(-1);
  if (newestExistingVersion && newestExistingVersion !== INITIAL_KEY_VERSION) {
    const existingKey = await getEncryptionKeyByVersionUnlocked(fastify, newestExistingVersion);
    await putSecret(fastify, scope, ACTIVE_KEY_VERSION_SECRET_KEY, newestExistingVersion);
    return existingKey;
  }

  let rawKey: string;
  try {
    rawKey = await getSecret(fastify, scope, getEncryptionKeySecretKey(INITIAL_KEY_VERSION));
  } catch (error) {
    if (!(error instanceof DatabricksSecretNotFoundError)) throw error;
    rawKey = generateRawKey();
    await putSecret(fastify, scope, getEncryptionKeySecretKey(INITIAL_KEY_VERSION), rawKey);
  }

  await putSecret(fastify, scope, ACTIVE_KEY_VERSION_SECRET_KEY, INITIAL_KEY_VERSION);
  return { version: INITIAL_KEY_VERSION, key: parseRawKey(rawKey, INITIAL_KEY_VERSION) };
}

async function getActiveEncryptionKeyUnlocked(fastify: FastifyInstance): Promise<EncryptionKey> {
  const scope = getAppSecretScope(fastify);

  try {
    const version = (await getSecret(fastify, scope, ACTIVE_KEY_VERSION_SECRET_KEY)).trim();
    if (!version) return bootstrapInitialEncryptionKey(fastify);
    return getEncryptionKeyByVersionUnlocked(fastify, version);
  } catch (error) {
    if (error instanceof DatabricksSecretNotFoundError) {
      return bootstrapInitialEncryptionKey(fastify);
    }
    throw error;
  }
}

export async function getActiveEncryptionKeyWithinLock(
  fastify: FastifyInstance
): Promise<EncryptionKey> {
  return getActiveEncryptionKeyUnlocked(fastify);
}

export async function getEncryptionKeyByVersionWithinLock(
  fastify: FastifyInstance,
  version: string
): Promise<EncryptionKey> {
  return getEncryptionKeyByVersionUnlocked(fastify, version);
}

export async function withEncryptionKeyLock<T>(
  fastify: FastifyInstance,
  callback: () => Promise<T>
): Promise<T> {
  return processEncryptionKeyMutex.run(async () => {
    if (fastify.isSqlite) return callback();

    return fastify.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ENCRYPTION_LOCK_KEY})`);
      return callback();
    });
  });
}

export async function getActiveEncryptionKey(fastify: FastifyInstance): Promise<EncryptionKey> {
  return withEncryptionKeyLock(fastify, () => getActiveEncryptionKeyUnlocked(fastify));
}

export async function getEncryptionKeyByVersion(
  fastify: FastifyInstance,
  version: string
): Promise<EncryptionKey> {
  return withEncryptionKeyLock(fastify, () => getEncryptionKeyByVersionUnlocked(fastify, version));
}

export async function getActiveEncryptionKeyVersion(
  fastify: FastifyInstance
): Promise<string | null> {
  try {
    return (await getActiveEncryptionKey(fastify)).version;
  } catch (error) {
    if (error instanceof DatabricksSecretNotFoundError) return null;
    throw error;
  }
}

export function encryptWithKey(plaintext: string, encryptionKey: EncryptionKey): EncryptedSecret {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    authTag: authTag.toString('base64url'),
    keyVersion: encryptionKey.version,
  };
}

export async function encryptSecret(
  fastify: FastifyInstance,
  plaintext: string
): Promise<EncryptedSecret> {
  const key = await getActiveEncryptionKey(fastify);
  return encryptWithKey(plaintext, key);
}

export function decryptWithKey(encrypted: EncryptedSecret, encryptionKey: EncryptionKey): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey.key,
    Buffer.from(encrypted.iv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export async function decryptSecret(
  fastify: FastifyInstance,
  encrypted: EncryptedSecret
): Promise<string> {
  const key = await getEncryptionKeyByVersion(fastify, encrypted.keyVersion);
  return decryptWithKey(encrypted, key);
}

export async function createNextEncryptionKey(fastify: FastifyInstance): Promise<EncryptionKey> {
  const scope = getAppSecretScope(fastify);
  const version = Date.now().toString();
  const rawKey = generateRawKey();
  await putSecret(fastify, scope, getEncryptionKeySecretKey(version), rawKey);
  return { version, key: parseRawKey(rawKey, version) };
}

export async function setActiveEncryptionKeyVersion(
  fastify: FastifyInstance,
  version: string
): Promise<void> {
  await putSecret(fastify, getAppSecretScope(fastify), ACTIVE_KEY_VERSION_SECRET_KEY, version);
}

export async function deleteEncryptionKeyVersion(
  fastify: FastifyInstance,
  version: string
): Promise<void> {
  await deleteSecret(fastify, getAppSecretScope(fastify), getEncryptionKeySecretKey(version));
}

export const __testing = {
  INITIAL_KEY_VERSION,
  ACTIVE_KEY_VERSION_SECRET_KEY,
  getEncryptionKeySecretKey,
  parseEncryptionKeyVersion,
  parseRawKey,
};
