import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isNewSessionNavigationState } from '@/types/navigation';
import {
  parseGitBranchRevision,
  type DatabricksWorkspaceSource,
  type GitRepositoryOutcome,
  type GitRepositorySource,
  type ResolvedDatabricksAppsOutcome,
  type SessionCreateRequest,
  type SessionOutcome,
  type SessionResponse,
  type SessionSource,
  type UserSettingsResponse,
  type UserMessageContentBlock,
  type WsAskUserQuestionRequest,
  type WsExitPlanModeRequest,
  type WsEffortLevel,
} from '@repo/types';
import { MainHeader } from './MainHeader';
import { MessageArea } from './MessageArea';
import { InputArea } from './InputArea';
import {
  WelcomeScreen,
  type NewSessionParams,
  type NewSessionSourceSelection,
} from './WelcomeScreen';
import { SessionNotFound } from './SessionNotFound';
import { GitRepositoryStatusBar } from './GitRepositoryStatusBar';
import { ExitPlanModeInputArea, type ExitPlanModeInputDecision } from './ExitPlanModeInputArea';
import type { ExitPlanModeOptimisticResult } from './tool-use/types';
import { useSessionEvents } from '@/hooks/useSessionEvents';
import { useSession } from '@/hooks/useSession';
import { useOpenWorkspace } from '@/hooks/useOpenWorkspace';
import { AskUserQuestionProvider } from '@/contexts/AskUserQuestionContext';
import { sessionService } from '@/services/session.service';
import { extractTextFromContent } from '@/lib/content-builder';
import { useUser } from '@/hooks/useUser';
import { toast } from 'sonner';
import { SESSION_MODELS } from '@/constants';

function toBranchSlug(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/g, '');
  return slug || null;
}

function createFallbackBranchName(message?: string): string {
  const safeSlug = message ? (toBranchSlug(message) ?? 'session') : 'session';
  const shortId = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  return `ccbricks/${safeSlug}-${shortId}`;
}

function parseRepositoryFullName(fullName: string): { owner: string; repo: string } | null {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

function parseRepositoryUrl(urlValue: string): { owner: string; repo: string } | null {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
  const [owner, rawRepo] = url.pathname.replace(/^\/+/, '').split('/');
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo) return null;
  return { owner, repo };
}

interface MainAreaProps {
  branchName?: string;
  onSendMessage?: (content: UserMessageContentBlock[]) => void;
  onSessionArchived?: (sessionId: string) => void;
  onSessionCreated?: (session: SessionResponse) => void;
}

const GIT_DIFF_REFRESH_DEBOUNCE_MS = 750;

type GitNewSessionSourceSelection = Extract<NewSessionSourceSelection, { type: 'git_repository' }>;

function getResolvedSessionModelId(
  modelId: string,
  modelSettings: UserSettingsResponse | null
): string {
  if (modelId === 'opus') return modelSettings?.opus_model_id ?? modelId;
  if (modelId === 'sonnet') return modelSettings?.sonnet_model_id ?? modelId;
  if (modelId === 'haiku') return modelSettings?.haiku_model_id ?? modelId;
  return modelId;
}

function getSessionModelTier(modelId: string | undefined): string | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

function getExitPlanOptimisticResult(
  decision: ExitPlanModeInputDecision
): ExitPlanModeOptimisticResult {
  switch (decision.kind) {
    case 'approve':
      return { type: 'approved' };
    case 'reject':
      return { type: 'rejected' };
    case 'suggest':
      return { type: 'suggested', message: decision.message.trim() };
  }
}

function buildAppCreateContext(params: {
  sessionTitle?: string | null;
  workspacePath?: string | null;
}): string {
  return [
    params.sessionTitle ? `Session title: ${params.sessionTitle}` : null,
    params.workspacePath ? `Workspace path: ${params.workspacePath}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
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
  const { githubOAuthAuthorization, modelSettings } = useUser();
  const [createSessionError, setCreateSessionError] = useState<string | null>(null);
  const [gitDiffRefreshKey, setGitDiffRefreshKey] = useState(0);
  const [gitRepositoryStatusRefreshKey, setGitRepositoryStatusRefreshKey] = useState(0);
  const [sessionControlPending, setSessionControlPending] = useState(false);
  const [optimisticModelId, setOptimisticModelId] = useState<string | null>(null);
  const [optimisticPlanMode, setOptimisticPlanMode] = useState<boolean | null>(null);
  const [optimisticEffortLevel, setOptimisticEffortLevel] = useState<WsEffortLevel | null>(null);
  const [isCreatingApp, setIsCreatingApp] = useState(false);
  const gitDiffRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gitRepositoryStatusRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    refetch: refetchSession,
    isLoading: isSessionLoading,
    error: sessionLoadError,
  } = useSession({
    sessionId: sessionId ?? null,
  });
  const activeSession = sessionId && session?.id === sessionId ? session : null;

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

  const [pendingExitPlans, setPendingExitPlans] = useState<Map<string, Record<string, unknown>>>(
    () => new Map()
  );
  const [optimisticExitPlanResults, setOptimisticExitPlanResults] = useState<
    Map<string, ExitPlanModeOptimisticResult>
  >(() => new Map());
  const handleExitPlanMode = useCallback((req: WsExitPlanModeRequest) => {
    setPendingExitPlans(prev => {
      const next = new Map(prev);
      next.set(req.tool_use_id, req.input);
      return next;
    });
  }, []);

  const handleGitDiffRefreshNeeded = useCallback(() => {
    if (gitDiffRefreshTimerRef.current) {
      clearTimeout(gitDiffRefreshTimerRef.current);
    }
    gitDiffRefreshTimerRef.current = setTimeout(() => {
      gitDiffRefreshTimerRef.current = null;
      setGitDiffRefreshKey(current => current + 1);
    }, GIT_DIFF_REFRESH_DEBOUNCE_MS);
  }, []);

  const handleGitRepositoryStatusRefreshNeeded = useCallback(() => {
    if (gitRepositoryStatusRefreshTimerRef.current) {
      clearTimeout(gitRepositoryStatusRefreshTimerRef.current);
    }
    gitRepositoryStatusRefreshTimerRef.current = setTimeout(() => {
      gitRepositoryStatusRefreshTimerRef.current = null;
      setGitRepositoryStatusRefreshKey(current => current + 1);
    }, GIT_DIFF_REFRESH_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (gitDiffRefreshTimerRef.current) {
        clearTimeout(gitDiffRefreshTimerRef.current);
        gitDiffRefreshTimerRef.current = null;
      }
      if (gitRepositoryStatusRefreshTimerRef.current) {
        clearTimeout(gitRepositoryStatusRefreshTimerRef.current);
        gitRepositoryStatusRefreshTimerRef.current = null;
      }
    };
  }, [sessionId]);

  useEffect(() => {
    setOptimisticExitPlanResults(new Map());
  }, [sessionId]);

  const {
    events,
    toolResultIds,
    isLoading,
    error,
    sessionStatus,
    sendMessage,
    answerQuestion,
    respondExitPlanMode,
    abort,
    setPermissionMode,
    setModel,
    setEffortLevel,
  } = useSessionEvents({
    sessionId: sessionId ?? null,
    initialSessionStatus: activeSession?.session_status,
    initialMessage,
    onAskUserQuestion: handleAskUserQuestion,
    onExitPlanMode: handleExitPlanMode,
    onGitDiffRefreshNeeded: handleGitDiffRefreshNeeded,
    onGitRepositoryStatusRefreshNeeded: handleGitRepositoryStatusRefreshNeeded,
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

  const submitExitPlanDecision = useCallback(
    async (toolUseId: string, decision: ExitPlanModeInputDecision) => {
      const responseDecision = decision.approved
        ? { approved: true as const }
        : { approved: false as const, message: decision.message };
      const success = await respondExitPlanMode(toolUseId, responseDecision);
      if (success) {
        const optimisticResult = getExitPlanOptimisticResult(decision);
        setOptimisticExitPlanResults(prev => {
          const next = new Map(prev);
          next.set(toolUseId, optimisticResult);
          return next;
        });
        setPendingExitPlans(prev => {
          const next = new Map(prev);
          next.delete(toolUseId);
          return next;
        });
        if (decision.approved) {
          setOptimisticPlanMode(false);
        }
      }
    },
    [respondExitPlanMode]
  );

  // session が idle に戻ったら pending をクリア
  useEffect(() => {
    if (sessionStatus === 'idle' && pendingQuestions.size > 0) {
      setPendingQuestions(new Map());
    }
  }, [sessionStatus, pendingQuestions.size]);

  useEffect(() => {
    if (toolResultIds.size === 0) return;

    setPendingExitPlans(prev => {
      const next = new Map(prev);
      for (const toolUseId of toolResultIds) {
        next.delete(toolUseId);
      }
      return next.size === prev.size ? prev : next;
    });
    setOptimisticExitPlanResults(prev => {
      const next = new Map(prev);
      for (const toolUseId of toolResultIds) {
        next.delete(toolUseId);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [toolResultIds]);

  const askUserQuestionCtx = useMemo(
    () => ({ pendingQuestions, submitAnswer }),
    [pendingQuestions, submitAnswer]
  );

  // session status が init または running の場合、エージェントが応答中
  // ただし AskUserQuestion の回答待ち中は除外
  const isAgentThinking = useMemo(() => {
    if (pendingQuestions.size > 0) return false;
    if (pendingExitPlans.size > 0) return false;
    return sessionStatus === 'init' || sessionStatus === 'running';
  }, [sessionStatus, pendingQuestions.size, pendingExitPlans.size]);

  const activeExitPlan = useMemo(() => {
    const firstPendingPlan = pendingExitPlans.entries().next().value;
    if (!firstPendingPlan) return null;
    const [toolUseId] = firstPendingPlan;
    return { toolUseId };
  }, [pendingExitPlans]);

  // init 中の準備処理表示。Git repository は clone、Workspace は sync として見せる。
  const syncingKind = useMemo((): 'workspace' | 'git' | null => {
    if (sessionStatus !== 'init') return null;
    const sources = activeSession?.session_context?.sources ?? [];
    if (sources.some(source => source.type === 'git_repository')) return 'git';
    if (sources.some(source => source.type === 'databricks_workspace')) return 'workspace';
    return null;
  }, [activeSession?.session_context?.sources, sessionStatus]);

  // session_context.outcomes から workspace / apps / git outcome を取得
  const { databricksWorkspaceOutcome, databricksAppsOutcome, gitRepositoryOutcome } =
    useMemo(() => {
      const outcomes = activeSession?.session_context?.outcomes;
      if (!outcomes) {
        return {
          databricksWorkspaceOutcome: null,
          databricksAppsOutcome: null,
          gitRepositoryOutcome: null,
        };
      }
      return {
        databricksWorkspaceOutcome:
          outcomes.find((o): o is DatabricksWorkspaceSource => o.type === 'databricks_workspace') ??
          null,
        databricksAppsOutcome:
          outcomes.find((o): o is ResolvedDatabricksAppsOutcome => o.type === 'databricks_apps') ??
          null,
        gitRepositoryOutcome:
          outcomes.find((o): o is GitRepositoryOutcome => o.type === 'git_repository') ?? null,
      };
    }, [activeSession?.session_context?.outcomes]);

  const gitRepositoryStatus = useMemo(() => {
    const gitSources =
      activeSession?.session_context?.sources.filter(
        (source): source is GitRepositorySource => source.type === 'git_repository'
      ) ?? [];
    if (gitSources.length !== 1) return null;

    const gitSource = gitSources[0];
    const repoInfoFromOutcome = gitRepositoryOutcome?.git_info.repo
      ? parseRepositoryFullName(gitRepositoryOutcome.git_info.repo)
      : null;
    const repoInfo = repoInfoFromOutcome ?? parseRepositoryUrl(gitSource.url);
    const headBranch = gitRepositoryOutcome?.git_info.branches[0];
    const baseBranch = parseGitBranchRevision(gitSource.revision);
    if (!repoInfo || !headBranch || !baseBranch) return null;
    return {
      ...repoInfo,
      headBranch,
      baseBranch,
    };
  }, [gitRepositoryOutcome, activeSession?.session_context?.sources]);

  const hasFloatingControls = !!gitRepositoryStatus;
  const gitStatusBottomClassName = activeExitPlan ? 'pb-[12.5rem]' : undefined;
  const { openWorkspace, isOpeningWorkspace } = useOpenWorkspace(databricksWorkspaceOutcome?.path);

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

  const currentSessionModelId = activeSession?.session_context?.model;
  const selectedSessionModelId =
    optimisticModelId ?? getSessionModelTier(currentSessionModelId) ?? currentSessionModelId;
  const selectedSessionEffortLevel =
    optimisticEffortLevel ?? activeSession?.session_context?.effort_level ?? 'high';
  const isPlanMode =
    optimisticPlanMode ?? activeSession?.session_context?.permission_mode === 'plan';
  const modeBeforePlan = activeSession?.session_context?.permission_mode_before_plan ?? 'auto';

  useEffect(() => {
    setOptimisticModelId(null);
  }, [sessionId, currentSessionModelId]);

  useEffect(() => {
    setOptimisticPlanMode(null);
  }, [sessionId, activeSession?.session_context?.permission_mode]);

  useEffect(() => {
    setOptimisticEffortLevel(null);
  }, [sessionId, activeSession?.session_context?.effort_level]);

  const handleSessionModelChange = useCallback(
    async (modelId: string) => {
      if (!sessionId || modelId === selectedSessionModelId) return;
      const previousModelId = selectedSessionModelId ?? null;
      const resolvedModelId = getResolvedSessionModelId(modelId, modelSettings);
      setSessionControlPending(true);
      setOptimisticModelId(modelId);
      try {
        const success = await setModel(resolvedModelId);
        if (!success) {
          setOptimisticModelId(previousModelId);
          toast.error(t('main.modelChangeError'));
          return;
        }
        await refetchSession();
      } catch {
        setOptimisticModelId(previousModelId);
        toast.error(t('main.modelChangeError'));
      } finally {
        setSessionControlPending(false);
      }
    },
    [modelSettings, refetchSession, selectedSessionModelId, sessionId, setModel, t]
  );

  const handleSessionEffortChange = useCallback(
    async (effortLevel: WsEffortLevel) => {
      if (!sessionId || effortLevel === selectedSessionEffortLevel) return;
      const previousEffortLevel = selectedSessionEffortLevel;
      setSessionControlPending(true);
      setOptimisticEffortLevel(effortLevel);
      try {
        const success = await setEffortLevel(effortLevel);
        if (!success) {
          setOptimisticEffortLevel(previousEffortLevel);
          toast.error(t('main.effortChangeError'));
          return;
        }
        await refetchSession();
      } catch {
        setOptimisticEffortLevel(previousEffortLevel);
        toast.error(t('main.effortChangeError'));
      } finally {
        setSessionControlPending(false);
      }
    },
    [refetchSession, selectedSessionEffortLevel, sessionId, setEffortLevel, t]
  );

  const handlePlanModeChange = useCallback(
    async (enabled: boolean) => {
      if (!sessionId || enabled === isPlanMode) return;
      const previousPlanMode = isPlanMode;
      setSessionControlPending(true);
      setOptimisticPlanMode(enabled);
      try {
        const success = await setPermissionMode(enabled ? 'plan' : modeBeforePlan);
        if (!success) {
          setOptimisticPlanMode(previousPlanMode);
          toast.error(t('main.planModeChangeError'));
          return;
        }
        await refetchSession();
      } catch {
        setOptimisticPlanMode(previousPlanMode);
        toast.error(t('main.planModeChangeError'));
      } finally {
        setSessionControlPending(false);
      }
    },
    [isPlanMode, modeBeforePlan, refetchSession, sessionId, setPermissionMode, t]
  );

  const handleCreateApp = useCallback(async () => {
    const workspacePath = databricksWorkspaceOutcome?.path;
    if (!sessionId || isCreatingApp) return;

    setIsCreatingApp(true);
    try {
      const result = await sessionService.createSessionApp(sessionId, {
        context: buildAppCreateContext({
          sessionTitle: activeSession?.title,
          workspacePath,
        }),
      });
      await refetchSession();
      if (result.notification_status === 'failed') {
        toast.warning(t('databricksApp.createNotificationFailed'));
      } else {
        toast.success(t('databricksApp.createSuccess'));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('databricksApp.createError');
      toast.error(message);
    } finally {
      setIsCreatingApp(false);
    }
  }, [
    activeSession?.title,
    databricksWorkspaceOutcome?.path,
    isCreatingApp,
    refetchSession,
    sessionId,
    t,
  ]);

  const handleNewSession = async ({
    content,
    modelId,
    effortLevel,
    enableDatabricksSqlWrite,
    isPlanMode,
    sourceSelections,
    mcpConfig,
    allowedTools,
    disallowedTools,
  }: NewSessionParams) => {
    try {
      setCreateSessionError(null);
      const hasGitRepositorySource = sourceSelections.some(
        source => source.type === 'git_repository'
      );
      if (hasGitRepositorySource && githubOAuthAuthorization?.status !== 'connected') {
        setCreateSessionError(t('welcome.sourceType.githubAuthorizationRequired'));
        return;
      }

      // UUID を外で生成（API と navigate state の両方で使用）
      const messageUuid = crypto.randomUUID();

      // タイトル生成用にテキストを抽出
      const textContent = extractTextFromContent(content);
      const titleResult = await sessionService.generateTitle(textContent);
      const branchName = titleResult?.branch_name ?? createFallbackBranchName(textContent);
      const sources: SessionSource[] = [];
      const outcomes: SessionOutcome[] = [];
      const gitSourceSelections = sourceSelections.filter(
        (sourceSelection): sourceSelection is GitNewSessionSourceSelection =>
          sourceSelection.type === 'git_repository'
      );
      const workspaceSourceSelection = sourceSelections.find(
        sourceSelection => sourceSelection.type === 'databricks_workspace'
      );

      for (const sourceSelection of sourceSelections) {
        if (sourceSelection.type === 'git_repository') {
          sources.push({
            allow_unrestricted_git_push: true,
            revision: `refs/heads/${sourceSelection.gitRepositoryBranch}`,
            sparse_checkout_paths: [],
            type: 'git_repository',
            url: sourceSelection.gitRepository.url,
          });
        } else {
          sources.push({
            type: 'databricks_workspace',
            path: sourceSelection.workspaceSelection.path,
          });
        }
      }

      if (workspaceSourceSelection?.type === 'databricks_workspace') {
        outcomes.push({
          type: 'databricks_workspace',
          path: workspaceSourceSelection.workspaceSelection.path,
        });
      }

      if (gitSourceSelections.length > 0) {
        outcomes.push({
          git_info: {
            branches: [branchName],
            type: 'github',
            ...(gitSourceSelections.length === 1
              ? { repo: gitSourceSelections[0].gitRepository.full_name }
              : {}),
          },
          type: 'git_repository',
        });
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
          model: getResolvedSessionModelId(modelId, modelSettings),
          permission_mode: isPlanMode ? 'plan' : 'auto',
          permission_mode_before_plan: isPlanMode ? 'auto' : undefined,
          effort_level: effortLevel,
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

  const showCreateAppButton = Boolean(activeSession && !databricksAppsOutcome);
  const createAppDisabled =
    !activeSession ||
    isAgentThinking ||
    sessionControlPending ||
    activeSession.session_status === 'archived';

  return (
    <AskUserQuestionProvider value={askUserQuestionCtx}>
      <div className="relative z-0 flex flex-col w-full h-full min-w-0 overflow-hidden bg-background">
        <MainHeader
          title={activeSession?.title ?? 'New Session'}
          branchName={branchName}
          sessionId={sessionId}
          onTitleUpdate={handleTitleUpdate}
          onArchive={handleArchive}
          workspacePath={databricksWorkspaceOutcome?.path}
          onOpenWorkspace={openWorkspace}
          isOpeningWorkspace={isOpeningWorkspace}
          showAppButton={!!databricksAppsOutcome}
          showCreateAppButton={showCreateAppButton}
          onCreateApp={handleCreateApp}
          appName={databricksAppsOutcome?.name}
          onAppDeleted={refetchSession}
          isCreatingApp={isCreatingApp}
          createAppDisabled={createAppDisabled}
        />
        <MessageArea
          events={events}
          isLoading={isLoading}
          error={error}
          isAgentThinking={isAgentThinking}
          syncingKind={syncingKind}
          hasFloatingButton={hasFloatingControls || !!activeExitPlan}
          optimisticExitPlanResults={optimisticExitPlanResults}
        />
        {activeExitPlan ? (
          <ExitPlanModeInputArea
            toolUseId={activeExitPlan.toolUseId}
            onDecision={submitExitPlanDecision}
          />
        ) : (
          <InputArea
            sessionId={sessionId}
            onSend={handleSend}
            onAbort={abort}
            isAgentThinking={isAgentThinking}
            disabled={activeSession?.session_status === 'archived'}
            currentModelId={selectedSessionModelId ?? undefined}
            modelOptions={SESSION_MODELS}
            modelControlDisabled={
              sessionControlPending || activeSession?.session_status === 'archived'
            }
            currentEffortLevel={selectedSessionEffortLevel}
            effortControlDisabled={
              sessionControlPending || activeSession?.session_status === 'archived'
            }
            isPlanMode={isPlanMode}
            planModeDisabled={sessionControlPending || activeSession?.session_status === 'archived'}
            onModelChange={handleSessionModelChange}
            onEffortChange={handleSessionEffortChange}
            onPlanModeChange={handlePlanModeChange}
          />
        )}
        {gitRepositoryStatus && (
          <GitRepositoryStatusBar
            key={`${sessionId ?? 'new'}:${gitRepositoryStatus.owner}/${gitRepositoryStatus.repo}:${gitRepositoryStatus.headBranch}:${gitRepositoryStatus.baseBranch}`}
            sessionId={sessionId}
            owner={gitRepositoryStatus.owner}
            repo={gitRepositoryStatus.repo}
            headBranch={gitRepositoryStatus.headBranch}
            baseBranch={gitRepositoryStatus.baseBranch}
            sessionTitle={activeSession?.title ?? undefined}
            diffRefreshKey={gitDiffRefreshKey}
            remoteRefreshKey={gitRepositoryStatusRefreshKey}
            bottomClassName={gitStatusBottomClassName}
          />
        )}
      </div>
    </AskUserQuestionProvider>
  );
}
