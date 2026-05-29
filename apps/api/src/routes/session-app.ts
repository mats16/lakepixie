import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type {
  ApiError,
  ResolvedDatabricksAppsOutcome,
  SessionAppCreateRequest,
  SessionAppCreateResponse,
  SessionAppDeleteResponse,
} from '@repo/types';
import { SessionId } from '../models/session.model.js';
import {
  createDatabricksAppForSession,
  deleteDatabricksAppForSession,
  getSession,
  SessionAppCreateError,
  SessionAppDeleteError,
} from '../services/session.service.js';
import { DatabricksAppsClient, DatabricksApiError } from '../lib/databricks-apps-client.js';
import { getAuthProvider } from '../lib/databricks-auth.js';
import { createUserContext } from '../lib/user-context.js';

function sendError(
  reply: FastifyReply,
  statusCode: 400 | 401 | 403 | 404 | 409 | 500,
  error: string,
  message: string
): ReturnType<FastifyReply['send']> {
  return reply.status(statusCode).send({ error, message, statusCode });
}

function getErrorName(statusCode: 400 | 401 | 403 | 404 | 409 | 500): string {
  switch (statusCode) {
    case 400:
      return 'BadRequest';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'NotFound';
    case 409:
      return 'Conflict';
    case 500:
      return 'InternalServerError';
  }
}

function parseSessionId(sessionIdStr: string): SessionId | null {
  try {
    return SessionId.fromString(sessionIdStr);
  } catch {
    return null;
  }
}

const sessionAppRoute: FastifyPluginAsync = async fastify => {
  fastify.post<{
    Params: { session_id: string };
    Body: SessionAppCreateRequest;
    Reply: SessionAppCreateResponse | ApiError;
  }>('/sessions/:session_id/app/create', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const sessionId = parseSessionId(request.params.session_id);
    if (!sessionId) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    if (!request.body || typeof request.body.context !== 'string') {
      return sendError(reply, 400, 'BadRequest', 'context is required');
    }

    try {
      const ctx = createUserContext(fastify, request);
      const result = await createDatabricksAppForSession({
        fastify,
        userId: user.id,
        sessionId,
        context: request.body.context,
        ctx,
      });
      return reply.status(201).send(result);
    } catch (error) {
      if (error instanceof SessionAppCreateError) {
        return sendError(reply, error.statusCode, getErrorName(error.statusCode), error.message);
      }
      if (error instanceof DatabricksApiError) {
        request.log.error(error, 'Failed to create Databricks App');
        return sendError(reply, 500, 'InternalServerError', error.message);
      }
      request.log.error(error, 'Failed to create Databricks App');
      const message = error instanceof Error ? error.message : 'Unknown error';
      return sendError(reply, 500, 'InternalServerError', message);
    }
  });

  /**
   * GET /sessions/:session_id/app
   * セッションに関連付けられた Databricks App の情報を取得
   */
  fastify.get<{
    Params: { session_id: string };
  }>('/sessions/:session_id/app', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const sessionId = parseSessionId(request.params.session_id);
    if (!sessionId) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    const session = await getSession(fastify, user.id, sessionId);
    if (!session) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    const appsOutcome = session.session_context?.outcomes?.find(
      (o): o is ResolvedDatabricksAppsOutcome => o.type === 'databricks_apps'
    );
    if (!appsOutcome?.name) {
      return sendError(
        reply,
        404,
        'NotFound',
        'This session does not have Databricks Apps outcome configured'
      );
    }

    const authProvider = getAuthProvider(fastify);
    const appsClient = new DatabricksAppsClient(authProvider);

    try {
      const app = await appsClient.get(appsOutcome.name);
      if (!app) {
        return sendError(reply, 404, 'NotFound', `App '${appsOutcome.name}' not found`);
      }
      return reply.send(app);
    } catch (error) {
      if (error instanceof DatabricksApiError) {
        const code = error.statusCode === 404 ? 404 : 500;
        return sendError(
          reply,
          code,
          code === 404 ? 'NotFound' : 'InternalServerError',
          error.message
        );
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return sendError(reply, 500, 'InternalServerError', message);
    }
  });

  /**
   * DELETE /sessions/:session_id/app
   * セッションに関連付けられた Databricks App を削除し、outcome も解除する
   */
  fastify.delete<{
    Params: { session_id: string };
    Reply: SessionAppDeleteResponse | ApiError;
  }>('/sessions/:session_id/app', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const sessionId = parseSessionId(request.params.session_id);
    if (!sessionId) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    try {
      const result = await deleteDatabricksAppForSession({
        fastify,
        userId: user.id,
        sessionId,
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof SessionAppDeleteError) {
        return sendError(reply, error.statusCode, getErrorName(error.statusCode), error.message);
      }
      if (error instanceof DatabricksApiError) {
        const code = error.statusCode === 403 ? 403 : error.statusCode === 404 ? 404 : 500;
        request.log.error(error, 'Failed to delete Databricks App');
        return sendError(reply, code, getErrorName(code), error.message);
      }
      request.log.error(error, 'Failed to delete Databricks App');
      const message = error instanceof Error ? error.message : 'Unknown error';
      return sendError(reply, 500, 'InternalServerError', message);
    }
  });
};

export default sessionAppRoute;
