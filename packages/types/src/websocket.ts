/**
 * WebSocket 関連の型定義
 */

import type {
  SDKMessage,
  SDKUserMessage,
  SDKAuthStatusMessage,
  SessionResponse,
} from './session.js';

// SDKMessage, SDKUserMessage, SDKAuthStatusMessage を re-export（WebSocket でも使用）
export type { SDKMessage, SDKUserMessage, SDKAuthStatusMessage };

/**
 * WebSocket 接続時のサーバーからの初期メッセージ
 */
export interface WsConnectedMessage {
  type: 'connected';
  session_id: string;
  last_event_id: string | null;
}

/**
 * WebSocket エラーメッセージ
 */
export interface WsErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

/**
 * Abort リクエスト（クライアント -> サーバー）
 */
export interface WsAbortRequest {
  subtype: 'abort';
}

/**
 * AskUserQuestion 回答リクエスト（クライアント -> サーバー）
 */
export interface WsAskUserQuestionAnswerRequest {
  subtype: 'ask_user_question_answer';
  tool_use_id: string;
  /** UI から受け取る header → 選択された label (single) または label[] (multi) のマッピング。backend で SDK 用に変換する */
  answers: Record<string, string | string[]>;
}

/**
 * ExitPlanMode 承認/修正リクエスト（クライアント -> サーバー）
 */
export interface WsExitPlanModeResponseRequest {
  subtype: 'exit_plan_mode_response';
  tool_use_id: string;
  approved: boolean;
  /** approved=false の場合、Claude に返す修正指示 */
  message?: string;
}

export type WsPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

export type WsEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * 権限モード変更リクエスト（クライアント -> サーバー）
 */
export interface WsSetPermissionModeRequest {
  subtype: 'set_permission_mode';
  mode: WsPermissionMode;
}

/**
 * モデル変更リクエスト（クライアント -> サーバー）
 */
export interface WsSetModelRequest {
  subtype: 'set_model';
  model: string;
}

/**
 * Claude Code flag settings 更新リクエスト（クライアント -> サーバー）
 */
export interface WsApplyFlagSettingsRequest {
  subtype: 'apply_flag_settings';
  settings: {
    effortLevel?: WsEffortLevel | null;
  };
}

export type WsControlRequestPayload =
  | WsAbortRequest
  | WsAskUserQuestionAnswerRequest
  | WsExitPlanModeResponseRequest
  | WsSetPermissionModeRequest
  | WsSetModelRequest
  | WsApplyFlagSettingsRequest;

/**
 * Control リクエスト（クライアント -> サーバー）
 */
export interface WsControlRequest {
  type: 'control_request';
  request_id: string;
  request: WsControlRequestPayload;
}

/**
 * Control 成功レスポンス
 */
export interface WsControlSuccessResponse {
  subtype: 'success';
  request_id: string;
}

/**
 * Control エラーレスポンス
 */
export interface WsControlErrorResponse {
  subtype: 'error';
  request_id: string;
  error: string;
}

/**
 * Control レスポンス（サーバー -> クライアント）
 */
export interface WsControlResponse {
  type: 'control_response';
  response: WsControlSuccessResponse | WsControlErrorResponse;
}

/**
 * AskUserQuestion リクエスト（サーバー -> クライアント）
 * canUseTool コールバックで AskUserQuestion を検知した際に送信
 */
export interface WsAskUserQuestionRequest {
  type: 'ask_user_question';
  tool_use_id: string;
  input: Record<string, unknown>;
}

/**
 * ExitPlanMode リクエスト（サーバー -> クライアント）
 * canUseTool コールバックで ExitPlanMode を検知した際に送信
 */
export interface WsExitPlanModeRequest {
  type: 'exit_plan_mode';
  tool_use_id: string;
  input: Record<string, unknown>;
}

/**
 * セッションコンテキスト更新通知（サーバー -> クライアント）
 */
export interface WsSessionContextUpdatedMessage {
  type: 'session_context_updated';
  session_id: string;
  session: SessionResponse;
}

/**
 * WebSocket サーバー -> クライアントメッセージ
 */
export type WsServerMessage =
  | WsConnectedMessage
  | SDKMessage
  | SDKAuthStatusMessage
  | WsErrorMessage
  | WsControlResponse
  | WsAskUserQuestionRequest
  | WsExitPlanModeRequest
  | WsSessionContextUpdatedMessage;

/**
 * WebSocket KeepAlive メッセージ（クライアント -> サーバー）
 */
export interface WsKeepAliveMessage {
  type: 'keep_alive';
}

/**
 * WebSocket クライアント -> サーバーメッセージ
 */
export type WsClientMessage = WsKeepAliveMessage | SDKUserMessage | WsControlRequest;
