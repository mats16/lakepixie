import { FastifyPluginAsync } from 'fastify';
import type { ServingEndpointsByTier, ApiError } from '@repo/types';
import {
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

      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Access token is required (Service Principal)',
        statusCode: 401,
      });
    }
  });
};

export default modelsRoute;
