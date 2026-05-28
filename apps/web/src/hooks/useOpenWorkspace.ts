import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useUser } from '@/hooks/useUser';
import { normalizeDatabricksHost } from '@/lib/databricks';
import { workspaceService } from '@/services';

function buildWorkspaceFolderUrl(host: string, objectId: number): string {
  return `https://${normalizeDatabricksHost(host)}/browse/folders/${objectId}`;
}

export function useOpenWorkspace(workspacePath?: string) {
  const { t } = useTranslation();
  const { databricksHost } = useUser();
  const [isOpeningWorkspace, setIsOpeningWorkspace] = useState(false);
  const workspaceObjectIdRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let isCurrent = true;
    workspaceObjectIdRef.current = undefined;
    if (!workspacePath) return;

    workspaceService
      .getStatus(workspacePath)
      .then(status => {
        if (!isCurrent) return;
        workspaceObjectIdRef.current = status.object_id;
      })
      .catch(() => {
        // pre-fetch failure is non-fatal; click handler will retry
      });

    return () => {
      isCurrent = false;
    };
  }, [workspacePath]);

  const openWorkspace = useCallback(() => {
    if (!workspacePath || !databricksHost) return;

    if (workspaceObjectIdRef.current !== undefined) {
      window.open(buildWorkspaceFolderUrl(databricksHost, workspaceObjectIdRef.current), '_blank');
      return;
    }

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
        newWindow.location.href = buildWorkspaceFolderUrl(databricksHost, status.object_id);
      })
      .catch(() => {
        newWindow.close();
        toast.error(t('databricksApp.workspaceOpenError'));
      })
      .finally(() => {
        setIsOpeningWorkspace(false);
      });
  }, [databricksHost, t, workspacePath]);

  return {
    isOpeningWorkspace,
    openWorkspace,
  };
}
