// apps/api/src/routes/session.ts
import path from 'node:path';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
} from 'fastify';
import type { WebSocket } from 'ws';
import type {
  SessionCreateRequest,
  SessionCreateResponse,
  SessionEventsResponse,
  SessionEventPostResponse,
  SessionEventCreateRequest,
  SessionEventsQuery,
  SessionListQuery,
  SessionListResponse,
  SessionResponse,
  SessionArchiveResponse,
  SessionUpdateRequest,
  WsConnectedMessage,
  WsErrorMessage,
  WsControlRequest,
  WsControlResponse,
  WsAskUserQuestionAnswerRequest,
  WsExitPlanModeResponseRequest,
  WsEffortLevel,
  WsPermissionMode,
  SDKAuthStatusMessage,
  SDKUserMessage,
  ApiError,
  GitRepositoryDiffResponse,
  GitRepositoryOutcome,
  GitRepositorySource,
} from '@repo/types';
import {
  isAuthError,
  isImageContentBlock,
  isTextContentBlock,
  isToolResultContentBlock,
  parseGitBranchRevision,
} from '@repo/types';
import { resolveUserAnswer } from '../services/ask-user-question.service.js';
import { resolveExitPlanModeDecision } from '../services/exit-plan-mode.service.js';
import {
  createSession,
  SessionValidationError,
  listSessions,
  getSession,
  updateSession,
  archiveSession,
  sendMessageToSession,
  canAbortSession,
  executeAbort,
  broadcastToSession,
  setSessionPermissionMode,
  setSessionModel,
  applySessionFlagSettings,
  validateSessionModelId,
} from '../services/session.service.js';
import { UserSettingsValidationError } from '../services/user-settings.service.js';
import { TelemetryConfigurationError } from '../services/claude-telemetry-env.service.js';
import {
  GitHubOAuthAuthorizationRequiredError,
  GitHubOAuthExpiredError,
  GitHubOAuthNotConfiguredError,
} from '../services/github-oauth.service.js';
import { listSessionEvents, getSessionLastEventId } from '../services/session-events.service.js';
import { wsManager } from '../services/websocket-manager.service.js';
import { encodeSseEvent, sessionStreamHub } from '../services/session-stream-hub.service.js';
import { getLocalGitDiffSummary } from '../services/local-git.service.js';
import { SessionId } from '../models/session.model.js';
import { createUserContext } from '../lib/user-context.js';
import { validatePathWithinBase } from '../utils/path-validation.js';

const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * エラーレスポンスを生成するヘルパー
 */
function sendError(
  reply: FastifyReply,
  statusCode: 400 | 401 | 404 | 500 | 503,
  error: string,
  message: string
): ReturnType<FastifyReply['send']> {
  return reply.status(statusCode).send({ error, message, statusCode });
}

function getApiErrorName(statusCode: 400 | 401 | 404 | 500 | 503): string {
  switch (statusCode) {
    case 400:
      return 'BadRequest';
    case 401:
      return 'Unauthorized';
    case 404:
      return 'NotFound';
    case 500:
      return 'InternalServerError';
    case 503:
      return 'ServiceUnavailable';
  }
}

/**
 * WebSocket エラーメッセージを生成して送信し、接続を閉じる
 */
function closeWebSocketWithError(
  socket: WebSocket,
  code: WsErrorMessage['code'],
  message: string,
  closeCode: number
): void {
  const errorMsg: WsErrorMessage = { type: 'error', code, message };
  socket.send(JSON.stringify(errorMsg));
  socket.close(closeCode, message);
}

/**
 * セッションIDをパースするヘルパー
 * 無効な UUIDv7 形式の場合は null を返す
 */
function parseSessionId(sessionIdStr: string, logger?: FastifyBaseLogger): SessionId | null {
  try {
    return SessionId.fromString(sessionIdStr);
  } catch (error) {
    logger?.debug({ sessionIdStr, error }, 'Invalid session ID format');
    return null;
  }
}

function getLastEventIdHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function createAuthStatusMessage(sessionId: SessionId, error: unknown): SDKAuthStatusMessage {
  const errorCode = (error as Error & { code?: string }).code;
  return {
    type: 'auth_status',
    uuid: crypto.randomUUID(),
    session_id: sessionId.toString(),
    isAuthenticating: false,
    output: [],
    error: isAuthError(errorCode)
      ? 'Invalid API key · Please run /login'
      : error instanceof Error
        ? error.message
        : 'Unknown error',
  };
}

function getMessageErrorStatus(error: unknown): 400 | 404 | 500 {
  if (!(error instanceof Error)) return 500;
  if (error.message === 'Session not found') return 404;
  if (error.message === 'Session is archived') return 400;
  if (error.message === 'Session is not ready (still initializing)') return 400;
  return 500;
}

class ControlRequestProcessingError extends Error {
  constructor(
    public readonly statusCode: 400 | 404 | 500,
    message: string
  ) {
    super(message);
    this.name = 'ControlRequestProcessingError';
  }
}

const PERMISSION_MODES = new Set<WsPermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);

const EFFORT_LEVELS = new Set<WsEffortLevel>(['low', 'medium', 'high', 'xhigh', 'max']);

function getControlErrorStatus(error: unknown): 400 | 404 | 500 {
  if (error instanceof ControlRequestProcessingError) return error.statusCode;
  if (error instanceof UserSettingsValidationError) return 400;
  if (!(error instanceof Error)) return 500;
  if (error.message === 'Session not found') return 404;
  if (error.message === 'Session is archived') return 400;
  if (error.message === 'Session context not found') return 400;
  return 500;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidPermissionMode(value: unknown): value is WsPermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.has(value as WsPermissionMode);
}

function isValidEffortLevel(value: unknown): value is WsEffortLevel {
  return typeof value === 'string' && EFFORT_LEVELS.has(value as WsEffortLevel);
}

function assertValidFlagSettings(settings: unknown): asserts settings is {
  effortLevel?: WsEffortLevel | null;
} {
  if (!isObject(settings)) {
    throw new ControlRequestProcessingError(400, 'settings must be an object');
  }

  for (const key of Object.keys(settings)) {
    if (key !== 'effortLevel') {
      throw new ControlRequestProcessingError(400, `Unsupported flag setting: ${key}`);
    }
  }

  if (
    'effortLevel' in settings &&
    settings.effortLevel !== null &&
    settings.effortLevel !== undefined &&
    !isValidEffortLevel(settings.effortLevel)
  ) {
    throw new ControlRequestProcessingError(400, 'settings.effortLevel is invalid');
  }
}

async function processControlRequest(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  controlRequest: WsControlRequest,
  options: { allowedModelIds?: ReadonlySet<string> } = {}
): Promise<void> {
  if (!isObject(controlRequest.request) || typeof controlRequest.request.subtype !== 'string') {
    throw new ControlRequestProcessingError(400, 'Unsupported control request');
  }

  if (controlRequest.request.subtype === 'ask_user_question_answer') {
    const answerRequest = controlRequest.request as WsAskUserQuestionAnswerRequest;
    const resolved = resolveUserAnswer(answerRequest.tool_use_id, answerRequest.answers);
    if (!resolved) {
      throw new ControlRequestProcessingError(
        400,
        'No pending question found for this tool_use_id'
      );
    }
    return;
  }

  if (controlRequest.request.subtype === 'exit_plan_mode_response') {
    const responseRequest = controlRequest.request as WsExitPlanModeResponseRequest;
    if (typeof responseRequest.tool_use_id !== 'string' || !responseRequest.tool_use_id) {
      throw new ControlRequestProcessingError(400, 'tool_use_id must be a non-empty string');
    }
    if (typeof responseRequest.approved !== 'boolean') {
      throw new ControlRequestProcessingError(400, 'approved must be a boolean');
    }
    if (responseRequest.message !== undefined && typeof responseRequest.message !== 'string') {
      throw new ControlRequestProcessingError(400, 'message must be a string');
    }

    const message = responseRequest.message?.trim();
    if (!responseRequest.approved && !message) {
      throw new ControlRequestProcessingError(
        400,
        'message must be a non-empty string when approved is false'
      );
    }

    const resolved = resolveExitPlanModeDecision(
      responseRequest.tool_use_id,
      responseRequest.approved ? { approved: true } : { approved: false, message: message! }
    );
    if (!resolved) {
      throw new ControlRequestProcessingError(
        400,
        'No pending ExitPlanMode found for this tool_use_id'
      );
    }
    return;
  }

  if (controlRequest.request.subtype === 'abort') {
    if (!canAbortSession(sessionId)) {
      throw new ControlRequestProcessingError(400, 'No active query for this session');
    }

    executeAbort(fastify, userId, sessionId).catch(error => {
      fastify.log.error(error, 'Failed to execute abort after accepting request');
    });
    return;
  }

  try {
    if (controlRequest.request.subtype === 'set_permission_mode') {
      if (!isValidPermissionMode(controlRequest.request.mode)) {
        throw new ControlRequestProcessingError(400, 'mode is invalid');
      }
      await setSessionPermissionMode(fastify, userId, sessionId, controlRequest.request.mode);
      return;
    }

    if (controlRequest.request.subtype === 'set_model') {
      if (
        typeof controlRequest.request.model !== 'string' ||
        controlRequest.request.model.trim().length === 0
      ) {
        throw new ControlRequestProcessingError(400, 'model must be a non-empty string');
      }
      if (options.allowedModelIds) {
        await setSessionModel(fastify, userId, sessionId, controlRequest.request.model, {
          allowedModelIds: options.allowedModelIds,
        });
      } else {
        await setSessionModel(fastify, userId, sessionId, controlRequest.request.model);
      }
      return;
    }

    if (controlRequest.request.subtype === 'apply_flag_settings') {
      assertValidFlagSettings(controlRequest.request.settings);
      await applySessionFlagSettings(fastify, userId, sessionId, controlRequest.request.settings);
      return;
    }
  } catch (error) {
    if (error instanceof ControlRequestProcessingError) throw error;
    throw new ControlRequestProcessingError(getControlErrorStatus(error), getErrorMessage(error));
  }

  throw new ControlRequestProcessingError(400, 'Unsupported control request');
}

async function assertValidControlRequestForBatch(
  fastify: FastifyInstance,
  controlRequest: WsControlRequest,
  context: EventBatchValidationContext
): Promise<void> {
  const payload = controlRequest.request;
  if (!isObject(payload) || typeof payload.subtype !== 'string') {
    throw new ControlRequestProcessingError(400, 'Unsupported control request');
  }

  switch (payload.subtype) {
    case 'ask_user_question_answer':
      if (typeof payload.tool_use_id !== 'string' || !payload.tool_use_id) {
        throw new ControlRequestProcessingError(400, 'tool_use_id must be a non-empty string');
      }
      if (!isObject(payload.answers)) {
        throw new ControlRequestProcessingError(400, 'answers must be an object');
      }
      return;

    case 'exit_plan_mode_response': {
      if (typeof payload.tool_use_id !== 'string' || !payload.tool_use_id) {
        throw new ControlRequestProcessingError(400, 'tool_use_id must be a non-empty string');
      }
      if (typeof payload.approved !== 'boolean') {
        throw new ControlRequestProcessingError(400, 'approved must be a boolean');
      }
      if (payload.message !== undefined && typeof payload.message !== 'string') {
        throw new ControlRequestProcessingError(400, 'message must be a string');
      }
      if (!payload.approved && !payload.message?.trim()) {
        throw new ControlRequestProcessingError(
          400,
          'message must be a non-empty string when approved is false'
        );
      }
      return;
    }

    case 'abort':
      return;

    case 'set_permission_mode':
      if (!isValidPermissionMode(payload.mode)) {
        throw new ControlRequestProcessingError(400, 'mode is invalid');
      }
      return;

    case 'set_model':
      if (typeof payload.model !== 'string' || payload.model.trim().length === 0) {
        throw new ControlRequestProcessingError(400, 'model must be a non-empty string');
      }
      try {
        context.allowedModelIds = await validateSessionModelId(
          fastify,
          payload.model,
          context.allowedModelIds
        );
      } catch (error) {
        throw new ControlRequestProcessingError(
          getControlErrorStatus(error),
          getErrorMessage(error)
        );
      }
      return;

    case 'apply_flag_settings':
      assertValidFlagSettings(payload.settings);
      return;

    default:
      throw new ControlRequestProcessingError(400, 'Unsupported control request');
  }
}

interface EventBatchValidationContext {
  allowedModelIds?: ReadonlySet<string>;
}

function isValidUserMessageContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content) || content.length === 0) return false;

  return content.every(block => {
    if (isTextContentBlock(block) || isImageContentBlock(block)) return true;
    if (!isToolResultContentBlock(block)) return false;
    return typeof block.content === 'string';
  });
}

function assertValidUserMessageEvent(event: SDKUserMessage): void {
  if (!isObject(event.message)) {
    throw new ControlRequestProcessingError(400, 'message must be an object');
  }
  if (event.message.role !== 'user') {
    throw new ControlRequestProcessingError(400, 'message.role must be user');
  }
  if (!isValidUserMessageContent(event.message.content)) {
    throw new ControlRequestProcessingError(
      400,
      'message.content must be a non-empty string or array'
    );
  }
}

async function assertValidEventBatch(
  fastify: FastifyInstance,
  events: SessionEventCreateRequest['events']
): Promise<EventBatchValidationContext> {
  const context: EventBatchValidationContext = {};
  for (const event of events) {
    if (isControlRequestEvent(event)) {
      await assertValidControlRequestForBatch(fastify, event, context);
      continue;
    }
    if (isUserMessageEvent(event)) {
      assertValidUserMessageEvent(event);
      continue;
    }

    throw new ControlRequestProcessingError(400, 'Only user and control events can be submitted');
  }
  return context;
}

async function handleControlRequest(
  fastify: FastifyInstance,
  request: FastifyRequest,
  userId: string,
  sessionId: SessionId,
  controlRequest: WsControlRequest
): Promise<WsControlResponse> {
  try {
    await processControlRequest(fastify, userId, sessionId, controlRequest);
    return {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: controlRequest.request_id,
      },
    };
  } catch (error) {
    if (
      controlRequest.request?.subtype === 'abort' &&
      (!(error instanceof ControlRequestProcessingError) || error.statusCode === 500)
    ) {
      request.log.error(error, 'Failed to execute abort');
      const errorMsg: WsErrorMessage = {
        type: 'error',
        code: 'ABORT_FAILED',
        message: getErrorMessage(error),
      };
      broadcastToSession(sessionId.toString(), errorMsg);
    }

    return {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: controlRequest.request_id,
        error: getErrorMessage(error),
      },
    };
  }
}

function isSessionEventCreateRequest(body: unknown): body is SessionEventCreateRequest {
  return isObject(body) && Array.isArray(body.events) && body.events.length > 0;
}

function isControlRequestEvent(event: unknown): event is WsControlRequest {
  return isObject(event) && event.type === 'control_request';
}

function isUserMessageEvent(event: unknown): event is SDKUserMessage {
  return isObject(event) && event.type === 'user';
}

const sessionRoute: FastifyPluginAsync = async fastify => {
  fastify.post<{
    Body: SessionCreateRequest;
    Reply: SessionCreateResponse | ApiError;
  }>('/sessions', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const { events } = request.body;

    if (!events || events.length === 0) {
      return sendError(reply, 400, 'BadRequest', 'At least one event is required');
    }

    try {
      const ctx = createUserContext(fastify, request);
      const result = await createSession(fastify, user.id, request.body, ctx);
      return reply.status(201).send(result);
    } catch (error) {
      request.log.error(error, 'Failed to create session');
      if (error instanceof SessionValidationError) {
        return sendError(reply, 400, 'BadRequest', error.message);
      }
      if (error instanceof TelemetryConfigurationError) {
        return sendError(reply, 500, 'InternalServerError', error.message);
      }
      if (error instanceof GitHubOAuthNotConfiguredError) {
        return sendError(reply, 503, 'GitHubOAuthNotConfigured', error.message);
      }
      if (
        error instanceof GitHubOAuthAuthorizationRequiredError ||
        error instanceof GitHubOAuthExpiredError
      ) {
        return sendError(reply, 401, 'GitHubAuthorizationRequired', error.message);
      }
      return sendError(reply, 500, 'InternalServerError', 'Failed to create session');
    }
  });

  // GET /sessions - セッション一覧取得
  fastify.get<{
    Querystring: SessionListQuery;
    Reply: SessionListResponse | ApiError;
  }>('/sessions', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const { limit, status, after } = request.query;

    if (after) {
      const cursorId = parseSessionId(after, request.log);
      if (!cursorId) {
        return sendError(reply, 400, 'BadRequest', 'Invalid cursor format for "after" parameter');
      }
    }

    try {
      const result = await listSessions(fastify, user.id, {
        limit: limit ? Number(limit) : undefined,
        status: status ?? undefined,
        after: after ?? undefined,
      });
      return reply.send(result);
    } catch (error) {
      request.log.error(error, 'Failed to list sessions');
      return sendError(reply, 500, 'InternalServerError', 'Failed to get sessions');
    }
  });

  // GET /sessions/:session_id - セッション詳細取得
  fastify.get<{
    Params: { session_id: string };
    Reply: SessionResponse | ApiError;
  }>('/sessions/:session_id', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const { session_id } = request.params;
    const sessionId = parseSessionId(session_id, request.log);

    if (!sessionId) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    try {
      const session = await getSession(fastify, user.id, sessionId);

      if (!session) {
        return sendError(reply, 404, 'NotFound', 'Session not found');
      }

      return reply.send(session);
    } catch (error) {
      request.log.error(error, 'Failed to get session');
      return sendError(reply, 500, 'InternalServerError', 'Failed to get session');
    }
  });

  fastify.get<{
    Params: { session_id: string };
    Reply: GitRepositoryDiffResponse | ApiError;
  }>('/sessions/:session_id/git-diff', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const sessionId = parseSessionId(request.params.session_id, request.log);
    if (!sessionId) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    try {
      const session = await getSession(fastify, user.id, sessionId);
      const context = session?.session_context;
      if (!context) {
        return sendError(reply, 404, 'NotFound', 'Session not found');
      }

      const gitOutcome = context.outcomes.find(
        (outcome): outcome is GitRepositoryOutcome => outcome.type === 'git_repository'
      );
      const gitSources = context.sources.filter(
        (source): source is GitRepositorySource => source.type === 'git_repository'
      );
      const gitSource = gitSources.length === 1 ? gitSources[0] : null;
      const headBranch = gitOutcome?.git_info.branches[0];
      const baseBranch = gitSource ? parseGitBranchRevision(gitSource.revision) : null;
      if (!gitSource || !headBranch || !baseBranch) {
        return sendError(reply, 404, 'NotFound', 'Git repository context not found');
      }

      const sessionsBaseDir = path.join(fastify.config.CCBRICKS_BASE_DIR, 'sessions');
      const cwd = await validatePathWithinBase(context.cwd, sessionsBaseDir);
      const diff = await getLocalGitDiffSummary(cwd, baseBranch, headBranch);
      return reply.send(diff);
    } catch (error) {
      request.log.warn({ error, sessionId: sessionId.toString() }, 'Failed to get local git diff');
      return reply.status(502).send({
        error: 'GitDiffUnavailable',
        message: 'Failed to get local git diff',
        details: error instanceof Error ? error.message : String(error),
        statusCode: 502,
      });
    }
  });

  // PATCH /sessions/:session_id - セッション更新（タイトルのみ）
  // ステータス変更は POST /sessions/:session_id/archive を使用
  fastify.patch<{
    Params: { session_id: string };
    Body: SessionUpdateRequest;
    Reply: SessionResponse | ApiError;
  }>('/sessions/:session_id', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const { session_id } = request.params;
    const sessionId = parseSessionId(session_id, request.log);
    const { title } = request.body;

    if (!sessionId) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    // 1. 必須フィールドのチェック
    if (title === undefined) {
      return sendError(reply, 400, 'BadRequest', 'title is required');
    }

    // 2. 無効なフィールドのチェック
    const allowedFields = ['title'];
    const receivedFields = Object.keys(request.body);
    const invalidFields = receivedFields.filter(f => !allowedFields.includes(f));

    if (invalidFields.length > 0) {
      return sendError(
        reply,
        400,
        'BadRequest',
        `Invalid fields: ${invalidFields.join(', ')}. Only 'title' can be updated.`
      );
    }

    try {
      const session = await updateSession(fastify, user.id, sessionId, { title });

      if (!session) {
        return sendError(reply, 404, 'NotFound', 'Session not found');
      }

      return reply.send(session);
    } catch (error) {
      request.log.error(error, 'Failed to update session');
      return sendError(reply, 500, 'InternalServerError', 'Failed to update session');
    }
  });

  // POST /sessions/:session_id/archive - セッションアーカイブ
  fastify.post<{
    Params: { session_id: string };
    Reply: SessionArchiveResponse | ApiError;
  }>('/sessions/:session_id/archive', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const { session_id } = request.params;
    const sessionId = parseSessionId(session_id, request.log);

    if (!sessionId) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    try {
      const session = await archiveSession(fastify, user.id, sessionId);

      if (!session) {
        return sendError(reply, 404, 'NotFound', 'Session not found');
      }

      return reply.send(session);
    } catch (error) {
      request.log.error(error, 'Failed to archive session');
      return sendError(reply, 500, 'InternalServerError', 'Failed to archive session');
    }
  });

  // GET /sessions/:session_id/events - 過去イベント取得
  fastify.get<{
    Params: { session_id: string };
    Querystring: SessionEventsQuery;
    Reply: SessionEventsResponse | ApiError;
  }>('/sessions/:session_id/events', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const { session_id } = request.params;
    const sessionId = parseSessionId(session_id, request.log);

    if (!sessionId) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    const { after, limit } = request.query;

    try {
      const result = await listSessionEvents(fastify, user.id, sessionId, {
        after: after ?? undefined,
        limit: limit ? Number(limit) : undefined,
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof Error && error.message === 'Session not found') {
        return sendError(reply, 404, 'NotFound', 'Session not found');
      }
      request.log.error(error, 'Failed to get session events');
      return sendError(reply, 500, 'InternalServerError', 'Failed to get session events');
    }
  });

  // GET /sessions/:session_id/stream - SSE リアルタイムイベント配信
  fastify.get<{
    Params: { session_id: string };
    Querystring: { after?: string };
  }>('/sessions/:session_id/stream', { compress: false }, async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const { session_id } = request.params;
    const sessionId = parseSessionId(session_id, request.log);

    if (!sessionId) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    let lastEventId: string | null;
    let replayAfter: string | undefined;

    try {
      lastEventId = await getSessionLastEventId(fastify, user.id, sessionId);
      replayAfter = request.query.after ?? getLastEventIdHeader(request.headers['last-event-id']);
    } catch (error) {
      if (error instanceof Error && error.message === 'Session not found') {
        return sendError(reply, 404, 'NotFound', 'Session not found');
      }
      request.log.error(error, 'SSE stream connection error');
      return sendError(reply, 500, 'InternalServerError', 'Failed to establish stream');
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    (reply.raw as typeof reply.raw & { flushHeaders?: () => void }).flushHeaders?.();

    const cleanup = sessionStreamHub.addConnection(session_id, user.id, reply.raw);
    const heartbeat = setInterval(() => {
      sessionStreamHub.heartbeat(session_id);
    }, SSE_HEARTBEAT_INTERVAL_MS);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      cleanup();
      clearInterval(heartbeat);
      request.log.info({ sessionId: session_id, userId: user.id }, 'SSE stream disconnected');
    };
    request.raw.on('close', close);
    reply.raw.on('error', close);

    const connectedMsg: WsConnectedMessage = {
      type: 'connected',
      session_id,
      last_event_id: lastEventId,
    };
    reply.raw.write(encodeSseEvent('connected', connectedMsg, undefined, 1000));

    // リプレイイベントをページ単位でストリーミング（メモリに蓄積しない）
    if (replayAfter && replayAfter !== lastEventId) {
      let cursor: string | undefined = replayAfter;
      let hasMore = true;
      for (let page = 0; page < 20 && hasMore; page++) {
        const response = await listSessionEvents(fastify, user.id, sessionId, {
          after: cursor,
          limit: 1000,
        });
        for (const event of response.data) {
          const eventId =
            'uuid' in event && typeof event.uuid === 'string' ? event.uuid : undefined;
          reply.raw.write(encodeSseEvent('message', event, eventId));
        }
        hasMore = response.has_more;
        const nextCursor = response.last_id || undefined;
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
    }

    request.log.info({ sessionId: session_id, userId: user.id }, 'SSE stream connected');
  });

  // POST /sessions/:session_id/events - ユーザーイベント送信 / control request
  // idle/error 時は即 resume、init/running 時は queued event として保存し実行完了後に resume する
  fastify.post<{
    Params: { session_id: string };
    Body: SessionEventCreateRequest;
    Reply: SessionEventPostResponse | ApiError;
  }>('/sessions/:session_id/events', async (request, reply) => {
    const { user } = request.ctx!;

    if (!user.id) {
      return sendError(reply, 401, 'Unauthorized', 'User ID not found in request context');
    }

    const { session_id } = request.params;
    const sessionId = parseSessionId(session_id, request.log);

    if (!sessionId) {
      return sendError(reply, 404, 'NotFound', 'Session not found');
    }

    if (!isSessionEventCreateRequest(request.body)) {
      return sendError(reply, 400, 'BadRequest', 'events must be a non-empty array');
    }

    try {
      const validationContext = await assertValidEventBatch(fastify, request.body.events);
      const ctx = createUserContext(fastify, request);
      const acceptedEvents: SessionEventCreateRequest['events'] = [];

      for (const event of request.body.events) {
        if (isControlRequestEvent(event)) {
          await processControlRequest(fastify, user.id, sessionId, event, validationContext);
          acceptedEvents.push(event);
          continue;
        }

        if (isUserMessageEvent(event)) {
          await sendMessageToSession(fastify, user.id, sessionId, event, ctx);
          acceptedEvents.push(event);
          continue;
        }

        throw new ControlRequestProcessingError(
          400,
          'Only user and control events can be submitted'
        );
      }

      return reply.status(202).send({ events: acceptedEvents, response: { subtype: 'success' } });
    } catch (error) {
      if (error instanceof ControlRequestProcessingError) {
        request.log.error(error, 'Failed to process control request');
        return sendError(reply, error.statusCode, getApiErrorName(error.statusCode), error.message);
      }

      request.log.error(error, 'Failed to send message to session');
      const authStatusMsg = createAuthStatusMessage(sessionId, error);
      broadcastToSession(sessionId.toString(), authStatusMsg);

      const status = getMessageErrorStatus(error);
      return sendError(
        reply,
        status,
        getApiErrorName(status),
        authStatusMsg.error ?? 'Failed to send message to session'
      );
    }
  });

  // WebSocket /sessions/:session_id/subscribe - リアルタイムイベント配信
  fastify.get<{
    Params: { session_id: string };
  }>('/sessions/:session_id/subscribe', { websocket: true }, async (socket, request) => {
    const { user } = request.ctx!;
    const { session_id } = request.params;
    const sessionId = parseSessionId(session_id, request.log);

    if (!sessionId) {
      closeWebSocketWithError(socket, 'NOT_FOUND', 'Session not found', 4004);
      return;
    }

    if (!user.id) {
      closeWebSocketWithError(socket, 'UNAUTHORIZED', 'User ID not found', 4001);
      return;
    }

    // WebSocket接続時に UserContext を生成して保持
    // （message イベントハンドラ内でも使用するため）
    const ctx = createUserContext(fastify, request);

    try {
      // 最新イベント ID を取得して接続成功メッセージを送信
      const lastEventId = await getSessionLastEventId(fastify, user.id, sessionId);

      // 接続を管理に追加
      wsManager.addConnection(session_id, user.id, socket);

      const connectedMsg: WsConnectedMessage = {
        type: 'connected',
        session_id,
        last_event_id: lastEventId,
      };
      socket.send(JSON.stringify(connectedMsg));

      request.log.info({ sessionId: session_id, userId: user.id }, 'WebSocket connected');

      // クライアントからのメッセージ処理（keep_alive, user message, control_request）
      socket.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'keep_alive') {
            // keep_alive メッセージは接続維持のため受信のみ（レスポンス不要）
          } else if (msg.type === 'user') {
            try {
              await sendMessageToSession(fastify, user.id, sessionId, msg, ctx);
            } catch (error) {
              request.log.error(error, 'Failed to send message to session');
              const authStatusMsg = createAuthStatusMessage(sessionId, error);
              socket.send(JSON.stringify(authStatusMsg));
            }
          } else if (msg.type === 'control_request') {
            const response = await handleControlRequest(
              fastify,
              request,
              user.id,
              sessionId,
              msg as WsControlRequest
            );
            socket.send(JSON.stringify(response));
          }
        } catch {
          // JSON パースエラーは無視
        }
      });

      socket.on('close', () => {
        request.log.info({ sessionId: session_id, userId: user.id }, 'WebSocket disconnected');
      });
    } catch (error) {
      request.log.error(error, 'WebSocket connection error');

      if (error instanceof Error && error.message === 'Session not found') {
        closeWebSocketWithError(socket, 'NOT_FOUND', 'Session not found', 4004);
        return;
      }

      closeWebSocketWithError(socket, 'CONNECTION_ERROR', 'Failed to establish connection', 4000);
    }
  });
};

export default sessionRoute;
