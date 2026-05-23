import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import type { UpdateUserSettingsRequest } from '@repo/types';
import { useUser } from '@/hooks/useUser';
import { userSettingsService } from '@/services';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function SettingsContent() {
  const { t } = useTranslation();
  const { modelSettings, refetchModelSettings } = useUser();
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(true);

  useEffect(() => {
    let isMounted = true;
    refetchModelSettings().finally(() => {
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

  if (isRefreshing || !modelSettings) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

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
      </div>
    </div>
  );
}
