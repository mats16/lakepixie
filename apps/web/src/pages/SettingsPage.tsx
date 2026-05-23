import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, X } from 'lucide-react';
import { CLAUDE_CODE_PRESET_TOOLS, type UpdateUserSettingsRequest } from '@repo/types';
import { useUser } from '@/hooks/useUser';
import { userSettingsService } from '@/services';
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

type ToolListSettingKey = 'allowed_tools' | 'disallowed_tools';
type ToolInputKind = 'allowed' | 'disallowed';

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

export function SettingsContent() {
  const { t } = useTranslation();
  const { modelSettings, refetchModelSettings } = useUser();
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [allowedToolQuery, setAllowedToolQuery] = useState('');
  const [disallowedToolQuery, setDisallowedToolQuery] = useState('');
  const [focusedToolInput, setFocusedToolInput] = useState<'allowed' | 'disallowed' | null>(null);

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
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6">
      <div className="max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">{t('settings.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('settings.description')}</p>
        </div>

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
      </div>
    </div>
  );
}
