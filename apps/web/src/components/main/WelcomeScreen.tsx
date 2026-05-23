import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import useLocalStorageState from 'use-local-storage-state';
import { useTranslation } from 'react-i18next';
import {
  Send,
  Image,
  ChevronDown,
  Check,
  Loader2,
  Bug,
  Construction,
  DatabaseZap,
  DatabaseSearch,
  Cable,
  Sparkles,
  Network,
  Rocket,
  FolderGit2,
  GitBranch,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { QuickstartCard } from './QuickstartCard';
import { QuickstartModal, QuickstartType } from './QuickstartModal';
import { ImagePreview } from './ImagePreview';
import { DropZoneOverlay } from './DropZoneOverlay';
import { WorkspaceSelector } from '@/components/workspace/WorkspaceSelector';
import { useImageAttachment } from '@/hooks/useImageAttachment';
import { useDragDrop } from '@/hooks/useDragDrop';
import { buildMessageContent } from '@/lib/content-builder';
import { gitRepositoryService } from '@/services';
import {
  SESSION_MODELS,
  DEFAULT_SESSION_MODEL,
  TEXTAREA_MAX_HEIGHT_MAIN,
  MCP_DBSQL_ID,
} from '@/constants';
import { useMcpSelection, type McpSelectionItem } from '@/hooks/useMcpSelection';
import { useUser } from '@/hooks/useUser';
import type {
  UserMessageContentBlock,
  GitRepositoryBranchCandidate,
  GitRepositoryCandidate,
  McpConfig,
  WorkspaceSelection,
} from '@repo/types';

export type NewSessionSourceType = 'databricks_workspace' | 'git_repository';

export interface NewSessionParams {
  content: UserMessageContentBlock[];
  modelId: string;
  sourceType: NewSessionSourceType;
  gitRepository: GitRepositoryCandidate | null;
  gitRepositoryBranch: string | null;
  enableDatabricksSqlWrite: boolean;
  enableDatabricksApps: boolean;
  workspaceSelection: WorkspaceSelection | null;
  mcpConfig?: McpConfig;
  allowedTools?: string[];
  disallowedTools?: string[];
}

interface WelcomeScreenProps {
  onNewSession?: (params: NewSessionParams) => Promise<void> | void;
  sessionError?: string | null;
}

function getMcpItemIcon(item: McpSelectionItem): LucideIcon {
  if (item.managed_type === 'databricks_sql' || item.space_id === MCP_DBSQL_ID) {
    return DatabaseSearch;
  }
  if (item.managed_type === 'databricks_genie') {
    return Sparkles;
  }
  if (item.managed_type === 'unity_ai_gateway') {
    return Network;
  }
  return Sparkles;
}

function McpItemIcon({ item }: { item: McpSelectionItem }) {
  const Icon = getMcpItemIcon(item);
  return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

export function WelcomeScreen({ onNewSession, sessionError }: WelcomeScreenProps) {
  const { t } = useTranslation();
  const { welcomeHeading, githubAppId, modelSettings } = useUser();
  const canUseGitRepositorySource = Boolean(githubAppId);
  const [selectedQuickstart, setSelectedQuickstart] = useState<QuickstartType | null>(null);
  const [content, setContent] = useLocalStorageState('chat-draft-new-session', {
    defaultValue: '',
  });
  const [selectedModelId, setSelectedModelId] = useLocalStorageState('selected-model-id', {
    defaultValue: DEFAULT_SESSION_MODEL.id,
  });
  const selectedModel = SESSION_MODELS.find(m => m.id === selectedModelId) ?? DEFAULT_SESSION_MODEL;
  const [sourceType, setSourceType] = useState<NewSessionSourceType>('databricks_workspace');
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceSelection | null>(null);
  const [gitRepositories, setGitRepositories] = useState<GitRepositoryCandidate[]>([]);
  const [selectedGitRepositoryName, setSelectedGitRepositoryName] = useState<string | null>(null);
  const [gitRepositoryBranches, setGitRepositoryBranches] = useState<
    Record<string, GitRepositoryBranchCandidate[]>
  >({});
  const [selectedGitRepositoryBranch, setSelectedGitRepositoryBranch] = useState<string | null>(
    null
  );
  const [gitRepositorySearchOpen, setGitRepositorySearchOpen] = useState(false);
  const [gitRepositorySearchQuery, setGitRepositorySearchQuery] = useState('');
  const [isSearchingGitRepositories, setIsSearchingGitRepositories] = useState(false);
  const [gitRepositoryLoadError, setGitRepositoryLoadError] = useState(false);
  const [loadingGitRepositoryBranchName, setLoadingGitRepositoryBranchName] = useState<
    string | null
  >(null);
  const [gitRepositoryBranchLoadErrors, setGitRepositoryBranchLoadErrors] = useState<
    Record<string, boolean>
  >({});
  const [hasLoadedGitRepositories, setHasLoadedGitRepositories] = useState(false);
  const [enableDatabricksSqlWrite, setEnableDatabricksSqlWrite] = useState(false);
  const [enableDatabricksApps, setEnableDatabricksApps] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const {
    items: mcpItems,
    enabledCount: mcpEnabledCount,
    toggleItem: toggleMcpItem,
    buildMcpConfig,
    buildAllowedTools,
    buildDisallowedTools,
  } = useMcpSelection();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const gitRepositoryLoadPromiseRef = useRef<Promise<void> | null>(null);
  const gitRepositoryBranchLoadPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const lastSelectedGitRepositoryNameRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);

  // 画像添付フック
  const { images, isProcessing, addImages, removeImage, clearImages, hasImages } =
    useImageAttachment({
      onError: message => {
        // TODO: トーストで表示
        console.error(message);
      },
    });

  // ドラッグ&ドロップフック
  const { isDragging } = useDragDrop(containerRef, {
    onDrop: addImages,
    disabled: isSubmitting,
  });

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, TEXTAREA_MAX_HEIGHT_MAIN)}px`;
    }
  }, [content]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadGitRepositories = useCallback(
    (force = false) => {
      if (!canUseGitRepositorySource) return Promise.resolve();
      if (hasLoadedGitRepositories && !force) return Promise.resolve();
      if (gitRepositoryLoadPromiseRef.current) return gitRepositoryLoadPromiseRef.current;

      setIsSearchingGitRepositories(true);
      setGitRepositoryLoadError(false);
      gitRepositoryLoadPromiseRef.current = gitRepositoryService
        .search('')
        .then(response => {
          if (!isMountedRef.current) return;
          const repositories = response.repositories;
          setGitRepositories(repositories);
          setHasLoadedGitRepositories(true);
          setSelectedGitRepositoryName(current =>
            current && repositories.some(repository => repository.full_name === current)
              ? current
              : (repositories[0]?.full_name ?? null)
          );
        })
        .catch(() => {
          if (!isMountedRef.current) return;
          setGitRepositories([]);
          setSelectedGitRepositoryName(null);
          setGitRepositoryLoadError(true);
          setHasLoadedGitRepositories(false);
        })
        .finally(() => {
          gitRepositoryLoadPromiseRef.current = null;
          if (isMountedRef.current) {
            setIsSearchingGitRepositories(false);
          }
        });

      return gitRepositoryLoadPromiseRef.current;
    },
    [canUseGitRepositorySource, hasLoadedGitRepositories]
  );

  useEffect(() => {
    if (sourceType === 'git_repository' && canUseGitRepositorySource) {
      void loadGitRepositories();
    }
  }, [canUseGitRepositorySource, loadGitRepositories, sourceType]);

  useEffect(() => {
    if (canUseGitRepositorySource) return;
    if (sourceType === 'git_repository') {
      setSourceType('databricks_workspace');
    }
    setGitRepositories([]);
    setSelectedGitRepositoryName(null);
    setSelectedGitRepositoryBranch(null);
    setGitRepositoryLoadError(false);
    setHasLoadedGitRepositories(false);
  }, [canUseGitRepositorySource, sourceType]);

  const filteredGitRepositories = useMemo(() => {
    const query = gitRepositorySearchQuery.trim().toLowerCase();
    if (!query) return gitRepositories;
    return gitRepositories.filter(repository => repository.full_name.toLowerCase().includes(query));
  }, [gitRepositories, gitRepositorySearchQuery]);

  const selectedGitRepository =
    gitRepositories.find(repository => repository.full_name === selectedGitRepositoryName) ?? null;
  const selectedGitRepositoryBranches = selectedGitRepositoryName
    ? (gitRepositoryBranches[selectedGitRepositoryName] ?? [])
    : [];
  const isLoadingSelectedGitRepositoryBranches =
    selectedGitRepositoryName !== null &&
    loadingGitRepositoryBranchName === selectedGitRepositoryName;
  const selectedGitRepositoryBranchLoadError =
    selectedGitRepositoryName !== null &&
    gitRepositoryBranchLoadErrors[selectedGitRepositoryName] === true;
  let gitRepositoryEmptyMessage = t('welcome.sourceType.noRepositories');
  if (gitRepositoryLoadError) {
    gitRepositoryEmptyMessage = t('welcome.sourceType.repositoriesLoadError');
  }
  if (isSearchingGitRepositories) {
    gitRepositoryEmptyMessage = t('common.loading');
  }

  const loadGitRepositoryBranches = useCallback(
    (repository: GitRepositoryCandidate) => {
      const repositoryName = repository.full_name;
      if (
        gitRepositoryBranches[repositoryName] &&
        gitRepositoryBranchLoadErrors[repositoryName] !== true
      ) {
        return Promise.resolve();
      }
      const existingPromise = gitRepositoryBranchLoadPromisesRef.current.get(repositoryName);
      if (existingPromise) return existingPromise;

      setLoadingGitRepositoryBranchName(repositoryName);
      setGitRepositoryBranchLoadErrors(current => ({ ...current, [repositoryName]: false }));
      const promise = gitRepositoryService
        .listBranches(repositoryName)
        .then(response => {
          if (!isMountedRef.current) return;
          const branches = response.branches;
          setGitRepositoryBranches(current => ({ ...current, [repositoryName]: branches }));
          setSelectedGitRepositoryBranch(current => {
            if (lastSelectedGitRepositoryNameRef.current !== repositoryName) return current;
            if (current && branches.some(branch => branch.name === current)) return current;
            if (
              repository.default_branch &&
              branches.some(branch => branch.name === repository.default_branch)
            ) {
              return repository.default_branch;
            }
            return branches[0]?.name ?? null;
          });
        })
        .catch(() => {
          if (!isMountedRef.current) return;
          setGitRepositoryBranches(current => ({ ...current, [repositoryName]: [] }));
          setGitRepositoryBranchLoadErrors(current => ({ ...current, [repositoryName]: true }));
          setSelectedGitRepositoryBranch(current =>
            lastSelectedGitRepositoryNameRef.current === repositoryName ? null : current
          );
        })
        .finally(() => {
          gitRepositoryBranchLoadPromisesRef.current.delete(repositoryName);
          if (isMountedRef.current) {
            setLoadingGitRepositoryBranchName(current =>
              current === repositoryName ? null : current
            );
          }
        });

      gitRepositoryBranchLoadPromisesRef.current.set(repositoryName, promise);
      return promise;
    },
    [gitRepositoryBranchLoadErrors, gitRepositoryBranches]
  );

  useEffect(() => {
    if (sourceType !== 'git_repository' || !selectedGitRepository) {
      lastSelectedGitRepositoryNameRef.current = null;
      setSelectedGitRepositoryBranch(null);
      return;
    }

    if (lastSelectedGitRepositoryNameRef.current !== selectedGitRepository.full_name) {
      lastSelectedGitRepositoryNameRef.current = selectedGitRepository.full_name;
      setSelectedGitRepositoryBranch(selectedGitRepository.default_branch ?? null);
    }

    void loadGitRepositoryBranches(selectedGitRepository);
  }, [loadGitRepositoryBranches, selectedGitRepository, sourceType]);

  const handleSourceTypeChange = (value: string) => {
    const nextSourceType = value as NewSessionSourceType;
    if (nextSourceType === 'git_repository' && !canUseGitRepositorySource) return;
    setSourceType(nextSourceType);
    if (nextSourceType === 'git_repository') {
      void loadGitRepositories();
    }
  };

  const handleGitRepositorySearchOpenChange = (open: boolean) => {
    setGitRepositorySearchOpen(open);
    if (open && canUseGitRepositorySource) {
      void loadGitRepositories();
    }
  };

  const handleGitRepositoryRetry = () => {
    setHasLoadedGitRepositories(false);
    void loadGitRepositories(true);
  };

  const handleGitRepositoryBranchRetry = () => {
    if (selectedGitRepository) {
      void loadGitRepositoryBranches(selectedGitRepository);
    }
  };

  const handleSubmit = async () => {
    const hasContent = content.trim() || hasImages;
    if (!hasContent || isSubmitting) return;
    if (sourceType === 'git_repository' && !canUseGitRepositorySource) return;
    if (sourceType === 'git_repository' && !selectedGitRepository) return;
    if (sourceType === 'git_repository' && !selectedGitRepositoryBranch) return;
    if (sourceType === 'git_repository' && gitRepositoryLoadError) return;
    if (sourceType === 'git_repository' && selectedGitRepositoryBranchLoadError) return;
    if (sourceType === 'git_repository' && isLoadingSelectedGitRepositoryBranches) return;

    setIsSubmitting(true);
    try {
      const messageContent = buildMessageContent(content.trim(), images);
      const mcpConfig = buildMcpConfig();
      const allowedTools = buildAllowedTools(modelSettings?.allowed_tools);
      const disallowedTools = buildDisallowedTools(modelSettings?.disallowed_tools);
      await onNewSession?.({
        content: messageContent,
        modelId: selectedModel.id,
        sourceType,
        gitRepository: selectedGitRepository,
        gitRepositoryBranch: sourceType === 'git_repository' ? selectedGitRepositoryBranch : null,
        enableDatabricksSqlWrite,
        enableDatabricksApps,
        workspaceSelection: sourceType === 'databricks_workspace' ? selectedWorkspace : null,
        mcpConfig,
        allowedTools,
        disallowedTools,
      });
      setContent('');
      clearImages();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleImageButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        addImages(files);
      }
      // 同じファイルを再選択できるようにリセット
      e.target.value = '';
    },
    [addImages]
  );

  const hasSelectedGitRepository =
    sourceType !== 'git_repository' ||
    (selectedGitRepository !== null && !gitRepositoryLoadError && !isSearchingGitRepositories);
  const hasSelectedGitRepositoryBranch =
    sourceType !== 'git_repository' ||
    (selectedGitRepositoryBranch !== null &&
      !selectedGitRepositoryBranchLoadError &&
      !isLoadingSelectedGitRepositoryBranches);
  const canSubmit =
    (content.trim() || hasImages) &&
    !isSubmitting &&
    hasSelectedGitRepository &&
    hasSelectedGitRepositoryBranch;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const quickstarts = [
    {
      type: 'lakeflow' as const,
      icon: Bug,
      title: t('welcome.quickstarts.lakeflow.title'),
      description: t('welcome.quickstarts.lakeflow.description'),
    },
    {
      type: 'tbd' as const,
      icon: Construction,
      title: t('welcome.quickstarts.tbd.title'),
      description: t('welcome.quickstarts.tbd.description'),
    },
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      {/* Title */}
      <div className="w-full max-w-3xl mb-6 text-center">
        <h1 className="text-2xl font-semibold text-foreground">
          {welcomeHeading || t('welcome.heading')}
        </h1>
      </div>

      {/* Source Selector */}
      <div className="w-full max-w-3xl mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[220px_minmax(0,1fr)]">
        <Select value={sourceType} onValueChange={handleSourceTypeChange} disabled={isSubmitting}>
          <SelectTrigger>
            <SelectValue placeholder={t('welcome.sourceType.placeholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="databricks_workspace">
              {t('welcome.sourceType.databricksWorkspace')}
            </SelectItem>
            {canUseGitRepositorySource && (
              <SelectItem value="git_repository">
                {t('welcome.sourceType.gitRepository')}
              </SelectItem>
            )}
          </SelectContent>
        </Select>

        {sourceType === 'databricks_workspace' ? (
          <WorkspaceSelector
            value={selectedWorkspace}
            onChange={setSelectedWorkspace}
            disabled={isSubmitting}
          />
        ) : (
          <div className="min-w-0 space-y-2">
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_180px]">
              <Popover
                open={gitRepositorySearchOpen}
                onOpenChange={handleGitRepositorySearchOpenChange}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={gitRepositorySearchOpen}
                    className="h-10 w-full justify-between px-3 font-normal"
                    disabled={isSubmitting}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {selectedGitRepositoryName && <FolderGit2 className="h-4 w-4 shrink-0" />}
                      <span
                        className={cn(
                          'truncate',
                          !selectedGitRepositoryName && 'text-muted-foreground'
                        )}
                      >
                        {selectedGitRepositoryName ?? t('welcome.sourceType.repositoryPlaceholder')}
                      </span>
                    </div>
                    <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[var(--radix-popover-trigger-width)] p-0"
                  align="start"
                >
                  <Command shouldFilter={false}>
                    <CommandInput
                      value={gitRepositorySearchQuery}
                      onValueChange={setGitRepositorySearchQuery}
                      placeholder={t('welcome.sourceType.repositorySearchPlaceholder')}
                    />
                    <CommandList>
                      <CommandEmpty>{gitRepositoryEmptyMessage}</CommandEmpty>
                      {filteredGitRepositories.map(repository => (
                        <CommandItem
                          key={repository.full_name}
                          value={repository.full_name}
                          onSelect={() => {
                            setSelectedGitRepositoryName(repository.full_name);
                            setGitRepositorySearchOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              'h-4 w-4',
                              selectedGitRepositoryName === repository.full_name
                                ? 'opacity-100'
                                : 'opacity-0'
                            )}
                          />
                          <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">{repository.full_name}</span>
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              <Select
                value={selectedGitRepositoryBranch ?? undefined}
                onValueChange={setSelectedGitRepositoryBranch}
                disabled={
                  isSubmitting || !selectedGitRepository || isLoadingSelectedGitRepositoryBranches
                }
              >
                <SelectTrigger className="h-10 w-full px-3 font-normal">
                  <div className="flex min-w-0 items-center gap-2">
                    {isLoadingSelectedGitRepositoryBranches ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <GitBranch className="h-4 w-4 shrink-0" />
                    )}
                    <SelectValue placeholder={t('welcome.sourceType.branchPlaceholder')} />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {selectedGitRepositoryBranches.length === 0 ? (
                    <SelectItem value="__no_branches__" disabled>
                      {t('welcome.sourceType.noBranches')}
                    </SelectItem>
                  ) : (
                    selectedGitRepositoryBranches.map(branch => (
                      <SelectItem key={branch.name} value={branch.name}>
                        {branch.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {(gitRepositoryLoadError || selectedGitRepositoryBranchLoadError) && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
                <span>
                  {gitRepositoryLoadError
                    ? t('welcome.sourceType.repositoriesLoadError')
                    : t('welcome.sourceType.branchesLoadError')}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={
                    gitRepositoryLoadError
                      ? handleGitRepositoryRetry
                      : handleGitRepositoryBranchRetry
                  }
                >
                  {t('common.retry')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Chat Input Area */}
      <div ref={containerRef} className="relative w-full max-w-3xl mb-6">
        <DropZoneOverlay isVisible={isDragging} />
        <div className="relative flex flex-col rounded-xl border border-border bg-background p-3 shadow-sm">
          {/* 画像プレビュー */}
          <ImagePreview images={images} onRemove={removeImage} disabled={isSubmitting} />

          <Textarea
            ref={textareaRef}
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('sidebar.newSessionPlaceholder')}
            className="min-h-[60px] max-h-[150px] w-full resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-none px-1 py-0 text-base"
            rows={2}
          />
          <div className="flex items-center justify-between shrink-0 mt-2">
            <div className="flex items-center gap-1">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={handleImageButtonClick}
                      disabled={isSubmitting || isProcessing}
                    >
                      {isProcessing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Image className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('sidebar.attachImage')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'h-8 w-8 shrink-0',
                        enableDatabricksSqlWrite && 'bg-orange-500/10'
                      )}
                      onClick={() => setEnableDatabricksSqlWrite(prev => !prev)}
                      disabled={isSubmitting}
                    >
                      <DatabaseZap
                        className={cn(
                          'h-4 w-4',
                          enableDatabricksSqlWrite
                            ? 'text-orange-500 stroke-[2.5]'
                            : 'text-muted-foreground'
                        )}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('welcome.databricksSqlWriteToggle')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn('h-8 w-8 shrink-0', enableDatabricksApps && 'bg-red-500/10')}
                      onClick={() => setEnableDatabricksApps(prev => !prev)}
                      disabled={isSubmitting}
                    >
                      <Rocket
                        className={cn(
                          'h-4 w-4',
                          enableDatabricksApps
                            ? 'text-red-500 stroke-[2.5]'
                            : 'text-muted-foreground'
                        )}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('databricksApp.enableApps')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              {mcpItems.length > 0 && (
                <Popover>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className={cn(
                              'h-8 px-2 shrink-0 gap-1',
                              mcpEnabledCount > 0 && 'bg-primary/10'
                            )}
                            disabled={isSubmitting}
                          >
                            <Cable
                              className={cn(
                                'h-4 w-4',
                                mcpEnabledCount > 0
                                  ? 'text-primary stroke-[2.5]'
                                  : 'text-muted-foreground'
                              )}
                            />
                            {mcpEnabledCount > 0 && (
                              <span className="text-xs text-primary font-medium">
                                {mcpEnabledCount}
                              </span>
                            )}
                          </Button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('mcp.sessionDropdownLabel')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <PopoverContent align="start" className="w-64 p-2">
                    <div className="space-y-1">
                      {mcpItems.map(item => (
                        <div
                          key={item.space_id}
                          className="flex items-center justify-between w-full px-2 py-1.5 rounded-md text-sm hover:bg-accent transition-colors"
                        >
                          <label
                            htmlFor={`mcp-session-${item.space_id}`}
                            className="flex items-center gap-2 truncate cursor-pointer"
                          >
                            <McpItemIcon item={item} />
                            <span className="truncate">{item.title}</span>
                          </label>
                          <Switch
                            id={`mcp-session-${item.space_id}`}
                            checked={item.enabled}
                            onCheckedChange={() => toggleMcpItem(item.space_id)}
                            className="shrink-0 ml-2 h-5 w-9 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4"
                          />
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>

            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-sm text-muted-foreground hover:text-foreground"
                  >
                    {selectedModel.shortName}
                    <ChevronDown className="h-3 w-3 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {SESSION_MODELS.map(model => (
                    <DropdownMenuItem
                      key={model.id}
                      onClick={() => setSelectedModelId(model.id)}
                      className="flex items-start justify-between py-2"
                    >
                      <div className="flex flex-col">
                        <span className="font-medium">{model.name}</span>
                        {model.descriptionKey && (
                          <span className="text-xs text-muted-foreground">
                            {t(model.descriptionKey)}
                          </span>
                        )}
                      </div>
                      {selectedModel.id === model.id && (
                        <Check className="h-4 w-4 text-primary shrink-0 ml-2" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={handleSubmit}
                      disabled={!canSubmit}
                    >
                      {isSubmitting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('sidebar.startSession')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        </div>
        {sessionError && (
          <div className="mt-2 px-1">
            <p className="text-sm text-destructive">{sessionError}</p>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {/* Quickstart Cards - Horizontal Layout */}
      <div className="w-full max-w-3xl grid grid-cols-1 md:grid-cols-2 gap-3">
        {quickstarts.map(qs => (
          <QuickstartCard
            key={qs.type}
            icon={qs.icon}
            title={qs.title}
            description={qs.description}
            onClick={() => setSelectedQuickstart(qs.type)}
          />
        ))}
      </div>

      {/* Quickstart Modal */}
      <QuickstartModal
        open={selectedQuickstart !== null}
        onOpenChange={open => !open && setSelectedQuickstart(null)}
        quickstartType={selectedQuickstart}
        onFillPrompt={prompt => {
          setContent(prompt);
        }}
      />
    </div>
  );
}
