import { FolderGit2, FolderSync } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type SyncingIndicatorKind = 'workspace' | 'git';

interface SyncingIndicatorProps {
  kind: SyncingIndicatorKind;
}

export function SyncingIndicator({ kind }: SyncingIndicatorProps) {
  const { t } = useTranslation();
  const Icon = kind === 'git' ? FolderGit2 : FolderSync;
  const label = kind === 'git' ? t('main.cloningGitRepository') : t('main.syncingWorkspace');
  const iconClassName =
    kind === 'git'
      ? 'h-4 w-4 animate-pulse text-muted-foreground'
      : 'h-4 w-4 animate-spin text-muted-foreground';

  return (
    <div className="py-3 mb-8" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm">
        <Icon className={iconClassName} />
        <span className="text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}
