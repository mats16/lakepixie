import type { FastifyInstance } from 'fastify';
import { eq, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  GitHubOAuthAuthorizationRequiredError,
  GitHubOAuthExpiredError,
  GitHubOAuthNotConfiguredError,
  getValidGitHubUserAccessToken,
  toGitHubRepositoryFullName,
} from './github-oauth.service.js';
import { gitCredentialRegistrations } from '../db/schema.js';

const CREDENTIAL_REGISTRATION_TTL_MS = 12 * 60 * 60 * 1000;

export interface GitCredentialRegistration {
  bearerToken: string;
  repoFullName: string;
}

function nextExpiresAt(): Date {
  return new Date(Date.now() + CREDENTIAL_REGISTRATION_TTL_MS);
}

async function cleanupExpiredRegistrations(fastify: FastifyInstance): Promise<void> {
  await fastify.db
    .delete(gitCredentialRegistrations)
    .where(lt(gitCredentialRegistrations.expiresAt, new Date()));
}

export async function registerGitCredential(
  fastify: FastifyInstance,
  userId: string,
  repository: string
): Promise<GitCredentialRegistration> {
  await cleanupExpiredRegistrations(fastify);
  const repoFullName = toGitHubRepositoryFullName(repository);
  const bearerToken = randomBytes(32).toString('base64url');
  await fastify.db.insert(gitCredentialRegistrations).values({
    bearerToken,
    userId,
    repoFullName,
    expiresAt: nextExpiresAt(),
  });
  return { bearerToken, repoFullName };
}

export async function revokeGitCredential(
  fastify: FastifyInstance,
  bearerToken: string
): Promise<void> {
  await fastify.db
    .delete(gitCredentialRegistrations)
    .where(eq(gitCredentialRegistrations.bearerToken, bearerToken));
}

function parseCredentialInput(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    if (!line) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;
    result[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
  }
  return result;
}

function normalizeCredentialPath(pathValue: string | undefined): string | null {
  if (!pathValue) return null;
  const cleaned = pathValue.replace(/^\/+/, '').replace(/\.git$/, '');
  const match = cleaned.match(/^([^/\s]+)\/([^/\s]+)$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function buildGitCredentialHelperScript(internalUrl: string, bearerToken: string): string {
  return `#!/usr/bin/env node
const command = process.argv[2];
if (command !== 'get') process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const response = await fetch(${JSON.stringify(internalUrl)}, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ${bearerToken}',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ input })
    });
    if (!response.ok) process.exit(0);
    process.stdout.write(await response.text());
  } catch {
    process.exit(0);
  }
});
`;
}

export async function resolveGitCredentialRequest(
  fastify: FastifyInstance,
  bearerToken: string,
  input: string
): Promise<string> {
  await cleanupExpiredRegistrations(fastify);
  const [registration] = await fastify.db
    .select()
    .from(gitCredentialRegistrations)
    .where(eq(gitCredentialRegistrations.bearerToken, bearerToken))
    .limit(1);
  if (!registration) return '';

  const parsed = parseCredentialInput(input);
  if (parsed.protocol !== 'https' || parsed.host !== 'github.com') {
    return '';
  }

  const repoFullName = normalizeCredentialPath(parsed.path);
  if (repoFullName !== registration.repoFullName) {
    return '';
  }

  let token: string;
  try {
    token = await getValidGitHubUserAccessToken(fastify, registration.userId);
  } catch (error) {
    if (
      error instanceof GitHubOAuthAuthorizationRequiredError ||
      error instanceof GitHubOAuthExpiredError ||
      error instanceof GitHubOAuthNotConfiguredError
    ) {
      return '';
    }
    throw error;
  }

  await fastify.db
    .update(gitCredentialRegistrations)
    .set({ expiresAt: nextExpiresAt() })
    .where(eq(gitCredentialRegistrations.bearerToken, bearerToken));

  return [
    'protocol=https',
    'host=github.com',
    `path=${registration.repoFullName}.git`,
    'username=x-access-token',
    `password=${token}`,
    '',
    '',
  ].join('\n');
}

export const __testing = {
  buildGitCredentialHelperScript,
  normalizeCredentialPath,
  parseCredentialInput,
};
