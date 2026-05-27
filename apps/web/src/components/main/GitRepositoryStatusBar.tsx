import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  GitCommitVertical,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { gitRepositoryService } from '@/services/git-repository.service';
import { sessionService } from '@/services/session.service';
import type {
  GitRepositoryBranchDetailResponse,
  GitRepositoryDiffResponse,
  GitRepositoryPullRequest,
} from '@repo/types';

interface GitRepositoryStatusBarProps {
  sessionId?: string;
  owner: string;
  repo: string;
  headBranch: string;
  baseBranch: string;
  sessionTitle?: string;
  diffRefreshKey?: number;
  remoteRefreshKey?: number;
  bottomClassName?: string;
}

function repositoryFullName(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function repositoryUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

function pullRequestCreateUrl(owner: string, repo: string, base: string, head: string): string {
  return `${repositoryUrl(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`;
}

function openUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

type PullStatusKey = 'open' | 'closed' | 'merged' | 'draft' | 'none';

const PULL_STATUS_ICON: Record<PullStatusKey, typeof GitCommitVertical> = {
  none: GitCommitVertical,
  merged: GitMerge,
  draft: GitPullRequestDraft,
  closed: GitPullRequestClosed,
  open: GitPullRequestArrow,
};

const PULL_STATUS_CLASS: Record<PullStatusKey, string> = {
  none: 'text-foreground',
  merged: 'text-purple-600',
  draft: 'text-muted-foreground',
  closed: 'text-red-600',
  open: 'text-green-600',
};

function getPullStatusKey(pull: GitRepositoryPullRequest | null): PullStatusKey {
  if (!pull) return 'none';
  if (pull.merged) return 'merged';
  if (pull.draft) return 'draft';
  return pull.state;
}

function hasPullRequestDiff(diff: GitRepositoryDiffResponse | null | undefined): boolean {
  if (!diff) return false;
  return diff.total_commits > 0 || diff.additions > 0 || diff.deletions > 0;
}

export function GitRepositoryStatusBar({
  sessionId,
  owner,
  repo,
  headBranch,
  baseBranch,
  sessionTitle,
  diffRefreshKey = 0,
  remoteRefreshKey = 0,
  bottomClassName = 'pb-[7.5rem]',
}: GitRepositoryStatusBarProps) {
  const { t, i18n } = useTranslation();
  const fullName = repositoryFullName(owner, repo);
  const [branchDetail, setBranchDetail] = useState<GitRepositoryBranchDetailResponse | null>(null);
  const [localDiff, setLocalDiff] = useState<GitRepositoryDiffResponse | null>(null);
  const [pull, setPull] = useState<GitRepositoryPullRequest | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [pendingPullRequestDraft, setPendingPullRequestDraft] = useState<boolean | null>(null);

  useEffect(() => {
    let isCurrent = true;

    void Promise.allSettled([
      gitRepositoryService.getBranch(fullName, headBranch, baseBranch),
      gitRepositoryService.listPullRequests(fullName, {
        head: `${owner}:${headBranch}`,
        base: baseBranch,
        state: 'all',
      }),
    ]).then(([branchResult, pullsResult]) => {
      if (!isCurrent) return;

      if (branchResult.status === 'fulfilled') {
        setBranchDetail(branchResult.value);
      } else {
        console.warn(
          '[GitRepositoryStatusBar] Failed to load branch details:',
          branchResult.reason
        );
      }

      if (pullsResult.status === 'fulfilled') {
        setPull(pullsResult.value.pulls[0] ?? null);
      } else {
        console.warn('[GitRepositoryStatusBar] Failed to load pull requests:', pullsResult.reason);
      }
    });

    return () => {
      isCurrent = false;
    };
  }, [baseBranch, fullName, headBranch, owner, remoteRefreshKey]);

  useEffect(() => {
    let isCurrent = true;

    if (!sessionId) {
      setLocalDiff(null);
      return;
    }

    void sessionService
      .getGitDiff(sessionId)
      .then(diff => {
        if (isCurrent) setLocalDiff(diff);
      })
      .catch(error => {
        if (!isCurrent) return;
        console.warn('[GitRepositoryStatusBar] Failed to load local git diff:', error);
        setLocalDiff(null);
      });

    return () => {
      isCurrent = false;
    };
  }, [diffRefreshKey, sessionId]);

  const handleCopyBranch = async () => {
    try {
      await navigator.clipboard.writeText(headBranch);
      toast.success(t('gitStatus.branchCopied'));
    } catch {
      toast.error(t('gitStatus.branchCopyError'));
    }
  };

  const handleCreatePullRequest = async (draft: boolean) => {
    setIsCreating(true);
    try {
      const createdPull = await gitRepositoryService.createPullRequest(fullName, {
        title: sessionTitle?.trim() || headBranch,
        head: `${owner}:${headBranch}`,
        base: baseBranch,
        draft,
        ...(sessionId ? { session_id: sessionId } : {}),
        language: i18n.resolvedLanguage ?? i18n.language,
      });
      setPull(createdPull);
      openUrl(createdPull.html_url);
    } catch (error) {
      console.warn('[GitRepositoryStatusBar] Failed to create pull request:', error);
      toast.error(t('gitStatus.createPullRequestError'));
    } finally {
      setIsCreating(false);
      setPendingPullRequestDraft(null);
    }
  };

  const handleConfirmPullRequest = () => {
    if (pendingPullRequestDraft === null) return;
    void handleCreatePullRequest(pendingPullRequestDraft);
  };

  const diff = localDiff ?? branchDetail?.compare;
  const diffBadge = diff ? (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium leading-none shadow-sm">
      <span className="text-green-600">+{diff.additions}</span>
      <span className="text-red-600">-{diff.deletions}</span>
    </span>
  ) : null;
  const statusKey = getPullStatusKey(pull);
  const StatusIcon = PULL_STATUS_ICON[statusKey];
  const statusTooltip = t(`gitStatus.status.${statusKey}`);
  const remoteBranchUrl = branchDetail?.html_url;
  const manualPullRequestUrl = pullRequestCreateUrl(owner, repo, baseBranch, headBranch);
  const canShowCreatePullRequest = branchDetail !== null && !pull;
  const isDiffKnownEmpty = diff !== null && diff !== undefined && !hasPullRequestDiff(diff);
  const canCreatePullRequest = canShowCreatePullRequest && !isDiffKnownEmpty;
  const createPullRequestDisabledReason = isDiffKnownEmpty
    ? t('gitStatus.createPullRequestDisabledNoDiff')
    : undefined;
  const createPullRequestButtonGroup = canShowCreatePullRequest ? (
    <div className="flex overflow-hidden rounded-md border shadow-sm">
      <Button
        type="button"
        variant="ghost"
        className="h-6 rounded-none px-2 text-xs"
        onClick={() => setPendingPullRequestDraft(false)}
        disabled={isCreating || !canCreatePullRequest}
      >
        {t('gitStatus.createPullRequest')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 rounded-none border-l"
            disabled={isCreating || !canCreatePullRequest}
            aria-label={t('gitStatus.createPullRequestOptions')}
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setPendingPullRequestDraft(false)}>
            <GitPullRequestArrow className="h-4 w-4" />
            {t('gitStatus.createPullRequest')}
            <Check className="ml-auto h-4 w-4" />
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setPendingPullRequestDraft(true)}>
            <GitPullRequestDraft className="h-4 w-4" />
            {t('gitStatus.createDraftPullRequest')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openUrl(manualPullRequestUrl)}>
            <ExternalLink className="h-4 w-4" />
            {t('gitStatus.createPullRequestManually')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ) : null;

  return (
    <>
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0 px-4 pointer-events-none z-10',
          bottomClassName
        )}
      >
        <div className="w-full max-w-[735px] mx-auto pointer-events-auto">
          <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 shadow-lg">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex shrink-0 items-center gap-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <StatusIcon className={cn('h-4 w-4', PULL_STATUS_CLASS[statusKey])} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{statusTooltip}</p>
                  </TooltipContent>
                </Tooltip>
                {pull && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-sm font-medium hover:underline"
                        onClick={() => openUrl(pull.html_url)}
                      >
                        #{pull.number}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('gitStatus.openPullRequest')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="truncate text-sm text-muted-foreground hover:text-foreground"
                    onClick={() => openUrl(repositoryUrl(owner, repo))}
                  >
                    {repo}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t('gitStatus.openRepository')}</p>
                </TooltipContent>
              </Tooltip>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="min-w-0 truncate text-sm font-medium hover:underline"
                  >
                    {headBranch}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={handleCopyBranch}>
                    <Copy className="h-4 w-4" />
                    {t('gitStatus.copyBranch')}
                  </DropdownMenuItem>
                  {remoteBranchUrl && (
                    <DropdownMenuItem onClick={() => openUrl(remoteBranchUrl)}>
                      <ExternalLink className="h-4 w-4" />
                      {t('gitStatus.openBranch')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {diffBadge}
              {createPullRequestDisabledReason && createPullRequestButtonGroup ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">{createPullRequestButtonGroup}</span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{createPullRequestDisabledReason}</p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                createPullRequestButtonGroup
              )}
            </div>
          </div>
        </div>
      </div>
      <Dialog
        open={pendingPullRequestDraft !== null}
        onOpenChange={open => {
          if (!open) setPendingPullRequestDraft(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('gitStatus.metadataDialog.title')}</DialogTitle>
            <DialogDescription>{t('gitStatus.metadataDialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingPullRequestDraft(null)}
              disabled={isCreating}
            >
              {t('gitStatus.metadataDialog.cancel')}
            </Button>
            <Button type="button" onClick={handleConfirmPullRequest} disabled={isCreating}>
              {pendingPullRequestDraft
                ? t('gitStatus.createDraftPullRequest')
                : t('gitStatus.createPullRequest')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
