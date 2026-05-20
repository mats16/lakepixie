import { FastifyPluginAsync } from 'fastify';
import type { ServingEndpointsByTier, ApiError } from '@repo/types';
import { getAuthProvider } from '../lib/databricks-auth.js';

interface ServingEndpointsResponse {
  endpoints?: Array<{
    name: string;
    [key: string]: unknown;
  }>;
}

const CLAUDE_PREFIX = 'databricks-claude-';

function classifyTier(name: string): 'opus' | 'sonnet' | 'haiku' | null {
  const lower = name.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

const modelsRoute: FastifyPluginAsync = async fastify => {
  const databricksHost = fastify.config.DATABRICKS_HOST;

  // GET /models - Claude モデル（Serving Endpoint）一覧
  fastify.get<{
    Reply: ServingEndpointsByTier | ApiError;
  }>('/models', async (_request, reply) => {
    const authProvider = getAuthProvider(fastify);
    let token: string;

    try {
      token = await authProvider.getToken();
    } catch {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Access token is required (Service Principal)',
        statusCode: 401,
      });
    }

    const response = await fetch(`https://${databricksHost}/api/2.0/serving-endpoints`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      fastify.log.error(
        { status: response.status, body: errorText },
        'Failed to fetch serving endpoints'
      );
      return reply.status(response.status).send({
        error: 'DatabricksApiError',
        message: 'Failed to fetch serving endpoints',
        statusCode: response.status,
      });
    }

    const data = (await response.json()) as ServingEndpointsResponse;

    const result: ServingEndpointsByTier = {
      opus: [],
      sonnet: [],
      haiku: [],
    };

    for (const ep of data.endpoints ?? []) {
      if (!ep.name.startsWith(CLAUDE_PREFIX)) continue;
      const tier = classifyTier(ep.name);
      if (tier) {
        result[tier].push(ep.name);
      }
    }

    for (const tier of ['opus', 'sonnet', 'haiku'] as const) {
      result[tier].sort((a, b) => b.localeCompare(a));
    }

    return reply.send(result);
  });
};

export default modelsRoute;
