import type { FastifyInstance } from 'fastify';
import { eq, desc, and, inArray, lt, asc } from 'drizzle-orm';
import { chmod, writeFile } from 'node:fs/promises';
import { spawnAsync } from '../utils/spawn.js';
import {
  query,
  type McpServerConfig,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
  type SDKUserMessageReplay,
} from '@anthropic-ai/claude-agent-sdk';
import type { UUID } from 'crypto';
import type {
  SessionCreateRequest,
  SessionCreateResponse,
  SessionContextResponse,
  SessionListQuery,
  SessionListResponse,
  SessionResponse,
  SessionStatus,
  SessionCreateEventData,
  SessionUpdateRequest,
  DatabricksWorkspaceSource,
  DatabricksAppsOutcome,
  GitRepositoryOutcome,
  GitRepositorySource,
  ResolvedDatabricksAppsOutcome,
  SessionOutcome,
  SessionSource,
  WsServerMessage,
} from '@repo/types';
import { buildSystemPromptConfig } from '../utils/system-prompt.helper.js';
import { sessionEvents, sessions } from '../db/schema.js';
import { insertSessionEventInTx } from '../db/helpers.js';
import { ensureDirectory, removeDirectory } from '../utils/directory.js';
import { validatePathWithinBase } from '../utils/path-validation.js';
import { fromUUID } from 'typeid-js';
import { DatabricksAppsClient } from '../lib/databricks-apps-client.js';
import { DatabricksWorkspaceClient } from '../lib/databricks-workspace-client.js';
import { getAuthProvider } from '../lib/databricks-auth.js';
import { getAppSettings, resolveModelSettings } from './admin.service.js';
import { writeHelperScripts } from './helper-scripts.service.js';
import { buildClaudeTelemetryEnv } from './claude-telemetry-env.service.js';
import { wsManager } from './websocket-manager.service.js';
import { sessionStreamHub } from './session-stream-hub.service.js';
import { enqueueSessionEvent } from './event-queue.service.js';
import { waitForUserAnswer } from './ask-user-question.service.js';
import { SessionId } from '../models/session.model.js';
import type { UserContext } from '../lib/user-context.js';
import path from 'node:path';
import {
  createGitHubGitAuthEnvironment,
  toGitHubRepositoryFullName,
} from './github-app-auth.service.js';
import {
  buildGitCredentialHelperScript,
  registerGitCredential,
  revokeGitCredential,
} from './git-credential.service.js';

/** セッションID → AbortController のマッピング（abort 用） */
const sessionAbortControllers = new Map<string, AbortController>();
const QUEUED_USER_EVENT_SUBTYPE = 'queued';
const GIT_COMMAND_TIMEOUT_MS = 60000;

export class SessionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionValidationError';
  }
}

interface QueuedUserMessageResume {
  userMessage: SDKUserMessage;
  sessionContext: SessionContextResponse;
  sdkSessionId: string;
}

/**
 * 単一の SDKUserMessage を AsyncIterable として返す
 * query() 関数に構造化コンテンツを渡すために使用
 */
async function* singleMessageIterable(msg: SDKUserMessage): AsyncIterable<SDKUserMessage> {
  yield msg;
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
  const prefix = 'refs/heads/';
  if (!revision.startsWith(prefix)) {
    throw new Error('Git repository revision must start with refs/heads/');
  }
  const branch = revision.slice(prefix.length);
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
 * SDKMessage から UUID を安全に抽出する。有効な文字列でない場合はランダム UUID を生成する。
 */
function extractEventUuid(message: SDKMessage): string {
  const raw = 'uuid' in message ? message.uuid : undefined;
  return typeof raw === 'string' && raw ? raw : crypto.randomUUID();
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
  const eventUuid = extractEventUuid(message);
  const eventSubtype = 'subtype' in message ? (message.subtype as string | undefined) : undefined;

  // 1. バッチバッファに追加（バッチサイズ到達 or インターバル経過で DB 永続化）
  enqueueSessionEvent(fastify, {
    userId,
    sessionId: sessionId.toUUID(),
    eventUuid,
    type: message.type,
    subtype: eventSubtype ?? null,
    message,
  });

  // 2. リアルタイム接続にブロードキャスト
  broadcastToSession(sessionId.toString(), message);
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

  try {
    for await (const message of response) {
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
            { sessionId: sessionId.toString(), updateError },
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
    fastify.log.error({ sessionId: sessionId.toString(), error }, 'Error processing events');

    // セッション状態を error に更新
    try {
      await fastify.withUserContext(userId, async tx => {
        await tx
          .update(sessions)
          .set({ status: 'error' })
          .where(eq(sessions.id, sessionId.toUUID()));
      });
    } catch (updateError) {
      fastify.log.error(
        { sessionId: sessionId.toString(), updateError },
        'Failed to update session status to error'
      );
    }

    throw error;
  } finally {
    cleanupGitCredential?.();

    // AbortController を削除
    sessionAbortControllers.delete(sessionId.toString());

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
          { sessionId: sessionId.toString(), updateError },
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
  const {
    fastify,
    ctx,
    sessionId,
    prompt: rawPrompt,
    sessionContext,
    sdkSessionId,
    initialUserEvent,
  } = params;
  const { userId, userHome } = ctx;
  let cleanupGitCredential: (() => void) | undefined;

  try {
    // Prompt: 構造化コンテンツは AsyncIterable にラップ、文字列はそのまま
    let prompt: string | AsyncIterable<SDKUserMessage>;
    if (typeof rawPrompt === 'string') {
      prompt = rawPrompt;
    } else if (Array.isArray(rawPrompt.message.content)) {
      prompt = singleMessageIterable(rawPrompt);
    } else {
      prompt = rawPrompt.message.content as string;
    }

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

    const appSettings = await getAppSettings(fastify);
    const modelSettings = resolveModelSettings(appSettings);
    const claudeTelemetryEnv = buildClaudeTelemetryEnv({
      appSettings,
      databricksHost: fastify.config.DATABRICKS_HOST,
      databricksClientId: fastify.config.DATABRICKS_CLIENT_ID,
      databricksClientSecret: fastify.config.DATABRICKS_CLIENT_SECRET,
      databricksWorkspaceId: fastify.config.DATABRICKS_WORKSPACE_ID,
      databricksAppName: fastify.config.DATABRICKS_APP_NAME,
      nodeEnv: fastify.config.NODE_ENV,
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

    const response = query({
      prompt,
      options: {
        abortController,
        ...(sdkSessionId ? { resume: sdkSessionId } : {}),
        cwd: sessionContext.cwd,
        model: sessionContext.model,
        maxTurns: 100,
        thinking: { type: 'adaptive' },
        settings: {
          apiKeyHelper: helperPaths.apiKeyHelper,
          otelHeadersHelper: helperPaths.otelHeadersHelper,
        },
        settingSources: ['user', 'project', 'local'],
        permissionMode: 'auto',
        canUseTool: async (toolName, input, options) => {
          if (toolName === 'AskUserQuestion') {
            const answers = await waitForUserAnswer(
              sessionId.toString(),
              options.toolUseID,
              input,
              options.signal
            );
            return { behavior: 'allow', updatedInput: { ...input, answers } };
          }
          return { behavior: 'allow' };
        },
        systemPrompt: systemPromptConfig,
        mcpServers,
        tools: {
          type: 'preset',
          preset: 'claude_code',
        },
        allowedTools: sessionContext.allowed_tools,
        // WebSearch は Anthropic API に依存しているため固定で無効化
        disallowedTools: ['WebSearch', ...(sessionContext.disallowed_tools ?? [])],
        env: {
          PATH: fastify.config.PATH,
          HOME: userHome,
          CLAUDE_CONFIG_DIR: path.join(userHome, '.claude'),
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
          // Databricks CLI と Claude Code モデル認証: OBO トークンを使用
          DATABRICKS_HOST: `https://${fastify.config.DATABRICKS_HOST}`,
          DATABRICKS_TOKEN: oboToken ?? '',
          // SP 認証情報: OTel ヘッダーヘルパーが OAuth トークン取得に使用
          DATABRICKS_CLIENT_ID: fastify.config.DATABRICKS_CLIENT_ID,
          DATABRICKS_CLIENT_SECRET: fastify.config.DATABRICKS_CLIENT_SECRET,
          ...claudeTelemetryEnv,
        },
      },
    });

    sessionAbortControllers.set(sessionId.toString(), abortController);

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
        { sessionId: sessionId.toString(), error },
        'Background event processing failed'
      );
    });
  } catch (error) {
    cleanupGitCredential?.();
    fastify.log.error({ sessionId: sessionId.toString(), error }, 'SDK query failed');
    await fastify.withUserContext(userId, async tx => {
      await tx.update(sessions).set({ status: 'error' }).where(eq(sessions.id, sessionId.toUUID()));
    });
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
        { appName: frontendName, sessionId: sessionId.toString(), error },
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

  // 5. outcomes の変数を解決（{session_id} → 実際のセッションID、apps にはアプリ名を割当）
  const resolvedOutcomes = await Promise.all(
    session_context.outcomes.map(async outcome => {
      if (outcome.type === 'databricks_workspace') {
        return {
          ...outcome,
          path: outcome.path.replace('{session_id}', sessionId.toString()),
        };
      }
      if (outcome.type === 'databricks_apps') {
        return resolveAppsOutcomeName(outcome, sessionId, fastify);
      }
      return outcome;
    })
  );

  // 6. context オブジェクトの構築
  const sessionContext: SessionContextResponse = {
    allowed_tools: session_context.allowed_tools,
    disallowed_tools: session_context.disallowed_tools,
    cwd,
    model: session_context.model,
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
  (async () => {
    // Workspace ソースからファイルをインポート（OBO トークンで REST API 直接呼び出し）
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
              { sessionId: sessionId.toString(), sourcePath: source.path, error },
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
      { sessionId: sessionId.toString(), error },
      'Background session setup failed'
    );
    fastify
      .withUserContext(userId, async tx => {
        await tx
          .update(sessions)
          .set({ status: 'error', updatedAt: new Date() })
          .where(eq(sessions.id, sessionId.toUUID()));
      })
      .catch(updateError => {
        fastify.log.error(
          { sessionId: sessionId.toString(), updateError },
          'Failed to update session status to error after setup failure'
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
    const eventUuid = extractEventUuid(userMessage);
    await fastify.withUserContext(userId, async tx => {
      await insertSessionEventInTx(tx, {
        uuid: eventUuid,
        sessionId: sessionId.toUUID(),
        type: 'user',
        subtype: QUEUED_USER_EVENT_SUBTYPE,
        message: userMessage,
      });

      await tx
        .update(sessions)
        .set({ updatedAt: new Date() })
        .where(eq(sessions.id, sessionId.toUUID()));
    });

    broadcastToSession(sessionId.toString(), userMessage);
    return;
  }

  // 5. user message を DB に保存し、status を running に更新
  const eventUuid = extractEventUuid(userMessage);
  await fastify.withUserContext(userId, async tx => {
    // user message を session_events に INSERT
    await insertSessionEventInTx(tx, {
      uuid: eventUuid,
      sessionId: sessionId.toUUID(),
      type: 'user',
      subtype: null,
      message: userMessage,
    });

    // sessions.status を running に UPDATE
    await tx
      .update(sessions)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(sessions.id, sessionId.toUUID()));
  });

  // リアルタイム接続にユーザーメッセージをブロードキャスト
  broadcastToSession(sessionId.toString(), userMessage);

  if (!sessionRow.sdkSessionId) {
    throw new Error('Session is not ready (still initializing)');
  }

  // 6. SDK query パイプラインを開始（resume）
  await startQueryPipeline({
    fastify,
    ctx,
    sessionId,
    prompt: userMessage,
    sessionContext,
    sdkSessionId: sessionRow.sdkSessionId,
    initialUserEvent: undefined,
  });
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
            { sessionId: sessionId.toString(), cwd, sessionsBaseDir, error },
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
          { sessionId: sessionId.toString(), appName: appsOutcome.name, error },
          'Failed to delete Databricks App'
        );
      });
    }

    return toSessionResponse(rows[0]);
  });
}

/**
 * セッションが abort 可能かチェック
 *
 * @param sessionId - SessionId オブジェクト
 * @returns abort 可能な場合は true
 */
export function canAbortSession(sessionId: SessionId): boolean {
  return sessionAbortControllers.has(sessionId.toString());
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
  const abortController = sessionAbortControllers.get(sessionIdStr);

  if (!abortController) return;

  // 1. abort を呼び出し（AbortController の削除は processAllEvents の finally で行う）
  abortController.abort();

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

  // 4. セッション状態を idle に更新
  await fastify.withUserContext(userId, async tx => {
    await tx.update(sessions).set({ status: 'idle' }).where(eq(sessions.id, sessionId.toUUID()));
  });
}

export const __testing = {
  cloneGitRepositorySource,
  getGitBranchFromRevision,
  validateGitBranchName,
  validateGitSessionContext,
  validateGitRepositoryUrl,
  validateSparseCheckoutPath,
};
