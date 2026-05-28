import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import useLocalStorageState from 'use-local-storage-state';
import { useTranslation } from 'react-i18next';
import {
  Send,
  Image,
  ChevronDown,
  Check,
  Loader2,
  Plus,
  X,
  Bug,
  Construction,
  DatabaseZap,
  DatabaseSearch,
  Cable,
  Sparkles,
  Network,
  Folder,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  ListTodo,
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
import { githubOAuthService, gitRepositoryService } from '@/services';
import {
  SESSION_MODELS,
  DEFAULT_SESSION_MODEL,
  EFFORT_LEVEL_OPTIONS,
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
  WsEffortLevel,
  WorkspaceSelection,
} from '@repo/types';

export type NewSessionSourceType = 'databricks_workspace' | 'git_repository';

interface DraftSourceSelection {
  id: string;
  type: NewSessionSourceType | null;
  workspaceSelection: WorkspaceSelection | null;
  gitRepositoryName: string | null;
  gitRepositoryBranch: string | null;
}

export type NewSessionSourceSelection =
  | {
      type: 'databricks_workspace';
      workspaceSelection: WorkspaceSelection;
    }
  | {
      type: 'git_repository';
      gitRepository: GitRepositoryCandidate;
      gitRepositoryBranch: string;
    };

export interface NewSessionParams {
  content: UserMessageContentBlock[];
  modelId: string;
  effortLevel: WsEffortLevel;
  sourceSelections: NewSessionSourceSelection[];
  enableDatabricksSqlWrite: boolean;
  isPlanMode: boolean;
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

function createDraftSourceSelection(): DraftSourceSelection {
  return {
    id: crypto.randomUUID(),
    type: null,
    workspaceSelection: null,
    gitRepositoryName: null,
    gitRepositoryBranch: null,
  };
}

export function WelcomeScreen({ onNewSession, sessionError }: WelcomeScreenProps) {
  const { t } = useTranslation();
  const { welcomeHeading, githubOAuthAuthorization, modelSettings } = useUser();
  const isGitHubIntegrationConfigured =
    githubOAuthAuthorization !== null && githubOAuthAuthorization.status !== 'not_configured';
  const canUseGitRepositorySource = githubOAuthAuthorization?.status === 'connected';
  const [selectedQuickstart, setSelectedQuickstart] = useState<QuickstartType | null>(null);
  const [content, setContent] = useLocalStorageState('chat-draft-new-session', {
    defaultValue: '',
  });
  const [selectedModelId, setSelectedModelId] = useLocalStorageState('selected-model-id', {
    defaultValue: DEFAULT_SESSION_MODEL.id,
  });
  const [selectedEffortLevel, setSelectedEffortLevel] = useLocalStorageState<WsEffortLevel>(
    'selected-effort-level',
    {
      defaultValue: 'high',
    }
  );
  const selectedModel = SESSION_MODELS.find(m => m.id === selectedModelId) ?? DEFAULT_SESSION_MODEL;
  const selectedEffort = EFFORT_LEVEL_OPTIONS.includes(selectedEffortLevel)
    ? selectedEffortLevel
    : 'high';
  const [sourceSelections, setSourceSelections] = useState<DraftSourceSelection[]>([]);
  const [gitRepositories, setGitRepositories] = useState<GitRepositoryCandidate[]>([]);
  const [gitRepositoryBranches, setGitRepositoryBranches] = useState<
    Record<string, GitRepositoryBranchCandidate[]>
  >({});
  const [openGitRepositorySourceId, setOpenGitRepositorySourceId] = useState<string | null>(null);
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
  const [isPlanMode, setIsPlanMode] = useState(false);
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
          setSourceSelections(current =>
            current.map(source => {
              if (source.type !== 'git_repository') return source;
              const gitRepositoryName =
                source.gitRepositoryName &&
                repositories.some(repository => repository.full_name === source.gitRepositoryName)
                  ? source.gitRepositoryName
                  : (repositories[0]?.full_name ?? null);
              const repository = repositories.find(
                candidate => candidate.full_name === gitRepositoryName
              );
              return {
                ...source,
                gitRepositoryName,
                gitRepositoryBranch:
                  source.gitRepositoryName === gitRepositoryName
                    ? source.gitRepositoryBranch
                    : (repository?.default_branch ?? null),
              };
            })
          );
        })
        .catch(() => {
          if (!isMountedRef.current) return;
          setGitRepositories([]);
          setSourceSelections(current =>
            current.map(source =>
              source.type === 'git_repository'
                ? { ...source, gitRepositoryName: null, gitRepositoryBranch: null }
                : source
            )
          );
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

  const hasGitRepositorySource = sourceSelections.some(source => source.type === 'git_repository');
  const hasDatabricksWorkspaceSource = sourceSelections.some(
    source => source.type === 'databricks_workspace'
  );
  const canAddDatabricksWorkspaceSource = !hasDatabricksWorkspaceSource;
  const canAddGitRepositorySource = isGitHubIntegrationConfigured;
  const canAddSource = canAddDatabricksWorkspaceSource || canAddGitRepositorySource;

  useEffect(() => {
    if (hasGitRepositorySource && canUseGitRepositorySource) {
      void loadGitRepositories();
    }
  }, [canUseGitRepositorySource, hasGitRepositorySource, loadGitRepositories]);

  useEffect(() => {
    if (canUseGitRepositorySource) return;
    setSourceSelections(current => current.filter(source => source.type !== 'git_repository'));
    setGitRepositories([]);
    setOpenGitRepositorySourceId(null);
    setGitRepositoryLoadError(false);
    setHasLoadedGitRepositories(false);
  }, [canUseGitRepositorySource]);

  const filteredGitRepositories = useMemo(() => {
    const query = gitRepositorySearchQuery.trim().toLowerCase();
    if (!query) return gitRepositories;
    return gitRepositories.filter(repository => repository.full_name.toLowerCase().includes(query));
  }, [gitRepositories, gitRepositorySearchQuery]);
  const gitRepositoryByName = useMemo(
    () => new Map(gitRepositories.map(repository => [repository.full_name, repository])),
    [gitRepositories]
  );

  let gitRepositoryEmptyMessage = t('welcome.sourceType.noRepositories');
  if (gitRepositoryLoadError) {
    gitRepositoryEmptyMessage = t('welcome.sourceType.repositoriesLoadError');
  }
  if (isSearchingGitRepositories) {
    gitRepositoryEmptyMessage = t('common.loading');
  }

  const loadGitRepositoryBranches = useCallback(
    (repository: GitRepositoryCandidate, force = false) => {
      const repositoryName = repository.full_name;
      if (gitRepositoryBranchLoadErrors[repositoryName] === true && !force) {
        return Promise.resolve();
      }
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
          setSourceSelections(current =>
            current.map(source => {
              if (
                source.type !== 'git_repository' ||
                source.gitRepositoryName !== repositoryName ||
                (source.gitRepositoryBranch &&
                  branches.some(branch => branch.name === source.gitRepositoryBranch))
              ) {
                return source;
              }

              const defaultBranch =
                repository.default_branch &&
                branches.some(branch => branch.name === repository.default_branch)
                  ? repository.default_branch
                  : (branches[0]?.name ?? null);
              return { ...source, gitRepositoryBranch: defaultBranch };
            })
          );
        })
        .catch(() => {
          if (!isMountedRef.current) return;
          setGitRepositoryBranches(current => ({ ...current, [repositoryName]: [] }));
          setGitRepositoryBranchLoadErrors(current => ({ ...current, [repositoryName]: true }));
          setSourceSelections(current =>
            current.map(source =>
              source.type === 'git_repository' && source.gitRepositoryName === repositoryName
                ? { ...source, gitRepositoryBranch: null }
                : source
            )
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
    for (const source of sourceSelections) {
      if (source.type !== 'git_repository' || !source.gitRepositoryName) continue;
      const repository = gitRepositoryByName.get(source.gitRepositoryName);
      if (repository) {
        void loadGitRepositoryBranches(repository);
      }
    }
  }, [gitRepositoryByName, loadGitRepositoryBranches, sourceSelections]);

  const updateSourceSelection = (
    sourceId: string,
    updater: (source: DraftSourceSelection) => DraftSourceSelection
  ) => {
    setSourceSelections(current =>
      current.map(source => (source.id === sourceId ? updater(source) : source))
    );
  };

  const handleAddSourceSelection = (nextSourceType: NewSessionSourceType) => {
    if (nextSourceType === 'databricks_workspace' && !canAddDatabricksWorkspaceSource) return;
    if (nextSourceType === 'git_repository' && !canAddGitRepositorySource) return;
    if (nextSourceType === 'git_repository' && !canUseGitRepositorySource) {
      const redirectAfter = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.open(
        githubOAuthService.getAuthorizeUrl(redirectAfter),
        '_blank',
        'noopener,noreferrer'
      );
      return;
    }
    const gitRepository = nextSourceType === 'git_repository' ? (gitRepositories[0] ?? null) : null;
    setSourceSelections(current => [
      ...current,
      {
        ...createDraftSourceSelection(),
        type: nextSourceType,
        gitRepositoryName: gitRepository?.full_name ?? null,
        gitRepositoryBranch: gitRepository?.default_branch ?? null,
      },
    ]);
    if (nextSourceType === 'git_repository') {
      void loadGitRepositories();
    }
  };

  const handleGitRepositorySearchOpenChange = (sourceId: string, open: boolean) => {
    setOpenGitRepositorySourceId(open ? sourceId : null);
    if (open && canUseGitRepositorySource) {
      void loadGitRepositories();
    }
  };

  const handleGitRepositorySelect = (sourceId: string, repository: GitRepositoryCandidate) => {
    updateSourceSelection(sourceId, source => ({
      ...source,
      gitRepositoryName: repository.full_name,
      gitRepositoryBranch: repository.default_branch ?? null,
    }));
    setOpenGitRepositorySourceId(null);
    void loadGitRepositoryBranches(repository);
  };

  const handleRemoveSourceSelection = (sourceId: string) => {
    setSourceSelections(current => current.filter(source => source.id !== sourceId));
    setOpenGitRepositorySourceId(current => (current === sourceId ? null : current));
  };

  const handleGitRepositoryRetry = () => {
    setHasLoadedGitRepositories(false);
    void loadGitRepositories(true);
  };

  const handleGitRepositoryBranchRetry = (repositoryName: string | null) => {
    if (!repositoryName || gitRepositoryBranchLoadErrors[repositoryName] !== true) return;
    const repository = gitRepositoryByName.get(repositoryName);
    if (repository) {
      void loadGitRepositoryBranches(repository, true);
    }
  };

  const finalizedSourceSelections = useMemo(
    () =>
      sourceSelections.flatMap((source): NewSessionSourceSelection[] => {
        if (source.type === 'databricks_workspace') {
          return source.workspaceSelection
            ? [{ type: 'databricks_workspace', workspaceSelection: source.workspaceSelection }]
            : [];
        }
        if (source.type === 'git_repository') {
          const repository = source.gitRepositoryName
            ? (gitRepositoryByName.get(source.gitRepositoryName) ?? null)
            : null;
          return repository && source.gitRepositoryBranch
            ? [
                {
                  type: 'git_repository',
                  gitRepository: repository,
                  gitRepositoryBranch: source.gitRepositoryBranch,
                },
              ]
            : [];
        }
        return [];
      }),
    [gitRepositoryByName, sourceSelections]
  );

  const hasIncompleteGitRepositorySource = sourceSelections.some(source => {
    if (source.type !== 'git_repository') return false;
    if (!canUseGitRepositorySource) return true;
    if (gitRepositoryLoadError || isSearchingGitRepositories) return true;
    if (!source.gitRepositoryName || !source.gitRepositoryBranch) return true;
    return (
      gitRepositoryBranchLoadErrors[source.gitRepositoryName] === true ||
      loadingGitRepositoryBranchName === source.gitRepositoryName
    );
  });

  const handleSubmit = async () => {
    const hasContent = content.trim() || hasImages;
    if (!hasContent || isSubmitting) return;
    if (hasIncompleteGitRepositorySource) return;

    setIsSubmitting(true);
    try {
      const messageContent = buildMessageContent(content.trim(), images);
      const mcpConfig = buildMcpConfig();
      const allowedTools = buildAllowedTools(modelSettings?.allowed_tools);
      const disallowedTools = buildDisallowedTools(modelSettings?.disallowed_tools);
      await onNewSession?.({
        content: messageContent,
        modelId: selectedModel.id,
        effortLevel: selectedEffort,
        sourceSelections: finalizedSourceSelections,
        enableDatabricksSqlWrite,
        isPlanMode,
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

  const canSubmit =
    (content.trim() || hasImages) && !isSubmitting && !hasIncompleteGitRepositorySource;

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

  const renderAddSourceMenu = (className: string, label?: string) => {
    if (!canAddSource) return null;

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size={label ? 'default' : 'icon'}
            className={className}
            disabled={isSubmitting}
            aria-label={label ?? t('common.add')}
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            {label && <span className="truncate">{label}</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {canAddDatabricksWorkspaceSource && (
            <DropdownMenuItem onClick={() => handleAddSourceSelection('databricks_workspace')}>
              <Folder className="h-4 w-4" />
              {t('welcome.sourceType.databricksWorkspace')}
            </DropdownMenuItem>
          )}
          {canAddGitRepositorySource && (
            <DropdownMenuItem onClick={() => handleAddSourceSelection('git_repository')}>
              <GitPullRequest className="h-4 w-4" />
              {t('welcome.sourceType.gitRepository')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      {/* Title */}
      <div className="w-full max-w-3xl mb-6 text-center">
        <h1 className="text-2xl font-semibold text-foreground">
          {welcomeHeading || t('welcome.heading')}
        </h1>
      </div>

      {/* Source Selector */}
      <div className="w-full max-w-3xl mb-4 space-y-2">
        {sourceSelections.length === 0 && (
          <div className="flex min-w-0 items-center gap-2">{renderAddSourceMenu('h-8 w-8')}</div>
        )}

        {sourceSelections.map((source, index) => {
          const selectedGitRepository = source.gitRepositoryName
            ? (gitRepositoryByName.get(source.gitRepositoryName) ?? null)
            : null;
          const selectedGitRepositoryBranches = source.gitRepositoryName
            ? (gitRepositoryBranches[source.gitRepositoryName] ?? [])
            : [];
          const isLoadingSelectedGitRepositoryBranches =
            source.gitRepositoryName !== null &&
            loadingGitRepositoryBranchName === source.gitRepositoryName;
          const selectedGitRepositoryBranchLoadError =
            source.gitRepositoryName !== null &&
            gitRepositoryBranchLoadErrors[source.gitRepositoryName] === true;
          const showAddButton = index === sourceSelections.length - 1;

          return (
            <div key={source.id} className="space-y-2">
              <div className="flex min-w-0 items-center gap-2">
                {source.type === 'databricks_workspace' && (
                  <WorkspaceSelector
                    value={source.workspaceSelection}
                    onChange={workspaceSelection =>
                      updateSourceSelection(source.id, current => ({
                        ...current,
                        workspaceSelection,
                      }))
                    }
                    disabled={isSubmitting}
                  />
                )}

                {source.type === 'git_repository' && (
                  <>
                    <Popover
                      open={openGitRepositorySourceId === source.id}
                      onOpenChange={open => handleGitRepositorySearchOpenChange(source.id, open)}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={openGitRepositorySourceId === source.id}
                          className="h-8 min-w-0 w-fit max-w-full justify-between gap-3 px-2 text-sm font-normal"
                          disabled={isSubmitting}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <GitPullRequest className="h-3.5 w-3.5 shrink-0" />
                            <span
                              className={cn(
                                'truncate',
                                !source.gitRepositoryName && 'text-muted-foreground'
                              )}
                            >
                              {source.gitRepositoryName ??
                                t('welcome.sourceType.repositoryPlaceholder')}
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
                                onSelect={() => handleGitRepositorySelect(source.id, repository)}
                              >
                                <Check
                                  className={cn(
                                    'h-4 w-4',
                                    source.gitRepositoryName === repository.full_name
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
                      value={source.gitRepositoryBranch ?? undefined}
                      onValueChange={branch =>
                        updateSourceSelection(source.id, current => ({
                          ...current,
                          gitRepositoryBranch: branch,
                        }))
                      }
                      disabled={
                        isSubmitting ||
                        !selectedGitRepository ||
                        isLoadingSelectedGitRepositoryBranches
                      }
                    >
                      <SelectTrigger className="h-8 min-w-0 w-fit max-w-[150px] px-2 text-sm font-normal">
                        <div className="flex min-w-0 items-center gap-2">
                          {isLoadingSelectedGitRepositoryBranches ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                          ) : (
                            <GitBranch className="h-3.5 w-3.5 shrink-0" />
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
                  </>
                )}

                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => handleRemoveSourceSelection(source.id)}
                  disabled={isSubmitting}
                  aria-label={t('common.remove')}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>

                {showAddButton ? renderAddSourceMenu('h-8 w-8') : <div />}
              </div>

              {source.type === 'git_repository' &&
                (gitRepositoryLoadError || selectedGitRepositoryBranchLoadError) && (
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
                          : () => handleGitRepositoryBranchRetry(source.gitRepositoryName)
                      }
                    >
                      {t('common.retry')}
                    </Button>
                  </div>
                )}
            </div>
          );
        })}
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

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        'h-8 shrink-0 gap-1 px-2 text-xs text-muted-foreground',
                        isPlanMode && 'bg-primary/10 text-primary'
                      )}
                      onClick={() => setIsPlanMode(prev => !prev)}
                      disabled={isSubmitting}
                      aria-label={t('main.planMode')}
                      aria-pressed={isPlanMode}
                    >
                      <ListTodo
                        className={cn(
                          'h-4 w-4',
                          isPlanMode ? 'text-primary stroke-[2.5]' : 'text-muted-foreground'
                        )}
                      />
                      <span>{t('main.planMode')}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('main.planModeTooltip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
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

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-sm text-muted-foreground hover:text-foreground"
                    title={t('main.effortControl')}
                  >
                    {selectedEffort}
                    <ChevronDown className="h-3 w-3 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                  {EFFORT_LEVEL_OPTIONS.map(effortLevel => (
                    <DropdownMenuItem
                      key={effortLevel}
                      onClick={() => setSelectedEffortLevel(effortLevel)}
                      className="flex items-center justify-between py-2"
                    >
                      <span className="font-medium">{effortLevel}</span>
                      {selectedEffort === effortLevel && (
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
