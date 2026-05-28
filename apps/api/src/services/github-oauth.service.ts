import type { FastifyInstance } from 'fastify';
import { and, eq, lt, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  GitHubOAuthAdminResponse,
  GitHubOAuthAuthorizationResponse,
  GitHubOAuthEncryptionKeyRotateResponse,
  GitRepositoryBranchCandidate,
  GitRepositoryBranchDetailResponse,
  GitRepositoryCandidate,
  GitRepositoryPullRequest,
  GitRepositoryPullRequestCreateRequest,
  GitRepositoryPullRequestStateFilter,
  UpdateGitHubOAuthAdminRequest,
} from '@repo/types';
import {
  DatabricksSecretNotFoundError,
  deleteSecret,
  getSecret,
  putSecret,
} from './databricks-secrets.service.js';
import {
  createNextEncryptionKey,
  decryptWithKey,
  deleteEncryptionKeyVersion,
  encryptWithKey,
  getAppSecretScope,
  getActiveEncryptionKeyWithinLock,
  getActiveEncryptionKeyVersion,
  getEncryptionKeyByVersionWithinLock,
  setActiveEncryptionKeyVersion,
  withEncryptionKeyLock,
  type EncryptedSecret,
} from './encryption-key.service.js';
import {
  appSettings,
  githubOAuthStates,
  githubUserAuthorizations,
  type GithubOAuthState,
  type GithubUserAuthorization,
} from '../db/schema.js';

const GITHUB_OAUTH_CLIENT_ID_SETTING_KEY = 'github_oauth_client_id';
export const GITHUB_OAUTH_CLIENT_SECRET_KEY = 'github-oauth-client-secret';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_PAGE_SIZE = '100';
const GITHUB_MAX_PAGES = 50;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface GitHubOAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

interface GitHubOAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserResponse {
  id?: number;
  login?: string;
}

interface GitHubInstallationResponse {
  id?: number;
}

interface GitHubUserInstallationsResponse {
  installations?: GitHubInstallationResponse[];
}

interface GitHubRepositoryResponse {
  full_name?: string;
  html_url?: string;
  clone_url?: string;
  default_branch?: string;
}

interface GitHubInstallationRepositoriesResponse {
  repositories?: GitHubRepositoryResponse[];
}

interface GitHubBranchResponse {
  name?: string;
  protected?: boolean;
}

interface GitHubPullRequestResponse {
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  html_url?: string;
  additions?: number;
  deletions?: number;
  head?: {
    ref?: string;
    label?: string;
  };
  base?: {
    ref?: string;
    label?: string;
  };
}

export class GitHubOAuthNotConfiguredError extends Error {
  constructor() {
    super('GitHub OAuth is not configured');
    this.name = 'GitHubOAuthNotConfiguredError';
  }
}

export class GitHubOAuthAuthorizationRequiredError extends Error {
  constructor() {
    super('GitHub authorization is required');
    this.name = 'GitHubOAuthAuthorizationRequiredError';
  }
}

export class GitHubOAuthExpiredError extends Error {
  constructor() {
    super('GitHub authorization has expired');
    this.name = 'GitHubOAuthExpiredError';
  }
}

export class GitHubOAuthError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'GitHubOAuthError';
  }
}

function base64UrlRandom(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

function expiresAtFromSeconds(seconds: number | undefined): Date | null {
  return Number.isFinite(seconds) && seconds !== undefined
    ? new Date(Date.now() + seconds * 1000)
    : null;
}

function hasNextPage(headers: Headers): boolean {
  return (
    headers
      .get('link')
      ?.split(',')
      .some(link => link.includes('rel="next"')) === true
  );
}

async function parseResponseDetails(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return response.text().catch(() => undefined);
  }
}

function getEncryptedSecret(row: {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
}): EncryptedSecret {
  return {
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
    keyVersion: row.keyVersion,
  };
}

function accessTokenSecret(row: GithubUserAuthorization): EncryptedSecret {
  return getEncryptedSecret({
    ciphertext: row.accessTokenCiphertext,
    iv: row.accessTokenIv,
    authTag: row.accessTokenAuthTag,
    keyVersion: row.accessTokenKeyVersion,
  });
}

function refreshTokenSecret(row: GithubUserAuthorization): EncryptedSecret | null {
  if (
    !row.refreshTokenCiphertext ||
    !row.refreshTokenIv ||
    !row.refreshTokenAuthTag ||
    !row.refreshTokenKeyVersion
  ) {
    return null;
  }
  return getEncryptedSecret({
    ciphertext: row.refreshTokenCiphertext,
    iv: row.refreshTokenIv,
    authTag: row.refreshTokenAuthTag,
    keyVersion: row.refreshTokenKeyVersion,
  });
}

function encryptedAccessTokenColumns(secret: EncryptedSecret) {
  return {
    accessTokenCiphertext: secret.ciphertext,
    accessTokenIv: secret.iv,
    accessTokenAuthTag: secret.authTag,
    accessTokenKeyVersion: secret.keyVersion,
  };
}

function encryptedRefreshTokenColumns(secret: EncryptedSecret | null) {
  return secret
    ? {
        refreshTokenCiphertext: secret.ciphertext,
        refreshTokenIv: secret.iv,
        refreshTokenAuthTag: secret.authTag,
        refreshTokenKeyVersion: secret.keyVersion,
      }
    : {
        refreshTokenCiphertext: null,
        refreshTokenIv: null,
        refreshTokenAuthTag: null,
        refreshTokenKeyVersion: null,
      };
}

function getCodeVerifierSecret(row: GithubOAuthState): EncryptedSecret {
  return {
    ciphertext: row.codeVerifierCiphertext,
    iv: row.codeVerifierIv,
    authTag: row.codeVerifierAuthTag,
    keyVersion: row.codeVerifierKeyVersion,
  };
}

function normalizeRepositoryCandidate(
  repository: GitHubRepositoryResponse
): GitRepositoryCandidate | null {
  if (!repository.full_name || !/^[^/\s]+\/[^/\s]+$/.test(repository.full_name)) {
    return null;
  }
  return {
    full_name: repository.full_name,
    url:
      repository.html_url ?? repository.clone_url ?? `https://github.com/${repository.full_name}`,
    ...(repository.default_branch ? { default_branch: repository.default_branch } : {}),
  };
}

export function parseGitHubRepository(value: string): { owner: string; repo: string } {
  const trimmed = value.trim();
  const fullNameMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (fullNameMatch) {
    return { owner: fullNameMatch[1], repo: fullNameMatch[2] };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GitHubOAuthError('Invalid GitHub repository URL');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new GitHubOAuthError('Only HTTPS GitHub repository URLs are supported');
  }

  const [owner, rawRepo] = url.pathname.replace(/^\/+/, '').split('/');
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo) {
    throw new GitHubOAuthError('Invalid GitHub repository URL');
  }
  return { owner, repo };
}

export function toGitHubRepositoryFullName(value: string): string {
  const { owner, repo } = parseGitHubRepository(value);
  return `${owner}/${repo}`;
}

function getRepositoryHtmlUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

function getBranchHtmlUrl(owner: string, repo: string, branch: string): string {
  return `${getRepositoryHtmlUrl(owner, repo)}/tree/${encodeURIComponent(branch)}`;
}

function normalizePullRequest(pull: GitHubPullRequestResponse): GitRepositoryPullRequest | null {
  if (
    !pull.number ||
    !pull.title ||
    (pull.state !== 'open' && pull.state !== 'closed') ||
    !pull.html_url ||
    !pull.head?.ref ||
    !pull.head.label ||
    !pull.base?.ref ||
    !pull.base.label
  ) {
    return null;
  }

  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft ?? false,
    merged: pull.merged ?? false,
    html_url: pull.html_url,
    ...(pull.additions !== undefined ? { additions: pull.additions } : {}),
    ...(pull.deletions !== undefined ? { deletions: pull.deletions } : {}),
    head: {
      ref: pull.head.ref,
      label: pull.head.label,
    },
    base: {
      ref: pull.base.ref,
      label: pull.base.label,
    },
  };
}

export function normalizePullRequestCreateHead(repositoryOwner: string, head: string): string {
  const ownerPrefix = `${repositoryOwner}:`;
  return head.startsWith(ownerPrefix) ? head.slice(ownerPrefix.length) : head;
}

export function normalizePullRequestListHead(repositoryOwner: string, head: string): string {
  return head.includes(':') ? head : `${repositoryOwner}:${head}`;
}

async function githubFetch<T>(
  url: string,
  token: string,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {}
): Promise<{ data: T; headers: Headers }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'ccbricks',
      'x-github-api-version': GITHUB_API_VERSION,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const details = await parseResponseDetails(response);
    throw new GitHubOAuthError(`GitHub API returned ${response.status}`, details);
  }

  return {
    data: (await response.json()) as T,
    headers: response.headers,
  };
}

async function githubRequest<T>(
  url: string,
  token: string,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {}
): Promise<T> {
  return (await githubFetch<T>(url, token, init)).data;
}

async function getGitHubOAuthClientId(fastify: FastifyInstance): Promise<string | null> {
  const rows = await fastify.db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, GITHUB_OAUTH_CLIENT_ID_SETTING_KEY))
    .limit(1);
  return rows[0]?.value.trim() || null;
}

async function updateGitHubOAuthClientId(
  fastify: FastifyInstance,
  clientId: string | null
): Promise<void> {
  const value = clientId?.trim() ?? '';
  if (!value) {
    await fastify.db
      .delete(appSettings)
      .where(eq(appSettings.key, GITHUB_OAUTH_CLIENT_ID_SETTING_KEY));
    return;
  }

  await fastify.db
    .insert(appSettings)
    .values({ key: GITHUB_OAUTH_CLIENT_ID_SETTING_KEY, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value },
    });
}

async function getGitHubOAuthClientSecret(fastify: FastifyInstance): Promise<string | null> {
  try {
    return (
      await getSecret(fastify, getAppSecretScope(fastify), GITHUB_OAUTH_CLIENT_SECRET_KEY)
    ).trim();
  } catch (error) {
    if (error instanceof DatabricksSecretNotFoundError) return null;
    throw error;
  }
}

async function getGitHubOAuthClientConfig(
  fastify: FastifyInstance
): Promise<GitHubOAuthClientConfig> {
  const [clientId, clientSecret] = await Promise.all([
    getGitHubOAuthClientId(fastify),
    getGitHubOAuthClientSecret(fastify),
  ]);
  if (!clientId || !clientSecret) throw new GitHubOAuthNotConfiguredError();
  return { clientId, clientSecret };
}

async function runAdminDatabaseTransaction(
  fastify: FastifyInstance,
  callback: (tx: typeof fastify.db) => Promise<void>
): Promise<void> {
  if (fastify.isSqlite) {
    await callback(fastify.db);
    return;
  }

  await fastify.db.transaction(async tx => {
    await tx.execute(sql`set local row_security = off`);
    await callback(tx as unknown as typeof fastify.db);
  });
}

async function deleteExpiredOAuthStates(fastify: FastifyInstance): Promise<void> {
  await runAdminDatabaseTransaction(fastify, async tx => {
    await tx.delete(githubOAuthStates).where(lt(githubOAuthStates.expiresAt, new Date()));
  });
}

async function deleteOAuthStatesForUser(fastify: FastifyInstance, userId: string): Promise<void> {
  await fastify.withUserContext(userId, async tx => {
    await tx.delete(githubOAuthStates).where(eq(githubOAuthStates.userId, userId));
  });
}

export async function deleteGitHubOAuthStateByState(
  fastify: FastifyInstance,
  state: string
): Promise<void> {
  await runAdminDatabaseTransaction(fastify, async tx => {
    await tx.delete(githubOAuthStates).where(eq(githubOAuthStates.state, state));
  });
}

export async function getGitHubOAuthAdminStatus(
  fastify: FastifyInstance,
  redirectUri: string
): Promise<GitHubOAuthAdminResponse> {
  const [clientId, clientSecret, activeKeyVersion] = await Promise.all([
    getGitHubOAuthClientId(fastify),
    getGitHubOAuthClientSecret(fastify),
    getActiveEncryptionKeyVersion(fastify),
  ]);

  return {
    client_id: clientId,
    client_secret_configured: Boolean(clientSecret),
    client_secret_last8: clientSecret ? clientSecret.slice(-8) : null,
    redirect_uri: redirectUri,
    encryption_key_configured: Boolean(activeKeyVersion),
    encryption_key_version: activeKeyVersion,
  };
}

export async function updateGitHubOAuthAdminSettings(
  fastify: FastifyInstance,
  request: UpdateGitHubOAuthAdminRequest,
  redirectUri: string
): Promise<GitHubOAuthAdminResponse> {
  if (request.client_id !== undefined) {
    await updateGitHubOAuthClientId(fastify, request.client_id);
  }

  if (request.client_secret !== undefined) {
    const value = request.client_secret?.trim() ?? '';
    if (value) {
      await putSecret(fastify, getAppSecretScope(fastify), GITHUB_OAUTH_CLIENT_SECRET_KEY, value);
    } else {
      await deleteSecret(fastify, getAppSecretScope(fastify), GITHUB_OAUTH_CLIENT_SECRET_KEY);
    }
  }

  return getGitHubOAuthAdminStatus(fastify, redirectUri);
}

async function getAuthorizationRow(
  fastify: FastifyInstance,
  userId: string
): Promise<GithubUserAuthorization | undefined> {
  const rows = (await fastify.withUserContext(userId, async tx =>
    tx
      .select()
      .from(githubUserAuthorizations)
      .where(eq(githubUserAuthorizations.userId, userId))
      .limit(1)
  )) as GithubUserAuthorization[];
  return rows[0];
}

async function saveAuthorization(params: {
  fastify: FastifyInstance;
  userId: string;
  githubUserId: string;
  githubLogin: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}): Promise<void> {
  await withEncryptionKeyLock(params.fastify, () => saveAuthorizationWithinLock(params));
}

async function saveAuthorizationWithinLock(params: {
  fastify: FastifyInstance;
  userId: string;
  githubUserId: string;
  githubLogin: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}): Promise<void> {
  const { fastify, userId } = params;
  const encryptionKey = await getActiveEncryptionKeyWithinLock(fastify);
  const accessToken = encryptWithKey(params.accessToken, encryptionKey);
  const refreshToken = params.refreshToken
    ? encryptWithKey(params.refreshToken, encryptionKey)
    : null;
  const values = {
    userId,
    githubUserId: params.githubUserId,
    githubLogin: params.githubLogin,
    ...encryptedAccessTokenColumns(accessToken),
    ...encryptedRefreshTokenColumns(refreshToken),
    tokenExpiresAt: params.tokenExpiresAt,
    refreshTokenExpiresAt: params.refreshTokenExpiresAt,
  };

  await fastify.withUserContext(userId, async tx => {
    const [existing] = (await tx
      .select({
        githubUserId: githubUserAuthorizations.githubUserId,
        githubLogin: githubUserAuthorizations.githubLogin,
      })
      .from(githubUserAuthorizations)
      .where(eq(githubUserAuthorizations.userId, userId))
      .limit(1)) as Array<{ githubUserId: string; githubLogin: string }>;

    if (existing && existing.githubUserId !== params.githubUserId) {
      fastify.log.warn(
        {
          userId,
          currentGitHubUserId: existing.githubUserId,
          currentGitHubLogin: existing.githubLogin,
          attemptedGitHubUserId: params.githubUserId,
          attemptedGitHubLogin: params.githubLogin,
        },
        'Rejected GitHub OAuth account switch without explicit confirmation'
      );
      throw new GitHubOAuthError('GitHub account switch requires explicit confirmation');
    }

    await tx.insert(githubUserAuthorizations).values(values).onConflictDoUpdate({
      target: githubUserAuthorizations.userId,
      set: values,
    });
  });
}

async function decryptSecretWithinLock(
  fastify: FastifyInstance,
  encrypted: EncryptedSecret
): Promise<string> {
  const key = await getEncryptionKeyByVersionWithinLock(fastify, encrypted.keyVersion);
  return decryptWithKey(encrypted, key);
}

async function refreshAuthorizationWithinLock(
  fastify: FastifyInstance,
  userId: string,
  row: GithubUserAuthorization
): Promise<string> {
  const refreshSecret = refreshTokenSecret(row);
  if (!refreshSecret) throw new GitHubOAuthExpiredError();
  if (row.refreshTokenExpiresAt && row.refreshTokenExpiresAt.getTime() <= Date.now()) {
    throw new GitHubOAuthExpiredError();
  }

  const config = await getGitHubOAuthClientConfig(fastify);
  const refreshToken = await decryptSecretWithinLock(fastify, refreshSecret);
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'ccbricks',
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const tokenResponse = (await response.json().catch(() => ({}))) as GitHubOAuthTokenResponse;
  if (!response.ok || !tokenResponse.access_token || tokenResponse.error) {
    throw new GitHubOAuthExpiredError();
  }

  await saveAuthorizationWithinLock({
    fastify,
    userId,
    githubUserId: row.githubUserId,
    githubLogin: row.githubLogin,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? refreshToken,
    tokenExpiresAt: expiresAtFromSeconds(tokenResponse.expires_in),
    refreshTokenExpiresAt:
      expiresAtFromSeconds(tokenResponse.refresh_token_expires_in) ?? row.refreshTokenExpiresAt,
  });

  return tokenResponse.access_token;
}

async function validateNonExpiringAccessTokenWithinLock(
  fastify: FastifyInstance,
  userId: string,
  row: GithubUserAuthorization
): Promise<string> {
  const token = await decryptSecretWithinLock(fastify, accessTokenSecret(row));
  try {
    await githubRequest<GitHubUserResponse>('https://api.github.com/user', token);
    return token;
  } catch (error) {
    if (error instanceof GitHubOAuthError && refreshTokenSecret(row)) {
      return refreshAuthorizationWithinLock(fastify, userId, row);
    }
    if (error instanceof GitHubOAuthError) {
      throw new GitHubOAuthExpiredError();
    }
    throw error;
  }
}

export async function getValidGitHubUserAccessToken(
  fastify: FastifyInstance,
  userId: string
): Promise<string> {
  await getGitHubOAuthClientConfig(fastify);
  return withEncryptionKeyLock(fastify, async () => {
    const row = await getAuthorizationRow(fastify, userId);
    if (!row) throw new GitHubOAuthAuthorizationRequiredError();

    if (!row.tokenExpiresAt) {
      return validateNonExpiringAccessTokenWithinLock(fastify, userId, row);
    }

    if (row.tokenExpiresAt.getTime() - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
      return decryptSecretWithinLock(fastify, accessTokenSecret(row));
    }

    return refreshAuthorizationWithinLock(fastify, userId, row);
  });
}

export async function getGitHubOAuthAuthorizationStatus(
  fastify: FastifyInstance,
  userId: string
): Promise<GitHubOAuthAuthorizationResponse> {
  try {
    await getGitHubOAuthClientConfig(fastify);
  } catch (error) {
    if (error instanceof GitHubOAuthNotConfiguredError) {
      return { status: 'not_configured', login: null, token_expires_at: null };
    }
    throw error;
  }

  const row = await getAuthorizationRow(fastify, userId);
  if (!row) return { status: 'disconnected', login: null, token_expires_at: null };

  try {
    await getValidGitHubUserAccessToken(fastify, userId);
    return {
      status: 'connected',
      login: row.githubLogin,
      token_expires_at: row.tokenExpiresAt?.toISOString() ?? null,
    };
  } catch (error) {
    if (error instanceof GitHubOAuthExpiredError) {
      return {
        status: 'expired',
        login: row.githubLogin,
        token_expires_at: row.tokenExpiresAt?.toISOString() ?? null,
      };
    }
    throw error;
  }
}

export async function createGitHubOAuthAuthorizationUrl(params: {
  fastify: FastifyInstance;
  userId: string;
  redirectUri: string;
  redirectAfter?: string;
}): Promise<string> {
  const config = await getGitHubOAuthClientConfig(params.fastify);
  const state = base64UrlRandom();
  const codeVerifier = base64UrlRandom(64);
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);

  await withEncryptionKeyLock(params.fastify, async () => {
    await deleteExpiredOAuthStates(params.fastify);
    const encryptionKey = await getActiveEncryptionKeyWithinLock(params.fastify);
    const encryptedCodeVerifier = encryptWithKey(codeVerifier, encryptionKey);

    await params.fastify.withUserContext(params.userId, async tx => {
      await tx.insert(githubOAuthStates).values({
        state,
        userId: params.userId,
        codeVerifierCiphertext: encryptedCodeVerifier.ciphertext,
        codeVerifierIv: encryptedCodeVerifier.iv,
        codeVerifierAuthTag: encryptedCodeVerifier.authTag,
        codeVerifierKeyVersion: encryptedCodeVerifier.keyVersion,
        redirectAfter: params.redirectAfter ?? '/settings',
        expiresAt,
      });
    });
  });

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', createCodeChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function exchangeCodeForToken(params: {
  fastify: FastifyInstance;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<GitHubOAuthTokenResponse> {
  const config = await getGitHubOAuthClientConfig(params.fastify);
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'ccbricks',
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }),
  });
  const tokenResponse = (await response.json().catch(() => ({}))) as GitHubOAuthTokenResponse;
  if (!response.ok || !tokenResponse.access_token || tokenResponse.error) {
    throw new GitHubOAuthError('Failed to exchange GitHub OAuth code', tokenResponse);
  }
  return tokenResponse;
}

export async function completeGitHubOAuthCallback(params: {
  fastify: FastifyInstance;
  userId: string;
  code: string;
  state: string;
  redirectUri: string;
}): Promise<string> {
  const { codeVerifier, redirectAfter } = await withEncryptionKeyLock(params.fastify, async () => {
    const [stateRow] = (await params.fastify.withUserContext(params.userId, async tx =>
      tx
        .select()
        .from(githubOAuthStates)
        .where(
          and(
            eq(githubOAuthStates.state, params.state),
            eq(githubOAuthStates.userId, params.userId)
          )
        )
        .limit(1)
    )) as GithubOAuthState[];
    if (!stateRow) throw new GitHubOAuthError('Invalid GitHub OAuth state');
    if (stateRow.expiresAt.getTime() <= Date.now()) {
      await params.fastify.withUserContext(params.userId, async tx => {
        await tx.delete(githubOAuthStates).where(eq(githubOAuthStates.state, params.state));
      });
      throw new GitHubOAuthError('GitHub OAuth state has expired');
    }

    const codeVerifier = await decryptSecretWithinLock(
      params.fastify,
      getCodeVerifierSecret(stateRow)
    );
    await params.fastify.withUserContext(params.userId, async tx => {
      await tx.delete(githubOAuthStates).where(eq(githubOAuthStates.state, params.state));
    });

    return {
      codeVerifier,
      redirectAfter: stateRow.redirectAfter || '/settings',
    };
  });
  const tokenResponse = await exchangeCodeForToken({
    fastify: params.fastify,
    code: params.code,
    codeVerifier,
    redirectUri: params.redirectUri,
  });
  const githubUser = await githubRequest<GitHubUserResponse>(
    'https://api.github.com/user',
    tokenResponse.access_token!
  );
  if (!githubUser.id || !githubUser.login) {
    throw new GitHubOAuthError('GitHub user response was incomplete');
  }

  await saveAuthorization({
    fastify: params.fastify,
    userId: params.userId,
    githubUserId: String(githubUser.id),
    githubLogin: githubUser.login,
    accessToken: tokenResponse.access_token!,
    refreshToken: tokenResponse.refresh_token ?? null,
    tokenExpiresAt: expiresAtFromSeconds(tokenResponse.expires_in),
    refreshTokenExpiresAt: expiresAtFromSeconds(tokenResponse.refresh_token_expires_in),
  });

  return redirectAfter;
}

export async function revokeGitHubOAuthAuthorization(
  fastify: FastifyInstance,
  userId: string
): Promise<void> {
  const accessToken = await withEncryptionKeyLock(fastify, async () => {
    const row = await getAuthorizationRow(fastify, userId);
    if (!row) return null;
    return decryptSecretWithinLock(fastify, accessTokenSecret(row));
  });
  if (!accessToken) {
    await deleteOAuthStatesForUser(fastify, userId);
    return;
  }

  const config = await getGitHubOAuthClientConfig(fastify);
  const response = await fetch(
    `https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`,
    {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'content-type': 'application/json',
        'user-agent': 'ccbricks',
        'x-github-api-version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({ access_token: accessToken }),
    }
  );
  if (!response.ok) {
    const details = await parseResponseDetails(response);
    throw new GitHubOAuthError(`GitHub token revocation returned ${response.status}`, details);
  }

  await fastify.withUserContext(userId, async tx => {
    await tx.delete(githubUserAuthorizations).where(eq(githubUserAuthorizations.userId, userId));
    await tx.delete(githubOAuthStates).where(eq(githubOAuthStates.userId, userId));
  });
}

function isEncryptionKeyReferenced(
  version: string,
  authorizationRows: Array<
    Pick<GithubUserAuthorization, 'accessTokenKeyVersion' | 'refreshTokenKeyVersion'>
  >,
  stateRows: Array<Pick<GithubOAuthState, 'codeVerifierKeyVersion'>>
): boolean {
  return (
    authorizationRows.some(
      row => row.accessTokenKeyVersion === version || row.refreshTokenKeyVersion === version
    ) || stateRows.some(row => row.codeVerifierKeyVersion === version)
  );
}

async function listUserInstallations(token: string): Promise<GitHubInstallationResponse[]> {
  const installations: GitHubInstallationResponse[] = [];
  for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
    const url = new URL('https://api.github.com/user/installations');
    url.searchParams.set('per_page', GITHUB_PAGE_SIZE);
    url.searchParams.set('page', String(page));
    const { data, headers } = await githubFetch<GitHubUserInstallationsResponse>(
      url.toString(),
      token
    );
    installations.push(
      ...(data.installations ?? []).filter(installation => installation.id !== undefined)
    );
    if (!hasNextPage(headers)) break;
  }
  return installations;
}

async function listUserInstallationRepositories(
  token: string,
  installationId: number
): Promise<GitRepositoryCandidate[]> {
  const repositories: GitRepositoryCandidate[] = [];
  for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
    const url = new URL(`https://api.github.com/user/installations/${installationId}/repositories`);
    url.searchParams.set('per_page', GITHUB_PAGE_SIZE);
    url.searchParams.set('page', String(page));
    const { data, headers } = await githubFetch<GitHubInstallationRepositoriesResponse>(
      url.toString(),
      token
    );
    for (const repository of data.repositories ?? []) {
      const candidate = normalizeRepositoryCandidate(repository);
      if (candidate) repositories.push(candidate);
    }
    if (!hasNextPage(headers)) break;
  }
  return repositories;
}

export async function listGitHubUserRepositories(
  fastify: FastifyInstance,
  userId: string,
  query = ''
): Promise<GitRepositoryCandidate[]> {
  const token = await getValidGitHubUserAccessToken(fastify, userId);
  const installations = await listUserInstallations(token);
  const repositories = new Map<string, GitRepositoryCandidate>();

  await Promise.all(
    installations.map(async installation => {
      if (!installation.id) return;
      const installationRepositories = await listUserInstallationRepositories(
        token,
        installation.id
      );
      for (const repository of installationRepositories) {
        repositories.set(repository.full_name, repository);
      }
    })
  );

  const normalizedQuery = query.trim().toLowerCase();
  const values = [...repositories.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
  if (!normalizedQuery) return values;
  return values.filter(repository => repository.full_name.toLowerCase().includes(normalizedQuery));
}

export async function listGitHubUserRepositoryBranches(
  fastify: FastifyInstance,
  userId: string,
  repository: string
): Promise<GitRepositoryBranchCandidate[]> {
  const token = await getValidGitHubUserAccessToken(fastify, userId);
  const { owner, repo } = parseGitHubRepository(repository);
  const branches = new Map<string, GitRepositoryBranchCandidate>();

  for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`
    );
    url.searchParams.set('per_page', GITHUB_PAGE_SIZE);
    url.searchParams.set('page', String(page));
    const { data, headers } = await githubFetch<GitHubBranchResponse[]>(url.toString(), token);
    for (const branch of data) {
      if (!branch.name) continue;
      branches.set(branch.name, {
        name: branch.name,
        ...(branch.protected !== undefined ? { protected: branch.protected } : {}),
      });
    }
    if (!hasNextPage(headers)) break;
  }

  return [...branches.values()];
}

export async function getGitHubUserRepositoryBranch(
  fastify: FastifyInstance,
  userId: string,
  repository: string,
  branch: string,
  compare: GitRepositoryBranchDetailResponse['compare'] = null
): Promise<GitRepositoryBranchDetailResponse> {
  const token = await getValidGitHubUserAccessToken(fastify, userId);
  const { owner, repo } = parseGitHubRepository(repository);
  const branchData = await githubRequest<GitHubBranchResponse>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`,
    token
  );
  if (!branchData.name) {
    throw new GitHubOAuthError('GitHub branch response did not include a branch name');
  }

  return {
    name: branchData.name,
    ...(branchData.protected !== undefined ? { protected: branchData.protected } : {}),
    html_url: getBranchHtmlUrl(owner, repo, branchData.name),
    compare,
  };
}

export async function listGitHubUserPullRequests(
  fastify: FastifyInstance,
  userId: string,
  repository: string,
  query: { head?: string; base?: string; state?: GitRepositoryPullRequestStateFilter } = {}
): Promise<GitRepositoryPullRequest[]> {
  const token = await getValidGitHubUserAccessToken(fastify, userId);
  const { owner, repo } = parseGitHubRepository(repository);
  const pulls: GitRepositoryPullRequest[] = [];
  for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`
    );
    url.searchParams.set('per_page', GITHUB_PAGE_SIZE);
    url.searchParams.set('page', String(page));
    if (query.head) url.searchParams.set('head', normalizePullRequestListHead(owner, query.head));
    if (query.base) url.searchParams.set('base', query.base);
    if (query.state) url.searchParams.set('state', query.state);
    const { data, headers } = await githubFetch<GitHubPullRequestResponse[]>(url.toString(), token);
    pulls.push(
      ...data
        .map(normalizePullRequest)
        .filter((pull): pull is GitRepositoryPullRequest => pull !== null)
    );
    if (!hasNextPage(headers)) break;
  }
  return pulls;
}

export async function getGitHubUserPullRequest(
  fastify: FastifyInstance,
  userId: string,
  repository: string,
  pullNumber: number
): Promise<GitRepositoryPullRequest> {
  const token = await getValidGitHubUserAccessToken(fastify, userId);
  const { owner, repo } = parseGitHubRepository(repository);
  const pull = await githubRequest<GitHubPullRequestResponse>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
    token
  );
  const normalized = normalizePullRequest(pull);
  if (!normalized) throw new GitHubOAuthError('GitHub pull request response was incomplete');
  return normalized;
}

export async function createGitHubUserPullRequest(
  fastify: FastifyInstance,
  userId: string,
  repository: string,
  request: GitRepositoryPullRequestCreateRequest
): Promise<GitRepositoryPullRequest> {
  const existingPulls = await listGitHubUserPullRequests(fastify, userId, repository, {
    head: request.head,
    base: request.base,
    state: 'open',
  });
  if (existingPulls[0]) return existingPulls[0];

  const token = await getValidGitHubUserAccessToken(fastify, userId);
  const { owner, repo } = parseGitHubRepository(repository);
  const head = normalizePullRequestCreateHead(owner, request.head);
  const pull = await githubRequest<GitHubPullRequestResponse>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        title: request.title,
        ...(request.body ? { body: request.body } : {}),
        head,
        base: request.base,
        draft: request.draft ?? false,
      }),
    }
  );
  const normalized = normalizePullRequest(pull);
  if (!normalized) throw new GitHubOAuthError('GitHub pull request response was incomplete');
  return normalized;
}

export interface GitAuthEnvironment {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export async function createGitHubUserGitAuthEnvironment(
  fastify: FastifyInstance,
  userId: string,
  repository: string
): Promise<GitAuthEnvironment> {
  parseGitHubRepository(repository);
  const token = await getValidGitHubUserAccessToken(fastify, userId);
  const askpassPath = join(tmpdir(), `ccbricks-git-askpass-${randomUUID()}.sh`);
  await writeFile(
    askpassPath,
    `#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *) printf '%s\n' "$GITHUB_OAUTH_TOKEN" ;;
esac
`,
    'utf-8'
  );
  await chmod(askpassPath, 0o700);

  return {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: askpassPath,
      GITHUB_OAUTH_TOKEN: token,
    },
    cleanup: async () => {
      await rm(askpassPath, { force: true });
    },
  };
}

export async function rotateGitHubOAuthEncryptionKey(
  fastify: FastifyInstance
): Promise<GitHubOAuthEncryptionKeyRotateResponse> {
  return withEncryptionKeyLock(fastify, async () => {
    const oldActiveKey = await getActiveEncryptionKeyWithinLock(fastify);
    const newKey = await createNextEncryptionKey(fastify);
    let reencryptedAuthorizations = 0;

    try {
      await runAdminDatabaseTransaction(fastify, async tx => {
        await tx.delete(githubOAuthStates).where(lt(githubOAuthStates.expiresAt, new Date()));
        const authorizationRows = (await tx
          .select()
          .from(githubUserAuthorizations)) as GithubUserAuthorization[];
        const stateRows = (await tx.select().from(githubOAuthStates)) as GithubOAuthState[];

        for (const row of authorizationRows) {
          const accessKey = await getEncryptionKeyByVersionWithinLock(
            fastify,
            row.accessTokenKeyVersion
          );
          const accessToken = decryptWithKey(accessTokenSecret(row), accessKey);
          const refreshSecret = refreshTokenSecret(row);
          const refreshToken = refreshSecret
            ? decryptWithKey(
                refreshSecret,
                await getEncryptionKeyByVersionWithinLock(fastify, refreshSecret.keyVersion)
              )
            : null;
          const encryptedAccessToken = encryptWithKey(accessToken, newKey);
          const encryptedRefreshToken = refreshToken ? encryptWithKey(refreshToken, newKey) : null;

          decryptWithKey(encryptedAccessToken, newKey);
          if (encryptedRefreshToken) decryptWithKey(encryptedRefreshToken, newKey);

          await tx
            .update(githubUserAuthorizations)
            .set({
              ...encryptedAccessTokenColumns(encryptedAccessToken),
              ...encryptedRefreshTokenColumns(encryptedRefreshToken),
            })
            .where(eq(githubUserAuthorizations.userId, row.userId));
          reencryptedAuthorizations += 1;
        }

        for (const row of stateRows) {
          const stateSecret = getCodeVerifierSecret(row);
          const codeVerifier = decryptWithKey(
            stateSecret,
            await getEncryptionKeyByVersionWithinLock(fastify, stateSecret.keyVersion)
          );
          const encryptedCodeVerifier = encryptWithKey(codeVerifier, newKey);
          decryptWithKey(encryptedCodeVerifier, newKey);
          await tx
            .update(githubOAuthStates)
            .set({
              codeVerifierCiphertext: encryptedCodeVerifier.ciphertext,
              codeVerifierIv: encryptedCodeVerifier.iv,
              codeVerifierAuthTag: encryptedCodeVerifier.authTag,
              codeVerifierKeyVersion: encryptedCodeVerifier.keyVersion,
            })
            .where(eq(githubOAuthStates.state, row.state));
        }
      });

      await setActiveEncryptionKeyVersion(fastify, newKey.version);
    } catch (error) {
      await setActiveEncryptionKeyVersion(fastify, oldActiveKey.version).catch(restoreError => {
        fastify.log.error(
          { error: restoreError, version: oldActiveKey.version },
          'Failed to restore active encryption key version after rotation failure'
        );
      });
      throw error;
    }

    if (oldActiveKey.version !== newKey.version) {
      let oldKeyStillReferenced = true;
      await runAdminDatabaseTransaction(fastify, async tx => {
        const [authorizationRows, stateRows] = (await Promise.all([
          tx.select().from(githubUserAuthorizations),
          tx.select().from(githubOAuthStates),
        ])) as [GithubUserAuthorization[], GithubOAuthState[]];
        oldKeyStillReferenced = isEncryptionKeyReferenced(
          oldActiveKey.version,
          authorizationRows,
          stateRows
        );
      });
      if (!oldKeyStillReferenced) {
        await deleteEncryptionKeyVersion(fastify, oldActiveKey.version).catch(error => {
          fastify.log.warn(
            { error, version: oldActiveKey.version },
            'Failed to delete retired key'
          );
        });
      }
    }

    return {
      encryption_key_version: newKey.version,
      reencrypted_authorizations: reencryptedAuthorizations,
    };
  });
}

export const __testing = {
  createCodeChallenge,
  normalizePullRequestListHead,
  normalizeRepositoryCandidate,
  parseGitHubRepository,
  toGitHubRepositoryFullName,
};
