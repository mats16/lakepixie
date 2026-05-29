import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Loader2, Logs, Rocket, Settings, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { DatabricksApp } from '@repo/types';
import { APP_STATUS_POLLING_INTERVAL_MS, APP_STATUS_POLLING_STABLE_INTERVAL_MS } from '@/constants';
import { useUser } from '@/hooks/useUser';
import { normalizeDatabricksHost } from '@/lib/databricks';
import { cn } from '@/lib/utils';
import { sessionService } from '@/services/session.service';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface SessionAppButtonProps {
  sessionId?: string;
  appName?: string;
  onAppDeleted?: () => void | Promise<void>;
}

type AppStateType = 'RUNNING' | 'DEPLOYING' | 'CRASHED' | 'UNAVAILABLE' | 'UNKNOWN';

const APP_STATE_ICON_CLASS: Record<AppStateType, string> = {
  RUNNING: 'text-green-500',
  DEPLOYING: 'text-yellow-500 animate-spin',
  CRASHED: 'text-red-500',
  UNAVAILABLE: 'text-red-500',
  UNKNOWN: 'text-foreground',
};

const STABLE_STATES = new Set<string>(['RUNNING', 'CRASHED', 'UNAVAILABLE']);
const DEFAULT_APPS_CONSOLE_URL_TEMPLATE = '/apps-v2/app/:appName/overview';

function withLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function buildAppOverviewUrl(host: string, appName: string): string {
  const template =
    import.meta.env.VITE_DATABRICKS_APPS_CONSOLE_URL_TEMPLATE?.trim() ||
    DEFAULT_APPS_CONSOLE_URL_TEMPLATE;
  const path = template.replace(':appName', encodeURIComponent(appName));
  return `https://${normalizeDatabricksHost(host)}${withLeadingSlash(path)}`;
}

function getPollingInterval(state: string | undefined): number {
  return state && STABLE_STATES.has(state)
    ? APP_STATUS_POLLING_STABLE_INTERVAL_MS
    : APP_STATUS_POLLING_INTERVAL_MS;
}

function getAppStateIconClass(state: string | undefined): string {
  return APP_STATE_ICON_CLASS[(state as AppStateType) ?? 'UNKNOWN'] ?? APP_STATE_ICON_CLASS.UNKNOWN;
}

export function SessionAppButton({
  sessionId,
  appName: sessionAppName,
  onAppDeleted,
}: SessionAppButtonProps) {
  const { t } = useTranslation();
  const { databricksHost } = useUser();
  const [appInfo, setAppInfo] = useState<DatabricksApp | null>(null);
  const [isDeletingApp, setIsDeletingApp] = useState(false);
  const [isAppDeleted, setIsAppDeleted] = useState(false);
  const [deleteDialogAppName, setDeleteDialogAppName] = useState<string | null>(null);
  const fetchAppInfoRef = useRef<() => Promise<void>>(undefined);
  const appStateRef = useRef<string | undefined>(undefined);

  const fetchAppInfo = useCallback(async () => {
    if (!sessionId || isDeletingApp || isAppDeleted) return;
    try {
      const response = await fetch(`/api/sessions/${sessionId}/app`);
      if (!response.ok) {
        console.warn(`[SessionAppButton] App info fetch failed with status ${response.status}`);
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
        if (
          prev?.name === app.name &&
          prev?.app_status?.state === app.app_status?.state &&
          prev?.url === app.url
        ) {
          return prev;
        }
        return app;
      });
    } catch (error) {
      console.warn('[SessionAppButton] Failed to fetch app info:', error);
      setAppInfo(prev => (prev === null ? prev : null));
    }
  }, [isAppDeleted, isDeletingApp, sessionId]);

  useEffect(() => {
    fetchAppInfoRef.current = fetchAppInfo;
  }, [fetchAppInfo]);

  useEffect(() => {
    if (!sessionId) return;

    let timeoutId: ReturnType<typeof setTimeout>;
    const poll = () => {
      fetchAppInfoRef.current?.();
      timeoutId = setTimeout(poll, getPollingInterval(appStateRef.current));
    };

    fetchAppInfoRef.current?.();
    timeoutId = setTimeout(poll, getPollingInterval(appStateRef.current));

    return () => clearTimeout(timeoutId);
  }, [sessionId]);

  if (!sessionId) return null;

  const appState = appInfo?.app_status?.state ?? 'UNKNOWN';
  const appName = isAppDeleted ? undefined : (appInfo?.name ?? sessionAppName);
  const canOpenDeployedApp = !!appInfo?.url;
  const canOpenConsole = !!appName && !!databricksHost;
  const canDeleteApp = !!appName;
  const appActionsDisabled = !canOpenDeployedApp && !canOpenConsole && !canDeleteApp;
  const appButtonLabel =
    appState === 'UNKNOWN' ? t('databricksApp.app') : `${t('databricksApp.app')} (${appState})`;

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
    if (appName && databricksHost) {
      window.open(buildAppOverviewUrl(databricksHost, appName), '_blank');
    }
  };

  const handleOpenDeleteDialog = () => {
    if (!appName || isDeletingApp) return;
    setDeleteDialogAppName(appName);
  };

  const handleDeleteApp = async () => {
    if (!sessionId || !deleteDialogAppName || isDeletingApp) return;

    setIsDeletingApp(true);
    try {
      const result = await sessionService.deleteSessionApp(sessionId);
      appStateRef.current = undefined;
      setAppInfo(null);
      setIsAppDeleted(true);
      setDeleteDialogAppName(null);
      toast.success(t('databricksApp.deleteSuccess', { name: result.name }));
      await onAppDeleted?.();
    } catch (error) {
      console.error('[SessionAppButton] Failed to delete app:', error);
      toast.error(error instanceof Error ? error.message : t('databricksApp.deleteError'));
    } finally {
      setIsDeletingApp(false);
    }
  };

  return (
    <>
      <div className="flex shrink-0 overflow-hidden rounded-md border shadow-sm">
        <Button
          type="button"
          variant="ghost"
          className="h-8 min-w-0 gap-1.5 rounded-none px-2.5 py-0 text-sm leading-none"
          onClick={handleOpenApp}
          disabled={!canOpenDeployedApp}
          aria-label={appButtonLabel}
          title={appButtonLabel}
        >
          <Rocket className={cn('h-4 w-4 shrink-0', getAppStateIconClass(appState))} />
          <span className="hidden sm:inline">{t('databricksApp.app')}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-none border-l py-0"
              disabled={appActionsDisabled}
              aria-label={t('databricksApp.actions')}
              title={t('databricksApp.actions')}
            >
              <ChevronDown className="h-3.5 w-3.5" />
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
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={handleOpenDeleteDialog}
              disabled={!canDeleteApp || isDeletingApp}
            >
              <Trash2 className="h-4 w-4" />
              {t('databricksApp.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog
        open={deleteDialogAppName !== null}
        onOpenChange={open => {
          if (!open && !isDeletingApp) setDeleteDialogAppName(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('databricksApp.deleteConfirm', { name: deleteDialogAppName })}
            </DialogTitle>
            <DialogDescription>{t('databricksApp.deleteDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteDialogAppName(null)}
              disabled={isDeletingApp}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDeleteApp}
              disabled={isDeletingApp}
            >
              {isDeletingApp ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t(isDeletingApp ? 'databricksApp.deleting' : 'databricksApp.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
