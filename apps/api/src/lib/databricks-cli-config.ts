import { readFileSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ensureDirectory } from '../utils/directory.js';
import { normalizeHost } from '../utils/normalize-host.js';

export const DATABRICKS_CONFIG_FILENAME = '.databrickscfg';
export const DATABRICKS_CONFIG_PROFILE = 'DEFAULT';
export const DATABRICKS_CONFIG_AUTH_TYPE = 'oauth-m2m';

export interface DatabricksConfigParams {
  host: string;
  clientId: string;
  clientSecret: string;
}

export interface ServicePrincipalConfig {
  host: string;
  authType: string;
  clientId: string;
  clientSecret: string;
}

function getSingleLineConfigValue(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} is required to provision ${DATABRICKS_CONFIG_FILENAME}`);
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new Error(`${name} must be a single line`);
  }
  return trimmed;
}

export function buildDatabricksConfigContent(params: DatabricksConfigParams): string {
  const host = `https://${normalizeHost(getSingleLineConfigValue('DATABRICKS_HOST', params.host))}`;
  const clientId = getSingleLineConfigValue('DATABRICKS_CLIENT_ID', params.clientId);
  const clientSecret = getSingleLineConfigValue('DATABRICKS_CLIENT_SECRET', params.clientSecret);

  return `[${DATABRICKS_CONFIG_PROFILE}]
host = ${host}
auth_type = ${DATABRICKS_CONFIG_AUTH_TYPE}
client_id = ${clientId}
client_secret = ${clientSecret}
`;
}

export async function writeDatabricksConfig(
  userHome: string,
  params: DatabricksConfigParams
): Promise<string> {
  const configPath = path.join(userHome, DATABRICKS_CONFIG_FILENAME);
  const configContent = buildDatabricksConfigContent(params);

  await ensureDirectory(userHome);
  await writeFile(configPath, configContent, { encoding: 'utf-8', mode: 0o600 });
  await chmod(configPath, 0o600);

  return configPath;
}

export function getDatabricksConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABRICKS_CONFIG_FILE ?? path.join(env.HOME || homedir(), DATABRICKS_CONFIG_FILENAME);
}

function parseDatabricksConfig(content: string, profile: string): Record<string, string> {
  const values: Record<string, string> = {};
  let currentSection = '';

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1]?.trim() ?? '';
      continue;
    }

    if (currentSection !== profile) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) {
      values[key] = value;
    }
  }

  return values;
}

function requireConfigValue(
  values: Record<string, string>,
  key: string,
  profile: string,
  configPath: string
): string {
  const value = values[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key} in ${profile} profile of ${configPath}`);
  }
  return value;
}

export function readServicePrincipalConfig(
  env: NodeJS.ProcessEnv = process.env
): ServicePrincipalConfig {
  const configPath = getDatabricksConfigPath(env);
  const profile = env.DATABRICKS_CONFIG_PROFILE ?? DATABRICKS_CONFIG_PROFILE;
  let content: string;

  try {
    content = readFileSync(configPath, 'utf-8');
  } catch {
    throw new Error(`Databricks config file is not available at ${configPath}`);
  }

  const values = parseDatabricksConfig(content, profile);
  const config = {
    host: requireConfigValue(values, 'host', profile, configPath),
    authType: requireConfigValue(values, 'auth_type', profile, configPath),
    clientId: requireConfigValue(values, 'client_id', profile, configPath),
    clientSecret: requireConfigValue(values, 'client_secret', profile, configPath),
  };

  if (config.authType !== DATABRICKS_CONFIG_AUTH_TYPE) {
    throw new Error(
      `${profile} profile in ${configPath} must use auth_type = ${DATABRICKS_CONFIG_AUTH_TYPE}`
    );
  }

  return config;
}
