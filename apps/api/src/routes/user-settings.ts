import type { FastifyPluginAsync, FastifyReply, FastifyBaseLogger } from 'fastify';
import type { ApiError, UpdateUserSettingsRequest, UserSettingsResponse } from '@repo/types';
import { getSession } from '../services/session.service.js';
import { generateSettingsZip } from '../services/settings-export.service.js';
import { createUserContext } from '../lib/user-context.js';
import { SessionId } from '../models/session.model.js';
import {
  getUserSettings,
  updateUserSettings,
  USER_ALLOWED_TOOLS_SETTING_KEY,
  USER_DISALLOWED_TOOLS_SETTING_KEY,
  USER_MODEL_SETTING_KEYS,
  UserSettingsValidationError,
} from '../services/user-settings.service.js';

function sendError(
  reply: FastifyReply,
  statusCode: 400 | 401 | 404 | 500,
  error: string,
  message: string
): ReturnType<FastifyReply['send']> {
  return reply.status(statusCode).send({ error, message, statusCode });
}

function parseSessionId(sessionIdStr: string, logger?: FastifyBaseLogger): SessionId | null {
  try {
    return SessionId.fromString(sessionIdStr);
  } catch (error) {
    logger?.debug({ sessionIdStr, error }, 'Invalid session ID format');
    return null;
  }
}

function parseToolSetting(
  key: typeof USER_ALLOWED_TOOLS_SETTING_KEY | typeof USER_DISALLOWED_TOOLS_SETTING_KEY,
  value: unknown
): string[] | null | undefined | { error: string } {
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value) || value.some(tool => typeof tool !== 'string')) {
    return { error: `${key} must be an array of strings or null` };
  }
  if (value.some(tool => tool.trim().length === 0)) {
    return { error: `${key} must contain only non-empty strings` };
  }
  return value.map(tool => tool.trim());
}

const userSettingsRoute: FastifyPluginAsync = async fastify => {
  fastify.get<{ Reply: UserSettingsResponse | ApiError }>(
    '/user/settings',
    async (request, reply) => {
      const { user } = request.ctx!;

      if (!user.id) {
        return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
      }

      const settings = await getUserSettings(fastify, user.id);
      return reply.send(settings);
    }
  );

  fastify.patch<{
    Body: UpdateUserSettingsRequest;
    Reply: UserSettingsResponse | ApiError;
  }>('/user/settings', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const settings: UpdateUserSettingsRequest = {};
    for (const key of USER_MODEL_SETTING_KEYS) {
      const value = request.body[key];
      if (value === undefined) continue;
      if (value !== null && (typeof value !== 'string' || value.trim().length === 0)) {
        return sendError(reply, 400, 'BadRequest', `${key} must be a non-empty string or null`);
      }
      settings[key] = value === null ? null : value.trim();
    }
    for (const key of [
      USER_ALLOWED_TOOLS_SETTING_KEY,
      USER_DISALLOWED_TOOLS_SETTING_KEY,
    ] as const) {
      const value = parseToolSetting(key, request.body[key]);
      if (value === undefined) continue;
      if (value && 'error' in value) return sendError(reply, 400, 'BadRequest', value.error);
      settings[key] = value;
    }

    try {
      const updated = await updateUserSettings(fastify, user.id, settings);
      return reply.send(updated);
    } catch (error) {
      if (error instanceof UserSettingsValidationError) {
        return sendError(reply, 400, 'BadRequest', error.message);
      }
      throw error;
    }
  });

  /**
   * GET /user/download-settings?session_id=xxx
   * セッション設定を zip としてダウンロード
   */
  fastify.get<{
    Querystring: { session_id: string };
  }>('/user/download-settings', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const { session_id } = request.query;
    if (!session_id) {
      return sendError(reply, 400, 'BadRequest', 'session_id query parameter is required');
    }

    const sessionId = parseSessionId(session_id, request.log);
    if (!sessionId) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    try {
      const session = await getSession(fastify, user.id, sessionId);
      if (!session) {
        return sendError(reply, 404, 'NotFound', 'Session not found');
      }
      if (!session.session_context) {
        return sendError(reply, 400, 'BadRequest', 'Session has no context');
      }

      const ctx = createUserContext(fastify, request);
      const zipStream = generateSettingsZip(ctx, session.session_context);

      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', 'attachment; filename="settings.zip"')
        .send(zipStream);
    } catch (error) {
      request.log.error(error, 'Failed to generate settings zip');
      return sendError(reply, 500, 'InternalServerError', 'Failed to generate settings');
    }
  });
};

export default userSettingsRoute;
