import type { FastifyInstance } from 'fastify';
import { getAuthProvider } from '../lib/databricks-auth.js';

interface DatabricksErrorResponse {
  error_code?: string;
  message?: string;
}

interface SecretResponse {
  value?: string;
}

interface SecretMetadata {
  key?: string;
}

interface ListSecretsResponse {
  secrets?: SecretMetadata[];
}

export class DatabricksSecretNotFoundError extends Error {
  constructor(scope: string, key: string) {
    super(`Secret '${key}' was not found in scope '${scope}'`);
    this.name = 'DatabricksSecretNotFoundError';
  }
}

export class DatabricksSecretsPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabricksSecretsPermissionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function parseDatabricksError(response: Response): Promise<DatabricksErrorResponse> {
  try {
    const body = (await response.json()) as unknown;
    if (!isRecord(body)) return {};
    return {
      error_code: typeof body.error_code === 'string' ? body.error_code : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
    };
  } catch {
    return {};
  }
}

function isNotFound(response: Response, error: DatabricksErrorResponse): boolean {
  return (
    response.status === 404 ||
    error.error_code === 'RESOURCE_DOES_NOT_EXIST' ||
    error.error_code === 'NOT_FOUND'
  );
}

function isAlreadyExists(error: DatabricksErrorResponse): boolean {
  return (
    error.error_code === 'RESOURCE_ALREADY_EXISTS' ||
    error.message?.includes('already exists') === true
  );
}

function isPermissionError(response: Response, error: DatabricksErrorResponse): boolean {
  return (
    response.status === 401 ||
    response.status === 403 ||
    error.error_code === 'PERMISSION_DENIED' ||
    error.error_code === 'UNAUTHENTICATED'
  );
}

async function getDatabricksApiToken(fastify: FastifyInstance): Promise<string> {
  return getAuthProvider(fastify).getToken();
}

async function secretsRequest<T>(
  fastify: FastifyInstance,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const token = await getDatabricksApiToken(fastify);
  const url = new URL(path, `https://${fastify.config.DATABRICKS_HOST}`);
  const response = await fetch(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (response.ok) {
    return (await response.json().catch(() => ({}))) as T;
  }

  const error = await parseDatabricksError(response);
  if (isPermissionError(response, error)) {
    throw new DatabricksSecretsPermissionError(
      'The app service principal does not have permission to manage the Databricks secret scope. Grant it permission to create/read/write secrets for this app.'
    );
  }

  throw new Error(error.message || `Databricks Secrets API returned ${response.status}`);
}

const ensuredScopes = new Set<string>();

export async function ensureSecretScope(fastify: FastifyInstance, scope: string): Promise<void> {
  if (ensuredScopes.has(scope)) return;
  const token = await getDatabricksApiToken(fastify);
  const url = new URL(
    '/api/2.0/secrets/scopes/create',
    `https://${fastify.config.DATABRICKS_HOST}`
  );
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ scope }),
  });

  if (response.ok) {
    ensuredScopes.add(scope);
    return;
  }

  const error = await parseDatabricksError(response);
  if (isAlreadyExists(error)) {
    ensuredScopes.add(scope);
    return;
  }
  if (isPermissionError(response, error)) {
    throw new DatabricksSecretsPermissionError(
      'The app service principal does not have permission to create the Databricks secret scope. Grant it permission to create/read/write secrets for this app.'
    );
  }
  throw new Error(error.message || `Databricks Secrets API returned ${response.status}`);
}

export async function putSecret(
  fastify: FastifyInstance,
  scope: string,
  key: string,
  value: string
): Promise<void> {
  await ensureSecretScope(fastify, scope);
  await secretsRequest<Record<string, never>>(fastify, 'POST', '/api/2.0/secrets/put', {
    scope,
    key,
    string_value: value,
  });
}

export async function deleteSecret(
  fastify: FastifyInstance,
  scope: string,
  key: string
): Promise<void> {
  try {
    await secretsRequest<Record<string, never>>(fastify, 'POST', '/api/2.0/secrets/delete', {
      scope,
      key,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not exist')) return;
    throw error;
  }
}

export async function getSecret(
  fastify: FastifyInstance,
  scope: string,
  key: string
): Promise<string> {
  const token = await getDatabricksApiToken(fastify);
  const url = new URL('/api/2.0/secrets/get', `https://${fastify.config.DATABRICKS_HOST}`);
  url.searchParams.set('scope', scope);
  url.searchParams.set('key', key);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await parseDatabricksError(response);
    if (isNotFound(response, error)) {
      throw new DatabricksSecretNotFoundError(scope, key);
    }
    if (isPermissionError(response, error)) {
      throw new DatabricksSecretsPermissionError(
        'The app service principal does not have permission to read the Databricks secret scope.'
      );
    }
    throw new Error(error.message || `Databricks Secrets API returned ${response.status}`);
  }

  const data = (await response.json()) as SecretResponse;
  if (!data.value) {
    throw new DatabricksSecretNotFoundError(scope, key);
  }

  return Buffer.from(data.value, 'base64').toString('utf-8');
}

export async function listSecretKeys(fastify: FastifyInstance, scope: string): Promise<string[]> {
  try {
    const data = await secretsRequest<ListSecretsResponse>(
      fastify,
      'GET',
      `/api/2.0/secrets/list?scope=${encodeURIComponent(scope)}`
    );
    return (data.secrets ?? [])
      .map(secret => secret.key)
      .filter((key): key is string => typeof key === 'string');
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not exist')) return [];
    throw error;
  }
}

export const __testing = {
  ensuredScopes,
  isAlreadyExists,
  isNotFound,
  isPermissionError,
};
