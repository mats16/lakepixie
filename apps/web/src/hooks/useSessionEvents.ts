import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  SDKMessage,
  SDKUserMessage,
  WsAskUserQuestionRequest,
  WsExitPlanModeRequest,
  WsExitPlanModeResponseRequest,
  WsConnectedMessage,
  WsSessionContextUpdatedMessage,
  WsEffortLevel,
  WsPermissionMode,
  UserMessageContentBlock,
  SessionStatus,
} from '@repo/types';
import {
  isSDKResultMessageEvent,
  isSDKSystemMessageEvent,
  isSDKUserMessageEvent,
  isToolResultContentBlock,
} from '@repo/types';
import { sessionService } from '@/services/session.service';
import { useSessionStream } from './useSessionStream';

interface UseSessionEventsOptions {
  sessionId: string | null;
  /** GET /api/sessions/:sessionId から取得した初期 sessionStatus */
  initialSessionStatus?: SessionStatus | null;
  /** 新規セッション作成時に navigate state から渡される初期メッセージ */
  initialMessage?: SDKUserMessage;
  /** AskUserQuestion リクエスト受信時のコールバック */
  onAskUserQuestion?: (request: WsAskUserQuestionRequest) => void;
  /** ExitPlanMode リクエスト受信時のコールバック */
  onExitPlanMode?: (request: WsExitPlanModeRequest) => void;
  /** Agent の tool_result / result 受信時に git diff を再取得するためのコールバック */
  onGitDiffRefreshNeeded?: () => void;
  /** Agent の result 受信時に GitHub 側の branch / pull request 状態を再取得するためのコールバック */
  onGitRepositoryStatusRefreshNeeded?: () => void;
  /** stream 接続・再接続時のコールバック */
  onConnected?: (message: WsConnectedMessage) => void;
  /** session_context 更新通知受信時のコールバック */
  onSessionContextUpdated?: (message: WsSessionContextUpdatedMessage) => void;
}

interface UseSessionEventsReturn {
  events: SDKMessage[];
  toolResultIds: ReadonlySet<string>;
  isLoading: boolean;
  isConnected: boolean;
  error: Error | null;
  /** stream からの result 受信で更新される session status */
  sessionStatus: SessionStatus | null;
  sendMessage: (content: UserMessageContentBlock[]) => void;
  answerQuestion: (
    toolUseId: string,
    answers: Record<string, string | string[]>
  ) => Promise<boolean>;
  respondExitPlanMode: (
    toolUseId: string,
    decision: Pick<WsExitPlanModeResponseRequest, 'approved' | 'message'>
  ) => Promise<boolean>;
  abort: () => Promise<boolean>;
  setPermissionMode: (mode: WsPermissionMode) => Promise<boolean>;
  setModel: (model: string) => Promise<boolean>;
  setEffortLevel: (effortLevel: WsEffortLevel) => Promise<boolean>;
}

export function shouldRefreshGitDiffForEvent(event: SDKMessage): boolean {
  if (isSDKResultMessageEvent(event)) return true;
  if (!isSDKUserMessageEvent(event)) return false;
  return (
    Array.isArray(event.message.content) &&
    event.message.content.some(block => isToolResultContentBlock(block))
  );
}

export function shouldRefreshGitRepositoryStatusForEvent(event: SDKMessage): boolean {
  if (!isSDKResultMessageEvent(event)) return false;
  const result = event as SDKMessage & {
    subtype?: string;
    is_error?: boolean;
    errors?: unknown;
  };
  const hasErrors = Array.isArray(result.errors) && result.errors.length > 0;
  return result.subtype !== 'error_during_execution' && result.is_error !== true && !hasErrors;
}

export function getToolResultIdsFromEvent(event: SDKMessage): string[] {
  if (!isSDKUserMessageEvent(event) || !Array.isArray(event.message.content)) return [];
  const ids: string[] = [];
  for (const block of event.message.content) {
    if (isToolResultContentBlock(block)) {
      ids.push(block.tool_use_id);
    }
  }
  return ids;
}

function mergeToolResultIds(prev: ReadonlySet<string>, ids: Iterable<string>): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of ids) {
    if (prev.has(id)) continue;
    next ??= new Set(prev);
    next.add(id);
  }
  return next ?? prev;
}

export function useSessionEvents({
  sessionId,
  initialSessionStatus,
  initialMessage,
  onAskUserQuestion,
  onExitPlanMode,
  onGitDiffRefreshNeeded,
  onGitRepositoryStatusRefreshNeeded,
  onConnected,
  onSessionContextUpdated,
}: UseSessionEventsOptions): UseSessionEventsReturn {
  const [events, setEvents] = useState<SDKMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [shouldAutoConnect, setShouldAutoConnect] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [toolResultIds, setToolResultIds] = useState<ReadonlySet<string>>(() => new Set());
  const seenUuidsRef = useRef<Set<string>>(new Set());

  // initialSessionStatus が変わったら sessionStatus を更新
  useEffect(() => {
    if (initialSessionStatus !== undefined) {
      setSessionStatus(initialSessionStatus);
    }
  }, [initialSessionStatus]);

  // 過去イベントの取得（ページネーションで全件取得）
  const loadPastEvents = useCallback(
    async (targetSessionId: string) => {
      if (!targetSessionId) return;

      setIsLoading(true);
      setError(null);
      setShouldAutoConnect(false);

      try {
        const allEvents: SDKMessage[] = [];
        let cursor: string | undefined;
        let hasMore = true;

        for (let page = 0; page < 20 && hasMore; page++) {
          const response = await sessionService.getSessionEvents(targetSessionId, {
            after: cursor,
            limit: 1000,
          });
          allEvents.push(...response.data);
          hasMore = response.has_more;
          const nextCursor = response.last_id || undefined;
          if (nextCursor === cursor) break;
          cursor = nextCursor;
        }

        // 既存の seenUuidsRef を保持しながら更新
        allEvents.forEach(e => {
          if ('uuid' in e && e.uuid) {
            seenUuidsRef.current.add(e.uuid as string);
          }
        });
        setToolResultIds(prev =>
          mergeToolResultIds(prev, allEvents.flatMap(getToolResultIdsFromEvent))
        );

        // events をマージ（重複排除）
        setEvents(prev => {
          const existingUuids = new Set(
            prev.filter(e => 'uuid' in e && e.uuid).map(e => e.uuid as string)
          );
          const newEvents = allEvents.filter(e => {
            if ('uuid' in e && e.uuid) {
              return !existingUuids.has(e.uuid as string);
            }
            return true;
          });
          if (newEvents.length === 0) return prev;
          return [...prev, ...newEvents];
        });

        // 選択中セッションでは SSE を接続しておく。
        // idle から追加入力する場合も、POST 前に stream を確立してイベントを取りこぼさないため。
        setShouldAutoConnect(initialSessionStatus !== 'archived');
      } catch (e) {
        setError(e instanceof Error ? e : new Error('Failed to load events'));
      } finally {
        setIsLoading(false);
      }
    },
    [initialSessionStatus]
  );

  // stream イベントハンドラ
  const handleEvent = useCallback(
    (event: SDKMessage) => {
      // 重複チェック（uuid ベース、uuid がない場合はスキップ）
      if ('uuid' in event && event.uuid) {
        const uuid = event.uuid as string;
        if (seenUuidsRef.current.has(uuid)) return;
        seenUuidsRef.current.add(uuid);
      }

      if (shouldRefreshGitDiffForEvent(event)) {
        onGitDiffRefreshNeeded?.();
      }
      if (shouldRefreshGitRepositoryStatusForEvent(event)) {
        onGitRepositoryStatusRefreshNeeded?.();
      }

      const nextToolResultIds = getToolResultIdsFromEvent(event);
      if (nextToolResultIds.length > 0) {
        setToolResultIds(prev => mergeToolResultIds(prev, nextToolResultIds));
      }

      setEvents(prev => [...prev, event]);

      // result イベント受信時に sessionStatus を idle に更新
      if (isSDKResultMessageEvent(event)) {
        setSessionStatus('idle');
      }
      // init イベント受信時に sessionStatus を running に更新
      if (isSDKSystemMessageEvent(event) && event.subtype === 'init') {
        setSessionStatus('running');
      }
    },
    [onGitDiffRefreshNeeded, onGitRepositoryStatusRefreshNeeded]
  );

  // SSE 接続（shouldAutoConnect に基づいて自動接続を制御）
  const {
    isConnected,
    error: streamError,
    sendMessage,
    answerQuestion,
    respondExitPlanMode,
    abort,
    setPermissionMode,
    setModel,
    setEffortLevel,
  } = useSessionStream({
    sessionId,
    autoConnect: shouldAutoConnect,
    onEvent: handleEvent,
    onAskUserQuestion,
    onExitPlanMode,
    onConnected,
    onSessionContextUpdated,
  });

  // セッション ID が変わったら過去イベントを取得
  useEffect(() => {
    if (sessionId) {
      setEvents([]);
      setToolResultIds(new Set());
      seenUuidsRef.current.clear();

      // 初期メッセージがある場合は即座に追加
      if (initialMessage) {
        if (initialMessage.uuid) {
          seenUuidsRef.current.add(initialMessage.uuid);
        }
        setEvents([initialMessage]);
        setToolResultIds(new Set(getToolResultIdsFromEvent(initialMessage)));
      }

      loadPastEvents(sessionId);
    }
  }, [sessionId, loadPastEvents, initialMessage]);

  return {
    events,
    toolResultIds,
    isLoading,
    isConnected,
    error: error ?? streamError,
    sessionStatus,
    sendMessage,
    answerQuestion,
    respondExitPlanMode,
    abort,
    setPermissionMode,
    setModel,
    setEffortLevel,
  };
}
