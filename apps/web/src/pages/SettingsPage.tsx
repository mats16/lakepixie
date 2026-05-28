import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, LogIn, LogOut, X } from 'lucide-react';
import { CLAUDE_CODE_PRESET_TOOLS, type UpdateUserSettingsRequest } from '@repo/types';
import { useUser } from '@/hooks/useUser';
import { githubOAuthService, userSettingsService } from '@/services';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type ToolListSettingKey = 'allowed_tools' | 'disallowed_tools';
type ToolInputKind = 'allowed' | 'disallowed';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      role="img"
      viewBox="0 0 16 16"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.7 7.7 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

interface ToolTagInputProps {
  kind: ToolInputKind;
  settingKey: ToolListSettingKey;
  selectedTools: readonly string[];
  query: string;
  savingKey: string | null;
  focusedInput: ToolInputKind | null;
  placeholder: string;
  addPlaceholder: string;
  customHint: (tool: string) => string;
  removeLabel: (tool: string) => string;
  onQueryChange: (value: string) => void;
  onFocusChange: (kind: ToolInputKind | null) => void;
  onToolsChange: (
    settingKey: ToolListSettingKey,
    tools: readonly string[],
    savingKey: string
  ) => void;
}

function ToolTagInput({
  kind,
  settingKey,
  selectedTools,
  query,
  savingKey,
  focusedInput,
  placeholder,
  addPlaceholder,
  customHint,
  removeLabel,
  onQueryChange,
  onFocusChange,
  onToolsChange,
}: ToolTagInputProps) {
  const selectedSet = new Set(selectedTools);
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();
  const suggestions = CLAUDE_CODE_PRESET_TOOLS.filter(
    tool => !selectedSet.has(tool) && tool.toLowerCase().includes(normalizedQuery)
  );
  const showSuggestions = focusedInput === kind && suggestions.length > 0;
  const isSaving = savingKey !== null;

  const updateTools = (tools: readonly string[], tool?: string) => {
    onToolsChange(settingKey, tools, tool ? `${settingKey}:${tool}` : settingKey);
  };

  const addTool = (tool: string) => {
    const trimmedTool = tool.trim();
    if (!trimmedTool || selectedSet.has(trimmedTool)) return;

    updateTools([...selectedTools, trimmedTool], trimmedTool);
    onQueryChange('');
  };

  const removeTool = (tool: string) => {
    updateTools(
      selectedTools.filter(selectedTool => selectedTool !== tool),
      tool
    );
  };

  const addBestMatch = () => {
    if (!trimmedQuery) return;

    const exactMatch = suggestions.find(tool => tool.toLowerCase() === normalizedQuery);
    addTool(exactMatch ?? suggestions[0] ?? trimmedQuery);
  };

  return (
    <div className="relative">
      <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-md border border-input bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
        {selectedTools.map(tool => (
          <Badge
            key={tool}
            variant="secondary"
            className="gap-1 rounded-md py-1 pl-2 pr-1 font-mono text-sm"
          >
            {tool}
            <button
              type="button"
              className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={isSaving}
              aria-label={removeLabel(tool)}
              onClick={() => removeTool(tool)}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <Input
          value={query}
          disabled={isSaving}
          placeholder={selectedTools.length === 0 ? placeholder : addPlaceholder}
          className="h-8 min-w-[180px] flex-1 border-0 px-0 font-mono shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          onChange={event => onQueryChange(event.target.value)}
          onFocus={() => onFocusChange(kind)}
          onBlur={() => onFocusChange(null)}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              addBestMatch();
            }
            if (event.key === 'Backspace' && query.length === 0) {
              const lastTool = selectedTools[selectedTools.length - 1];
              if (lastTool) removeTool(lastTool);
            }
          }}
        />
      </div>
      {showSuggestions && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
          {suggestions.map(tool => (
            <button
              key={tool}
              type="button"
              className="flex w-full items-center rounded-sm px-3 py-2 text-left font-mono text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onMouseDown={event => event.preventDefault()}
              onClick={() => addTool(tool)}
            >
              {tool}
            </button>
          ))}
        </div>
      )}
      {!showSuggestions && trimmedQuery.length > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">{customHint(trimmedQuery)}</p>
      )}
    </div>
  );
}

function getGitHubAuthorizationBadgeVariant(status: string | undefined) {
  return status === 'connected' ? 'default' : 'secondary';
}

export function SettingsContent() {
  const { t } = useTranslation();
  const {
    githubOAuthAuthorization,
    modelSettings,
    refetchGitHubAuthorization,
    refetchModelSettings,
  } = useUser();
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [isDisconnectingGitHub, setIsDisconnectingGitHub] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [allowedToolQuery, setAllowedToolQuery] = useState('');
  const [disallowedToolQuery, setDisallowedToolQuery] = useState('');
  const [focusedToolInput, setFocusedToolInput] = useState<'allowed' | 'disallowed' | null>(null);
  const [activeSettingsTab, setActiveSettingsTab] = useState('claude-code');

  useEffect(() => {
    let isMounted = true;
    refetchModelSettings()
      .catch(err => {
        console.error('Failed to refresh model settings:', err);
      })
      .finally(() => {
        if (isMounted) setIsRefreshing(false);
      });
    return () => {
      isMounted = false;
    };
  }, [refetchModelSettings]);

  const handleModelChange = async (key: keyof UpdateUserSettingsRequest, value: string) => {
    setSavingKey(key);
    try {
      await userSettingsService.updateSettings({ [key]: value });
      await refetchModelSettings();
      toast.success(t('settings.updateSuccess'));
    } catch {
      toast.error(t('settings.updateError'));
    } finally {
      setSavingKey(null);
    }
  };

  const handleToolListChange = async (
    settingKey: ToolListSettingKey,
    tools: readonly string[] | null,
    savingKey: string = settingKey
  ) => {
    setSavingKey(savingKey);
    try {
      await userSettingsService.updateSettings({
        [settingKey]: tools === null ? null : [...tools],
      });
      await refetchModelSettings();
      toast.success(t('settings.updateSuccess'));
    } catch {
      toast.error(t('settings.updateError'));
    } finally {
      setSavingKey(null);
    }
  };

  const connectGitHub = () => {
    window.location.assign(githubOAuthService.getAuthorizeUrl('/settings'));
  };

  const disconnectGitHub = async () => {
    setIsDisconnectingGitHub(true);
    try {
      await githubOAuthService.revoke();
      await refetchGitHubAuthorization();
      toast.success(t('settings.githubDisconnectSuccess'));
    } catch {
      toast.error(t('settings.githubDisconnectError'));
    } finally {
      setIsDisconnectingGitHub(false);
    }
  };

  if (isRefreshing || !modelSettings) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const allowedToolSet = new Set(modelSettings.allowed_tools);
  const allowedToolCount = CLAUDE_CODE_PRESET_TOOLS.filter(tool => allowedToolSet.has(tool)).length;
  const areAllPresetToolsAllowed = CLAUDE_CODE_PRESET_TOOLS.every(tool => allowedToolSet.has(tool));
  const selectedAllowedTools = modelSettings.allowed_tools;
  const selectedDisallowedTools = modelSettings.disallowed_tools;
  const enableAllPresetTools = () => {
    void handleToolListChange('allowed_tools', [
      ...selectedAllowedTools,
      ...CLAUDE_CODE_PRESET_TOOLS.filter(tool => !allowedToolSet.has(tool)),
    ]);
  };
  const handleToolsChange = (
    settingKey: ToolListSettingKey,
    tools: readonly string[],
    nextSavingKey: string
  ) => {
    void handleToolListChange(settingKey, tools, nextSavingKey);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-xl font-bold">{t('settings.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('settings.description')}</p>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-3xl">
          <Tabs
            value={activeSettingsTab}
            onValueChange={setActiveSettingsTab}
            className="space-y-6"
          >
            <TabsList>
              <TabsTrigger value="claude-code">{t('settings.claudeCodeTab')}</TabsTrigger>
              <TabsTrigger value="integration">{t('settings.integrationTab')}</TabsTrigger>
            </TabsList>

            <TabsContent value="integration" className="mt-0 space-y-6">
              <section>
                <div className="rounded-lg border border-border p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <GitHubIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-medium">{t('settings.githubAccount')}</h3>
                          <Badge
                            variant={getGitHubAuthorizationBadgeVariant(
                              githubOAuthAuthorization?.status
                            )}
                            className="rounded-md"
                          >
                            {t(
                              `settings.githubStatus.${githubOAuthAuthorization?.status ?? 'unknown'}`
                            )}
                          </Badge>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {githubOAuthAuthorization?.login
                            ? githubOAuthAuthorization.login
                            : t('settings.githubNoAccount')}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {githubOAuthAuthorization?.status === 'connected' ? (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={isDisconnectingGitHub}
                          onClick={() => void disconnectGitHub()}
                        >
                          {isDisconnectingGitHub ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <LogOut className="h-4 w-4" />
                          )}
                          {t('settings.disconnectGitHub')}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          disabled={githubOAuthAuthorization?.status === 'not_configured'}
                          onClick={connectGitHub}
                        >
                          <LogIn className="h-4 w-4" />
                          {githubOAuthAuthorization?.status === 'expired'
                            ? t('settings.reconnectGitHub')
                            : t('settings.connectGitHub')}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </TabsContent>

            <TabsContent value="claude-code" className="mt-0 space-y-6">
              <section>
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">{t('settings.toolConfiguration')}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('settings.toolConfigurationDescription')}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={savingKey !== null || areAllPresetToolsAllowed}
                    onClick={enableAllPresetTools}
                  >
                    {t('settings.enableAllTools')}
                  </Button>
                </div>
                <div className="rounded-lg border border-border p-4 space-y-5">
                  <div>
                    <div className="mb-3 flex items-center justify-between gap-4">
                      <div>
                        <h3 className="text-sm font-medium">{t('settings.allowedTools')}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {t('settings.allowedToolCount', {
                            count: selectedAllowedTools.length,
                            standardCount: allowedToolCount,
                            total: CLAUDE_CODE_PRESET_TOOLS.length,
                          })}
                        </p>
                      </div>
                    </div>
                    <ToolTagInput
                      kind="allowed"
                      settingKey="allowed_tools"
                      selectedTools={selectedAllowedTools}
                      query={allowedToolQuery}
                      savingKey={savingKey}
                      focusedInput={focusedToolInput}
                      placeholder={t('settings.toolInputPlaceholder')}
                      addPlaceholder={t('settings.toolInputAddPlaceholder')}
                      customHint={tool => t('settings.addCustomToolHint', { tool })}
                      removeLabel={tool => t('settings.removeToolLabel', { tool })}
                      onQueryChange={setAllowedToolQuery}
                      onFocusChange={setFocusedToolInput}
                      onToolsChange={handleToolsChange}
                    />
                  </div>

                  <div>
                    <div className="mb-3 flex items-center justify-between gap-4">
                      <div>
                        <h3 className="text-sm font-medium">{t('settings.disallowedTools')}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {t('settings.disallowedToolCount', {
                            count: selectedDisallowedTools.length,
                          })}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={savingKey !== null || selectedDisallowedTools.length === 0}
                        onClick={() => handleToolListChange('disallowed_tools', null)}
                      >
                        {t('settings.clearDisallowedTools')}
                      </Button>
                    </div>
                    <ToolTagInput
                      kind="disallowed"
                      settingKey="disallowed_tools"
                      selectedTools={selectedDisallowedTools}
                      query={disallowedToolQuery}
                      savingKey={savingKey}
                      focusedInput={focusedToolInput}
                      placeholder={t('settings.toolInputPlaceholder')}
                      addPlaceholder={t('settings.toolInputAddPlaceholder')}
                      customHint={tool => t('settings.addCustomToolHint', { tool })}
                      removeLabel={tool => t('settings.removeToolLabel', { tool })}
                      onQueryChange={setDisallowedToolQuery}
                      onFocusChange={setFocusedToolInput}
                      onToolsChange={handleToolsChange}
                    />
                  </div>
                </div>
              </section>

              <section>
                <h2 className="mb-4 text-lg font-semibold">{t('settings.modelConfiguration')}</h2>
                <div className="rounded-lg border border-border p-4 space-y-4">
                  {(
                    [
                      {
                        key: 'opus_model_id',
                        label: t('admin.opusModel'),
                        value: modelSettings.opus_model_id,
                        options: modelSettings.allowed_model_ids.opus,
                      },
                      {
                        key: 'sonnet_model_id',
                        label: t('admin.sonnetModel'),
                        value: modelSettings.sonnet_model_id,
                        options: modelSettings.allowed_model_ids.sonnet,
                      },
                      {
                        key: 'haiku_model_id',
                        label: t('admin.haikuModel'),
                        value: modelSettings.haiku_model_id,
                        options: modelSettings.allowed_model_ids.haiku,
                      },
                    ] as const
                  ).map(({ key, label, value, options }) => {
                    return (
                      <div key={key} className="flex items-center justify-between gap-4">
                        <p className="shrink-0 text-sm font-medium">{label}</p>
                        <Select
                          value={value}
                          onValueChange={nextValue => handleModelChange(key, nextValue)}
                          disabled={savingKey !== null || options.length === 0}
                        >
                          <SelectTrigger className="w-[360px] max-w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {options.map(modelId => (
                              <SelectItem key={modelId} value={modelId}>
                                {modelId}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              </section>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
