import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ExternalLink,
  HelpCircle,
  Loader2,
  Save,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  AdminUserInfo,
  AppSettingsResponse,
  GitHubAppAuthResponse,
  ServingEndpointsByTier,
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';

const GITHUB_APPS_SETTINGS_URL = 'https://github.com/settings/apps';

function includeSelectedModel(options: string[], selectedValue: string): string[] {
  if (!selectedValue || options.includes(selectedValue)) {
    return options;
  }
  return [selectedValue, ...options];
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

  return { settings, isLoadingSettings, savingKey, saveSetting };
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
            </dl>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AdminSettingsContent() {
  const { t } = useTranslation();
  const { settings, isLoadingSettings, savingKey, saveSetting } = useAdminSettings();

  const [servingEndpoints, setServingEndpoints] = useState<ServingEndpointsByTier | null>(null);
  const [isLoadingEndpoints, setIsLoadingEndpoints] = useState(true);
  const [otelMetricsTableInput, setOtelMetricsTableInput] = useState('');
  const [otelLogsTableInput, setOtelLogsTableInput] = useState('');
  const [otelTracesTableInput, setOtelTracesTableInput] = useState('');

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
      setOtelMetricsTableInput(settings.otel_metrics_table_name ?? '');
      setOtelLogsTableInput(settings.otel_logs_table_name ?? '');
      setOtelTracesTableInput(settings.otel_traces_table_name ?? '');
    }
  }, [settings]);

  const handleModelChange = (
    key: 'default_opus_model' | 'default_sonnet_model' | 'default_haiku_model',
    value: string
  ) => saveSetting(key, { [key]: value });

  const handleDefaultRoleChange = (value: string) =>
    saveSetting('default_new_user_role', { default_new_user_role: value as 'admin' | 'member' });

  const otelDirty =
    otelMetricsTableInput.trim() !== (settings?.otel_metrics_table_name ?? '') ||
    otelLogsTableInput.trim() !== (settings?.otel_logs_table_name ?? '') ||
    otelTracesTableInput.trim() !== (settings?.otel_traces_table_name ?? '');

  const handleOtelSave = () => {
    const metrics = otelMetricsTableInput.trim();
    const logs = otelLogsTableInput.trim();
    const traces = otelTracesTableInput.trim();
    return saveSetting('otel', {
      otel_metrics_table_name: metrics || null,
      otel_logs_table_name: logs || null,
      otel_traces_table_name: traces || null,
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6 space-y-8">
      <section>
        <h2 className="text-lg font-semibold mb-4">{t('admin.settings')}</h2>
        {isLoadingSettings ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="border border-border rounded-lg p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{t('admin.defaultRole')}</p>
              <Select
                value={settings?.default_new_user_role ?? 'admin'}
                onValueChange={handleDefaultRoleChange}
                disabled={savingKey !== null}
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
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-4">{t('admin.modelConfiguration')}</h2>
        {isLoadingEndpoints || isLoadingSettings ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="border border-border rounded-lg p-4 space-y-4">
            {(
              [
                {
                  key: 'default_opus_model',
                  label: t('admin.opusModel'),
                  options: servingEndpoints?.opus ?? [],
                },
                {
                  key: 'default_sonnet_model',
                  label: t('admin.sonnetModel'),
                  options: servingEndpoints?.sonnet ?? [],
                },
                {
                  key: 'default_haiku_model',
                  label: t('admin.haikuModel'),
                  options: servingEndpoints?.haiku ?? [],
                },
              ] as const
            ).map(({ key, label, options }) => {
              const selectedValue = settings?.[key] ?? '';
              const modelOptions = includeSelectedModel(options, selectedValue);

              return (
                <div key={key} className="flex items-center justify-between gap-4">
                  <p className="text-sm font-medium shrink-0">{label}</p>
                  <Select
                    value={selectedValue}
                    onValueChange={value => handleModelChange(key, value)}
                    disabled={savingKey !== null}
                  >
                    <SelectTrigger className="w-[320px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {modelOptions.map(name => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-4">{t('admin.telemetryConfiguration')}</h2>
        {isLoadingSettings ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="border border-border rounded-lg p-4 space-y-4">
            <p className="text-xs text-muted-foreground">{t('admin.telemetryDescription')}</p>
            {(
              [
                {
                  key: 'otel_metrics',
                  label: t('admin.otelMetricsTableName'),
                  description: t('admin.otelMetricsTableNameDescription'),
                  value: otelMetricsTableInput,
                  onChange: setOtelMetricsTableInput,
                },
                {
                  key: 'otel_logs',
                  label: t('admin.otelLogsTableName'),
                  description: t('admin.otelLogsTableNameDescription'),
                  value: otelLogsTableInput,
                  onChange: setOtelLogsTableInput,
                },
                {
                  key: 'otel_traces',
                  label: t('admin.otelTracesTableName'),
                  description: t('admin.otelTracesTableNameDescription'),
                  value: otelTracesTableInput,
                  onChange: setOtelTracesTableInput,
                },
              ] as const
            ).map(({ key, label, description, value, onChange }) => (
              <div key={key} className="flex items-center justify-between gap-4">
                <div className="shrink-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                <Input
                  className="w-[320px]"
                  placeholder={t('admin.otelTableNamePlaceholder')}
                  value={value}
                  onChange={e => onChange(e.target.value)}
                  disabled={savingKey !== null}
                />
              </div>
            ))}
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={handleOtelSave}
                disabled={savingKey !== null || !otelDirty}
              >
                {savingKey === 'otel' ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                {t('common.save')}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function AdminGitContent() {
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
          <div className="flex items-center justify-between gap-4">
            <div className="shrink-0">
              <p className="text-sm font-medium">{t('admin.githubAppId')}</p>
              <p className="text-xs text-muted-foreground">{t('admin.githubAppIdDescription')}</p>
            </div>
            <div className="flex w-[320px] items-center gap-2">
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
          <div className="flex items-start justify-between gap-4">
            <div className="shrink-0">
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
            <div className="w-[320px] space-y-2">
              <input
                ref={githubAppPrivateKeyFileInputRef}
                type="file"
                accept=".pem,.key,.txt,text/plain"
                className="hidden"
                onChange={handleGitHubAppPrivateKeyFileChange}
                disabled={isSavingGitHubAppAuth}
              />
              {isGitHubAppPrivateKeyConfigured ? (
                <div className="flex gap-2">
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
        <div className="border border-border rounded-lg p-4">
          {textSettings.map(({ key, label, placeholder, value, onChange, dirty }, index) => (
            <div
              key={key}
              className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${
                index === textSettings.length - 1 ? '' : 'pb-4 mb-4 border-b border-border'
              }`}
            >
              <p className="text-sm font-medium shrink-0">{label}</p>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                <ClearableInput
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

  return (
    <section className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6">
      <h2 className="text-lg font-semibold mb-4">{t('admin.userManagement')}</h2>
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
                          <ShieldOff className="h-3.5 w-3.5" />
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
  const { t } = useTranslation();
  const { isAdmin } = useUser();
  const navigate = useNavigate();
  const location = useLocation();

  const activeTab =
    location.pathname === '/admin/users'
      ? 'users'
      : location.pathname === '/admin/branding'
        ? 'branding'
        : location.pathname === '/admin/git'
          ? 'git'
          : 'settings';

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
      <div className="flex items-center gap-3 p-4 border-b border-border shrink-0">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-xl font-bold">{t('admin.title')}</h1>
      </div>

      <div className="px-6 pt-4">
        <Tabs value={activeTab} onValueChange={val => navigate(`/admin/${val}`, { replace: true })}>
          <TabsList>
            <TabsTrigger value="settings">{t('admin.settings')}</TabsTrigger>
            <TabsTrigger value="git">{t('admin.git')}</TabsTrigger>
            <TabsTrigger value="branding">{t('admin.branding')}</TabsTrigger>
            <TabsTrigger value="users">{t('admin.userManagement')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className={activeTab === 'settings' ? 'min-h-0 flex-1 flex flex-col' : 'hidden'}>
        {mounted.has('settings') && <AdminSettingsContent />}
      </div>
      <div className={activeTab === 'git' ? 'min-h-0 flex-1 flex flex-col' : 'hidden'}>
        {mounted.has('git') && <AdminGitContent />}
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
