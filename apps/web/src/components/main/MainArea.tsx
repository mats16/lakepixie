import { useState, useMemo, useCallback, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isNewSessionNavigationState } from '@/types/navigation';
import type {
  SessionCreateRequest,
  SessionResponse,
  UserMessageContentBlock,
  WsAskUserQuestionRequest,
  DatabricksWorkspaceSource,
  SessionOutcome,
  SessionSource,
  ResolvedDatabricksAppsOutcome,
} from '@repo/types';
import { MainHeader } from './MainHeader';
import { MessageArea } from './MessageArea';
import { InputArea } from './InputArea';
import { WelcomeScreen, type NewSessionParams } from './WelcomeScreen';
import { SessionNotFound } from './SessionNotFound';
import { FloatingButtons } from './FloatingButtons';
import { useSessionEvents } from '@/hooks/useSessionEvents';
import { useSession } from '@/hooks/useSession';
import { AskUserQuestionProvider } from '@/contexts/AskUserQuestionContext';
import { sessionService } from '@/services/session.service';
import { extractTextFromContent } from '@/lib/content-builder';

function createFallbackBranchName(appName?: string): string {
  const safeAppName = appName && /^[a-z0-9][a-z0-9-]{0,25}$/.test(appName) ? appName : 'session';
  const shortId = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  return `ccbricks/${safeAppName}-${shortId}`;
}

interface MainAreaProps {
  branchName?: string;
  onSendMessage?: (content: UserMessageContentBlock[]) => void;
  onSessionArchived?: (sessionId: string) => void;
  onSessionCreated?: (session: SessionResponse) => void;
}

export function MainArea({
  branchName,
  onSendMessage,
  onSessionArchived,
  onSessionCreated,
}: MainAreaProps) {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const [createSessionError, setCreateSessionError] = useState<string | null>(null);

  // navigate state から初期メッセージを取得
  const initialMessage = useMemo(() => {
    if (isNewSessionNavigationState(location.state)) {
      return location.state.initialMessage;
    }
    return undefined;
  }, [location.state]);

  const {
    session,
    updateSession,
    isLoading: isSessionLoading,
    error: sessionLoadError,
  } = useSession({
    sessionId: sessionId ?? null,
  });

  // AskUserQuestion の pending 状態管理
  const [pendingQuestions, setPendingQuestions] = useState<Map<string, Record<string, unknown>>>(
    () => new Map()
  );
  const handleAskUserQuestion = useCallback((req: WsAskUserQuestionRequest) => {
    setPendingQuestions(prev => {
      const next = new Map(prev);
      next.set(req.tool_use_id, req.input);
      return next;
    });
  }, []);

  const { events, isLoading, error, sessionStatus, sendMessage, answerQuestion, abort } =
    useSessionEvents({
      sessionId: sessionId ?? null,
      initialSessionStatus: session?.session_status,
      initialMessage,
      onAskUserQuestion: handleAskUserQuestion,
    });

  const submitAnswer = useCallback(
    (toolUseId: string, answers: Record<string, string | string[]>) => {
      answerQuestion(toolUseId, answers).then(success => {
        if (success) {
          setPendingQuestions(prev => {
            const next = new Map(prev);
            next.delete(toolUseId);
            return next;
          });
        }
      });
    },
    [answerQuestion]
  );

  // session が idle に戻ったら pending をクリア
  useEffect(() => {
    if (sessionStatus === 'idle' && pendingQuestions.size > 0) {
      setPendingQuestions(new Map());
    }
  }, [sessionStatus, pendingQuestions.size]);

  const askUserQuestionCtx = useMemo(
    () => ({ pendingQuestions, submitAnswer }),
    [pendingQuestions, submitAnswer]
  );

  // session status が init または running の場合、エージェントが応答中
  // ただし AskUserQuestion の回答待ち中は除外
  const isAgentThinking = useMemo(() => {
    if (pendingQuestions.size > 0) return false;
    return sessionStatus === 'init' || sessionStatus === 'running';
  }, [sessionStatus, pendingQuestions.size]);

  // init 中の準備処理表示。Git repository は clone、Workspace は sync として見せる。
  const syncingKind = useMemo((): 'workspace' | 'git' | null => {
    if (sessionStatus !== 'init') return null;
    const sources = session?.session_context?.sources ?? [];
    if (sources.some(source => source.type === 'git_repository')) return 'git';
    if (sources.some(source => source.type === 'databricks_workspace')) return 'workspace';
    return null;
  }, [session?.session_context?.sources, sessionStatus]);

  // session_context.outcomes から workspace / apps outcome を取得
  const { databricksWorkspaceOutcome, databricksAppsOutcome } = useMemo(() => {
    const outcomes = session?.session_context?.outcomes;
    if (!outcomes) return { databricksWorkspaceOutcome: null, databricksAppsOutcome: null };
    return {
      databricksWorkspaceOutcome:
        outcomes.find((o): o is DatabricksWorkspaceSource => o.type === 'databricks_workspace') ??
        null,
      databricksAppsOutcome:
        outcomes.find((o): o is ResolvedDatabricksAppsOutcome => o.type === 'databricks_apps') ??
        null,
    };
  }, [session?.session_context?.outcomes]);

  // フローティングボタンを表示するかどうか
  const hasFloatingButtons = !!databricksAppsOutcome || !!databricksWorkspaceOutcome;

  const handleSend = (content: UserMessageContentBlock[]) => {
    onSendMessage?.(content);
    sendMessage(content);
  };

  const handleTitleUpdate = async (newTitle: string) => {
    await updateSession({ title: newTitle });
  };

  const handleArchive = async () => {
    if (!sessionId) return;
    onSessionArchived?.(sessionId);
  };

  const handleNewSession = async ({
    content,
    modelId,
    enableDatabricksSqlWrite,
    enableDatabricksApps,
    sourceType,
    gitRepository,
    gitRepositoryBranch,
    workspaceSelection,
    mcpConfig,
    allowedTools,
    disallowedTools,
  }: NewSessionParams) => {
    try {
      setCreateSessionError(null);
      const gitRepositoryForSession = sourceType === 'git_repository' ? gitRepository : null;
      if (sourceType === 'git_repository' && !gitRepositoryForSession) {
        setCreateSessionError(t('welcome.sourceType.repositoryRequired'));
        return;
      }
      if (sourceType === 'git_repository' && !gitRepositoryBranch) {
        setCreateSessionError(t('welcome.sourceType.branchRequired'));
        return;
      }

      // UUID を外で生成（API と navigate state の両方で使用）
      const messageUuid = crypto.randomUUID();

      // タイトル生成用にテキストを抽出
      const textContent = extractTextFromContent(content);
      const titleResult = await sessionService.generateTitle(textContent);
      const branchName =
        titleResult?.branch_name ?? createFallbackBranchName(titleResult?.app_name);
      const sources: SessionSource[] = [];
      const outcomes: SessionOutcome[] = [];

      if (gitRepositoryForSession) {
        sources.push({
          allow_unrestricted_git_push: true,
          revision: `refs/heads/${gitRepositoryBranch}`,
          sparse_checkout_paths: [],
          type: 'git_repository',
          url: gitRepositoryForSession.url,
        });
        outcomes.push({
          git_info: {
            branches: [branchName],
            repo: gitRepositoryForSession.full_name,
            type: 'github',
          },
          type: 'git_repository',
        });
      } else if (workspaceSelection) {
        sources.push({
          type: 'databricks_workspace',
          path: workspaceSelection.path,
        });
        outcomes.push({
          type: 'databricks_workspace',
          path: '/Workspace/Shared/ccbricks/sessions/{session_id}',
        });
      } else {
        outcomes.push({
          type: 'databricks_workspace',
          path: '/Workspace/Shared/ccbricks/sessions/{session_id}',
        });
      }

      if (enableDatabricksApps) {
        outcomes.push({ type: 'databricks_apps', name: titleResult?.app_name });
      }

      const request: SessionCreateRequest = {
        title: titleResult?.title ?? undefined,
        events: [
          {
            type: 'event',
            data: {
              uuid: messageUuid,
              session_id: '',
              type: 'user',
              parent_tool_use_id: null,
              message: {
                role: 'user',
                content: content,
              },
            },
          },
        ],
        session_context: {
          model: modelId as 'opus' | 'sonnet' | 'haiku',
          sources,
          outcomes,
          allowed_tools: allowedTools,
          disallowed_tools: [
            ...(enableDatabricksSqlWrite ? [] : ['mcp__dbsql__execute_sql']),
            ...(disallowedTools ?? []),
          ],
          mcp_config: mcpConfig,
        },
      };

      const response = await sessionService.createSession(request);
      onSessionCreated?.({
        id: response.id,
        title: response.title,
        session_status: response.session_status,
        created_at: response.created_at,
        updated_at: response.updated_at,
        session_context: response.session_context,
      });

      // navigate state に初期メッセージを渡す
      navigate(`/sessions/${response.id}`, {
        state: {
          initialMessage: {
            type: 'user',
            uuid: messageUuid,
            session_id: response.id,
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: content,
            },
          },
        },
      });
    } catch (err) {
      console.error('Failed to create session:', err);
      setCreateSessionError(t('sidebar.sessionCreateError'));
    }
  };

  // セッション未選択時はウェルカムスクリーンを表示
  if (!sessionId) {
    return (
      <div className="relative z-0 flex flex-col w-full h-full min-w-0 overflow-hidden bg-background">
        <WelcomeScreen onNewSession={handleNewSession} sessionError={createSessionError} />
      </div>
    );
  }

  // セッションが見つからない場合
  if (!isSessionLoading && sessionLoadError) {
    return <SessionNotFound onGoHome={() => navigate('/')} />;
  }

  return (
    <AskUserQuestionProvider value={askUserQuestionCtx}>
      <div className="relative z-0 flex flex-col w-full h-full min-w-0 overflow-hidden bg-background">
        <MainHeader
          title={session?.title ?? 'New Session'}
          branchName={branchName}
          sessionId={sessionId}
          onTitleUpdate={handleTitleUpdate}
          onArchive={handleArchive}
        />
        <MessageArea
          events={events}
          isLoading={isLoading}
          error={error}
          isAgentThinking={isAgentThinking}
          syncingKind={syncingKind}
          hasFloatingButton={hasFloatingButtons}
        />
        <InputArea
          sessionId={sessionId}
          onSend={handleSend}
          onAbort={abort}
          isAgentThinking={isAgentThinking}
          disabled={session?.session_status === 'archived'}
        />
        {hasFloatingButtons && (
          <FloatingButtons
            sessionId={sessionId}
            showAppButton={!!databricksAppsOutcome}
            workspacePath={databricksWorkspaceOutcome?.path}
          />
        )}
      </div>
    </AskUserQuestionProvider>
  );
}
