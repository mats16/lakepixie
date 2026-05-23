import type { FastifyInstance } from 'fastify';
import type { ServingEndpointsByTier } from '@repo/types';
import { getAuthProvider } from '../lib/databricks-auth.js';

interface ServingEndpointsResponse {
  endpoints?: Array<{
    name: string;
    [key: string]: unknown;
  }>;
}

const CLAUDE_PREFIX = 'databricks-claude-';

export type ModelTier = keyof ServingEndpointsByTier;

export function classifyModelTier(name: string): ModelTier | null {
  const lower = name.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

export function groupModelIdsByTier(modelIds: string[]): ServingEndpointsByTier {
  const result: ServingEndpointsByTier = {
    opus: [],
    sonnet: [],
    haiku: [],
  };

  for (const modelId of modelIds) {
    const tier = classifyModelTier(modelId);
    if (tier) result[tier].push(modelId);
  }

  for (const tier of ['opus', 'sonnet', 'haiku'] as const) {
    result[tier] = [...new Set(result[tier])].sort((a, b) => b.localeCompare(a));
  }

  return result;
}

export function flattenServingEndpointsByTier(endpoints: ServingEndpointsByTier): string[] {
  return [...endpoints.opus, ...endpoints.sonnet, ...endpoints.haiku];
}

export async function listClaudeServingEndpoints(
  fastify: FastifyInstance
): Promise<ServingEndpointsByTier> {
  const authProvider = getAuthProvider(fastify);
  let token: string;
  try {
    token = await authProvider.getToken();
  } catch {
    throw new DatabricksServingEndpointAuthError('Access token is required (Service Principal)');
  }

  const response = await fetch(
    `https://${fastify.config.DATABRICKS_HOST}/api/2.0/serving-endpoints`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    fastify.log.error(
      { status: response.status, body: errorText },
      'Failed to fetch serving endpoints'
    );
    throw new DatabricksServingEndpointError(response.status, 'Failed to fetch serving endpoints');
  }

  const data = (await response.json()) as ServingEndpointsResponse;
  const modelIds = (data.endpoints ?? [])
    .map(endpoint => endpoint.name)
    .filter(name => name.startsWith(CLAUDE_PREFIX));

  return groupModelIdsByTier(modelIds);
}

export class DatabricksServingEndpointAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabricksServingEndpointAuthError';
  }
}

export class DatabricksServingEndpointError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'DatabricksServingEndpointError';
  }
}
