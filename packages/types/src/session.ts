// =====================================================
// Session Status Types
// =====================================================

export type SessionStatus = 'init' | 'running' | 'idle' | 'error' | 'archived';

// =====================================================
// Source/Outcome Types
// =====================================================

export interface DatabricksWorkspaceSource {
  type: 'databricks_workspace';
  path: string;
}

export interface GitRepositorySource {
  type: 'git_repository';
  url: string;
  /** Branch revision only. Supported format: refs/heads/<branch>. */
  revision: string;
  sparse_checkout_paths: string[];
  allow_unrestricted_git_push: boolean;
}

export const GIT_BRANCH_REVISION_PREFIX = 'refs/heads/';

export function parseGitBranchRevision(revision: string): string | null {
  if (!revision.startsWith(GIT_BRANCH_REVISION_PREFIX)) return null;
  const branch = revision.slice(GIT_BRANCH_REVISION_PREFIX.length);
  return branch || null;
}

export interface DatabricksAppsOutcome {
  type: 'databricks_apps';
  name?: string;
}

export interface GitRepositoryOutcome {
  type: 'git_repository';
  git_info: {
    type: 'github';
    /** Deprecated for multi-repository sessions. Prefer repository sources. */
    repo?: string;
    branches: string[];
  };
}

/** resolveAppsOutcomeName() 通過後の DatabricksAppsOutcome（name は必ず存在） */
export interface ResolvedDatabricksAppsOutcome {
  type: 'databricks_apps';
  name: string;
}

export type SessionSource = DatabricksWorkspaceSource | GitRepositorySource;
export type SessionOutcome =
  | DatabricksWorkspaceSource
  | DatabricksAppsOutcome
  | GitRepositoryOutcome;
export type ResolvedSessionOutcome =
  | DatabricksWorkspaceSource
  | ResolvedDatabricksAppsOutcome
  | GitRepositoryOutcome;

// =====================================================
// Session Context Types
// =====================================================

import type { McpConfig } from './mcp.js';
import type { WsControlRequest, WsEffortLevel, WsPermissionMode } from './websocket.js';

/**
 * セッション作成リクエスト用のコンテキスト
 */
export interface SessionCreateContext {
  model: string;
  permission_mode?: WsPermissionMode;
  permission_mode_before_plan?: Exclude<WsPermissionMode, 'plan'>;
  effort_level?: WsEffortLevel | null;
  sources: SessionSource[];
  outcomes: SessionOutcome[];
  allowed_tools?: string[];
  disallowed_tools?: string[];
  mcp_config?: McpConfig;
}

/**
 * セッションレスポンス用のコンテキスト（DBに保存される形式）
 */
export interface SessionContextResponse {
  allowed_tools?: string[];
  disallowed_tools?: string[];
  cwd: string;
  model: string;
  permission_mode?: WsPermissionMode;
  permission_mode_before_plan?: Exclude<WsPermissionMode, 'plan'>;
  effort_level?: WsEffortLevel | null;
  sources: SessionSource[];
  outcomes: ResolvedSessionOutcome[];
  mcp_config?: McpConfig;
}

// =====================================================
// Session Create Event Types
// =====================================================

import type { UserMessageContentBlock } from './message.js';

export interface SessionCreateEventData {
  uuid: string;
  session_id: string;
  type: 'user';
  parent_tool_use_id: string | null;
  message: {
    role: 'user';
    content: string | UserMessageContentBlock[];
  };
}

export interface SessionCreateEvent {
  type: 'event';
  data: SessionCreateEventData;
}

// =====================================================
// Session Create Request/Response Types
// =====================================================

export interface SessionCreateRequest {
  title?: string;
  events: SessionCreateEvent[];
  session_context: SessionCreateContext;
}

export interface SessionCreateResponse {
  id: string;
  session_status: SessionStatus;
  title: string | null;
  created_at: string;
  updated_at: string;
  session_context: SessionContextResponse;
}

// =====================================================
// Session Response Types
// =====================================================

export interface SessionResponse {
  id: string;
  title: string | null;
  session_status: SessionStatus;
  created_at: string;
  updated_at: string;
  session_context: SessionContextResponse | null;
}

export interface SessionListResponse {
  data: SessionResponse[];
  first_id: string;
  last_id: string;
  has_more: boolean;
}

/**
 * GET /api/sessions のクエリパラメータ
 */
export interface SessionListQuery {
  /** 取得件数上限（デフォルト: 20、最大: 100） */
  limit?: number;
  /** ステータスでフィルタリング */
  status?: SessionStatus;
  /** カーソル: この session ID の updated_at より古いセッションを取得 */
  after?: string;
}

// =====================================================
// Session Archive Types (POST /api/sessions/:id/archive)
// =====================================================

/**
 * POST /api/sessions/:session_id/archive のレスポンス
 */
export type SessionArchiveResponse = SessionResponse;

// =====================================================
// Session Update Types (PATCH /api/sessions/:session_id)
// =====================================================

/**
 * PATCH /api/sessions/:session_id のリクエストボディ
 * ステータス変更は POST /api/sessions/:session_id/archive を使用してください
 */
export interface SessionUpdateRequest {
  /** セッションタイトル */
  title?: string;
}

// =====================================================
// Session Events Types (GET /api/sessions/:id/events)
// =====================================================

import type {
  SDKMessage,
  SDKUserMessage,
  SDKAuthStatusMessage,
} from '@anthropic-ai/claude-agent-sdk';

// SDK Message 型を re-export
export type { SDKMessage, SDKUserMessage, SDKAuthStatusMessage };

/**
 * GET /api/sessions/:session_id/events のクエリパラメータ
 */
export interface SessionEventsQuery {
  /** 取得開始位置（この uuid より後のイベントを取得） */
  after?: string;
  /** 取得件数上限（デフォルト: 100） */
  limit?: number;
}

/**
 * GET /api/sessions/:session_id/events のレスポンス
 */
export interface SessionEventsResponse {
  data: SDKMessage[];
  first_id: string;
  last_id: string;
  has_more: boolean;
}

/**
 * POST /api/sessions/:session_id/events のリクエスト
 */
export interface SessionEventCreateRequest {
  events: Array<SDKUserMessage | WsControlRequest>;
}

/**
 * POST /api/sessions/:session_id/events のレスポンス
 */
export interface SessionEventPostResponse {
  events: Array<SDKUserMessage | WsControlRequest>;
  response: {
    subtype: 'success';
  };
}

// =====================================================
// Message Types
// =====================================================

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
}

// =====================================================
// Legacy Types (後方互換性のため残す)
// =====================================================

/**
 * @deprecated Use UserMessageContentBlock from message.ts instead
 */
export interface LegacyUserMessageContentBlock {
  type: 'text';
  text: string;
}

/**
 * @deprecated Use message types from message.ts instead
 */
export interface UserMessage {
  role: 'user';
  content: LegacyUserMessageContentBlock[];
}

/**
 * @deprecated Use SessionCreateEvent instead
 */
export interface SessionStartEvent {
  uuid: string;
  type: 'user';
  message: UserMessage;
}

/**
 * @deprecated Use SessionCreateContext instead
 */
export interface SessionContext {
  model: string;
  databricksWorkspacePath: string | null;
  databricksWorkspaceAutoPush: boolean;
}

/**
 * @deprecated Use SessionCreateRequest instead
 */
export interface SessionStartRequest {
  events: SessionStartEvent[];
  session_context: SessionContext;
}

/**
 * @deprecated Use SessionCreateResponse instead
 */
export interface SessionStartResponse {
  session_id: string;
  sdk_session_id: string | null;
  error?: unknown;
}

/**
 * @deprecated Use SessionCreateRequest instead
 */
export interface CreateSessionRequest {
  title?: string;
}

/**
 * @deprecated Use SessionCreateResponse instead
 */
export interface CreateSessionResponse {
  session: SessionResponse;
}
