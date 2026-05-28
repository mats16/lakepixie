import { useState } from 'react';
import {
  GitBranch,
  ChevronDown,
  Pencil,
  Archive,
  Download,
  Folder,
  Loader2,
  Rocket,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { downloadSessionSettings } from '@/lib/download-settings';
import { SessionAppButton } from './SessionAppButton';

interface MainHeaderProps {
  title?: string;
  branchName?: string;
  sessionId?: string;
  onTitleUpdate?: (newTitle: string) => Promise<void>;
  onArchive?: () => Promise<void>;
  workspacePath?: string;
  onOpenWorkspace?: () => void;
  isOpeningWorkspace?: boolean;
  showAppButton?: boolean;
  showCreateAppButton?: boolean;
  onCreateApp?: () => void;
  isCreatingApp?: boolean;
  createAppDisabled?: boolean;
}

export function MainHeader({
  title = 'New Session',
  branchName,
  sessionId,
  onTitleUpdate,
  onArchive,
  workspacePath,
  onOpenWorkspace,
  isOpeningWorkspace = false,
  showAppButton = false,
  showCreateAppButton = false,
  onCreateApp,
  isCreatingApp = false,
  createAppDisabled = false,
}: MainHeaderProps) {
  const { t } = useTranslation();
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [newTitle, setNewTitle] = useState(title);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleOpenRenameDialog = () => {
    setNewTitle(title);
    setIsRenameDialogOpen(true);
  };

  const handleRename = async () => {
    if (!onTitleUpdate || newTitle.trim() === '') return;

    setIsSubmitting(true);
    try {
      await onTitleUpdate(newTitle.trim());
      setIsRenameDialogOpen(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleArchive = async () => {
    if (!onArchive) return;
    await onArchive();
  };

  const handleDownloadSettings = async () => {
    if (!sessionId) return;
    try {
      await downloadSessionSettings(sessionId, title);
    } catch (error) {
      console.error('Failed to download settings:', error);
      toast.error(t('main.downloadSettingsError'));
    }
  };

  const createAppButton = showCreateAppButton ? (
    <Button
      type="button"
      size="sm"
      className="h-8 shrink-0 gap-1.5"
      onClick={onCreateApp}
      disabled={isCreatingApp || createAppDisabled || !onCreateApp}
      aria-label={t(isCreatingApp ? 'databricksApp.creating' : 'databricksApp.create')}
    >
      {isCreatingApp ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Rocket className="h-3.5 w-3.5" />
      )}
      <span className="hidden sm:inline">
        {t(isCreatingApp ? 'databricksApp.creating' : 'databricksApp.createShort')}
      </span>
    </Button>
  ) : null;
  const openWorkspaceButton = workspacePath ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 shrink-0 gap-1.5"
      onClick={onOpenWorkspace}
      disabled={isOpeningWorkspace || !onOpenWorkspace}
      aria-label={t('databricksApp.openWorkspace')}
      title={workspacePath}
    >
      {isOpeningWorkspace ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Folder className="h-3.5 w-3.5" />
      )}
      <span className="hidden sm:inline">{t('databricksApp.workspace')}</span>
    </Button>
  ) : null;

  return (
    <>
      <div className="flex items-center justify-between h-[50px] px-4 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-1 font-medium text-foreground">
                <span className="truncate max-w-[300px]">{title}</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-0">
              <DropdownMenuItem onClick={handleOpenRenameDialog}>
                <Pencil className="h-4 w-4" />
                {t('main.renameSession')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleArchive}>
                <Archive className="h-4 w-4" />
                {t('main.archiveSession')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleDownloadSettings} disabled={!sessionId}>
                <Download className="h-4 w-4" />
                {t('main.downloadSettings')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2">
          {branchName && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                    <GitBranch className="h-3.5 w-3.5" />
                    <span className="text-xs truncate max-w-[150px]">{branchName}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{branchName}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {openWorkspaceButton ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>{openWorkspaceButton}</TooltipTrigger>
                <TooltipContent className="max-w-[420px]">
                  <p className="break-all">{workspacePath}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {showAppButton ? <SessionAppButton sessionId={sessionId} /> : createAppButton}
        </div>
      </div>

      <Dialog open={isRenameDialogOpen} onOpenChange={setIsRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('main.renameSession')}</DialogTitle>
          </DialogHeader>
          <Input
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder={t('main.sessionTitlePlaceholder')}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !isSubmitting) {
                handleRename();
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRenameDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleRename} disabled={isSubmitting || newTitle.trim() === ''}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
