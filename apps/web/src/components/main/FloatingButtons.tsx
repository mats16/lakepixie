import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Rocket, Folder, Settings, Logs, Loader2, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { APP_STATUS_POLLING_INTERVAL_MS, APP_STATUS_POLLING_STABLE_INTERVAL_MS } from '@/constants';
import { useUser } from '@/hooks/useUser';
import { workspaceService } from '@/services';
import { toast } from 'sonner';
import type { DatabricksApp } from '@repo/types';

interface FloatingButtonsProps {
  sessionId: string;
  showAppButton: boolean;
  /** Workspace パス - ボタン表示は path の有無で判定 */
  workspacePath?: string;
  bottomClassName?: string;
  onCreateApp?: () => void;
  isCreatingApp?: boolean;
  createAppDisabled?: boolean;
  createAppTooltip?: string;
}

type AppStateType = 'RUNNING' | 'DEPLOYING' | 'CRASHED' | 'UNAVAILABLE' | 'UNKNOWN';

interface AppStateStyle {
  iconClass: string;
}

const APP_STATE_STYLES: Record<AppStateType, AppStateStyle> = {
  RUNNING: {
    iconClass: 'text-green-500',
  },
  DEPLOYING: {
    iconClass: 'text-yellow-500 animate-spin',
  },
  CRASHED: {
    iconClass: 'text-red-500',
  },
  UNAVAILABLE: {
    iconClass: 'text-red-500',
  },
  UNKNOWN: {
    iconClass: 'text-foreground',
  },
};

function getAppStateStyle(state: string | undefined): AppStateStyle {
  return APP_STATE_STYLES[(state as AppStateType) ?? 'UNKNOWN'] ?? APP_STATE_STYLES.UNKNOWN;
}

const STABLE_STATES = new Set<string>(['RUNNING', 'CRASHED', 'UNAVAILABLE']);

function normalizeDatabricksHost(host: string): string {
  return host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function buildAppOverviewUrl(host: string, appName: string): string {
  return `https://${normalizeDatabricksHost(host)}/apps-v2/app/${encodeURIComponent(appName)}/overview`;
}

function getWorkspaceDisplayName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function getPollingInterval(state: string | undefined): number {
  return state && STABLE_STATES.has(state)
    ? APP_STATUS_POLLING_STABLE_INTERVAL_MS
    : APP_STATUS_POLLING_INTERVAL_MS;
}

export function FloatingButtons({
  sessionId,
  showAppButton,
  workspacePath,
  bottomClassName = 'pb-[7.5rem]',
  onCreateApp,
  isCreatingApp = false,
  createAppDisabled = false,
  createAppTooltip,
}: FloatingButtonsProps) {
  const showWorkspaceButton = !!workspacePath;
  const showCreateButton = showWorkspaceButton && !showAppButton && !!onCreateApp;
  const { t } = useTranslation();
  const { databricksHost } = useUser();
  const [appInfo, setAppInfo] = useState<DatabricksApp | null>(null);
  const [isOpeningWorkspace, setIsOpeningWorkspace] = useState(false);
  const workspaceObjectIdRef = useRef<number | undefined>(undefined);
  const fetchAppInfoRef = useRef<() => Promise<void>>(undefined);
  const appStateRef = useRef<string | undefined>(undefined);
  const workspaceDisplayName = workspacePath ? getWorkspaceDisplayName(workspacePath) : '';

  const fetchAppInfo = useCallback(async () => {
    if (!showAppButton) return;
    try {
      const response = await fetch(`/api/sessions/${sessionId}/app`);
      if (!response.ok) {
        console.warn(`[FloatingButtons] App info fetch failed with status ${response.status}`);
        setAppInfo(prev => (prev === null ? prev : null));
        return;
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('name' in data)) {
        setAppInfo(prev => (prev === null ? prev : null));
        return;
      }
      const app = data as DatabricksApp;
      appStateRef.current = app.app_status?.state;
      setAppInfo(prev => {
        if (prev?.app_status?.state === app.app_status?.state && prev?.url === app.url) {
          return prev;
        }
        return app;
      });
    } catch (error) {
      console.warn('[FloatingButtons] Failed to fetch app info:', error);
      setAppInfo(prev => (prev === null ? prev : null));
    }
  }, [sessionId, showAppButton]);

  useEffect(() => {
    fetchAppInfoRef.current = fetchAppInfo;
  }, [fetchAppInfo]);

  useEffect(() => {
    if (!showAppButton) return;

    let timeoutId: ReturnType<typeof setTimeout>;
    const poll = () => {
      fetchAppInfoRef.current?.();
      timeoutId = setTimeout(poll, getPollingInterval(appStateRef.current));
    };

    fetchAppInfoRef.current?.();
    timeoutId = setTimeout(poll, getPollingInterval(appStateRef.current));

    return () => clearTimeout(timeoutId);
  }, [showAppButton]);

  // Workspace object_id を pre-fetch してキャッシュ（クリック時の同期 window.open に必要）
  useEffect(() => {
    if (!workspacePath) return;
    workspaceService
      .getStatus(workspacePath)
      .then(status => {
        workspaceObjectIdRef.current = status.object_id;
      })
      .catch(() => {
        // pre-fetch failure is non-fatal; click handler will retry
      });
  }, [workspacePath]);

  const style = getAppStateStyle(appInfo?.app_status?.state ?? 'UNKNOWN');
  const canOpenDeployedApp = !!appInfo?.url;
  const canOpenConsole = !!appInfo?.name && !!databricksHost;
  const appActionsDisabled = !canOpenDeployedApp && !canOpenConsole;

  const handleOpenApp = () => {
    if (appInfo?.url) {
      window.open(appInfo.url, '_blank');
    }
  };

  const handleOpenLogs = () => {
    if (appInfo?.url) {
      window.open(`${appInfo.url}/logz`, '_blank');
    }
  };

  const handleOpenConsole = () => {
    if (appInfo?.name && databricksHost) {
      window.open(buildAppOverviewUrl(databricksHost, appInfo.name), '_blank');
    }
  };

  const handleOpenWorkspace = () => {
    if (!workspacePath || !databricksHost) return;

    // pre-fetch 済み: 同期的に開く（ポップアップブロッカー回避）
    if (workspaceObjectIdRef.current !== undefined) {
      window.open(
        `https://${databricksHost}/browse/folders/${workspaceObjectIdRef.current}`,
        '_blank'
      );
      return;
    }

    // pre-fetch 未完了: 先にウィンドウを確保してから API 呼び出し
    const newWindow = window.open('', '_blank');
    if (!newWindow) {
      toast.error(t('databricksApp.workspaceOpenError'));
      return;
    }
    setIsOpeningWorkspace(true);
    workspaceService
      .getStatus(workspacePath)
      .then(status => {
        workspaceObjectIdRef.current = status.object_id;
        newWindow.location.href = `https://${databricksHost}/browse/folders/${status.object_id}`;
      })
      .catch(() => {
        newWindow.close();
        toast.error(t('databricksApp.workspaceOpenError'));
      })
      .finally(() => {
        setIsOpeningWorkspace(false);
      });
  };

  if (!showAppButton && !showWorkspaceButton) {
    return null;
  }

  return (
    <div
      className={cn(
        'absolute bottom-0 left-0 right-0 px-4 pointer-events-none z-10',
        bottomClassName
      )}
    >
      <div className="w-full max-w-[735px] mx-auto pointer-events-auto">
        <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 shadow-lg">
          {showWorkspaceButton && (
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left hover:opacity-70 disabled:opacity-50"
              onClick={handleOpenWorkspace}
              disabled={isOpeningWorkspace}
              title={workspacePath}
            >
              {isOpeningWorkspace ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-foreground" />
              ) : (
                <Folder className="h-4 w-4 shrink-0 text-foreground" />
              )}
              <span className="min-w-0 truncate text-sm font-medium">{workspaceDisplayName}</span>
            </button>
          )}

          {showAppButton && (
            <div
              className={cn(
                'flex shrink-0 overflow-hidden rounded-md border shadow-sm',
                showWorkspaceButton ? 'max-w-[42%] shrink-0' : 'ml-auto'
              )}
            >
              <Button
                type="button"
                variant="ghost"
                className="h-6 min-w-0 gap-1.5 rounded-none px-2 py-0 text-xs leading-none"
                onClick={handleOpenApp}
                disabled={!canOpenDeployedApp}
                title={t('databricksApp.app')}
              >
                <Rocket className={cn('h-4 w-4 shrink-0', style.iconClass)} />
                <span className="truncate leading-none">{t('databricksApp.app')}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 rounded-none border-l py-0"
                    disabled={appActionsDisabled}
                    aria-label={t('databricksApp.actions')}
                    title={t('databricksApp.actions')}
                  >
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleOpenLogs} disabled={!canOpenDeployedApp}>
                    <Logs className="h-4 w-4" />
                    {t('databricksApp.logs')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleOpenConsole} disabled={!canOpenConsole}>
                    <Settings className="h-4 w-4" />
                    {t('databricksApp.console')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          {showCreateButton && (
            <span
              className="flex shrink-0 overflow-hidden rounded-md border shadow-sm"
              title={
                createAppTooltip ??
                t(isCreatingApp ? 'databricksApp.creating' : 'databricksApp.create')
              }
            >
              <button
                type="button"
                className="inline-flex h-6 shrink-0 items-center gap-1.5 px-2 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                onClick={onCreateApp}
                disabled={isCreatingApp || createAppDisabled}
                aria-label={t(isCreatingApp ? 'databricksApp.creating' : 'databricksApp.create')}
              >
                {isCreatingApp ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-foreground" />
                ) : (
                  <Rocket className="h-3 w-3 shrink-0 text-foreground" />
                )}
                <span className="whitespace-nowrap">{t('databricksApp.createShort')}</span>
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
