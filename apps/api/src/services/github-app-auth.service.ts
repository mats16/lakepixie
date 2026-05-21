import type { FastifyInstance } from 'fastify';
import { randomUUID, sign } from 'node:crypto';
import { writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  GitRepositoryBranchDetailResponse,
  GitHubAppAuthResponse,
  GitRepositoryBranchCandidate,
  GitRepositoryCandidate,
  GitRepositoryPullRequest,
  GitRepositoryPullRequestCreateRequest,
  GitRepositoryPullRequestStateFilter,
  UpdateGitHubAppAuthRequest,
} from '@repo/types';
import {
  DatabricksSecretNotFoundError,
  deleteSecret,
  getSecret,
  putSecret,
} from './databricks-secrets.service.js';
import { getGitHubAppIdSetting, updateGitHubAppIdSetting } from './admin.service.js';

export const GITHUB_APP_PRIVATE_KEY_SECRET_KEY = 'github-app-private-key';

const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_PAGE_SIZE = '100';
const GITHUB_MAX_PAGES = 50;
const TOKEN_CACHE_BUFFER_MS = 5 * 60 * 1000;

export type GitHubAppTokenPermission = 'read' | 'write';
type GitHubAppPermissionName = 'contents' | 'pull_requests';
type GitHubAppTokenPermissions = Partial<Record<GitHubAppPermissionName, GitHubAppTokenPermission>>;

interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
}

interface GitHubInstallationResponse {
  id: number;
}

interface GitHubInstallationTokenRequest {
  repositories?: string[];
  permissions: GitHubAppTokenPermissions;
}

interface GitHubInstallationTokenResponse {
  token: string;
  expires_at: string;
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

interface CachedInstallationToken {
  token: string;
  expiresAt: number;
}

interface CachedGitHubValue<T> {
  value: T;
  expiresAt: number;
}

const REPOSITORY_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const BRANCH_LIST_CACHE_TTL_MS = 60 * 1000;
const installationTokenCache = new Map<string, CachedInstallationToken>();
const repositoryListCache = new Map<string, CachedGitHubValue<GitRepositoryCandidate[]>>();
const repositoryListInflight = new Map<string, Promise<GitRepositoryCandidate[]>>();
const branchListCache = new Map<string, CachedGitHubValue<GitRepositoryBranchCandidate[]>>();
const branchListInflight = new Map<string, Promise<GitRepositoryBranchCandidate[]>>();

export class GitHubAppAuthNotConfiguredError extends Error {
  constructor() {
    super('GitHub App authentication is not configured');
    this.name = 'GitHubAppAuthNotConfiguredError';
  }
}

export class GitHubAppAuthError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'GitHubAppAuthError';
  }
}

export function clearGitHubAppCaches(): void {
  installationTokenCache.clear();
  repositoryListCache.clear();
  repositoryListInflight.clear();
  branchListCache.clear();
  branchListInflight.clear();
}

export function getGitHubAppSecretScope(fastify: FastifyInstance): string {
  const appName = fastify.config.DATABRICKS_APP_NAME.trim();
  return appName || 'ccbricks-local';
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function createGitHubAppJwt(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const exp = iat + 10 * 60;
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({ iat, exp, iss: appId });
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
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
    throw new GitHubAppAuthError('Invalid GitHub repository URL');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new GitHubAppAuthError('Only HTTPS GitHub repository URLs are supported');
  }

  const [owner, rawRepo] = url.pathname.replace(/^\/+/, '').split('/');
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo) {
    throw new GitHubAppAuthError('Invalid GitHub repository URL');
  }
  return { owner, repo };
}

export function toGitHubRepositoryFullName(value: string): string {
  const { owner, repo } = parseGitHubRepository(value);
  return `${owner}/${repo}`;
}

async function getGitHubAppCredentials(
  fastify: FastifyInstance
): Promise<GitHubAppCredentials | null> {
  const scope = getGitHubAppSecretScope(fastify);
  const appId = await getGitHubAppIdSetting(fastify);
  if (!appId) return null;

  try {
    const privateKey = await getSecret(fastify, scope, GITHUB_APP_PRIVATE_KEY_SECRET_KEY);
    const trimmedPrivateKey = privateKey.trim();
    if (!trimmedPrivateKey) return null;
    return { appId, privateKey: trimmedPrivateKey };
  } catch (error) {
    if (error instanceof DatabricksSecretNotFoundError) return null;
    throw error;
  }
}

export async function getGitHubAppAuthStatus(
  fastify: FastifyInstance
): Promise<GitHubAppAuthResponse> {
  const scope = getGitHubAppSecretScope(fastify);
  const githubAppId = await getGitHubAppIdSetting(fastify);
  let privateKeyConfigured = false;

  try {
    privateKeyConfigured =
      (await getSecret(fastify, scope, GITHUB_APP_PRIVATE_KEY_SECRET_KEY)).trim().length > 0;
  } catch (error) {
    if (!(error instanceof DatabricksSecretNotFoundError)) throw error;
  }

  return {
    secret_scope: scope,
    github_app_id: githubAppId,
    private_key_configured: privateKeyConfigured,
  };
}

export async function updateGitHubAppAuth(
  fastify: FastifyInstance,
  request: UpdateGitHubAppAuthRequest
): Promise<GitHubAppAuthResponse> {
  const scope = getGitHubAppSecretScope(fastify);

  if (request.github_app_id !== undefined) {
    const value = request.github_app_id?.trim() ?? '';
    await updateGitHubAppIdSetting(fastify, value || null);
  }

  if (request.github_app_private_key !== undefined) {
    const value = request.github_app_private_key?.trim() ?? '';
    if (value) {
      await putSecret(fastify, scope, GITHUB_APP_PRIVATE_KEY_SECRET_KEY, value);
    } else {
      await deleteSecret(fastify, scope, GITHUB_APP_PRIVATE_KEY_SECRET_KEY);
    }
  }

  clearGitHubAppCaches();
  return getGitHubAppAuthStatus(fastify);
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
    let details: unknown;
    try {
      details = await response.json();
    } catch {
      details = await response.text().catch(() => undefined);
    }
    if (response.status === 404) {
      throw new GitHubAppAuthError(
        'GitHub App is not installed on this repository or the repository is not accessible',
        details
      );
    }
    throw new GitHubAppAuthError(`GitHub API returned ${response.status}`, details);
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

function hasNextPage(headers: Headers): boolean {
  return (
    headers
      .get('link')
      ?.split(',')
      .some(link => link.includes('rel="next"')) === true
  );
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

async function getScopedInstallationToken(
  appId: string,
  jwt: string,
  installationId: number,
  permissions: GitHubAppTokenPermissions,
  cacheScope: string,
  repositories?: string[]
): Promise<CachedInstallationToken> {
  const permissionKey = Object.entries(permissions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, permission]) => `${name}:${permission}`)
    .join(',');
  const cacheKey = `${appId}:installation:${installationId}:${cacheScope}:${permissionKey}`;
  const cached = installationTokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_CACHE_BUFFER_MS > Date.now()) {
    return cached;
  }

  const requestBody: GitHubInstallationTokenRequest = {
    permissions,
  };
  if (repositories && repositories.length > 0) {
    requestBody.repositories = repositories;
  }

  const tokenResponse = await githubRequest<GitHubInstallationTokenResponse>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    jwt,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    }
  );

  const cachedToken = {
    token: tokenResponse.token,
    expiresAt: Date.parse(tokenResponse.expires_at),
  };
  installationTokenCache.set(cacheKey, cachedToken);

  return cachedToken;
}

export async function getGitHubAppInstallationToken(
  fastify: FastifyInstance,
  repository: string,
  permission: GitHubAppTokenPermission
): Promise<string> {
  const credentials = await getGitHubAppCredentials(fastify);
  if (!credentials) {
    throw new GitHubAppAuthNotConfiguredError();
  }

  const { owner, repo } = parseGitHubRepository(repository);
  const cacheKey = `${credentials.appId}:${owner}/${repo}:${permission}`;
  const cached = installationTokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_CACHE_BUFFER_MS > Date.now()) {
    return cached.token;
  }

  const jwt = createGitHubAppJwt(credentials.appId, credentials.privateKey);
  const installation = await githubRequest<GitHubInstallationResponse>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    jwt
  );
  const token = await getScopedInstallationToken(
    credentials.appId,
    jwt,
    installation.id,
    { contents: permission },
    `repo:${owner}/${repo}`,
    [repo]
  );

  installationTokenCache.set(cacheKey, {
    token: token.token,
    expiresAt: token.expiresAt,
  });

  return token.token;
}

async function getGitHubAppPullRequestToken(
  fastify: FastifyInstance,
  repository: string,
  permission: GitHubAppTokenPermission
): Promise<string> {
  const credentials = await getGitHubAppCredentials(fastify);
  if (!credentials) {
    throw new GitHubAppAuthNotConfiguredError();
  }

  const { owner, repo } = parseGitHubRepository(repository);
  const cacheKey = `${credentials.appId}:${owner}/${repo}:pull_requests:${permission}`;
  const cached = installationTokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_CACHE_BUFFER_MS > Date.now()) {
    return cached.token;
  }

  const jwt = createGitHubAppJwt(credentials.appId, credentials.privateKey);
  const installation = await githubRequest<GitHubInstallationResponse>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    jwt
  );
  const token = await getScopedInstallationToken(
    credentials.appId,
    jwt,
    installation.id,
    { contents: 'read', pull_requests: permission },
    `repo:${owner}/${repo}:pull_requests`,
    [repo]
  );

  installationTokenCache.set(cacheKey, {
    token: token.token,
    expiresAt: token.expiresAt,
  });

  return token.token;
}

async function listGitHubAppInstallations(jwt: string): Promise<GitHubInstallationResponse[]> {
  const installations: GitHubInstallationResponse[] = [];

  for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
    const url = new URL('https://api.github.com/app/installations');
    url.searchParams.set('per_page', GITHUB_PAGE_SIZE);
    url.searchParams.set('page', String(page));

    const { data, headers } = await githubFetch<GitHubInstallationResponse[]>(url.toString(), jwt);
    installations.push(...data.filter(installation => Number.isFinite(installation.id)));

    if (!hasNextPage(headers)) break;
  }

  return installations;
}

async function listInstallationRepositories(
  installationToken: string
): Promise<GitRepositoryCandidate[]> {
  const repositories: GitRepositoryCandidate[] = [];

  for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
    const url = new URL('https://api.github.com/installation/repositories');
    url.searchParams.set('per_page', GITHUB_PAGE_SIZE);
    url.searchParams.set('page', String(page));

    const { data, headers } = await githubFetch<GitHubInstallationRepositoriesResponse>(
      url.toString(),
      installationToken
    );
    const pageRepositories = data.repositories ?? [];
    for (const repository of pageRepositories) {
      const candidate = normalizeRepositoryCandidate(repository);
      if (candidate) repositories.push(candidate);
    }

    if (!hasNextPage(headers)) break;
  }

  return repositories;
}

async function fetchGitHubAppRepositories(
  credentials: GitHubAppCredentials
): Promise<GitRepositoryCandidate[]> {
  const jwt = createGitHubAppJwt(credentials.appId, credentials.privateKey);
  const installations = await listGitHubAppInstallations(jwt);
  const repositories = new Map<string, GitRepositoryCandidate>();

  await Promise.all(
    installations.map(async installation => {
      const token = await getScopedInstallationToken(
        credentials.appId,
        jwt,
        installation.id,
        { contents: 'read' },
        'repositories:*'
      );
      const installationRepositories = await listInstallationRepositories(token.token);

      for (const repository of installationRepositories) {
        repositories.set(repository.full_name, repository);
      }
    })
  );

  return [...repositories.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
}

async function getCachedGitHubAppRepositories(
  credentials: GitHubAppCredentials
): Promise<GitRepositoryCandidate[]> {
  const cacheKey = `${credentials.appId}:repositories`;
  const cached = repositoryListCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const existingPromise = repositoryListInflight.get(cacheKey);
  if (existingPromise) return existingPromise;

  const promise = fetchGitHubAppRepositories(credentials)
    .then(repositories => {
      repositoryListCache.set(cacheKey, {
        value: repositories,
        expiresAt: Date.now() + REPOSITORY_LIST_CACHE_TTL_MS,
      });
      return repositories;
    })
    .finally(() => {
      repositoryListInflight.delete(cacheKey);
    });
  repositoryListInflight.set(cacheKey, promise);
  return promise;
}

export async function listGitHubAppRepositories(
  fastify: FastifyInstance,
  query = ''
): Promise<GitRepositoryCandidate[]> {
  const credentials = await getGitHubAppCredentials(fastify);
  if (!credentials) {
    throw new GitHubAppAuthNotConfiguredError();
  }

  const normalizedQuery = query.trim().toLowerCase();
  const repositories = await getCachedGitHubAppRepositories(credentials);
  if (!normalizedQuery) return repositories;
  return repositories.filter(repository =>
    repository.full_name.toLowerCase().includes(normalizedQuery)
  );
}

async function fetchGitHubAppRepositoryBranches(
  fastify: FastifyInstance,
  owner: string,
  repo: string
): Promise<GitRepositoryBranchCandidate[]> {
  const token = await getGitHubAppInstallationToken(fastify, `${owner}/${repo}`, 'read');
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

export async function listGitHubAppRepositoryBranches(
  fastify: FastifyInstance,
  repository: string
): Promise<GitRepositoryBranchCandidate[]> {
  const credentials = await getGitHubAppCredentials(fastify);
  if (!credentials) {
    throw new GitHubAppAuthNotConfiguredError();
  }

  const { owner, repo } = parseGitHubRepository(repository);
  const cacheKey = `${credentials.appId}:branches:${owner}/${repo}`;
  const cached = branchListCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const existingPromise = branchListInflight.get(cacheKey);
  if (existingPromise) return existingPromise;

  const promise = fetchGitHubAppRepositoryBranches(fastify, owner, repo)
    .then(branches => {
      branchListCache.set(cacheKey, {
        value: branches,
        expiresAt: Date.now() + BRANCH_LIST_CACHE_TTL_MS,
      });
      return branches;
    })
    .finally(() => {
      branchListInflight.delete(cacheKey);
    });
  branchListInflight.set(cacheKey, promise);
  return promise;
}

export async function getGitHubAppRepositoryBranch(
  fastify: FastifyInstance,
  repository: string,
  branch: string,
  compare: GitRepositoryBranchDetailResponse['compare'] = null
): Promise<GitRepositoryBranchDetailResponse> {
  const { owner, repo } = parseGitHubRepository(repository);
  const token = await getGitHubAppInstallationToken(fastify, `${owner}/${repo}`, 'read');
  const encodedBranch = encodeURIComponent(branch);
  const branchData = await githubRequest<GitHubBranchResponse>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodedBranch}`,
    token
  );

  if (!branchData.name) {
    throw new GitHubAppAuthError('GitHub branch response did not include a branch name');
  }

  return {
    name: branchData.name,
    ...(branchData.protected !== undefined ? { protected: branchData.protected } : {}),
    html_url: getBranchHtmlUrl(owner, repo, branchData.name),
    compare,
  };
}

export async function listGitHubAppPullRequests(
  fastify: FastifyInstance,
  repository: string,
  query: { head?: string; base?: string; state?: GitRepositoryPullRequestStateFilter } = {}
): Promise<GitRepositoryPullRequest[]> {
  const { owner, repo } = parseGitHubRepository(repository);
  const token = await getGitHubAppPullRequestToken(fastify, `${owner}/${repo}`, 'read');
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`
  );
  if (query.head) url.searchParams.set('head', query.head);
  if (query.base) url.searchParams.set('base', query.base);
  if (query.state) url.searchParams.set('state', query.state);

  const pulls = await githubRequest<GitHubPullRequestResponse[]>(url.toString(), token);
  return pulls
    .map(normalizePullRequest)
    .filter((pull): pull is GitRepositoryPullRequest => pull !== null);
}

export async function getGitHubAppPullRequest(
  fastify: FastifyInstance,
  repository: string,
  pullNumber: number
): Promise<GitRepositoryPullRequest> {
  const { owner, repo } = parseGitHubRepository(repository);
  const token = await getGitHubAppPullRequestToken(fastify, `${owner}/${repo}`, 'read');
  const pull = await githubRequest<GitHubPullRequestResponse>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
    token
  );
  const normalized = normalizePullRequest(pull);
  if (!normalized) {
    throw new GitHubAppAuthError('GitHub pull request response was incomplete');
  }
  return normalized;
}

export async function createGitHubAppPullRequest(
  fastify: FastifyInstance,
  repository: string,
  request: GitRepositoryPullRequestCreateRequest
): Promise<GitRepositoryPullRequest> {
  const existingPulls = await listGitHubAppPullRequests(fastify, repository, {
    head: request.head,
    base: request.base,
    state: 'open',
  }).catch(() => []);
  if (existingPulls[0]) return existingPulls[0];

  const { owner, repo } = parseGitHubRepository(repository);
  const token = await getGitHubAppPullRequestToken(fastify, `${owner}/${repo}`, 'write');
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
  if (!normalized) {
    throw new GitHubAppAuthError('GitHub pull request response was incomplete');
  }
  return normalized;
}

function clearExpiredGitHubCaches(now = Date.now()): void {
  for (const [key, cached] of repositoryListCache.entries()) {
    if (cached.expiresAt <= now) repositoryListCache.delete(key);
  }

  for (const [key, cached] of branchListCache.entries()) {
    if (cached.expiresAt <= now) branchListCache.delete(key);
  }
}

export interface GitAuthEnvironment {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export async function createGitHubGitAuthEnvironment(
  fastify: FastifyInstance,
  repository: string,
  permission: GitHubAppTokenPermission
): Promise<GitAuthEnvironment | null> {
  try {
    const token = await getGitHubAppInstallationToken(fastify, repository, permission);
    const scriptPath = join(tmpdir(), `ccbricks-git-askpass-${randomUUID()}.sh`);
    await writeFile(
      scriptPath,
      `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *) printf '%s\\n' "$GITHUB_APP_TOKEN" ;;
esac
`,
      'utf-8'
    );
    await chmod(scriptPath, 0o700);

    return {
      env: {
        ...process.env,
        GIT_ASKPASS: scriptPath,
        GIT_TERMINAL_PROMPT: '0',
        GITHUB_APP_TOKEN: token,
      },
      cleanup: async () => {
        await rm(scriptPath, { force: true });
      },
    };
  } catch (error) {
    if (error instanceof GitHubAppAuthNotConfiguredError) return null;
    if (
      error instanceof Error &&
      error.message.includes('Service Principal token is not available')
    ) {
      return null;
    }
    throw error;
  }
}

export const __testing = {
  createGitHubAppJwt,
  getGitHubAppSecretScope,
  normalizeRepositoryCandidate,
  parseGitHubRepository,
  toGitHubRepositoryFullName,
  clearExpiredGitHubCaches,
  clearGitHubAppCaches,
  installationTokenCache,
  repositoryListCache,
  branchListCache,
};
