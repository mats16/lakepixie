import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import {
  getValidGitHubUserAccessToken,
  toGitHubRepositoryFullName,
} from './github-oauth.service.js';

const CREDENTIAL_REGISTRATION_TTL_MS = 12 * 60 * 60 * 1000;

interface RegisteredGitCredential {
  userId: string;
  repoFullName: string;
  expiresAt: number;
}

const registeredCredentials = new Map<string, RegisteredGitCredential>();

export interface GitCredentialRegistration {
  bearerToken: string;
  repoFullName: string;
}

function cleanupExpiredRegistrations(): void {
  const now = Date.now();
  for (const [token, registration] of registeredCredentials.entries()) {
    if (registration.expiresAt <= now) {
      registeredCredentials.delete(token);
    }
  }
}

export function registerGitCredential(
  userId: string,
  repository: string
): GitCredentialRegistration {
  cleanupExpiredRegistrations();
  const repoFullName = toGitHubRepositoryFullName(repository);
  const bearerToken = randomBytes(32).toString('base64url');
  registeredCredentials.set(bearerToken, {
    userId,
    repoFullName,
    expiresAt: Date.now() + CREDENTIAL_REGISTRATION_TTL_MS,
  });
  return { bearerToken, repoFullName };
}

export function revokeGitCredential(bearerToken: string): boolean {
  return registeredCredentials.delete(bearerToken);
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
  cleanupExpiredRegistrations();
  const registration = registeredCredentials.get(bearerToken);
  if (!registration) return '';

  const parsed = parseCredentialInput(input);
  if (parsed.protocol !== 'https' || parsed.host !== 'github.com') {
    return '';
  }

  const repoFullName = normalizeCredentialPath(parsed.path);
  if (repoFullName !== registration.repoFullName) {
    return '';
  }

  const token = await getValidGitHubUserAccessToken(fastify, registration.userId);

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
  revokeGitCredential,
  registeredCredentials,
};
