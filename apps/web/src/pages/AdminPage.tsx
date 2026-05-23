import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronsUpDown,
  Database,
  ExternalLink,
  HelpCircle,
  Info,
  Loader2,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  User as UserIcon,
} from 'lucide-react';
import type {
  AdminUserInfo,
  AppSettingsResponse,
  GitHubAppAuthResponse,
  ServingEndpointsByTier,
  UpdateAppSettingsRequest,
} from '@repo/types';
import { useUser } from '@/hooks/useUser';
import { adminService } from '@/services';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClearableInput } from '@/components/ui/clearable-input';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const GITHUB_APPS_SETTINGS_URL = 'https://github.com/settings/apps';

type MlflowSettingKey =
  | 'mlflow_experiment_id'
  | 'otel_metrics_table_name'
  | 'otel_logs_table_name'
  | 'otel_traces_table_name';

function classifyModelTier(modelId: string): keyof ServingEndpointsByTier | null {
  const lower = modelId.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

function groupModelIdsByTier(modelIds: string[]): ServingEndpointsByTier {
  const grouped: ServingEndpointsByTier = { opus: [], sonnet: [], haiku: [] };
  for (const modelId of modelIds) {
    const tier = classifyModelTier(modelId);
    if (tier) grouped[tier].push(modelId);
  }
  for (const tier of ['opus', 'sonnet', 'haiku'] as const) {
    grouped[tier] = [...new Set(grouped[tier])].sort((a, b) => b.localeCompare(a));
  }
  return grouped;
}

function flattenServingEndpoints(endpoints: ServingEndpointsByTier | null): string[] {
  return endpoints ? [...endpoints.opus, ...endpoints.sonnet, ...endpoints.haiku] : [];
}

function useAdminSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettingsResponse | null>(null);
  const [isLoadingSettings, setIsLoadingSettings] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoadingSettings(true);
      const data = await adminService.getSettings();
      setSettings(data);
    } catch {
      toast.error(t('admin.fetchError'));
    } finally {
      setIsLoadingSettings(false);
    }
  }, [t]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSetting = useCallback(
    async (key: string, patch: Parameters<typeof adminService.updateSettings>[0]) => {
      setSavingKey(key);
      try {
        const updatedSettings = await adminService.updateSettings(patch);
        setSettings(updatedSettings);
        toast.success(t('admin.updateSettingsSuccess'));
        return true;
      } catch {
        toast.error(t('admin.updateSettingsError'));
        return false;
      } finally {
        setSavingKey(null);
      }
    },
    [t]
  );

  return { settings, isLoadingSettings, savingKey, saveSetting, refreshSettings: fetchSettings };
}

function useGitHubAppAuth() {
  const { t } = useTranslation();
  const [githubAppAuth, setGitHubAppAuth] = useState<GitHubAppAuthResponse | null>(null);
  const [isLoadingGitHubAppAuth, setIsLoadingGitHubAppAuth] = useState(true);
  const [isSavingGitHubAppAuth, setIsSavingGitHubAppAuth] = useState(false);

  const fetchGitHubAppAuth = useCallback(async () => {
    try {
      setIsLoadingGitHubAppAuth(true);
      const data = await adminService.getGitHubAppAuth();
      setGitHubAppAuth(data);
    } catch {
      toast.error(t('admin.fetchGitHubAppAuthError'));
    } finally {
      setIsLoadingGitHubAppAuth(false);
    }
  }, [t]);

  useEffect(() => {
    fetchGitHubAppAuth();
  }, [fetchGitHubAppAuth]);

  const saveGitHubAppAuth = useCallback(
    async (patch: Parameters<typeof adminService.updateGitHubAppAuth>[0]) => {
      setIsSavingGitHubAppAuth(true);
      try {
        const updated = await adminService.updateGitHubAppAuth(patch);
        setGitHubAppAuth(updated);
        toast.success(t('admin.updateSettingsSuccess'));
        return true;
      } catch {
        toast.error(t('admin.updateGitHubAppAuthError'));
        return false;
      } finally {
        setIsSavingGitHubAppAuth(false);
      }
    },
    [t]
  );

  return {
    githubAppAuth,
    isLoadingGitHubAppAuth,
    isSavingGitHubAppAuth,
    saveGitHubAppAuth,
  };
}

interface GitHubAppGuideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function GitHubAppGuideDialog({ open, onOpenChange }: GitHubAppGuideDialogProps) {
  const { t } = useTranslation();
  const steps = [
    t('admin.githubAppGuideStepCreate'),
    t('admin.githubAppGuideStepUrls'),
    t('admin.githubAppGuideStepPermissions'),
    t('admin.githubAppGuideStepInstall'),
    t('admin.githubAppGuideStepPrivateKey'),
    t('admin.githubAppGuideStepSave'),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('admin.githubAppGuideTitle')}</DialogTitle>
          <DialogDescription>{t('admin.githubAppGuideDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <Button variant="outline" asChild>
            <a href={GITHUB_APPS_SETTINGS_URL} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              {t('admin.githubAppGuideOpenSettings')}
            </a>
          </Button>

          <div className="rounded-md border border-border p-4">
            <h3 className="text-sm font-medium">{t('admin.githubAppGuideStepsTitle')}</h3>
            <ol className="mt-3 space-y-3 text-sm text-muted-foreground">
              {steps.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
                    {index + 1}
                  </span>
                  <span className="pt-0.5">{step}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="rounded-md border border-border p-4">
            <h3 className="text-sm font-medium">{t('admin.githubAppGuideValuesTitle')}</h3>
            <dl className="mt-3 grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t('admin.githubAppGuideCallbackUrl')}</dt>
              <dd>{t('admin.githubAppGuideCallbackUrlValue')}</dd>
              <dt className="text-muted-foreground">{t('admin.githubAppGuideWebhook')}</dt>
              <dd>{t('admin.githubAppGuideWebhookValue')}</dd>
              <dt className="text-muted-foreground">
                {t('admin.githubAppGuideContentsPermission')}
              </dt>
              <dd>{t('admin.githubAppGuideContentsPermissionValue')}</dd>
              <dt className="text-muted-foreground">
                {t('admin.githubAppGuidePullRequestsPermission')}
              </dt>
              <dd>{t('admin.githubAppGuidePullRequestsPermissionValue')}</dd>
            </dl>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const DEFAULT_TELEMETRY_TABLE_PREFIX = 'ccbricks';

interface SearchableSelectProps {
  disabled?: boolean;
  emptyText: string;
  options: string[];
  placeholder: string;
  searchPlaceholder: string;
  triggerRef?: React.Ref<HTMLButtonElement>;
  value: string;
  onValueChange: (value: string) => void;
}

function SearchableSelect({
  disabled = false,
  emptyText,
  options,
  placeholder,
  searchPlaceholder,
  triggerRef,
  value,
  onValueChange,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return options;

    return options.filter(option => option.toLowerCase().includes(normalizedQuery));
  }, [options, query]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-10 w-full justify-between px-3 font-normal"
          disabled={disabled}
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="z-[60] w-[--radix-popover-trigger-width] overflow-hidden p-0"
        align="start"
      >
        <div className="border-b p-2">
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-9"
          />
        </div>
        <div
          className="max-h-80 overflow-y-auto overscroll-contain p-1"
          onWheelCapture={event => event.stopPropagation()}
        >
          {filteredOptions.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
          ) : (
            filteredOptions.map(option => (
              <button
                key={option}
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                onClick={() => {
                  onValueChange(option);
                  setOpen(false);
                }}
              >
                <Check className={cn('h-4 w-4', option === value ? 'opacity-100' : 'opacity-0')} />
                <span className="truncate">{option}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface FieldHelpLabelProps {
  label: string;
  help: string;
}

function FieldHelpLabel({ label, help }: FieldHelpLabelProps) {
  return (
    <div className="flex items-center gap-2">
      <p className="text-sm font-medium">{label}</p>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              aria-label={help}
            >
              <Info className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p>{help}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

interface TelemetrySetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appName: string;
  onSetupComplete: () => Promise<void>;
}

function TelemetrySetupDialog({
  open,
  onOpenChange,
  appName,
  onSetupComplete,
}: TelemetrySetupDialogProps) {
  const { t } = useTranslation();
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [selectedCatalog, setSelectedCatalog] = useState('');
  const [selectedSchema, setSelectedSchema] = useState('');
  const [tablePrefixInput, setTablePrefixInput] = useState(DEFAULT_TELEMETRY_TABLE_PREFIX);
  const [experimentNameInput, setExperimentNameInput] = useState('ccbricks-otel');
  const [isLoadingCatalogs, setIsLoadingCatalogs] = useState(false);
  const [isLoadingSchemas, setIsLoadingSchemas] = useState(false);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const catalogTriggerRef = useRef<HTMLButtonElement>(null);

  const catalogName = selectedCatalog.trim();
  const schemaName = selectedSchema.trim();
  const tablePrefix = tablePrefixInput.trim();
  const experimentName = experimentNameInput.trim();
  const experimentPath = appName
    ? `/Shared/${appName}/experiments/${experimentName || t('admin.telemetryExperimentNamePreview')}`
    : t('admin.telemetryAppNameUnavailable');
  const canSubmit =
    catalogName.length > 0 &&
    schemaName.length > 0 &&
    tablePrefix.length > 0 &&
    experimentName.length > 0 &&
    !isSettingUp;

  const loadCatalogs = useCallback(async () => {
    setIsLoadingCatalogs(true);
    try {
      const response = await adminService.getTelemetryCatalogs();
      setCatalogs(response.catalogs);
    } catch {
      toast.error(t('admin.telemetryCatalogsFetchError'));
    } finally {
      setIsLoadingCatalogs(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;

    setSelectedCatalog('');
    setSelectedSchema('');
    setSchemas([]);
    setTablePrefixInput(DEFAULT_TELEMETRY_TABLE_PREFIX);
    setExperimentNameInput('ccbricks-otel');
  }, [open]);

  const loadSchemas = useCallback(
    async (catalog: string) => {
      setIsLoadingSchemas(true);
      try {
        const response = await adminService.getTelemetrySchemas(catalog);
        setSchemas(response.schemas);
      } catch {
        toast.error(t('admin.telemetrySchemasFetchError'));
      } finally {
        setIsLoadingSchemas(false);
      }
    },
    [t]
  );

  useEffect(() => {
    if (open) {
      void loadCatalogs();
    }
  }, [loadCatalogs, open]);

  useEffect(() => {
    if (open && selectedCatalog) {
      void loadSchemas(selectedCatalog);
    }
  }, [loadSchemas, open, selectedCatalog]);

  const handleCatalogChange = (value: string) => {
    setSelectedCatalog(value);
    setSelectedSchema('');
  };

  const handleSchemaChange = (value: string) => {
    setSelectedSchema(value);
  };

  const handleSetup = async () => {
    if (!canSubmit) return;
    setIsSettingUp(true);
    try {
      await adminService.setupTelemetry({
        catalog_name: catalogName,
        schema_name: schemaName,
        table_prefix: tablePrefix,
        experiment_name: experimentName,
      });
      toast.success(t('admin.telemetrySetupSuccess'));
      await onSetupComplete();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('admin.telemetrySetupError'));
    } finally {
      setIsSettingUp(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!isSettingUp) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="max-w-2xl"
        onOpenAutoFocus={event => {
          event.preventDefault();
          catalogTriggerRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('admin.telemetrySetupTitle')}</DialogTitle>
          <DialogDescription>{t('admin.telemetrySetupDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <p className="text-sm font-medium">{t('admin.telemetryCatalog')}</p>
              <SearchableSelect
                value={selectedCatalog}
                onValueChange={handleCatalogChange}
                disabled={isLoadingCatalogs || isSettingUp}
                triggerRef={catalogTriggerRef}
                options={catalogs}
                placeholder={t('admin.telemetryCatalogPlaceholder')}
                searchPlaceholder={t('admin.telemetryCatalogSearchPlaceholder')}
                emptyText={t('admin.telemetryCatalogEmpty')}
              />
            </div>

            <div className="grid gap-2">
              <p className="text-sm font-medium">{t('admin.telemetrySchema')}</p>
              <SearchableSelect
                value={selectedSchema}
                onValueChange={handleSchemaChange}
                disabled={!selectedCatalog || isLoadingSchemas || isSettingUp}
                options={schemas}
                placeholder={t('admin.telemetrySchemaPlaceholder')}
                searchPlaceholder={t('admin.telemetrySchemaSearchPlaceholder')}
                emptyText={t('admin.telemetrySchemaEmpty')}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <FieldHelpLabel
              label={t('admin.telemetryTablePrefix')}
              help={t('admin.telemetryTablePrefixHelp')}
            />
            <Input
              value={tablePrefixInput}
              onChange={event => setTablePrefixInput(event.target.value)}
              placeholder={DEFAULT_TELEMETRY_TABLE_PREFIX}
              disabled={isSettingUp}
            />
          </div>

          <div className="grid gap-2">
            <FieldHelpLabel
              label={t('admin.telemetryExperimentName')}
              help={t('admin.telemetryExperimentNameHelp')}
            />
            <Input
              value={experimentNameInput}
              onChange={event => setExperimentNameInput(event.target.value)}
              placeholder={t('admin.telemetryExperimentNamePlaceholder')}
              disabled={isSettingUp}
            />
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {experimentPath}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSettingUp}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSetup} disabled={!canSubmit}>
            {isSettingUp && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('admin.telemetrySetupRun')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdminGeneralContent() {
  const { t } = useTranslation();
  const { settings, isLoadingSettings, savingKey, saveSetting, refreshSettings } =
    useAdminSettings();

  const [servingEndpoints, setServingEndpoints] = useState<ServingEndpointsByTier | null>(null);
  const [isLoadingEndpoints, setIsLoadingEndpoints] = useState(true);
  const [mlflowExperimentIdInput, setMlflowExperimentIdInput] = useState('');
  const [otelMetricsTableInput, setOtelMetricsTableInput] = useState('');
  const [otelLogsTableInput, setOtelLogsTableInput] = useState('');
  const [otelTracesTableInput, setOtelTracesTableInput] = useState('');
  const [isTelemetrySetupOpen, setIsTelemetrySetupOpen] = useState(false);

  const fetchServingEndpoints = useCallback(async () => {
    try {
      setIsLoadingEndpoints(true);
      const data = await adminService.getServingEndpoints();
      setServingEndpoints(data);
    } catch {
      toast.error(t('admin.fetchEndpointsError'));
    } finally {
      setIsLoadingEndpoints(false);
    }
  }, [t]);

  useEffect(() => {
    fetchServingEndpoints();
  }, [fetchServingEndpoints]);

  useEffect(() => {
    if (settings) {
      setMlflowExperimentIdInput(settings.mlflow_experiment_id ?? '');
      setOtelMetricsTableInput(settings.otel_metrics_table_name ?? '');
      setOtelLogsTableInput(settings.otel_logs_table_name ?? '');
      setOtelTracesTableInput(settings.otel_traces_table_name ?? '');
    }
  }, [settings]);

  const handleAllowedModelChange = (modelId: string, checked: boolean) => {
    const current = settings?.allowed_model_ids ?? [];
    const next = checked
      ? [...new Set([...current, modelId])]
      : current.filter(id => id !== modelId);
    return saveSetting('allowed_model_ids', { allowed_model_ids: next });
  };

  const allowedModelOptions = useMemo(() => {
    const currentEndpoints = flattenServingEndpoints(servingEndpoints);
    return groupModelIdsByTier([...(settings?.allowed_model_ids ?? []), ...currentEndpoints]);
  }, [servingEndpoints, settings?.allowed_model_ids]);

  const currentEndpointSet = useMemo(
    () => new Set(flattenServingEndpoints(servingEndpoints)),
    [servingEndpoints]
  );

  const handleMlflowSettingSave = (key: MlflowSettingKey, value: string) => {
    const settingValue = value.trim() || null;
    const patch: UpdateAppSettingsRequest = { [key]: settingValue };
    return saveSetting(key, patch);
  };

  const mlflowSettings = [
    {
      key: 'mlflow_experiment',
      settingKey: 'mlflow_experiment_id',
      label: t('admin.mlflowExperimentId'),
      description: t('admin.mlflowExperimentIdDescription'),
      placeholder: t('admin.mlflowExperimentIdPlaceholder'),
      value: mlflowExperimentIdInput,
      onChange: setMlflowExperimentIdInput,
    },
    {
      key: 'otel_metrics',
      settingKey: 'otel_metrics_table_name',
      label: t('admin.otelMetricsTableName'),
      description: t('admin.otelMetricsTableNameDescription'),
      placeholder: t('admin.otelTableNamePlaceholder'),
      value: otelMetricsTableInput,
      onChange: setOtelMetricsTableInput,
    },
    {
      key: 'otel_logs',
      settingKey: 'otel_logs_table_name',
      label: t('admin.otelLogsTableName'),
      description: t('admin.otelLogsTableNameDescription'),
      placeholder: t('admin.otelTableNamePlaceholder'),
      value: otelLogsTableInput,
      onChange: setOtelLogsTableInput,
    },
    {
      key: 'otel_traces',
      settingKey: 'otel_traces_table_name',
      label: t('admin.otelTracesTableName'),
      description: t('admin.otelTracesTableNameDescription'),
      placeholder: t('admin.otelTableNamePlaceholder'),
      value: otelTracesTableInput,
      onChange: setOtelTracesTableInput,
    },
  ] as const;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6 space-y-8">
      <section>
        <h2 className="text-lg font-semibold mb-4">{t('admin.allowedModelIds')}</h2>
        {isLoadingEndpoints || isLoadingSettings ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="border border-border rounded-lg p-4 space-y-5">
            {(
              [
                { tier: 'opus', label: t('admin.opusModel') },
                { tier: 'sonnet', label: t('admin.sonnetModel') },
                { tier: 'haiku', label: t('admin.haikuModel') },
              ] as const
            ).map(({ tier, label }) => (
              <div key={tier} className="space-y-2">
                <p className="text-sm font-medium">{label}</p>
                <div className="space-y-2">
                  {allowedModelOptions[tier].map(modelId => {
                    const checked = settings?.allowed_model_ids.includes(modelId) ?? false;
                    const isUnavailable = !currentEndpointSet.has(modelId);
                    return (
                      <label
                        key={modelId}
                        className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
                      >
                        <span className="min-w-0 truncate font-mono">{modelId}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          {isUnavailable && (
                            <Badge variant="outline">{t('admin.modelUnavailable')}</Badge>
                          )}
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-primary"
                            checked={checked}
                            disabled={savingKey !== null}
                            onChange={event =>
                              handleAllowedModelChange(modelId, event.currentTarget.checked)
                            }
                          />
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{t('admin.telemetryConfiguration')}</h2>
          {!isLoadingSettings && (
            <Button variant="outline" size="sm" onClick={() => setIsTelemetrySetupOpen(true)}>
              <Database className="h-4 w-4" />
              {t('admin.telemetrySetupButton')}
            </Button>
          )}
        </div>
        {isLoadingSettings ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="rounded-lg border border-border p-4 space-y-4">
            <p className="text-xs text-muted-foreground">{t('admin.telemetryDescription')}</p>
            {mlflowSettings.map(
              ({ key, settingKey, label, description, placeholder, value, onChange }) => {
                const dirty = value.trim() !== (settings?.[settingKey] ?? '');
                const isSaving = savingKey === settingKey;
                return (
                  <div
                    key={key}
                    className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between"
                  >
                    <div className="min-w-0 xl:w-64">
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-xs text-muted-foreground">{description}</p>
                    </div>
                    <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center xl:max-w-md">
                      <Input
                        className="min-w-0 flex-1"
                        placeholder={placeholder}
                        value={value}
                        onChange={e => onChange(e.target.value)}
                        disabled={savingKey !== null}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full sm:w-auto"
                        onClick={() => handleMlflowSettingSave(settingKey, value)}
                        disabled={savingKey !== null || !dirty}
                      >
                        {isSaving ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                          <Save className="h-4 w-4 mr-2" />
                        )}
                        {t('common.save')}
                      </Button>
                    </div>
                  </div>
                );
              }
            )}
          </div>
        )}
        <TelemetrySetupDialog
          open={isTelemetrySetupOpen}
          onOpenChange={setIsTelemetrySetupOpen}
          appName={settings?.databricks_app_name ?? ''}
          onSetupComplete={refreshSettings}
        />
      </section>
    </div>
  );
}

function AdminRepositoryContent() {
  const { t } = useTranslation();
  const { githubAppAuth, isLoadingGitHubAppAuth, isSavingGitHubAppAuth, saveGitHubAppAuth } =
    useGitHubAppAuth();

  const [githubAppIdInput, setGitHubAppIdInput] = useState('');
  const [isGitHubAppGuideOpen, setIsGitHubAppGuideOpen] = useState(false);
  const githubAppPrivateKeyFileInputRef = useRef<HTMLInputElement>(null);
  const lastSyncedGitHubAppIdRef = useRef('');

  useEffect(() => {
    if (githubAppAuth) {
      const persistedAppId = githubAppAuth.github_app_id ?? '';
      const previousPersistedAppId = lastSyncedGitHubAppIdRef.current;
      setGitHubAppIdInput(current =>
        current === previousPersistedAppId ? persistedAppId : current
      );
      lastSyncedGitHubAppIdRef.current = persistedAppId;
    }
  }, [githubAppAuth]);

  const trimmedGitHubAppId = githubAppIdInput.trim();
  const githubAppIdDirty = trimmedGitHubAppId !== (githubAppAuth?.github_app_id ?? '');
  const isGitHubAppPrivateKeyConfigured = githubAppAuth?.private_key_configured ?? false;
  const githubAppPrivateKeyHelpText = isGitHubAppPrivateKeyConfigured
    ? t('admin.githubAppPrivateKeyConfiguredDescription')
    : t('admin.githubAppPrivateKeyNotConfigured');

  const openGitHubAppPrivateKeyFilePicker = () => {
    githubAppPrivateKeyFileInputRef.current?.click();
  };

  const handleGitHubAppIdSave = async () => {
    if (!githubAppIdDirty) return;
    await saveGitHubAppAuth({ github_app_id: trimmedGitHubAppId || null });
  };

  const handleGitHubAppPrivateKeyFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      if (!text.includes('PRIVATE KEY')) {
        toast.error(t('admin.githubAppPrivateKeyFileInvalid'));
        return;
      }

      await saveGitHubAppAuth({ github_app_private_key: text });
    } catch {
      toast.error(t('admin.githubAppPrivateKeyFileError'));
    } finally {
      input.value = '';
    }
  };

  const handleGitHubAppPrivateKeyDelete = async () => {
    if (!window.confirm(t('admin.githubAppPrivateKeyDeleteConfirm'))) return;

    await saveGitHubAppAuth({ github_app_private_key: null });
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('admin.githubAppAuthConfiguration')}</h2>
        <Button variant="outline" size="sm" onClick={() => setIsGitHubAppGuideOpen(true)}>
          <HelpCircle className="h-4 w-4" />
          {t('admin.githubAppGuideButton')}
        </Button>
      </div>
      {isLoadingGitHubAppAuth ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="border border-border rounded-lg p-4 space-y-4">
          <p className="text-xs text-muted-foreground">{t('admin.githubAppAuthDescription')}</p>
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {t('admin.githubAppAccessModel')}
          </p>
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t('admin.githubAppId')}</p>
              <p className="text-xs text-muted-foreground">{t('admin.githubAppIdDescription')}</p>
            </div>
            <div className="flex w-full max-w-md flex-col gap-2 sm:flex-row sm:items-center xl:w-[380px]">
              <Input
                className="min-w-0 flex-1"
                placeholder={t('admin.githubAppIdPlaceholder')}
                value={githubAppIdInput}
                onChange={e => setGitHubAppIdInput(e.target.value)}
                disabled={isSavingGitHubAppAuth}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleGitHubAppIdSave}
                disabled={isSavingGitHubAppAuth || !githubAppIdDirty}
              >
                {isSavingGitHubAppAuth ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                {t('common.save')}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{t('admin.githubAppPrivateKey')}</p>
                {isGitHubAppPrivateKeyConfigured && (
                  <Badge
                    variant="secondary"
                    className="gap-1 border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                  >
                    <ShieldCheck className="h-3 w-3" />
                    {t('admin.githubAppPrivateKeyConfigured')}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('admin.githubAppPrivateKeyDescription')}
              </p>
            </div>
            <div className="w-full max-w-md space-y-2 xl:w-[380px]">
              <input
                ref={githubAppPrivateKeyFileInputRef}
                type="file"
                accept=".pem,.key,.txt,text/plain"
                className="hidden"
                onChange={handleGitHubAppPrivateKeyFileChange}
                disabled={isSavingGitHubAppAuth}
              />
              {isGitHubAppPrivateKeyConfigured ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 justify-center"
                    onClick={openGitHubAppPrivateKeyFilePicker}
                    disabled={isSavingGitHubAppAuth}
                  >
                    <Upload className="h-4 w-4" />
                    {t('admin.githubAppPrivateKeyChangeFile')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 justify-center text-destructive hover:text-destructive"
                    onClick={handleGitHubAppPrivateKeyDelete}
                    disabled={isSavingGitHubAppAuth}
                  >
                    {isSavingGitHubAppAuth ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    {t('admin.githubAppPrivateKeyDelete')}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={openGitHubAppPrivateKeyFilePicker}
                  disabled={isSavingGitHubAppAuth}
                >
                  <Upload className="h-4 w-4" />
                  {t('admin.githubAppPrivateKeySelectFile')}
                </Button>
              )}
              <p className="text-xs text-muted-foreground">{githubAppPrivateKeyHelpText}</p>
            </div>
          </div>
        </div>
      )}
      <GitHubAppGuideDialog open={isGitHubAppGuideOpen} onOpenChange={setIsGitHubAppGuideOpen} />
    </section>
  );
}

function AdminBrandingContent() {
  const { t } = useTranslation();
  const { refetchAppSettings } = useUser();
  const { settings, isLoadingSettings, savingKey, saveSetting } = useAdminSettings();

  const [appTitleInput, setAppTitleInput] = useState('');
  const [welcomeHeadingInput, setWelcomeHeadingInput] = useState('');

  useEffect(() => {
    if (settings) {
      setAppTitleInput(settings.app_title);
      setWelcomeHeadingInput(settings.welcome_heading);
    }
  }, [settings]);

  const textSettings = [
    {
      key: 'app_title' as const,
      label: t('admin.appTitle'),
      placeholder: t('app.title'),
      value: appTitleInput,
      onChange: setAppTitleInput,
      dirty: appTitleInput.trim() !== (settings?.app_title ?? ''),
    },
    {
      key: 'welcome_heading' as const,
      label: t('admin.welcomeHeading'),
      placeholder: t('welcome.heading'),
      value: welcomeHeadingInput,
      onChange: setWelcomeHeadingInput,
      dirty: welcomeHeadingInput.trim() !== (settings?.welcome_heading ?? ''),
    },
  ];

  const handleTextSettingSave = async (key: 'app_title' | 'welcome_heading', value: string) => {
    const trimmed = value.trim();
    const saved = await saveSetting(key, { [key]: trimmed || null });
    if (saved) await refetchAppSettings();
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6">
      <h2 className="text-lg font-semibold mb-4">{t('admin.branding')}</h2>
      {isLoadingSettings ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div>
          {textSettings.map(({ key, label, placeholder, value, onChange, dirty }, index) => (
            <div
              key={key}
              className={`flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between ${
                index === textSettings.length - 1 ? '' : 'mb-6'
              }`}
            >
              <p className="shrink-0 text-sm font-medium xl:w-44">{label}</p>
              <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center xl:max-w-md">
                <ClearableInput
                  className="min-w-0 flex-1 sm:w-auto"
                  clearLabel={t('common.clear')}
                  disabled={savingKey !== null}
                  maxLength={80}
                  onChange={onChange}
                  placeholder={placeholder}
                  value={value}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => handleTextSettingSave(key, value)}
                  disabled={savingKey !== null || !dirty}
                >
                  {savingKey === key ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  {t('common.save')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AdminUsersContent() {
  const { t } = useTranslation();
  const { user } = useUser();
  const { settings, isLoadingSettings, savingKey, saveSetting } = useAdminSettings();

  const [users, setUsers] = useState<AdminUserInfo[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  const adminCount = useMemo(() => users.filter(u => u.is_admin).length, [users]);

  const fetchUsers = useCallback(async () => {
    try {
      setIsLoadingUsers(true);
      const data = await adminService.getUsers();
      setUsers(data.users);
    } catch {
      toast.error(t('admin.fetchError'));
    } finally {
      setIsLoadingUsers(false);
    }
  }, [t]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleRoleChange = async (userId: string, newIsAdmin: boolean) => {
    setUpdatingUserId(userId);
    try {
      await adminService.updateUserRole(userId, newIsAdmin);
      setUsers(prev => prev.map(u => (u.id === userId ? { ...u, is_admin: newIsAdmin } : u)));
      toast.success(t('admin.updateRoleSuccess'));
    } catch {
      toast.error(t('admin.updateRoleError'));
    } finally {
      setUpdatingUserId(null);
    }
  };

  const handleDefaultRoleChange = (value: string) =>
    saveSetting('default_new_user_role', { default_new_user_role: value as 'admin' | 'member' });

  return (
    <section className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6">
      <h2 className="text-lg font-semibold mb-4">{t('admin.userManagement')}</h2>
      <div className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium">{t('admin.defaultRole')}</p>
          <Select
            value={settings?.default_new_user_role ?? 'admin'}
            onValueChange={handleDefaultRoleChange}
            disabled={isLoadingSettings || savingKey !== null}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">{t('admin.roleAdmin')}</SelectItem>
              <SelectItem value="member">{t('admin.roleMember')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {isLoadingUsers ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/50">
                <th className="text-left text-sm font-medium text-muted-foreground px-4 py-3">
                  {t('admin.userId')}
                </th>
                <th className="text-left text-sm font-medium text-muted-foreground px-4 py-3">
                  {t('admin.email')}
                </th>
                <th className="text-left text-sm font-medium text-muted-foreground px-4 py-3">
                  {t('admin.role')}
                </th>
                <th className="text-left text-sm font-medium text-muted-foreground px-4 py-3">
                  {t('admin.createdAt')}
                </th>
                <th className="text-right text-sm font-medium text-muted-foreground px-4 py-3">
                  {t('admin.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => {
                const isCurrentUser = u.id === user?.id;
                const isLastAdmin = u.is_admin && adminCount <= 1;
                const isUpdating = updatingUserId === u.id;

                return (
                  <tr key={u.id} className="border-t border-border">
                    <td className="px-4 py-3 text-sm font-mono truncate max-w-[300px]">
                      {u.id}
                      {isCurrentUser && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          ({t('admin.you')})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground truncate max-w-[250px]">
                      {u.email ?? '-'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1.5 text-sm ${u.is_admin ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
                      >
                        {u.is_admin ? (
                          <ShieldCheck className="h-3.5 w-3.5" />
                        ) : (
                          <UserIcon className="h-3.5 w-3.5" />
                        )}
                        {u.is_admin ? t('admin.roleAdmin') : t('admin.roleMember')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {u.is_admin ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isLastAdmin || isUpdating}
                          onClick={() => handleRoleChange(u.id, false)}
                        >
                          {isUpdating ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            t('admin.demote')
                          )}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isUpdating}
                          onClick={() => handleRoleChange(u.id, true)}
                        >
                          {isUpdating ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            t('admin.promote')
                          )}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AdminContent() {
  const { isAdmin } = useUser();
  const navigate = useNavigate();
  const location = useLocation();

  const activeTab =
    location.pathname === '/admin/users'
      ? 'users'
      : location.pathname === '/admin/branding'
        ? 'branding'
        : location.pathname === '/admin/repo'
          ? 'repo'
          : 'general';

  const [mounted, setMounted] = useState<Set<string>>(() => new Set([activeTab]));
  useEffect(() => {
    setMounted(prev => (prev.has(activeTab) ? prev : new Set(prev).add(activeTab)));
  }, [activeTab]);

  useEffect(() => {
    if (!isAdmin) {
      navigate('/');
    }
  }, [isAdmin, navigate]);

  if (!isAdmin) return null;

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      <div className={activeTab === 'general' ? 'min-h-0 flex-1 flex flex-col' : 'hidden'}>
        {mounted.has('general') && <AdminGeneralContent />}
      </div>
      <div className={activeTab === 'repo' ? 'min-h-0 flex-1 flex flex-col' : 'hidden'}>
        {mounted.has('repo') && <AdminRepositoryContent />}
      </div>
      <div className={activeTab === 'branding' ? 'min-h-0 flex-1 flex flex-col' : 'hidden'}>
        {mounted.has('branding') && <AdminBrandingContent />}
      </div>
      <div className={activeTab === 'users' ? 'min-h-0 flex-1 flex flex-col' : 'hidden'}>
        {mounted.has('users') && <AdminUsersContent />}
      </div>
    </div>
  );
}
