import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  WsServerMessage,
  SDKMessage,
  SDKUserMessage,
  WsConnectedMessage,
  WsControlRequest,
  WsAskUserQuestionRequest,
  WsExitPlanModeRequest,
  WsExitPlanModeResponseRequest,
  WsSessionContextUpdatedMessage,
  WsEffortLevel,
  WsPermissionMode,
  UserMessageContentBlock,
} from '@repo/types';
import { sessionService } from '@/services/session.service';

interface UseSessionStreamOptions {
  sessionId: string | null;
  autoConnect?: boolean;
  onEvent?: (event: SDKMessage) => void;
  onConnected?: (message: WsConnectedMessage) => void;
  onAskUserQuestion?: (request: WsAskUserQuestionRequest) => void;
  onExitPlanMode?: (request: WsExitPlanModeRequest) => void;
  onSessionContextUpdated?: (message: WsSessionContextUpdatedMessage) => void;
  onError?: (error: Error) => void;
}

interface UseSessionStreamReturn {
  isConnected: boolean;
  isConnecting: boolean;
  error: Error | null;
  reconnect: () => void;
  connect: () => void;
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

function parseServerMessage(event: MessageEvent<string>): WsServerMessage | null {
  try {
    return JSON.parse(event.data) as WsServerMessage;
  } catch (error) {
    console.error('Failed to parse SSE message:', error);
    return null;
  }
}

export function useSessionStream({
  sessionId,
  autoConnect = true,
  onEvent,
  onConnected,
  onAskUserQuestion,
  onExitPlanMode,
  onSessionContextUpdated,
  onError,
}: UseSessionStreamOptions): UseSessionStreamReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const connectWaitersRef = useRef<Array<() => void>>([]);

  const onEventRef = useRef(onEvent);
  const onConnectedRef = useRef(onConnected);
  const onAskUserQuestionRef = useRef(onAskUserQuestion);
  const onExitPlanModeRef = useRef(onExitPlanMode);
  const onSessionContextUpdatedRef = useRef(onSessionContextUpdated);
  const onErrorRef = useRef(onError);

  onEventRef.current = onEvent;
  onConnectedRef.current = onConnected;
  onAskUserQuestionRef.current = onAskUserQuestion;
  onExitPlanModeRef.current = onExitPlanMode;
  onSessionContextUpdatedRef.current = onSessionContextUpdated;
  onErrorRef.current = onError;

  const handleMessage = useCallback((event: MessageEvent<string>) => {
    if (event.lastEventId) {
      lastEventIdRef.current = event.lastEventId;
    }

    const message = parseServerMessage(event);
    if (!message) return;

    if (message.type === 'connected') {
      setIsConnected(true);
      setIsConnecting(false);
      onConnectedRef.current?.(message as WsConnectedMessage);
    } else if (message.type === 'control_response') {
      // Control responses are returned by POST /events. Keep this for compatibility
      // with any future server-pushed control acknowledgements.
    } else if (message.type === 'ask_user_question') {
      onAskUserQuestionRef.current?.(message as WsAskUserQuestionRequest);
    } else if (message.type === 'exit_plan_mode') {
      onExitPlanModeRef.current?.(message as WsExitPlanModeRequest);
    } else if (message.type === 'session_context_updated') {
      onSessionContextUpdatedRef.current?.(message as WsSessionContextUpdatedMessage);
    } else if (message.type === 'error') {
      const errorMessage = (message as { message: string }).message;
      const nextError = new Error(errorMessage);
      setError(nextError);
      onErrorRef.current?.(nextError);
    } else if ('session_id' in message) {
      onEventRef.current?.(message as SDKMessage);
    }
  }, []);

  const connect = useCallback(() => {
    if (!sessionId) return;
    if (
      eventSourceRef.current?.readyState === EventSource.OPEN ||
      eventSourceRef.current?.readyState === EventSource.CONNECTING
    ) {
      return;
    }

    // 前の EventSource が残っていれば確実に閉じる
    eventSourceRef.current?.close();
    eventSourceRef.current = null;

    setIsConnecting(true);
    setError(null);

    const params = new URLSearchParams();
    if (lastEventIdRef.current) {
      params.set('after', lastEventIdRef.current);
    }
    const queryString = params.toString();
    const url = `/api/sessions/${sessionId}/stream${queryString ? `?${queryString}` : ''}`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setIsConnecting(false);
      const waiters = connectWaitersRef.current;
      connectWaitersRef.current = [];
      waiters.forEach(resolve => resolve());
    };

    for (const name of [
      'connected',
      'message',
      'ask_user_question',
      'exit_plan_mode',
      'session_context_updated',
      'control_response',
    ]) {
      eventSource.addEventListener(name, event => {
        handleMessage(event as MessageEvent<string>);
      });
    }
    eventSource.onerror = event => {
      if ('data' in event && typeof event.data === 'string') {
        handleMessage(event as MessageEvent<string>);
        return;
      }
      setIsConnected(false);
      setIsConnecting(eventSource.readyState === EventSource.CONNECTING);
      if (eventSource.readyState === EventSource.CLOSED) {
        const nextError = new Error('SSE connection closed');
        setError(nextError);
        onErrorRef.current?.(nextError);
      }
    };
  }, [handleMessage, sessionId]);

  const reconnect = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setIsConnected(false);
    connect();
  }, [connect]);

  const waitForConnection = useCallback((): Promise<void> => {
    connect();
    if (eventSourceRef.current?.readyState === EventSource.OPEN) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        connectWaitersRef.current = connectWaitersRef.current.filter(waiter => waiter !== done);
        resolve();
      }, 2_000);
      const done = () => {
        clearTimeout(timeout);
        resolve();
      };
      connectWaitersRef.current.push(done);
    });
  }, [connect]);

  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setIsConnected(false);
      setIsConnecting(false);
      // Drain pending waitForConnection promises to prevent stale callbacks
      const waiters = connectWaitersRef.current;
      connectWaitersRef.current = [];
      waiters.forEach(resolve => resolve());
    };
  }, [autoConnect, connect]);

  const sendMessage = useCallback(
    (content: UserMessageContentBlock[]) => {
      if (!sessionId) return;

      const message: SDKUserMessage = {
        type: 'user',
        uuid: crypto.randomUUID(),
        session_id: sessionId,
        message: {
          role: 'user',
          content,
        },
        parent_tool_use_id: null,
      };

      waitForConnection()
        .then(() => sessionService.sendMessage(sessionId, message))
        .catch(err => {
          const nextError = err instanceof Error ? err : new Error('Failed to send message');
          setError(nextError);
          onErrorRef.current?.(nextError);
        });
    },
    [sessionId, waitForConnection]
  );

  const sendControlRequest = useCallback(
    async (request: WsControlRequest['request']): Promise<boolean> => {
      if (!sessionId) return false;

      const requestId = crypto.randomUUID();
      const msg: WsControlRequest = {
        type: 'control_request',
        request_id: requestId,
        request,
      };

      try {
        const response = await sessionService.sendControlRequest(sessionId, msg);
        return response.events.some(
          event => event.type === 'control_request' && event.request_id === requestId
        );
      } catch (err) {
        const nextError = err instanceof Error ? err : new Error('Failed to send control request');
        setError(nextError);
        onErrorRef.current?.(nextError);
        return false;
      }
    },
    [sessionId]
  );

  const answerQuestion = useCallback(
    (toolUseId: string, answers: Record<string, string | string[]>): Promise<boolean> =>
      sendControlRequest({
        subtype: 'ask_user_question_answer',
        tool_use_id: toolUseId,
        answers,
      }),
    [sendControlRequest]
  );

  const respondExitPlanMode = useCallback(
    (
      toolUseId: string,
      decision: Pick<WsExitPlanModeResponseRequest, 'approved' | 'message'>
    ): Promise<boolean> =>
      sendControlRequest({
        subtype: 'exit_plan_mode_response',
        tool_use_id: toolUseId,
        ...decision,
      }),
    [sendControlRequest]
  );

  const abort = useCallback(
    (): Promise<boolean> => sendControlRequest({ subtype: 'abort' }),
    [sendControlRequest]
  );

  const setPermissionMode = useCallback(
    (mode: WsPermissionMode): Promise<boolean> =>
      sendControlRequest({ subtype: 'set_permission_mode', mode }),
    [sendControlRequest]
  );

  const setModel = useCallback(
    (model: string): Promise<boolean> => sendControlRequest({ subtype: 'set_model', model }),
    [sendControlRequest]
  );

  const setEffortLevel = useCallback(
    (effortLevel: WsEffortLevel): Promise<boolean> =>
      sendControlRequest({
        subtype: 'apply_flag_settings',
        settings: { effortLevel },
      }),
    [sendControlRequest]
  );

  return {
    isConnected,
    isConnecting,
    error,
    reconnect,
    connect,
    sendMessage,
    answerQuestion,
    respondExitPlanMode,
    abort,
    setPermissionMode,
    setModel,
    setEffortLevel,
  };
}
