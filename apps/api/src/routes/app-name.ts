import type { FastifyPluginAsync } from 'fastify';
import type { ApiError, GenerateAppNameRequest, GenerateAppNameResponse } from '@repo/types';
import { createUserContext } from '../lib/user-context.js';
import { getModelSettings } from '../services/admin.service.js';
import { AppNameService } from '../services/app-name.service.js';

const appNameRoute: FastifyPluginAsync = async fastify => {
  const appNameService = new AppNameService({
    databricksHost: fastify.config.DATABRICKS_HOST,
  });

  fastify.post<{
    Body: GenerateAppNameRequest;
    Reply: GenerateAppNameResponse | ApiError;
  }>('/generate_app_name', async (request, reply) => {
    const context = request.body?.context;
    if (typeof context !== 'string' || context.trim().length === 0) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'context is required and must be a non-empty string',
        statusCode: 400,
      });
    }

    const ctx = createUserContext(fastify, request);
    const authProvider = ctx.getAuthProvider();
    let accessToken: string;
    try {
      accessToken = await authProvider.getToken();
    } catch {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Access token is required (Service Principal)',
        statusCode: 401,
      });
    }

    try {
      const modelSettings = await getModelSettings(fastify);
      const result = await appNameService.generateAppName({
        context,
        accessToken,
        model: modelSettings.haikuModel,
      });
      return reply.send(result);
    } catch (error) {
      fastify.log.error(error, 'Failed to generate Databricks App name');
      return reply.status(500).send({
        error: 'InternalServerError',
        message: 'Failed to generate Databricks App name',
        statusCode: 500,
      });
    }
  });
};

export default appNameRoute;
