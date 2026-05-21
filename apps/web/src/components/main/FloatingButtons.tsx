import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Rocket, Folder, Settings, Logs, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
}

type AppStateType = 'RUNNING' | 'DEPLOYING' | 'CRASHED' | 'UNAVAILABLE' | 'UNKNOWN';

interface AppStateStyle {
  iconClass: string;
  badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline';
  badgeClass: string;
}

const APP_STATE_STYLES: Record<AppStateType, AppStateStyle> = {
  RUNNING: {
    iconClass: 'text-green-500',
    badgeVariant: 'default',
    badgeClass: 'bg-green-500 hover:bg-green-500',
  },
  DEPLOYING: {
    iconClass: 'text-yellow-500 animate-spin',
    badgeVariant: 'secondary',
    badgeClass: 'bg-yellow-500 hover:bg-yellow-500 text-black',
  },
  CRASHED: {
    iconClass: 'text-red-500',
    badgeVariant: 'destructive',
    badgeClass: 'bg-red-500 hover:bg-red-500',
  },
  UNAVAILABLE: {
    iconClass: 'text-red-500',
    badgeVariant: 'destructive',
    badgeClass: 'bg-red-500 hover:bg-red-500',
  },
  UNKNOWN: {
    iconClass: 'text-foreground',
    badgeVariant: 'secondary',
    badgeClass: '',
  },
};

function getAppStateStyle(state: string | undefined): AppStateStyle {
  return APP_STATE_STYLES[(state as AppStateType) ?? 'UNKNOWN'] ?? APP_STATE_STYLES.UNKNOWN;
}

const STABLE_STATES = new Set<string>(['RUNNING', 'CRASHED', 'UNAVAILABLE']);

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
}: FloatingButtonsProps) {
  const showWorkspaceButton = !!workspacePath;
  const { t } = useTranslation();
  const { databricksHost } = useUser();
  const [appInfo, setAppInfo] = useState<DatabricksApp | null>(null);
  const [isOpeningWorkspace, setIsOpeningWorkspace] = useState(false);
  const workspaceObjectIdRef = useRef<number | undefined>(undefined);
  const fetchAppInfoRef = useRef<() => Promise<void>>(undefined);
  const appStateRef = useRef<string | undefined>(undefined);

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

  const appState = appInfo?.app_status?.state ?? 'UNKNOWN';
  const style = getAppStateStyle(appState);

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
      const consoleUrl = `https://${databricksHost}/apps/${appInfo.name}`;
      window.open(consoleUrl, '_blank');
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
              <span className="min-w-0 truncate text-sm font-medium">{workspacePath}</span>
            </button>
          )}

          {showAppButton && (
            <div
              className={cn(
                'flex min-w-0 items-center gap-2 overflow-hidden',
                showWorkspaceButton ? 'max-w-[42%] shrink-0' : 'ml-auto'
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 hover:opacity-70 disabled:opacity-50"
                onClick={handleOpenApp}
                disabled={!appInfo?.url}
              >
                <Rocket className={cn('h-4 w-4 shrink-0', style.iconClass)} />
                <span className="truncate text-sm font-medium">{t('databricksApp.app')}</span>
              </button>
              <Badge
                variant={style.badgeVariant}
                className={cn('shrink-0 text-xs px-1.5 py-0', style.badgeClass)}
              >
                {appState}
              </Badge>
              <span className="shrink-0 text-muted-foreground">|</span>
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 hover:opacity-70 disabled:opacity-50"
                onClick={handleOpenLogs}
                disabled={!appInfo?.url}
              >
                <Logs className="h-4 w-4 shrink-0 text-foreground" />
                <span className="truncate text-sm font-medium">{t('databricksApp.logs')}</span>
              </button>
              <span className="shrink-0 text-muted-foreground">|</span>
              <button
                type="button"
                className="shrink-0 hover:opacity-70 disabled:opacity-50"
                onClick={handleOpenConsole}
                disabled={!appInfo?.name}
              >
                <Settings className="h-4 w-4 text-foreground" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
