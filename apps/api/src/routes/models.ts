import { FastifyPluginAsync } from 'fastify';
import type { ServingEndpointsByTier, ApiError } from '@repo/types';
import {
  DatabricksServingEndpointAuthError,
  DatabricksServingEndpointError,
  listClaudeServingEndpoints,
} from '../services/model-serving.service.js';

const modelsRoute: FastifyPluginAsync = async fastify => {
  // GET /models - Claude モデル（Serving Endpoint）一覧
  fastify.get<{
    Reply: ServingEndpointsByTier | ApiError;
  }>('/models', async (_request, reply) => {
    try {
      const result = await listClaudeServingEndpoints(fastify);
      return reply.send(result);
    } catch (error) {
      if (error instanceof DatabricksServingEndpointError) {
        return reply.status(error.statusCode).send({
          error: 'DatabricksApiError',
          message: error.message,
          statusCode: error.statusCode,
        });
      }
      if (error instanceof DatabricksServingEndpointAuthError) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: error.message,
          statusCode: 401,
        });
      }

      fastify.log.error({ error }, 'Unexpected error fetching serving endpoints');
      return reply.status(502).send({
        error: 'UpstreamError',
        message: 'Failed to reach Databricks serving endpoints',
        statusCode: 502,
      });
    }
  });
};

export default modelsRoute;
