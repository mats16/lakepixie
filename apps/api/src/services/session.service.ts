import type { FastifyInstance } from 'fastify';
import { eq, desc, and, inArray, lt, asc } from 'drizzle-orm';
import { accessSync, constants as fsConstants } from 'node:fs';
import { access, chmod, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnAsync } from '../utils/spawn.js';
import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
  type SDKUserMessageReplay,
  type Query,
} from '@anthropic-ai/claude-agent-sdk';
import type { UUID } from 'crypto';
import {
  parseGitBranchRevision,
  type DatabricksAppsOutcome,
  type DatabricksWorkspaceSource,
  type GitRepositoryOutcome,
  type GitRepositorySource,
  type ResolvedDatabricksAppsOutcome,
  type SessionContextResponse,
  type SessionCreateRequest,
  type SessionCreateResponse,
  type SessionCreateEventData,
  type SessionAppCreateResponse,
  type SessionAppNotificationStatus,
  type SessionListQuery,
  type SessionListResponse,
  type SessionOutcome,
  type SessionResponse,
  type SessionSource,
  type SessionStatus,
  type SessionUpdateRequest,
  type WsServerMessage,
  type WsEffortLevel,
  type WsPermissionMode,
} from '@repo/types';
import { buildSystemPromptConfig } from '../utils/system-prompt.helper.js';
import { sessionEvents, sessions } from '../db/schema.js';
import { insertSessionEventInTx } from '../db/helpers.js';
import { ensureDirectory, removeDirectory } from '../utils/directory.js';
import { validatePathWithinBase } from '../utils/path-validation.js';
import { fromUUID } from 'typeid-js';
import { DatabricksApiError, DatabricksAppsClient } from '../lib/databricks-apps-client.js';
import { DatabricksWorkspaceClient } from '../lib/databricks-workspace-client.js';
import { getAuthProvider } from '../lib/databricks-auth.js';
import { DATABRICKS_CONFIG_PROFILE, writeDatabricksConfig } from '../lib/databricks-cli-config.js';
import { getAllowedModelIds, getAppSettings, getModelSettings } from './admin.service.js';
import { writeHelperScripts } from './helper-scripts.service.js';
import { buildClaudeTelemetryEnv } from './claude-telemetry-env.service.js';
import { wsManager } from './websocket-manager.service.js';
import { sessionStreamHub } from './session-stream-hub.service.js';
import { enqueueSessionEvent } from './event-queue.service.js';
import { waitForUserAnswer } from './ask-user-question.service.js';
import { waitForExitPlanModeDecision } from './exit-plan-mode.service.js';
import { SessionId } from '../models/session.model.js';
import type { UserContext } from '../lib/user-context.js';
import path from 'node:path';
import { AppNameService, isValidDatabricksAppName } from './app-name.service.js';
import {
  createGitHubGitAuthEnvironment,
  toGitHubRepositoryFullName,
} from './github-app-auth.service.js';
import {
  buildGitCredentialHelperScript,
  registerGitCredential,
  revokeGitCredential,
} from './git-credential.service.js';
import {
  getUserSettings,
  resolveSessionModelIdFromSettings,
  UserSettingsValidationError,
} from './user-settings.service.js';

interface ActiveSessionQuery {
  abortController: AbortController;
  query: Query;
  permissionModeBeforePlan?: Exclude<WsPermissionMode, 'plan'>;
}

/** セッションID → 実行中 SDK query のマッピング（abort / control request 用） */
const activeSessionQueries = new Map<string, ActiveSessionQuery>();
const QUEUED_USER_EVENT_SUBTYPE = 'queued';
const GIT_COMMAND_TIMEOUT_MS = 60000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const moduleRequire = createRequire(import.meta.url);
const MCP_TOOL_PATTERN_PREFIX = 'mcp__';
const PERMISSION_MODES = new Set<WsPermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);
const EFFORT_LEVELS = new Set<WsEffortLevel>(['low', 'medium', 'high', 'xhigh', 'max']);
const LIVE_APPLY_FLAG_EFFORT_LEVELS = new Set<Exclude<WsEffortLevel, 'max'>>([
  'low',
  'medium',
  'high',
  'xhigh',
]);
type EffectiveToolSettings = {
  allowed_tools: string[];
  disallowed_tools: string[];
};

function isValidPermissionMode(value: unknown): value is WsPermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.has(value as WsPermissionMode);
}

function isValidEffortLevel(value: unknown): value is WsEffortLevel {
  return typeof value === 'string' && EFFORT_LEVELS.has(value as WsEffortLevel);
}

function isLiveApplyFlagEffortLevel(
  value: WsEffortLevel | null | undefined
): value is Exclude<WsEffortLevel, 'max'> {
  return (
    typeof value === 'string' &&
    value !== 'max' &&
    LIVE_APPLY_FLAG_EFFORT_LEVELS.has(value as Exclude<WsEffortLevel, 'max'>)
  );
}

export class SessionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionValidationError';
  }
}

export class SessionAppCreateError extends Error {
  constructor(
    public readonly statusCode: 400 | 401 | 404 | 409 | 500,
    message: string
  ) {
    super(message);
    this.name = 'SessionAppCreateError';
  }
}

interface QueuedUserMessageResume {
  userMessage: SDKUserMessage;
  sessionContext: SessionContextResponse;
  sdkSessionId: string;
}

type SupportedClaudeArch = 'x64' | 'arm64';
type LinuxLibc = 'glibc' | 'musl';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildGitIdentityEnv(ctx: UserContext): Record<string, string> {
  // userId/Name/Email はヘッダー欠落時に空文字フォールバックされうるため、最後に固定値を当てる
  const gitName = ctx.userName.trim() || ctx.userEmail.trim() || ctx.userId || 'ccbricks';
  const gitEmail = ctx.userEmail.trim() || ctx.userId || 'ccbricks@localhost';

  return {
    GIT_AUTHOR_NAME: gitName,
    GIT_AUTHOR_EMAIL: gitEmail,
    GIT_COMMITTER_NAME: gitName,
    GIT_COMMITTER_EMAIL: gitEmail,
  };
}

function toLogError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function findDatabricksAppsOutcome(
  context: SessionContextResponse
): ResolvedDatabricksAppsOutcome | undefined {
  return context.outcomes.find(
    (outcome): outcome is ResolvedDatabricksAppsOutcome => outcome.type === 'databricks_apps'
  );
}

function findDatabricksWorkspaceOutcome(
  context: SessionContextResponse
): DatabricksWorkspaceSource | undefined {
  return context.outcomes.find(
    (outcome): outcome is DatabricksWorkspaceSource => outcome.type === 'databricks_workspace'
  );
}

function assertValidDatabricksWorkspacePath(workspacePath: string): void {
  if (
    !workspacePath.startsWith('/') ||
    workspacePath.includes('..') ||
    workspacePath.includes('\0')
  ) {
    throw new SessionAppCreateError(400, 'Databricks Workspace path is invalid');
  }
}

function getSupportedClaudeArch(): SupportedClaudeArch {
  if (process.arch === 'x64' || process.arch === 'arm64') {
    return process.arch;
  }
  throw new Error(`Unsupported Claude Agent SDK architecture: ${process.arch}`);
}

function getLinuxLibc(): LinuxLibc {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const header = report?.header;
  return header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

function getClaudeNativePackageName(): string {
  const arch = getSupportedClaudeArch();
  if (process.platform === 'linux') {
    const libcSuffix = getLinuxLibc() === 'musl' ? '-musl' : '';
    return `@anthropic-ai/claude-agent-sdk-linux-${arch}${libcSuffix}`;
  }
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return `@anthropic-ai/claude-agent-sdk-${process.platform}-${arch}`;
  }
  throw new Error(`Unsupported Claude Agent SDK platform: ${process.platform}`);
}

function resolveClaudeCodeExecutable(packageName = getClaudeNativePackageName()): string {
  const executableName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  let executablePath: string;
  try {
    executablePath = moduleRequire.resolve(`${packageName}/${executableName}`);
  } catch (err) {
    throw new Error(
      `Claude Agent SDK native binary package is missing for ${process.platform}-${process.arch}` +
        `${process.platform === 'linux' ? `-${getLinuxLibc()}` : ''}: ${packageName}`,
      { cause: toLogError(err) }
    );
  }

  try {
    accessSync(executablePath, fsConstants.X_OK);
  } catch (err) {
    throw new Error(`Claude Agent SDK native binary is not executable: ${executablePath}`, {
      cause: toLogError(err),
    });
  }

  return executablePath;
}

async function setSessionStatusError(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  stage: string
): Promise<void> {
  try {
    await fastify.withUserContext(userId, async tx => {
      await tx
        .update(sessions)
        .set({ status: 'error', updatedAt: new Date() })
        .where(eq(sessions.id, sessionId.toUUID()));
    });
  } catch (err) {
    fastify.log.error(
      { err: toLogError(err), sessionId: sessionId.toString(), userId, stage },
      'Failed to mark session as error'
    );
  }
}

async function persistSessionFailureEvent(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  stage: string,
  error: unknown
): Promise<void> {
  const message = errorMessage(error);
  const eventUuid = crypto.randomUUID();
  const failureEvent = {
    type: 'result',
    subtype: 'error_during_execution',
    uuid: eventUuid,
    session_id: sessionId.toString(),
    is_error: true,
    errors: [`${stage}: ${message}`],
    result: message,
  } as unknown as SDKResultMessage;

  broadcastToSession(sessionId.toString(), failureEvent);

  try {
    await fastify.withUserContext(userId, async tx => {
      await insertSessionEventInTx(tx, {
        uuid: eventUuid,
        sessionId: sessionId.toUUID(),
        type: failureEvent.type,
        subtype: failureEvent.subtype,
        message: failureEvent,
      });
    });
  } catch (err) {
    fastify.log.error(
      {
        err: toLogError(err),
        sessionId: sessionId.toString(),
        userId,
        stage,
        failureEventUuid: eventUuid,
        originalError: message,
      },
      'Failed to persist session failure event'
    );
  }
}

/**
 * query() の streaming input mode を有効にするため、単一 user message を AsyncIterable 化する。
 */
async function* singleMessageIterable(msg: SDKUserMessage): AsyncIterable<SDKUserMessage> {
  yield msg;
}

function buildPromptMessage(
  sessionId: SessionId,
  rawPrompt: string | SDKUserMessage,
  initialUserEvent: SessionCreateEventData | undefined
): SDKUserMessage {
  if (typeof rawPrompt !== 'string') return rawPrompt;

  return {
    type: 'user',
    uuid: (initialUserEvent?.uuid ?? crypto.randomUUID()) as UUID,
    session_id: sessionId.toString(),
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: rawPrompt,
    },
  };
}

interface HandleCanUseToolParams {
  fastify: FastifyInstance;
  userId: string;
  sessionId: SessionId;
  toolName: string;
  input: Record<string, unknown>;
  options: Parameters<CanUseTool>[2];
}

async function handleCanUseTool({
  fastify,
  userId,
  sessionId,
  toolName,
  input,
  options,
}: HandleCanUseToolParams): Promise<PermissionResult> {
  if (toolName === 'AskUserQuestion') {
    const answers = await waitForUserAnswer(
      sessionId.toString(),
      options.toolUseID,
      input,
      options.signal
    );
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  if (toolName === 'ExitPlanMode') {
    const decision = await waitForExitPlanModeDecision(
      sessionId.toString(),
      options.toolUseID,
      input,
      options.signal
    );
    if (!decision.approved) {
      return { behavior: 'deny', message: decision.message };
    }

    await restorePermissionModeAfterPlan(fastify, userId, sessionId);
    return { behavior: 'allow', updatedInput: input };
  }

  return { behavior: 'allow', updatedInput: input };
}

function validateGitBranchName(branch: string): void {
  const validBranchPattern = /^[a-zA-Z0-9]([a-zA-Z0-9._/-]*[a-zA-Z0-9])?$/;
  const invalidPatterns = [/\.\./, /\/\//, /@\{/, /\\/, /\.lock$/];
  // eslint-disable-next-line no-control-regex
  const controlCharPattern = /[\x00-\x1f\x7f]/;

  if (!branch || branch.length > 255) {
    throw new Error('Invalid git branch name: must be 1-255 characters');
  }
  if (controlCharPattern.test(branch)) {
    throw new Error('Invalid git branch name: contains control characters');
  }
  if (/[~^:?*[\]]/.test(branch)) {
    throw new Error('Invalid git branch name: contains forbidden characters');
  }
  if (!validBranchPattern.test(branch)) {
    throw new Error('Invalid git branch name: contains invalid characters');
  }
  for (const pattern of invalidPatterns) {
    if (pattern.test(branch)) {
      throw new Error('Invalid git branch name: contains forbidden pattern');
    }
  }
}

function getGitBranchFromRevision(revision: string): string {
  const branch = parseGitBranchRevision(revision);
  if (!branch) {
    throw new Error('Git repository revision must start with refs/heads/');
  }
  validateGitBranchName(branch);
  return branch;
}

function validateGitRepositoryUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid git repository URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error('Only HTTPS GitHub repository URLs are supported');
  }
}

function validateSparseCheckoutPath(pathValue: string): void {
  if (
    !pathValue ||
    pathValue.startsWith('/') ||
    pathValue.includes('..') ||
    pathValue.includes('\\') ||
    pathValue.includes('\0')
  ) {
    throw new Error(`Invalid sparse checkout path: ${pathValue}`);
  }
}

function assertSessionValidation(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new SessionValidationError(message);
  }
}

function runGitSessionValidation(validate: () => void): void {
  try {
    validate();
  } catch (error) {
    throw new SessionValidationError(error instanceof Error ? error.message : 'Invalid git source');
  }
}

function validateGitSessionContext(sources: SessionSource[], outcomes: SessionOutcome[]): void {
  const gitSources = sources.filter((source): source is GitRepositorySource => {
    return source.type === 'git_repository';
  });
  const workspaceSources = sources.filter((source): source is DatabricksWorkspaceSource => {
    return source.type === 'databricks_workspace';
  });
  const gitOutcomes = outcomes.filter((outcome): outcome is GitRepositoryOutcome => {
    return outcome.type === 'git_repository';
  });

  if (gitSources.length === 0) {
    assertSessionValidation(
      gitOutcomes.length === 0,
      'Git repository outcome requires a git repository source'
    );
    return;
  }

  assertSessionValidation(gitSources.length === 1, 'Only one git repository source is supported');
  assertSessionValidation(
    workspaceSources.length === 0,
    'Git repository sources cannot be combined with Databricks Workspace sources'
  );
  assertSessionValidation(
    gitOutcomes.length === 1,
    'Git repository source requires exactly one git repository outcome'
  );

  const source = gitSources[0];
  const outcome = gitOutcomes[0];
  const gitInfo = outcome.git_info;

  assertSessionValidation(
    source.allow_unrestricted_git_push === true,
    'Read-only git repository sessions are not supported yet'
  );
  assertSessionValidation(
    Array.isArray(source.sparse_checkout_paths),
    'Git repository sparse checkout paths must be an array'
  );
  assertSessionValidation(
    gitInfo?.type === 'github',
    'Git repository outcome must describe a GitHub repository'
  );
  assertSessionValidation(
    Array.isArray(gitInfo.branches),
    'Git repository outcome branches must be an array'
  );
  assertSessionValidation(
    gitInfo.branches.length === 1,
    'Git repository outcome requires exactly one branch'
  );

  runGitSessionValidation(() => validateGitRepositoryUrl(source.url));
  runGitSessionValidation(() => {
    getGitBranchFromRevision(source.revision);
  });
  runGitSessionValidation(() => validateGitBranchName(gitInfo.branches[0]));
  for (const sparsePath of source.sparse_checkout_paths) {
    runGitSessionValidation(() => validateSparseCheckoutPath(sparsePath));
  }

  let sourceRepo: string;
  try {
    sourceRepo = toGitHubRepositoryFullName(source.url);
  } catch (error) {
    throw new SessionValidationError(
      error instanceof Error ? error.message : 'Invalid GitHub repository URL'
    );
  }
  assertSessionValidation(
    gitInfo.repo === sourceRepo,
    'Git repository source URL must match the git repository outcome'
  );
}

function uniqueTools(tools: readonly string[]): string[] {
  return [...new Set(tools)];
}

function getRequestedMcpToolPatterns(tools: readonly string[] | undefined): string[] {
  return (tools ?? []).filter(tool => tool.startsWith(MCP_TOOL_PATTERN_PREFIX));
}

function getSessionMcpToolPatterns(params: {
  userTools: readonly string[];
  requestedTools?: readonly string[];
}): string[] {
  const userMcpPatterns = new Set(getRequestedMcpToolPatterns(params.userTools));
  return getRequestedMcpToolPatterns(params.requestedTools).filter(
    tool => !userMcpPatterns.has(tool)
  );
}

function buildEffectiveToolSettings(params: {
  userAllowedTools: readonly string[];
  userDisallowedTools: readonly string[];
  requestedAllowedTools?: readonly string[];
  requestedDisallowedTools?: readonly string[];
}): EffectiveToolSettings {
  return {
    allowed_tools: uniqueTools([
      ...params.userAllowedTools,
      ...getRequestedMcpToolPatterns(params.requestedAllowedTools),
    ]),
    disallowed_tools: uniqueTools([
      ...params.userDisallowedTools,
      ...getRequestedMcpToolPatterns(params.requestedDisallowedTools),
    ]),
  };
}

function buildSessionToolSettings(params: {
  userAllowedTools: readonly string[];
  userDisallowedTools: readonly string[];
  requestedAllowedTools?: readonly string[];
  requestedDisallowedTools?: readonly string[];
}): EffectiveToolSettings {
  return {
    allowed_tools: uniqueTools(
      getSessionMcpToolPatterns({
        userTools: params.userAllowedTools,
        requestedTools: params.requestedAllowedTools,
      })
    ),
    disallowed_tools: uniqueTools(
      getSessionMcpToolPatterns({
        userTools: params.userDisallowedTools,
        requestedTools: params.requestedDisallowedTools,
      })
    ),
  };
}

function getInternalGitCredentialUrl(fastify: FastifyInstance): string {
  const port =
    fastify.config.NODE_ENV === 'development'
      ? fastify.config.PORT
      : fastify.config.DATABRICKS_APP_PORT;
  return `http://127.0.0.1:${port}/api/internal/git-credential`;
}

async function configureGitCredentialHelper(
  fastify: FastifyInstance,
  cwd: string,
  repositoryUrl: string
): Promise<() => void> {
  const registration = registerGitCredential(repositoryUrl, 'write');
  const helperPath = path.join(cwd, '.git', 'ccbricks-credential-helper.mjs');
  await writeFile(
    helperPath,
    buildGitCredentialHelperScript(getInternalGitCredentialUrl(fastify), registration.bearerToken),
    'utf-8'
  );
  await chmod(helperPath, 0o700);

  await spawnAsync('git', ['config', '--local', 'credential.helper', helperPath], {
    cwd,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  });
  await spawnAsync('git', ['config', '--local', 'credential.useHttpPath', 'true'], {
    cwd,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  });

  return () => {
    revokeGitCredential(registration.bearerToken);
  };
}

/**
 * DB から取得するセッションカラムの選択定義
 */
const SESSION_SELECT_COLUMNS = {
  id: sessions.id,
  title: sessions.title,
  status: sessions.status,
  context: sessions.context,
  createdAt: sessions.createdAt,
  updatedAt: sessions.updatedAt,
} as const;

/**
 * SDKMessage から PostgreSQL uuid 型に保存できる UUID を抽出する。
 * SQLite は任意文字列を受け入れるため、Lakebase 移行後にここが不正値検出ポイントになる。
 */
function extractEventUuid(message: SDKMessage | SDKUserMessage): string {
  const raw = 'uuid' in message ? message.uuid : undefined;
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : crypto.randomUUID();
}

function normalizeMessageUuid<T extends SDKMessage | SDKUserMessage>(
  fastify: FastifyInstance,
  sessionId: SessionId,
  message: T
): { eventUuid: string; message: T } {
  const raw = 'uuid' in message ? message.uuid : undefined;
  const eventUuid = extractEventUuid(message);
  if (typeof raw === 'string' && raw === eventUuid) {
    return { eventUuid, message };
  }

  if (typeof raw === 'string' && raw.length > 0) {
    fastify.log.warn(
      {
        sessionId: sessionId.toString(),
        originalUuid: raw,
        replacementUuid: eventUuid,
        messageType: message.type,
      },
      'Replacing non-PostgreSQL UUID event id before persistence'
    );
  }

  return {
    eventUuid,
    message: { ...message, uuid: eventUuid } as T,
  };
}

/**
 * イベントをバッチバッファに追加し、リアルタイム接続にブロードキャストする
 *
 * 1. バッチバッファに追加（非同期で DB 永続化）
 * 2. SSE / WebSocket にブロードキャスト
 *
 * @param sessionId - SessionId オブジェクト
 */
function saveAndBroadcastEvent(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  message: SDKMessage
): void {
  const normalized = normalizeMessageUuid(fastify, sessionId, message);
  const eventSubtype =
    'subtype' in normalized.message
      ? (normalized.message.subtype as string | undefined)
      : undefined;

  // 1. バッチバッファに追加（バッチサイズ到達 or インターバル経過で DB 永続化）
  enqueueSessionEvent(fastify, {
    userId,
    sessionId: sessionId.toUUID(),
    eventUuid: normalized.eventUuid,
    type: normalized.message.type,
    subtype: eventSubtype ?? null,
    message: normalized.message,
  });

  // 2. リアルタイム接続にブロードキャスト
  broadcastToSession(sessionId.toString(), normalized.message);
}

/**
 * SSE / WebSocket の両方にメッセージをブロードキャストする
 */
export function broadcastToSession(sessionId: string, message: WsServerMessage | SDKMessage): void {
  sessionStreamHub.send(sessionId, message);
  wsManager.broadcast(sessionId, message);
}

/**
 * すべてのイベントをバックグラウンドで処理する
 * - init イベント: status='running' に更新、sdkSessionId を設定、初回 user message を broadcast
 * - result イベント: sessions.status を 'idle' に更新
 * - すべてのイベント: WebSocket 送信 & バッチ経由で DB 保存
 *
 * @param response - SDK からのイベントストリーム
 * @param fastify - Fastify インスタンス
 * @param userId - ユーザーID
 * @param sessionId - セッションID
 * @param initialUserEvent - 初回ユーザーイベント（createSession 時のみ）
 */
async function processAllEvents(
  response: AsyncIterable<SDKMessage>,
  fastify: FastifyInstance,
  ctx: UserContext,
  sessionId: SessionId,
  initialUserEvent?: SessionCreateEventData,
  cleanupGitCredential?: () => void
): Promise<void> {
  const { userId } = ctx;
  let hasError = false;
  let pendingSdkSessionId: string | null = null;
  let eventCount = 0;

  try {
    for await (const message of response) {
      eventCount++;
      // バッチバッファに追加 & WebSocket 送信
      saveAndBroadcastEvent(fastify, userId, sessionId, message);

      // init イベント時に status='running' に更新、sdkSessionId を設定、初回 user message を broadcast
      if (message.type === 'system' && message.subtype === 'init') {
        const initMessage = message as SDKSystemMessage;
        pendingSdkSessionId = initMessage.session_id || null;

        // status='running' に更新 & sdkSessionId を設定
        try {
          await fastify.withUserContext(userId, async tx => {
            await tx
              .update(sessions)
              .set({
                status: 'running',
                sdkSessionId: pendingSdkSessionId,
              })
              .where(eq(sessions.id, sessionId.toUUID()));
          });
          pendingSdkSessionId = null; // 成功したのでフォールバック不要
        } catch (updateError) {
          fastify.log.error(
            { err: toLogError(updateError), sessionId: sessionId.toString(), userId },
            'Failed to update session status to running (continuing event processing)'
          );
        }

        // 初回 user message を SDKUserMessageReplay として broadcast & DB 保存
        if (initialUserEvent) {
          const userMessageReplay: SDKUserMessageReplay = {
            type: 'user',
            message: {
              role: 'user',
              content: initialUserEvent.message.content,
            },
            parent_tool_use_id: initialUserEvent.parent_tool_use_id,
            uuid: initialUserEvent.uuid as UUID,
            session_id: sessionId.toString(),
            isReplay: true,
          };
          saveAndBroadcastEvent(fastify, userId, sessionId, userMessageReplay);
        }
      }
    }
  } catch (error) {
    hasError = true;
    const stage = 'process_events';
    fastify.log.error(
      { err: toLogError(error), sessionId: sessionId.toString(), userId, eventCount },
      'Error processing session events'
    );

    await persistSessionFailureEvent(fastify, userId, sessionId, stage, error);
    await setSessionStatusError(fastify, userId, sessionId, stage);

    throw error;
  } finally {
    cleanupGitCredential?.();

    // 実行中 query ハンドルを削除
    activeSessionQueries.delete(sessionId.toString());

    // エラーでない場合は status を idle に更新
    // （result イベントの有無に関わらず、正常終了時に確実に idle にする）
    // 条件付き更新: status が init/running の場合のみ更新（競合状態を防ぐ）
    // - 新しいリクエストで既に running になっている場合は上書きしない
    // - error 状態は hasError フラグで保護済み
    if (!hasError) {
      try {
        const queuedResume = await completeRunAndClaimQueuedMessage(
          fastify,
          userId,
          sessionId,
          pendingSdkSessionId
        );
        if (queuedResume) {
          await startQueryPipeline({
            fastify,
            ctx,
            sessionId,
            prompt: queuedResume.userMessage,
            sessionContext: queuedResume.sessionContext,
            sdkSessionId: queuedResume.sdkSessionId,
            initialUserEvent: undefined,
          });
        }
      } catch (updateError) {
        fastify.log.error(
          { err: toLogError(updateError), sessionId: sessionId.toString(), userId },
          'Failed to complete session run in finally'
        );
      }
    }
  }
}

async function completeRunAndClaimQueuedMessage(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  pendingSdkSessionId: string | null
): Promise<QueuedUserMessageResume | null> {
  return fastify.withUserContext(userId, async tx => {
    const [sessionRow] = await tx
      .select({
        sdkSessionId: sessions.sdkSessionId,
        status: sessions.status,
        context: sessions.context,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId.toUUID()))
      .limit(1);

    if (!sessionRow || sessionRow.status === 'archived') {
      return null;
    }

    const effectiveSdkSessionId = pendingSdkSessionId ?? sessionRow.sdkSessionId;

    const [queuedEvent] = await tx
      .select({
        uuid: sessionEvents.uuid,
        message: sessionEvents.message,
      })
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId.toUUID()),
          eq(sessionEvents.type, 'user'),
          eq(sessionEvents.subtype, QUEUED_USER_EVENT_SUBTYPE)
        )
      )
      .orderBy(asc(sessionEvents.createdAt))
      .limit(1);

    if (queuedEvent && effectiveSdkSessionId) {
      await tx
        .update(sessionEvents)
        .set({ subtype: null })
        .where(eq(sessionEvents.uuid, queuedEvent.uuid));

      await tx
        .update(sessions)
        .set({
          status: 'running',
          sdkSessionId: effectiveSdkSessionId,
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, sessionId.toUUID()));

      return {
        userMessage: queuedEvent.message as SDKUserMessage,
        sessionContext: sessionRow.context as SessionContextResponse,
        sdkSessionId: effectiveSdkSessionId,
      };
    }

    await tx
      .update(sessions)
      .set({
        status: 'idle',
        ...(pendingSdkSessionId != null && { sdkSessionId: pendingSdkSessionId }),
      })
      .where(
        and(eq(sessions.id, sessionId.toUUID()), inArray(sessions.status, ['init', 'running']))
      );

    return null;
  });
}

async function getLatestSessionContext(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId
): Promise<SessionContextResponse> {
  const [sessionRow] = await fastify.withUserContext(userId, async tx =>
    tx
      .select({
        context: sessions.context,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId.toUUID()))
      .limit(1)
  );

  if (!sessionRow) {
    throw new Error('Session not found');
  }
  if (sessionRow.status === 'archived') {
    throw new Error('Session is archived');
  }
  if (!sessionRow.context) {
    throw new Error('Session context not found');
  }

  return sessionRow.context as SessionContextResponse;
}

async function updateSessionContext(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  patch: Partial<
    Pick<
      SessionContextResponse,
      'model' | 'permission_mode' | 'permission_mode_before_plan' | 'effort_level'
    >
  >
): Promise<SessionContextResponse> {
  return fastify.withUserContext(userId, async tx => {
    const [sessionRow] = await tx
      .select({
        context: sessions.context,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId.toUUID()))
      .limit(1);

    if (!sessionRow) {
      throw new Error('Session not found');
    }
    if (sessionRow.status === 'archived') {
      throw new Error('Session is archived');
    }
    if (!sessionRow.context) {
      throw new Error('Session context not found');
    }

    const nextContext: SessionContextResponse = {
      ...(sessionRow.context as SessionContextResponse),
      ...patch,
    };

    await tx
      .update(sessions)
      .set({ context: nextContext, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId.toUUID()));

    return nextContext;
  });
}

export async function validateSessionModelId(
  fastify: FastifyInstance,
  model: string,
  allowedModelIds?: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  const modelIds = allowedModelIds ?? new Set(await getAllowedModelIds(fastify));
  if (!modelIds.has(model)) {
    throw new UserSettingsValidationError('model must be an allowed model id');
  }
  return modelIds;
}

async function rollbackSessionContext(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  patch: Partial<
    Pick<SessionContextResponse, 'model' | 'permission_mode' | 'permission_mode_before_plan'>
  >
): Promise<void> {
  try {
    await updateSessionContext(fastify, userId, sessionId, patch);
  } catch (error) {
    fastify.log.error(
      { err: toLogError(error), sessionId: sessionId.toString(), userId },
      'Failed to roll back session context after SDK control failure'
    );
  }
}

async function restorePermissionModeAfterPlan(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId
): Promise<void> {
  const currentContext = await getLatestSessionContext(fastify, userId, sessionId);
  const activeQuery = activeSessionQueries.get(sessionId.toString());
  const mode =
    currentContext.permission_mode_before_plan ?? activeQuery?.permissionModeBeforePlan ?? 'auto';

  await updateSessionContext(fastify, userId, sessionId, {
    permission_mode: mode,
    permission_mode_before_plan: undefined,
  });

  if (activeQuery) {
    try {
      await activeQuery.query.setPermissionMode(mode);
      activeQuery.permissionModeBeforePlan = undefined;
    } catch (error) {
      await rollbackSessionContext(fastify, userId, sessionId, {
        permission_mode: currentContext.permission_mode,
        permission_mode_before_plan: currentContext.permission_mode_before_plan,
      });
      throw error;
    }
  }
}

/**
 * SDK query() 呼び出し〜バックグラウンドイベント処理のパイプラインパラメータ
 */
interface StartQueryPipelineParams {
  fastify: FastifyInstance;
  ctx: UserContext;
  sessionId: SessionId;
  /** テキストの場合は string、構造化コンテンツの場合は SDKUserMessage */
  prompt: string | SDKUserMessage;
  sessionContext: SessionContextResponse;
  /** resume 用の SDK session ID（新規セッションの場合は undefined） */
  sdkSessionId: string | undefined;
  /** init イベント後に broadcast する初回ユーザーイベント（createSession 時のみ） */
  initialUserEvent: SessionCreateEventData | undefined;
}

/**
 * SDK query() を呼び出し、バックグラウンドでイベント処理を開始する
 *
 * createSession と sendMessageToSession で共通のパイプライン。
 * sdkSessionId の有無で新規セッション / resume を切り替える。
 * エラー時は session status を 'error' に更新して throw する。
 */
async function startQueryPipeline(params: StartQueryPipelineParams): Promise<void> {
  const { fastify, ctx, sessionId, prompt: rawPrompt, sdkSessionId, initialUserEvent } = params;
  const { userId, userHome } = ctx;
  let cleanupGitCredential: (() => void) | undefined;

  try {
    const { sessionContext } = params;
    const prompt = singleMessageIterable(
      buildPromptMessage(sessionId, rawPrompt, initialUserEvent)
    );

    const systemPromptConfig = buildSystemPromptConfig(sessionContext.outcomes);
    const abortController = new AbortController();
    // MCP サーバーを構築（フロントエンドの mcp_config から、OBO トークンを注入）
    const mcpServers: Record<string, McpServerConfig> = {};
    const oboToken = ctx.oboAccessToken;
    if (sessionContext.mcp_config?.mcpServers) {
      for (const [serverId, serverConfig] of Object.entries(sessionContext.mcp_config.mcpServers)) {
        if (serverConfig.type === 'stdio') {
          // stdio: ローカルコマンド実行（OBO トークン不要）
          mcpServers[serverId] = {
            type: 'stdio',
            command: serverConfig.command!,
            args: serverConfig.args,
            env: serverConfig.env,
          };
        } else if (oboToken) {
          // http / sse: OBO トークンを注入
          mcpServers[serverId] = {
            type: serverConfig.type,
            url: serverConfig.url!,
            headers: {
              ...serverConfig.headers,
              Authorization: `Bearer ${oboToken}`,
            },
          };
        }
      }
    }
    const workspacePath = sessionContext.outcomes.find(
      (o): o is DatabricksWorkspaceSource => o.type === 'databricks_workspace'
    )?.path;
    const appsOutcomeName = sessionContext.outcomes.find(
      (o): o is ResolvedDatabricksAppsOutcome => o.type === 'databricks_apps'
    )?.name;
    const gitOutcome = sessionContext.outcomes.find(
      (o): o is GitRepositoryOutcome => o.type === 'git_repository'
    );
    const gitBranch = gitOutcome?.git_info.branches[0];
    const gitSource = sessionContext.sources.find(
      (source): source is GitRepositorySource => source.type === 'git_repository'
    );

    const [appSettings, userModelSettings] = await Promise.all([
      getAppSettings(fastify),
      getUserSettings(fastify, userId),
    ]);
    const modelSettings = {
      opusModel: userModelSettings.opus_model_id,
      sonnetModel: userModelSettings.sonnet_model_id,
      haikuModel: userModelSettings.haiku_model_id,
    };
    const claudeTelemetryEnv = buildClaudeTelemetryEnv({
      appSettings,
      databricksHost: fastify.config.DATABRICKS_HOST,
      databricksClientId: fastify.config.DATABRICKS_CLIENT_ID,
      databricksClientSecret: fastify.config.DATABRICKS_CLIENT_SECRET,
      databricksWorkspaceId: fastify.config.DATABRICKS_WORKSPACE_ID,
      databricksAppName: fastify.config.DATABRICKS_APP_NAME,
      nodeEnv: fastify.config.NODE_ENV,
    });
    const effectiveToolSettings = buildEffectiveToolSettings({
      userAllowedTools: userModelSettings.allowed_tools,
      userDisallowedTools: userModelSettings.disallowed_tools,
      requestedAllowedTools: sessionContext.allowed_tools,
      requestedDisallowedTools: sessionContext.disallowed_tools,
    });

    // Databricks CLI / helper が SP 権限で動作するように設定ファイルを配置
    const claudeNativePackage = getClaudeNativePackageName();
    const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable(claudeNativePackage);
    const databricksConfigFile = await writeDatabricksConfig(userHome, {
      host: fastify.config.DATABRICKS_HOST,
      clientId: fastify.config.DATABRICKS_CLIENT_ID,
      clientSecret: fastify.config.DATABRICKS_CLIENT_SECRET,
    });
    // ヘルパースクリプトを配置（apiKeyHelper / otelHeadersHelper）
    const helperPaths = await writeHelperScripts(userHome);
    if (gitSource) {
      cleanupGitCredential = await configureGitCredentialHelper(
        fastify,
        sessionContext.cwd,
        gitSource.url
      );
    }

    fastify.log.info(
      {
        sessionId: sessionId.toString(),
        userId,
        cwd: sessionContext.cwd,
        model: sessionContext.model,
        resume: Boolean(sdkSessionId),
        hasOboToken: Boolean(oboToken),
        isSqlite: fastify.isSqlite,
        hasLakebaseEndpoint: fastify.config.LAKEBASE_ENDPOINT.trim() !== '',
        claudeNativePackage,
        pathToClaudeCodeExecutable,
        mcpServerCount: Object.keys(mcpServers).length,
        allowedToolCount: effectiveToolSettings.allowed_tools.length,
        disallowedToolCount: effectiveToolSettings.disallowed_tools.length,
      },
      'Starting Claude Agent SDK query'
    );

    const response = query({
      prompt,
      options: {
        abortController,
        ...(sdkSessionId ? { resume: sdkSessionId } : {}),
        cwd: sessionContext.cwd,
        pathToClaudeCodeExecutable,
        model: sessionContext.model,
        maxTurns: 100,
        thinking: { type: 'adaptive' },
        settings: {
          apiKeyHelper: helperPaths.apiKeyHelper,
          otelHeadersHelper: helperPaths.otelHeadersHelper,
        },
        settingSources: ['user', 'project', 'local'],
        permissionMode: sessionContext.permission_mode ?? 'auto',
        ...(sessionContext.effort_level ? { effort: sessionContext.effort_level } : {}),
        canUseTool: (toolName, input, options) =>
          handleCanUseTool({ fastify, userId, sessionId, toolName, input, options }),
        systemPrompt: systemPromptConfig,
        mcpServers,
        tools: {
          type: 'preset',
          preset: 'claude_code',
        },
        allowedTools: effectiveToolSettings.allowed_tools,
        disallowedTools: effectiveToolSettings.disallowed_tools,
        env: {
          PATH: fastify.config.PATH,
          HOME: userHome,
          CLAUDE_CONFIG_DIR: path.join(userHome, '.claude'),
          ...buildGitIdentityEnv(ctx),
          ...(sdkSessionId ? { CLAUDE_CODE_SESSION_ID: sdkSessionId } : {}),
          SESSION_ID: sessionId.toString(),
          ...(workspacePath ? { SESSION_WORKSPACE_PATH: workspacePath } : {}),
          ...(appsOutcomeName ? { SESSION_APP_NAME: appsOutcomeName } : {}),
          ...(gitOutcome ? { SESSION_GIT_REPO: gitOutcome.git_info.repo } : {}),
          ...(gitBranch ? { SESSION_GIT_BRANCH: gitBranch } : {}),
          ANTHROPIC_BASE_URL: fastify.config.ANTHROPIC_BASE_URL,
          ANTHROPIC_DEFAULT_OPUS_MODEL: modelSettings.opusModel,
          ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES:
            'thinking,adaptive_thinking,effort,interleaved_thinking,max_effort',
          ANTHROPIC_DEFAULT_SONNET_MODEL: modelSettings.sonnetModel,
          ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:
            'thinking,adaptive_thinking,effort,interleaved_thinking',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: modelSettings.haikuModel,
          ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES:
            'thinking,adaptive_thinking,effort,interleaved_thinking',
          ANTHROPIC_CUSTOM_HEADERS: 'x-databricks-use-coding-agent-mode: true',
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
          // Databricks CLI は ~/.databrickscfg の SP 認証、workspace-push は OBO token を使用
          DATABRICKS_HOST: `https://${fastify.config.DATABRICKS_HOST}`,
          DATABRICKS_CONFIG_FILE: databricksConfigFile,
          DATABRICKS_CONFIG_PROFILE,
          DATABRICKS_TOKEN: oboToken ?? '',
          ...claudeTelemetryEnv,
        },
      },
    });

    fastify.log.info(
      { sessionId: sessionId.toString(), userId },
      'Claude Agent SDK query iterable created'
    );

    activeSessionQueries.set(sessionId.toString(), {
      abortController,
      query: response,
      permissionModeBeforePlan:
        sessionContext.permission_mode === 'plan'
          ? (sessionContext.permission_mode_before_plan ?? 'auto')
          : undefined,
    });

    // バックグラウンド処理開始（await しない）
    processAllEvents(
      response,
      fastify,
      ctx,
      sessionId,
      initialUserEvent,
      cleanupGitCredential
    ).catch(error => {
      fastify.log.error(
        { err: toLogError(error), sessionId: sessionId.toString(), userId },
        'Background event processing failed'
      );
    });
  } catch (error) {
    const stage = 'start_query_pipeline';
    cleanupGitCredential?.();
    fastify.log.error(
      { err: toLogError(error), sessionId: sessionId.toString(), userId },
      'SDK query failed before event processing started'
    );
    await persistSessionFailureEvent(fastify, userId, sessionId, stage, error);
    await setSessionStatusError(fastify, userId, sessionId, stage);
    throw error;
  }
}

/**
 * Databricks Apps outcome のアプリ名を解決する
 *
 * フロントエンドから提供された名前を使用し、重複がある場合はフォールバック名を生成する。
 * フォールバック名は session UUID から typeid を生成して決定的に作成する。
 */
async function resolveAppsOutcomeName(
  outcome: DatabricksAppsOutcome,
  sessionId: SessionId,
  fastify: FastifyInstance
): Promise<ResolvedDatabricksAppsOutcome> {
  const frontendName = outcome.name?.trim();

  if (frontendName) {
    try {
      const authProvider = getAuthProvider(fastify);
      const appsClient = new DatabricksAppsClient(authProvider);
      const existingApp = await appsClient.get(frontendName);

      if (!existingApp) {
        return { ...outcome, name: frontendName };
      }

      fastify.log.info(
        { appName: frontendName, sessionId: sessionId.toString() },
        'App name already exists, generating fallback name'
      );
    } catch (error) {
      fastify.log.warn(
        { err: toLogError(error), appName: frontendName, sessionId: sessionId.toString() },
        'Failed to check app name availability, using fallback name'
      );
    }
  }

  const fallbackName = fromUUID(sessionId.toUUID(), 'app').toString().replaceAll('_', '-');
  return { ...outcome, name: fallbackName };
}

async function cloneGitRepositorySource(
  source: GitRepositorySource,
  outcome: GitRepositoryOutcome,
  cwd: string,
  fastify?: FastifyInstance
): Promise<void> {
  validateGitRepositoryUrl(source.url);
  const sourceBranch = getGitBranchFromRevision(source.revision);
  const targetBranch = outcome.git_info.branches[0];
  validateGitBranchName(targetBranch);

  for (const sparsePath of source.sparse_checkout_paths) {
    validateSparseCheckoutPath(sparsePath);
  }

  const gitAuth = fastify
    ? await createGitHubGitAuthEnvironment(fastify, source.url, 'read')
    : null;
  try {
    await spawnAsync(
      'git',
      [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        '--depth',
        '1',
        '--branch',
        sourceBranch,
        source.url,
        cwd,
      ],
      { timeout: GIT_COMMAND_TIMEOUT_MS, env: gitAuth?.env }
    );
  } finally {
    await gitAuth?.cleanup();
  }

  if (source.sparse_checkout_paths.length > 0) {
    await spawnAsync('git', ['sparse-checkout', 'init', '--cone'], {
      cwd,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
    await spawnAsync('git', ['sparse-checkout', 'set', ...source.sparse_checkout_paths], {
      cwd,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
  }

  await spawnAsync('git', ['checkout'], { cwd, timeout: GIT_COMMAND_TIMEOUT_MS });
  await spawnAsync('git', ['checkout', '-B', targetBranch], {
    cwd,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  });
}

/**
 * 新規セッションを作成する
 *
 * 処理フロー:
 * 1. UUIDv7 で session_id 生成
 * 2. sessions INSERT (status='init')
 * 3. claude-agent-sdk で query() 実行
 * 4. 即座にレスポンスを返し、すべてのイベントはバックグラウンドで処理
 *    - init イベント時に status='running' に更新、sdkSessionId を設定、初回 user message を broadcast
 *    - result イベント時に sessions.status を 'idle' に更新
 * 5. query() 失敗時は sessions.status を 'error' に更新
 *
 * @param fastify - Fastify インスタンス
 * @param userId - ユーザーID
 * @param request - セッション作成リクエスト
 * @param ctx - ユーザーコンテキスト
 * @returns セッション作成レスポンス
 */
export async function createSession(
  fastify: FastifyInstance,
  userId: string,
  request: SessionCreateRequest,
  ctx: UserContext
): Promise<SessionCreateResponse> {
  const { events, session_context, title } = request;
  if (!session_context) {
    throw new SessionValidationError('session_context is required');
  }
  if (!Array.isArray(session_context.sources)) {
    throw new SessionValidationError('session_context.sources must be an array');
  }
  if (!Array.isArray(session_context.outcomes)) {
    throw new SessionValidationError('session_context.outcomes must be an array');
  }
  if (typeof session_context.model !== 'string' || session_context.model.trim().length === 0) {
    throw new SessionValidationError('session_context.model must be a non-empty string');
  }
  if (
    session_context.permission_mode !== undefined &&
    !isValidPermissionMode(session_context.permission_mode)
  ) {
    throw new SessionValidationError('session_context.permission_mode is invalid');
  }
  const permissionModeBeforePlan = session_context.permission_mode_before_plan as unknown;
  if (
    permissionModeBeforePlan !== undefined &&
    (!isValidPermissionMode(permissionModeBeforePlan) || permissionModeBeforePlan === 'plan')
  ) {
    throw new SessionValidationError('session_context.permission_mode_before_plan is invalid');
  }
  if (
    session_context.effort_level !== undefined &&
    session_context.effort_level !== null &&
    !isValidEffortLevel(session_context.effort_level)
  ) {
    throw new SessionValidationError('session_context.effort_level is invalid');
  }

  // 1. SessionId を生成（UUIDv7）
  const sessionId = new SessionId();

  // 2. ユーザーメッセージのテキストを抽出
  const userEvent = events[0];
  const userContent = userEvent?.data.message.content ?? '';

  // 3. cwd の生成（CCBRICKS_BASE_DIR/sessions/sessionId）
  /** Claude Code Working Directory  (e.g. /home/app/sessions/session_xxx) */
  const cwd = path.join(fastify.config.CCBRICKS_BASE_DIR, 'sessions', sessionId.toString());

  validateGitSessionContext(session_context.sources, session_context.outcomes);

  await ensureDirectory(cwd);
  const [userSettings, allowedModelIds] = await Promise.all([
    getUserSettings(fastify, userId),
    getAllowedModelIds(fastify),
  ]);
  let resolvedModelId: string;
  try {
    resolvedModelId = resolveSessionModelIdFromSettings(
      userSettings,
      new Set(allowedModelIds),
      session_context.model
    );
  } catch (error) {
    if (error instanceof UserSettingsValidationError) {
      throw new SessionValidationError(error.message);
    }
    throw error;
  }

  // 4. Workspace ソースのバリデーション
  const workspaceSources = session_context.sources
    .filter((s): s is DatabricksWorkspaceSource => s.type === 'databricks_workspace')
    .filter(source => {
      if (!source.path || !source.path.startsWith('/') || source.path.includes('..')) {
        fastify.log.warn(
          { sessionId: sessionId.toString(), path: source.path },
          'Invalid workspace source path, skipping'
        );
        return false;
      }
      return true;
    });
  const gitSources = session_context.sources.filter(
    (s): s is GitRepositorySource => s.type === 'git_repository'
  );

  // 5. Apps outcome にアプリ名を割当
  const resolvedOutcomes = await Promise.all(
    session_context.outcomes.map(async outcome => {
      if (outcome.type === 'databricks_apps') {
        return resolveAppsOutcomeName(outcome, sessionId, fastify);
      }
      return outcome;
    })
  );

  // 6. context オブジェクトの構築
  const sessionToolSettings = buildSessionToolSettings({
    userAllowedTools: userSettings.allowed_tools,
    userDisallowedTools: userSettings.disallowed_tools,
    requestedAllowedTools: session_context.allowed_tools,
    requestedDisallowedTools: session_context.disallowed_tools,
  });
  const permissionMode = session_context.permission_mode ?? 'auto';
  const sessionContext: SessionContextResponse = {
    allowed_tools: sessionToolSettings.allowed_tools,
    disallowed_tools: sessionToolSettings.disallowed_tools,
    cwd,
    model: resolvedModelId,
    permission_mode: permissionMode,
    permission_mode_before_plan:
      permissionMode === 'plan'
        ? (session_context.permission_mode_before_plan ?? 'auto')
        : undefined,
    effort_level: session_context.effort_level ?? null,
    sources: session_context.sources,
    outcomes: resolvedOutcomes,
    mcp_config: session_context.mcp_config,
  };
  const gitOutcome = sessionContext.outcomes.find(
    (o): o is GitRepositoryOutcome => o.type === 'git_repository'
  );

  // 7. タイムスタンプを設定（レスポンス用）
  const now = new Date();

  // 8. sessions を INSERT (status='init')
  await fastify.withUserContext(userId, async tx => {
    await tx.insert(sessions).values({
      id: sessionId.toUUID(),
      userId,
      title: title ?? null,
      status: 'init',
      sdkSessionId: null,
      context: sessionContext,
    });
  });
  fastify.log.info(
    {
      sessionId: sessionId.toString(),
      userId,
      cwd,
      isSqlite: fastify.isSqlite,
      hasLakebaseEndpoint: fastify.config.LAKEBASE_ENDPOINT.trim() !== '',
      sourceCount: sessionContext.sources.length,
      outcomeCount: sessionContext.outcomes.length,
      hasOboToken: Boolean(ctx.oboAccessToken),
    },
    'Session row created; background setup will start'
  );

  // 9. prompt の構築
  const prompt: string | SDKUserMessage =
    Array.isArray(userContent) && userEvent
      ? {
          type: 'user',
          message: { role: 'user', content: userContent },
          parent_tool_use_id: null,
          uuid: userEvent.data.uuid as UUID,
          session_id: sessionId.toString(),
        }
      : typeof userContent === 'string'
        ? userContent
        : '';

  // 10. バックグラウンドで workspace export → query pipeline を実行
  let setupStage = 'session_setup';
  let queryPipelineStarted = false;
  (async () => {
    fastify.log.info(
      {
        sessionId: sessionId.toString(),
        userId,
        workspaceSourceCount: workspaceSources.length,
        gitSourceCount: gitSources.length,
      },
      'Background session setup started'
    );

    // Workspace ソースからファイルをインポート（OBO トークンで REST API 直接呼び出し）
    setupStage = 'workspace_export';
    if (workspaceSources.length > 0) {
      const oboToken = ctx.oboAccessToken;
      if (oboToken) {
        const wsClient = new DatabricksWorkspaceClient(fastify.config.DATABRICKS_HOST, oboToken);
        for (const source of workspaceSources) {
          try {
            await wsClient.exportDir(source.path, cwd);
            fastify.log.info(
              { sessionId: sessionId.toString(), sourcePath: source.path },
              'Exported workspace directory to session cwd'
            );
          } catch (error) {
            fastify.log.error(
              {
                err: toLogError(error),
                sessionId: sessionId.toString(),
                userId,
                sourcePath: source.path,
              },
              'Failed to export workspace directory'
            );
          }
        }
      } else {
        fastify.log.warn(
          { sessionId: sessionId.toString() },
          'OBO token not available, skipping workspace export'
        );
      }
    }

    setupStage = 'git_clone';
    if (gitSources.length > 0) {
      if (!gitOutcome) {
        throw new Error('Git repository source requires a git_repository outcome');
      }

      for (const source of gitSources) {
        await cloneGitRepositorySource(source, gitOutcome, cwd, fastify);
        fastify.log.info(
          {
            sessionId: sessionId.toString(),
            repoUrl: source.url,
            branch: gitOutcome.git_info.branches[0],
          },
          'Cloned git repository source to session cwd'
        );
      }
    }

    // SDK query パイプラインを開始（export 完了後）
    setupStage = 'query_pipeline';
    queryPipelineStarted = true;
    await startQueryPipeline({
      fastify,
      ctx,
      sessionId,
      prompt,
      sessionContext,
      sdkSessionId: undefined,
      initialUserEvent: userEvent?.data,
    });
  })().catch(error => {
    fastify.log.error(
      {
        err: toLogError(error),
        sessionId: sessionId.toString(),
        userId,
        setupStage,
        queryPipelineStarted,
      },
      'Background session setup failed'
    );
    const stage = queryPipelineStarted ? 'query_pipeline' : setupStage;
    const persistFailure = queryPipelineStarted
      ? Promise.resolve()
      : persistSessionFailureEvent(fastify, userId, sessionId, stage, error);
    persistFailure
      .then(() => setSessionStatusError(fastify, userId, sessionId, stage))
      .catch(err => {
        fastify.log.error(
          { err: toLogError(err), sessionId: sessionId.toString(), userId, stage },
          'Failed to record background setup failure'
        );
      });
  });

  // 11. 即座にレスポンス返却
  return {
    id: sessionId.toString(),
    session_status: 'init',
    title: title ?? null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    session_context: sessionContext,
  };
}

/**
 * ユーザーのセッション一覧を取得する
 *
 * @param fastify - Fastify インスタンス
 * @param userId - ユーザーID
 * @param options - クエリオプション（limit, status）
 * @returns セッション一覧レスポンス
 */
export async function listSessions(
  fastify: FastifyInstance,
  userId: string,
  options: SessionListQuery = {}
): Promise<SessionListResponse> {
  const { limit = 20, status, after } = options;

  // limit のバリデーション（1-100）
  const safeLimit = Math.min(Math.max(1, limit), 100);

  return fastify.withUserContext(userId, async tx => {
    const conditions = [];
    if (status) {
      conditions.push(eq(sessions.status, status));
    }
    if (after) {
      const [cursorSession] = await tx
        .select({ updatedAt: sessions.updatedAt })
        .from(sessions)
        .where(eq(sessions.id, after))
        .limit(1);
      if (cursorSession) {
        conditions.push(lt(sessions.updatedAt, cursorSession.updatedAt));
      }
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // limit + 1 で取得して has_more を判定
    const rows = await tx
      .select(SESSION_SELECT_COLUMNS)
      .from(sessions)
      .where(whereClause)
      .orderBy(desc(sessions.updatedAt))
      .limit(safeLimit + 1);

    // has_more 判定
    const hasMore = rows.length > safeLimit;
    const resultRows = hasMore ? rows.slice(0, safeLimit) : rows;

    // SessionResponse 形式に変換
    const data: SessionResponse[] = resultRows.map(toSessionResponse);

    return {
      data,
      first_id: data.length > 0 ? data[0].id : '',
      last_id: data.length > 0 ? data[data.length - 1].id : '',
      has_more: hasMore,
    };
  });
}

/**
 * DB行をSessionResponseに変換するヘルパー
 */
function toSessionResponse(row: {
  id: string;
  title: string | null;
  status: string;
  context: unknown;
  createdAt: Date;
  updatedAt: Date;
}): SessionResponse {
  return {
    id: row.id,
    title: row.title,
    session_status: row.status as SessionStatus,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    session_context: (row.context as SessionContextResponse) ?? null,
  };
}

/**
 * 指定されたセッションを取得する
 *
 * @param fastify - Fastify インスタンス
 * @param userId - ユーザーID
 * @param sessionId - SessionId オブジェクト
 * @returns セッション情報（見つからない場合は null）
 */
export async function getSession(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId
): Promise<SessionResponse | null> {
  return fastify.withUserContext(userId, async tx => {
    const rows = await tx
      .select(SESSION_SELECT_COLUMNS)
      .from(sessions)
      .where(eq(sessions.id, sessionId.toUUID()))
      .limit(1);

    if (rows.length === 0) return null;

    return toSessionResponse(rows[0]);
  });
}

/**
 * セッションを更新する（タイトルのみ）
 * ステータス変更は archiveSession() を使用してください
 *
 * @param fastify - Fastify インスタンス
 * @param userId - ユーザーID
 * @param sessionId - SessionId オブジェクト
 * @param request - 更新リクエスト
 * @returns 更新後のセッション情報（見つからない場合は null）
 */
export async function updateSession(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  request: SessionUpdateRequest
): Promise<SessionResponse | null> {
  const { title } = request;

  return fastify.withUserContext(userId, async tx => {
    // 更新を実行（RETURNING で更新後の値を取得）
    const updateFields: { title?: string | null; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (title !== undefined) {
      updateFields.title = title;
    }

    const rows = await tx
      .update(sessions)
      .set(updateFields)
      .where(eq(sessions.id, sessionId.toUUID()))
      .returning(SESSION_SELECT_COLUMNS);

    if (rows.length === 0) return null;

    return toSessionResponse(rows[0]);
  });
}

/**
 * 既存セッションにメッセージを送信する
 *
 * 処理フロー:
 * 1. セッション取得（sdkSessionId, status, context を取得）
 * 2. archived → エラー throw
 * 3. init/running 中 → user message を queued event として保存
 * 4. idle/error → 即時処理を開始
 *    - user message を session_events に INSERT
 *    - sessions.status を 'running' に UPDATE
 *    - query({ resume: sdkSessionId, prompt }) で SDK 呼び出し
 *    - バックグラウンドでイベント処理
 *
 * @param fastify - Fastify インスタンス
 * @param userId - ユーザーID
 * @param sessionId - SessionId オブジェクト
 * @param userMessage - ユーザーメッセージ（SDKUserMessage）
 * @param ctx - ユーザーコンテキスト
 */
export async function sendMessageToSession(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  userMessage: SDKUserMessage,
  ctx: UserContext
): Promise<void> {
  // 1. セッション情報を取得
  const sessionRow = await fastify.withUserContext(userId, async tx => {
    const rows = await tx
      .select({
        sdkSessionId: sessions.sdkSessionId,
        status: sessions.status,
        context: sessions.context,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId.toUUID()))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!sessionRow) {
    throw new Error('Session not found');
  }

  // 2. archived の場合はエラー
  if (sessionRow.status === 'archived') {
    throw new Error('Session is archived');
  }

  // 3. sdkSessionId が null かつ実行中でない場合はエラー
  if (!sessionRow.sdkSessionId && !['init', 'running'].includes(sessionRow.status)) {
    throw new Error('Session is not ready (still initializing)');
  }

  const sessionContext = sessionRow.context as SessionContextResponse;

  // 4. 実行中は user message を queued event として保存するだけにする。
  // 現在の SDK stream 完了後に processAllEvents() の finally で最古の queued event を resume する。
  if (sessionRow.status === 'init' || sessionRow.status === 'running') {
    const normalized = normalizeMessageUuid(fastify, sessionId, userMessage);
    await fastify.withUserContext(userId, async tx => {
      await insertSessionEventInTx(tx, {
        uuid: normalized.eventUuid,
        sessionId: sessionId.toUUID(),
        type: 'user',
        subtype: QUEUED_USER_EVENT_SUBTYPE,
        message: normalized.message,
      });

      await tx
        .update(sessions)
        .set({ updatedAt: new Date() })
        .where(eq(sessions.id, sessionId.toUUID()));
    });

    broadcastToSession(sessionId.toString(), normalized.message);
    return;
  }

  // 5. user message を DB に保存し、status を running に更新
  const normalized = normalizeMessageUuid(fastify, sessionId, userMessage);
  await fastify.withUserContext(userId, async tx => {
    // user message を session_events に INSERT
    await insertSessionEventInTx(tx, {
      uuid: normalized.eventUuid,
      sessionId: sessionId.toUUID(),
      type: 'user',
      subtype: null,
      message: normalized.message,
    });

    // sessions.status を running に UPDATE
    await tx
      .update(sessions)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(sessions.id, sessionId.toUUID()));
  });

  // リアルタイム接続にユーザーメッセージをブロードキャスト
  broadcastToSession(sessionId.toString(), normalized.message);

  if (!sessionRow.sdkSessionId) {
    throw new Error('Session is not ready (still initializing)');
  }

  // 6. SDK query パイプラインを開始（resume）
  await startQueryPipeline({
    fastify,
    ctx,
    sessionId,
    prompt: normalized.message,
    sessionContext,
    sdkSessionId: sessionRow.sdkSessionId,
    initialUserEvent: undefined,
  });
}

function createAppCreateNotificationMessage(params: {
  sessionId: SessionId;
  appName: string;
  workspacePath: string;
}): SDKUserMessage {
  const appName = escapeXmlText(params.appName);
  const workspacePath = escapeXmlText(params.workspacePath);

  return {
    type: 'user',
    uuid: crypto.randomUUID() as UUID,
    session_id: params.sessionId.toString(),
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            'I created an app on Databricks Apps. Please deploy it once compute starts.',
            'Compute startup can take 2-3 minutes after creation.',
            '',
            `<app_name>${appName}</app_name>`,
            `<workspace_path>${workspacePath}</workspace_path>`,
          ].join('\n'),
        },
      ],
    },
  };
}

async function createOrReuseDatabricksApp(
  appsClient: DatabricksAppsClient,
  appName: string,
  appDescription: string
): Promise<void> {
  const existingApp = await appsClient.get(appName);
  if (existingApp) return;

  try {
    await appsClient.create(appName, {
      description: appDescription,
      noCompute: false,
    });
  } catch (error) {
    if (error instanceof DatabricksApiError && error.statusCode === 409) {
      const app = await appsClient.get(appName);
      if (app) return;
    }
    throw error;
  }
}

async function appendDatabricksAppsOutcome(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  context: SessionContextResponse,
  appName: string
): Promise<void> {
  const existingAppsOutcome = findDatabricksAppsOutcome(context);
  if (existingAppsOutcome) {
    if (existingAppsOutcome.name !== appName) {
      throw new SessionAppCreateError(
        400,
        `Session already has Databricks Apps outcome '${existingAppsOutcome.name}'`
      );
    }
    return;
  }

  const nextContext: SessionContextResponse = {
    ...context,
    outcomes: [...context.outcomes, { type: 'databricks_apps', name: appName }],
  };

  await fastify.withUserContext(userId, async tx => {
    await tx
      .update(sessions)
      .set({ context: nextContext, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId.toUUID()));
  });
}

export async function createDatabricksAppForSession(params: {
  fastify: FastifyInstance;
  userId: string;
  sessionId: SessionId;
  context: string;
  ctx: UserContext;
}): Promise<SessionAppCreateResponse> {
  const { fastify, userId, sessionId, ctx } = params;
  const createContext = params.context.trim();
  if (!createContext) {
    throw new SessionAppCreateError(400, 'context is required');
  }

  const oboToken = ctx.oboAccessToken;
  if (!oboToken) {
    throw new SessionAppCreateError(401, 'OBO access token is required to create an app');
  }

  const servicePrincipalName = fastify.config.DATABRICKS_CLIENT_ID.trim();
  if (!servicePrincipalName) {
    throw new SessionAppCreateError(500, 'DATABRICKS_CLIENT_ID is required');
  }

  const sessionRow = await fastify.withUserContext(userId, async tx => {
    const rows = await tx
      .select({
        status: sessions.status,
        context: sessions.context,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId.toUUID()))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!sessionRow) {
    throw new SessionAppCreateError(404, 'Session not found');
  }
  if (sessionRow.status === 'archived') {
    throw new SessionAppCreateError(400, 'Session is archived');
  }
  if (sessionRow.status === 'init' || sessionRow.status === 'running') {
    throw new SessionAppCreateError(409, 'Session is busy');
  }
  if (!sessionRow.context) {
    throw new SessionAppCreateError(400, 'Session context not found');
  }

  const sessionContext = sessionRow.context as SessionContextResponse;
  const existingAppsOutcome = findDatabricksAppsOutcome(sessionContext);
  if (existingAppsOutcome) {
    throw new SessionAppCreateError(
      400,
      `Session already has Databricks Apps outcome '${existingAppsOutcome.name}'`
    );
  }

  const workspaceOutcome = findDatabricksWorkspaceOutcome(sessionContext);
  if (!workspaceOutcome?.path) {
    throw new SessionAppCreateError(400, 'Databricks Workspace outcome is required');
  }
  const workspacePath = workspaceOutcome.path.trim();
  assertValidDatabricksWorkspacePath(workspacePath);

  const sessionsBaseDir = path.join(fastify.config.CCBRICKS_BASE_DIR, 'sessions');
  const cwd = await validatePathWithinBase(sessionContext.cwd, sessionsBaseDir);
  try {
    await access(path.join(cwd, 'app.yaml'));
  } catch {
    throw new SessionAppCreateError(400, 'app.yaml is required to create a Databricks App');
  }

  let metadataAccessToken: string;
  try {
    metadataAccessToken = await ctx.getAuthProvider().getToken();
  } catch {
    throw new SessionAppCreateError(401, 'Access token is required to generate app metadata');
  }

  const modelSettings = await getModelSettings(fastify);
  const appMetadata = await new AppNameService({
    databricksHost: fastify.config.DATABRICKS_HOST,
  }).generateAppMetadata({
    context: createContext,
    accessToken: metadataAccessToken,
    model: modelSettings.haikuModel,
  });
  const appName = appMetadata.name;
  const appDescription = appMetadata.description;
  if (!isValidDatabricksAppName(appName)) {
    throw new SessionAppCreateError(
      500,
      'Generated app name must contain only lowercase alphanumeric characters and hyphens'
    );
  }

  const workspaceClient = new DatabricksWorkspaceClient(fastify.config.DATABRICKS_HOST, oboToken);
  await workspaceClient.importDir(cwd, workspacePath);
  const workspaceStatus = await workspaceClient.getStatus(workspacePath);
  await workspaceClient.updateDirectoryPermissions(workspaceStatus.object_id, [
    {
      service_principal_name: servicePrincipalName,
      permission_level: 'CAN_READ',
    },
  ]);

  const appsClient = DatabricksAppsClient.fromToken(fastify.config.DATABRICKS_HOST, oboToken);
  await createOrReuseDatabricksApp(appsClient, appName, appDescription);
  await appsClient.updatePermissions(appName, [
    {
      service_principal_name: servicePrincipalName,
      permission_level: 'CAN_MANAGE',
    },
  ]);

  await appendDatabricksAppsOutcome(fastify, userId, sessionId, sessionContext, appName);

  let notificationStatus: SessionAppNotificationStatus = 'sent';
  try {
    const notifySession = await getSession(fastify, userId, sessionId);
    if (!notifySession?.session_context) {
      throw new Error('Session context not found after app creation');
    }
    await sendMessageToSession(
      fastify,
      userId,
      sessionId,
      createAppCreateNotificationMessage({
        sessionId,
        appName,
        workspacePath,
      }),
      ctx
    );
  } catch (error) {
    notificationStatus = 'failed';
    fastify.log.error(
      { err: toLogError(error), sessionId: sessionId.toString(), appName },
      'Failed to notify agent after Databricks App creation'
    );
  }

  const session = await getSession(fastify, userId, sessionId);
  if (!session) {
    throw new SessionAppCreateError(404, 'Session not found');
  }

  return {
    session,
    name: appName,
    description: appDescription,
    workspace_path: workspacePath,
    sp_permission_status: 'granted',
    notification_status: notificationStatus,
  };
}

/**
 * セッションをアーカイブする
 * ステータスを 'archived' に変更し、Working Directory を削除する
 *
 * @param fastify - Fastify インスタンス
 * @param userId - ユーザーID
 * @param sessionId - SessionId オブジェクト
 * @returns アーカイブ後のセッション情報（見つからない場合は null）
 */
export async function archiveSession(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId
): Promise<SessionResponse | null> {
  const sessionsBaseDir = path.join(fastify.config.CCBRICKS_BASE_DIR, 'sessions');

  return fastify.withUserContext(userId, async tx => {
    // 1. セッション情報を取得（cwd を取得するため）
    const sessionRows = await tx
      .select({ context: sessions.context })
      .from(sessions)
      .where(eq(sessions.id, sessionId.toUUID()))
      .limit(1);

    if (sessionRows.length === 0) return null;

    const context = sessionRows[0].context as SessionContextResponse | null;
    const cwd = context?.cwd;

    // 2. ステータスを archived に更新
    const rows = await tx
      .update(sessions)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(sessions.id, sessionId.toUUID()))
      .returning(SESSION_SELECT_COLUMNS);

    if (rows.length === 0) return null;

    // 3. Working Directory を削除（sessions ベースディレクトリ配下に制限、トランザクション外で非同期実行）
    if (cwd) {
      validatePathWithinBase(cwd, sessionsBaseDir)
        .then(safeCwd => removeDirectory(safeCwd))
        .catch(error => {
          fastify.log.error(
            { err: toLogError(error), sessionId: sessionId.toString(), cwd, sessionsBaseDir },
            'Failed to remove working directory'
          );
        });
    }

    // 4. Databricks App を削除（outcomes に databricks_apps がある場合、トランザクション外で非同期実行）
    const appsOutcome = context?.outcomes?.find(
      (o): o is ResolvedDatabricksAppsOutcome => o.type === 'databricks_apps'
    );
    if (appsOutcome) {
      const authProvider = getAuthProvider(fastify);
      const appsClient = new DatabricksAppsClient(authProvider);
      appsClient.delete(appsOutcome.name).catch(error => {
        fastify.log.error(
          { err: toLogError(error), sessionId: sessionId.toString(), appName: appsOutcome.name },
          'Failed to delete Databricks App'
        );
      });
    }

    return toSessionResponse(rows[0]);
  });
}

export async function setSessionPermissionMode(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  mode: WsPermissionMode
): Promise<void> {
  const currentContext = await getLatestSessionContext(fastify, userId, sessionId);
  const activeQuery = activeSessionQueries.get(sessionId.toString());
  const patch: Partial<
    Pick<SessionContextResponse, 'permission_mode' | 'permission_mode_before_plan'>
  > = { permission_mode: mode };

  if (mode === 'plan') {
    patch.permission_mode_before_plan =
      currentContext.permission_mode && currentContext.permission_mode !== 'plan'
        ? currentContext.permission_mode
        : (currentContext.permission_mode_before_plan ?? 'auto');
  } else {
    patch.permission_mode_before_plan = undefined;
  }

  await updateSessionContext(fastify, userId, sessionId, patch);
  if (activeQuery) {
    const previousActivePermissionModeBeforePlan = activeQuery.permissionModeBeforePlan;
    try {
      await activeQuery.query.setPermissionMode(mode);
      activeQuery.permissionModeBeforePlan =
        mode === 'plan' ? patch.permission_mode_before_plan : undefined;
    } catch (error) {
      activeQuery.permissionModeBeforePlan = previousActivePermissionModeBeforePlan;
      await rollbackSessionContext(fastify, userId, sessionId, {
        permission_mode: currentContext.permission_mode,
        permission_mode_before_plan: currentContext.permission_mode_before_plan,
      });
      throw error;
    }
  }
}

export async function setSessionModel(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  model: string,
  options: { allowedModelIds?: ReadonlySet<string> } = {}
): Promise<void> {
  await validateSessionModelId(fastify, model, options.allowedModelIds);
  await updateSessionContext(fastify, userId, sessionId, { model });
  const activeQuery = activeSessionQueries.get(sessionId.toString());
  if (activeQuery) {
    await activeQuery.query.setModel(model);
  }
}

export async function applySessionFlagSettings(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId,
  settings: { effortLevel?: WsEffortLevel | null }
): Promise<void> {
  if (Object.keys(settings).length === 0) {
    return;
  }

  if ('effortLevel' in settings) {
    await updateSessionContext(fastify, userId, sessionId, {
      effort_level: settings.effortLevel ?? null,
    });
  }

  const effortLevel = settings.effortLevel;
  const activeQuery = activeSessionQueries.get(sessionId.toString());
  if (activeQuery && isLiveApplyFlagEffortLevel(effortLevel)) {
    await activeQuery.query.applyFlagSettings({ effortLevel });
  }
}

/**
 * セッションが abort 可能かチェック
 *
 * @param sessionId - SessionId オブジェクト
 * @returns abort 可能な場合は true
 */
export function canAbortSession(sessionId: SessionId): boolean {
  return activeSessionQueries.has(sessionId.toString());
}

/**
 * Abort を実行（非同期）
 * user メッセージと result イベントを送信し、セッション状態を idle に更新する
 *
 * @param fastify - Fastify インスタンス
 * @param userId - ユーザーID
 * @param sessionId - SessionId オブジェクト
 */
export async function executeAbort(
  fastify: FastifyInstance,
  userId: string,
  sessionId: SessionId
): Promise<void> {
  const sessionIdStr = sessionId.toString();
  const activeQuery = activeSessionQueries.get(sessionIdStr);

  if (!activeQuery) return;

  // 1. abort を呼び出し（ハンドルの削除は processAllEvents の finally で行う）
  activeQuery.abortController.abort();

  // 2. user メッセージを送信（画面表示用）
  const userMessage = {
    type: 'user',
    uuid: crypto.randomUUID(),
    session_id: sessionIdStr,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'text', text: '[Request aborted by user]' }],
    },
  } as SDKUserMessage;
  saveAndBroadcastEvent(fastify, userId, sessionId, userMessage);

  // 3. result イベントを送信
  const resultMessage = {
    type: 'result',
    subtype: 'error_during_execution',
    uuid: crypto.randomUUID(),
    session_id: sessionIdStr,
    is_error: false,
  } as SDKResultMessage;
  saveAndBroadcastEvent(fastify, userId, sessionId, resultMessage);

  // status は processAllEvents の finally で idle に戻す。
}

export const __testing = {
  buildGitIdentityEnv,
  buildEffectiveToolSettings,
  buildSessionToolSettings,
  cloneGitRepositorySource,
  extractEventUuid,
  getGitBranchFromRevision,
  validateGitBranchName,
  validateGitSessionContext,
  validateGitRepositoryUrl,
  validateSparseCheckoutPath,
  handleCanUseTool,
  clearActiveSessionQueries: () => activeSessionQueries.clear(),
  registerActiveSessionQuery: (
    sessionId: SessionId,
    activeQuery: Partial<ActiveSessionQuery> & { query: Query }
  ) => {
    activeSessionQueries.set(sessionId.toString(), {
      abortController: activeQuery.abortController ?? new AbortController(),
      query: activeQuery.query,
      permissionModeBeforePlan: activeQuery.permissionModeBeforePlan,
    });
  },
};
