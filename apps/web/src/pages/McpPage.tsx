import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  AlertCircle,
  DatabaseSearch,
  Sparkles,
  Plus,
  Trash2,
  Pencil,
  Terminal,
  Globe,
  X,
  Search,
  Construction,
  Network,
  LogIn,
  ExternalLink,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { genieService, mcpServerService, externalMcpServerService } from '@/services';
import { useUser } from '@/hooks/useUser';
import { buildDbsqlMcpUrl, buildGenieMcpUrl } from '@/constants';
import type {
  GenieSpace,
  McpServerRecord,
  McpServerType,
  ManagedMcpType,
  ExternalMcpServer,
} from '@repo/types';

// ─── Shared helpers ──────────────────────────────────────────

const SYSTEM_AI_AGENT_PREFIX = 'system_ai_agent_';

interface KeyValuePair {
  key: string;
  value: string;
}

function KeyValueEditor({
  pairs,
  onChange,
  addLabel,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
}: {
  pairs: KeyValuePair[];
  onChange: (pairs: KeyValuePair[]) => void;
  addLabel: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const addPair = () => onChange([...pairs, { key: '', value: '' }]);

  const removePair = (index: number) => onChange(pairs.filter((_, i) => i !== index));

  const updatePair = (index: number, field: 'key' | 'value', val: string) => {
    const updated = pairs.map((p, i) => (i === index ? { ...p, [field]: val } : p));
    onChange(updated);
  };

  return (
    <div className="space-y-2">
      {pairs.map((pair, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={pair.key}
            onChange={e => updatePair(index, 'key', e.target.value)}
            placeholder={keyPlaceholder}
            className="font-mono text-sm flex-1"
          />
          <Input
            value={pair.value}
            onChange={e => updatePair(index, 'value', e.target.value)}
            placeholder={valuePlaceholder}
            className="font-mono text-sm flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => removePair(index)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addPair}>
        <Plus className="h-3 w-3 mr-1" />
        {addLabel}
      </Button>
    </div>
  );
}

/** unity_ai_gateway サーバーの URL から connection name を抽出する */
function extractConnectionName(server: McpServerRecord): string | null {
  if (server.managed_type !== 'unity_ai_gateway' || !server.url) return null;
  try {
    const pathname = new URL(server.url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || null;
  } catch {
    return null;
  }
}

function prioritizeSystemAiAgentExternalServers<T extends { name: string }>(servers: T[]) {
  const systemAiAgentServers: T[] = [];
  const otherServers: T[] = [];

  for (const server of servers) {
    if (server.name.startsWith(SYSTEM_AI_AGENT_PREFIX)) {
      systemAiAgentServers.push(server);
    } else {
      otherServers.push(server);
    }
  }

  return [...systemAiAgentServers, ...otherServers];
}

function ManagedIcon({ managedType }: { managedType: ManagedMcpType }) {
  if (managedType === 'databricks_sql')
    return <DatabaseSearch className="h-4 w-4 shrink-0 text-muted-foreground" />;
  if (managedType === 'databricks_genie')
    return <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />;
  if (managedType === 'unity_ai_gateway')
    return <Network className="h-4 w-4 shrink-0 text-muted-foreground" />;
  return <Search className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function ServerTypeIcon({ type }: { type: McpServerType }) {
  if (type === 'stdio') return <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />;
  return <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function ServerSubtitle({ server }: { server: McpServerRecord }) {
  if (server.type === 'stdio') {
    const parts = [server.command, ...(server.args ?? [])].join(' ');
    return <p className="text-xs text-muted-foreground/70 mt-1 ml-6 font-mono truncate">{parts}</p>;
  }
  if (server.url) {
    return (
      <p className="text-xs text-muted-foreground/70 mt-1 ml-6 font-mono truncate">{server.url}</p>
    );
  }
  return null;
}

function ManagedServerCard({
  server,
  idPrefix,
  isEnabled,
  databricksHost,
  loginLabel,
  onToggle,
  onDelete,
}: {
  server: McpServerRecord;
  idPrefix: string;
  isEnabled: boolean;
  databricksHost: string | null | undefined;
  loginLabel: string;
  onToggle: (serverId: string, checked: boolean) => void;
  onDelete: (server: McpServerRecord) => void;
}) {
  const connectionName = extractConnectionName(server);

  return (
    <div className="group flex items-center justify-between p-4 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0 mr-4">
        <div className="flex items-center gap-2">
          <ManagedIcon managedType={server.managed_type!} />
          <Label htmlFor={`${idPrefix}-${server.id}`} className="font-medium cursor-pointer">
            {server.name}
          </Label>
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {server.id}
          </span>
        </div>
        <ServerSubtitle server={server} />
      </div>
      <div className="flex items-center gap-2">
        {connectionName && databricksHost && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs mr-2"
            onClick={() =>
              window.open(
                `https://${databricksHost}/explore/connections/${connectionName}`,
                '_blank'
              )
            }
          >
            <LogIn className="h-3.5 w-3.5 mr-1" />
            {loginLabel}
          </Button>
        )}
        <Switch
          id={`${idPrefix}-${server.id}`}
          checked={isEnabled}
          onCheckedChange={checked => onToggle(server.id, checked)}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive invisible group-hover:visible"
          onClick={() => onDelete(server)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function pairsToRecord(pairs: KeyValuePair[]): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  for (const p of pairs) {
    const trimmedKey = p.key.trim();
    if (trimmedKey) record[trimmedKey] = p.value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function recordToPairs(record?: Record<string, string>): KeyValuePair[] {
  return record ? Object.entries(record).map(([key, value]) => ({ key, value })) : [];
}

// ─── Custom server form ──────────────────────────────────────

interface ServerFormState {
  id: string;
  serverName: string;
  type: McpServerType;
  url: string;
  headers: KeyValuePair[];
  command: string;
  args: string;
  env: KeyValuePair[];
}

const EMPTY_FORM: ServerFormState = {
  id: '',
  serverName: '',
  type: 'http',
  url: '',
  headers: [],
  command: '',
  args: '',
  env: [],
};

function serverToFormState(server: McpServerRecord): ServerFormState {
  return {
    id: server.id,
    serverName: server.name,
    type: server.type,
    url: server.url ?? '',
    headers: recordToPairs(server.headers),
    command: server.command ?? '',
    args: server.args?.join(' ') ?? '',
    env: recordToPairs(server.env),
  };
}

function buildFormPayload(form: ServerFormState) {
  const trimmedArgs = form.args.trim();
  return {
    name: form.serverName.trim(),
    type: form.type,
    url: form.url.trim() || undefined,
    headers: pairsToRecord(form.headers),
    command: form.command.trim() || undefined,
    args: trimmedArgs ? trimmedArgs.split(/\s+/) : undefined,
    env: pairsToRecord(form.env),
  };
}

interface ServerFormDialogProps {
  mode: 'add' | 'edit';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: ServerFormState;
  onFormChange: (form: ServerFormState) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  formError: string | null;
}

function ServerFormDialog({
  mode,
  open,
  onOpenChange,
  form,
  onFormChange,
  onSubmit,
  isSubmitting,
  formError,
}: ServerFormDialogProps) {
  const { t } = useTranslation();
  const isNetworkType = form.type === 'http' || form.type === 'sse';
  const prefix = mode === 'add' ? 'mcp' : 'mcp-edit';

  const update = (patch: Partial<ServerFormState>) => onFormChange({ ...form, ...patch });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'add' ? t('mcp.addServer') : t('mcp.editServer')}</DialogTitle>
          <DialogDescription>
            {mode === 'add' ? t('mcp.addServerDescription') : t('mcp.editServerDescription')}
          </DialogDescription>
        </DialogHeader>

        {formError && (
          <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-md text-sm">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {formError}
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-id`}>{t('mcp.id')}</Label>
            {mode === 'add' ? (
              <Input
                id={`${prefix}-id`}
                value={form.id}
                onChange={e => update({ id: e.target.value })}
                placeholder={t('mcp.idPlaceholder')}
                className="font-mono"
              />
            ) : (
              <Input
                id={`${prefix}-id`}
                value={form.id}
                disabled
                className="font-mono opacity-60"
              />
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${prefix}-display-name`}>{t('mcp.displayName')}</Label>
            <Input
              id={`${prefix}-display-name`}
              value={form.serverName}
              onChange={e => update({ serverName: e.target.value })}
              placeholder={t('mcp.displayNamePlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('mcp.type')}</Label>
            <Select value={form.type} onValueChange={v => update({ type: v as McpServerType })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">http</SelectItem>
                <SelectItem value="sse">sse</SelectItem>
                <SelectItem value="stdio">stdio</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isNetworkType && (
            <>
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-url`}>{t('mcp.url')}</Label>
                <Input
                  id={`${prefix}-url`}
                  value={form.url}
                  onChange={e => update({ url: e.target.value })}
                  placeholder={t('mcp.urlPlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('mcp.headers')}</Label>
                <KeyValueEditor
                  pairs={form.headers}
                  onChange={headers => update({ headers })}
                  addLabel={t('common.add')}
                  keyPlaceholder={t('mcp.headerKeyPlaceholder')}
                  valuePlaceholder={t('mcp.headerValuePlaceholder')}
                />
              </div>
            </>
          )}

          {form.type === 'stdio' && (
            <>
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-command`}>{t('mcp.command')}</Label>
                <Input
                  id={`${prefix}-command`}
                  value={form.command}
                  onChange={e => update({ command: e.target.value })}
                  placeholder={t('mcp.commandPlaceholder')}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-args`}>{t('mcp.argsField')}</Label>
                <Input
                  id={`${prefix}-args`}
                  value={form.args}
                  onChange={e => update({ args: e.target.value })}
                  placeholder={t('mcp.argsPlaceholder')}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label>{t('mcp.envField')}</Label>
                <KeyValueEditor
                  pairs={form.env}
                  onChange={env => update({ env })}
                  addLabel={t('common.add')}
                  keyPlaceholder={t('mcp.envKeyPlaceholder')}
                  valuePlaceholder={t('mcp.envValuePlaceholder')}
                />
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onSubmit} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {mode === 'add' ? t('mcp.addServer') : t('common.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Unified Add MCP dialog ──────────────────────────────────

interface McpTileConfig {
  type:
    | 'databricks_sql'
    | 'databricks_genie'
    | 'databricks_vector_search'
    | 'unity_ai_gateway'
    | 'custom';
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  disabled?: boolean;
  disabledBadgeKey?: string;
}

const MCP_TILES: McpTileConfig[] = [
  {
    type: 'databricks_sql',
    labelKey: 'mcp.dbsqlLabel',
    descriptionKey: 'mcp.dbsqlDescription',
    icon: DatabaseSearch,
  },
  {
    type: 'databricks_genie',
    labelKey: 'mcp.genieLabel',
    descriptionKey: 'mcp.genieDescription',
    icon: Sparkles,
  },
  {
    type: 'databricks_vector_search',
    labelKey: 'mcp.vectorSearchLabel',
    descriptionKey: 'mcp.vectorSearchComingSoon',
    icon: Search,
    disabled: true,
    disabledBadgeKey: 'mcp.vectorSearchComingSoon',
  },
  {
    type: 'unity_ai_gateway',
    labelKey: 'mcp.unityAiGatewayLabel',
    descriptionKey: 'mcp.unityAiGatewayDescription',
    icon: Network,
  },
  {
    type: 'custom',
    labelKey: 'mcp.customMcpLabel',
    descriptionKey: 'mcp.customMcpDescription',
    icon: ExternalLink,
  },
];

type AddMcpStep = 'select' | 'configure-managed' | 'configure-unity-gateway';

// ─── Unity AI Gateway step (extracted) ───────────────────────

function UnityAiGatewayStep({
  existingServers,
  onBack,
  onCreated,
  onClose,
}: {
  existingServers: McpServerRecord[];
  onBack: () => void;
  onCreated: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [ucMcpServers, setUcMcpServers] = useState<ExternalMcpServer[]>([]);
  const [isLoadingUcServers, setIsLoadingUcServers] = useState(true);
  const [selectedUcServerId, setSelectedUcServerId] = useState('');
  const [ucSearchQuery, setUcSearchQuery] = useState('');
  const [serverName, setServerName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const registeredUcConnectionIds = useMemo(
    () =>
      new Set(existingServers.filter(s => s.managed_type === 'unity_ai_gateway').map(s => s.id)),
    [existingServers]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await externalMcpServerService.list();
        if (!cancelled) setUcMcpServers(res.mcp_servers ?? []);
      } catch {
        if (!cancelled) setFormError(t('mcp.unityAiGatewayFetchError'));
      } finally {
        if (!cancelled) setIsLoadingUcServers(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const selectedUcServer = useMemo(
    () => ucMcpServers.find(s => s.id === selectedUcServerId),
    [ucMcpServers, selectedUcServerId]
  );

  // コネクション選択時にデフォルト表示名をセット
  useEffect(() => {
    if (selectedUcServer) {
      setServerName(selectedUcServer.name);
    }
  }, [selectedUcServer]);

  const availableUcMcpServers = useMemo(() => {
    const q = ucSearchQuery.toLowerCase().trim();
    const filteredServers = ucMcpServers.filter(s => {
      if (registeredUcConnectionIds.has(s.id)) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.owner?.toLowerCase().includes(q);
    });

    return prioritizeSystemAiAgentExternalServers(filteredServers);
  }, [ucMcpServers, registeredUcConnectionIds, ucSearchQuery]);

  const handleSubmit = async () => {
    setFormError(null);

    if (!selectedUcServer) {
      setFormError(t('mcp.selectConnection'));
      return;
    }

    if (!serverName.trim()) {
      setFormError(t('mcp.displayNameRequired'));
      return;
    }

    setIsSubmitting(true);
    try {
      await mcpServerService.create({
        id: selectedUcServer.name,
        name: serverName.trim(),
        type: 'http',
        managed_type: 'unity_ai_gateway',
      });
      toast.success(t('mcp.addSuccess'));
      onClose();
      onCreated();
    } catch (err) {
      const detail = err instanceof Error ? err.message : '';
      if (detail.includes('409') || detail.toLowerCase().includes('already')) {
        setFormError(t('mcp.duplicateError'));
      } else {
        setFormError(detail || t('mcp.addError'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 min-h-0 flex-1">
      {formError && (
        <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-md text-sm shrink-0">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {formError}
        </div>
      )}

      <Button variant="ghost" size="sm" className="self-start shrink-0" onClick={onBack}>
        &larr; {t('mcp.selectServerType')}
      </Button>

      <div className="flex flex-col gap-2 min-h-0 flex-1">
        <Label className="shrink-0">{t('mcp.selectConnection')}</Label>
        <Input
          value={ucSearchQuery}
          onChange={e => setUcSearchQuery(e.target.value)}
          placeholder={t('mcp.connectionSearchPlaceholder')}
          className="shrink-0"
        />
        {isLoadingUcServers ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="overflow-y-auto border border-border rounded-lg min-h-0 flex-1 max-h-[40vh]">
            <div className="space-y-0.5 p-1">
              {availableUcMcpServers.length === 0 && (
                <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                  <Network className="h-8 w-8 mb-2 opacity-50" />
                  <p className="text-sm">{t('mcp.empty')}</p>
                </div>
              )}
              {availableUcMcpServers.map(server => (
                <button
                  key={server.id}
                  type="button"
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors border',
                    selectedUcServerId === server.id
                      ? 'bg-primary/10 border-primary/30'
                      : 'hover:bg-accent/50 border-transparent'
                  )}
                  onClick={() => setSelectedUcServerId(server.id)}
                >
                  <Network className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{server.name}</p>
                    <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                      {server.url}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {selectedUcServer && (
        <div className="space-y-2 shrink-0">
          <Label htmlFor="unity-display-name">{t('mcp.displayName')}</Label>
          <Input
            id="unity-display-name"
            value={serverName}
            onChange={e => setServerName(e.target.value)}
            placeholder={t('mcp.displayNamePlaceholder')}
          />
        </div>
      )}

      {/* URL preview */}
      {selectedUcServer && (
        <div className="space-y-1 shrink-0">
          <Label className="text-xs text-muted-foreground">{t('mcp.url')}</Label>
          <p className="text-xs font-mono text-muted-foreground/70 bg-muted p-2 rounded truncate">
            {selectedUcServer.url}
          </p>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2 shrink-0">
        <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
          {t('common.cancel')}
        </Button>
        <Button onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          {t('mcp.addManagedServer')}
        </Button>
      </div>
    </div>
  );
}

// ─── Unified Add MCP dialog ──────────────────────────────────

function AddMcpDialog({
  open,
  onOpenChange,
  onCreated,
  databricksHost,
  existingServers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  databricksHost: string | null | undefined;
  existingServers: McpServerRecord[];
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<AddMcpStep>('select');

  // Managed MCP state
  const [selectedManagedType, setSelectedManagedType] = useState<ManagedMcpType | null>(null);
  const [serverName, setServerName] = useState('');
  const [selectedGenieSpaceId, setSelectedGenieSpaceId] = useState('');
  const [genieSpaces, setGenieSpaces] = useState<GenieSpace[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [isLoadingSpaces, setIsLoadingSpaces] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [genieSearchQuery, setGenieSearchQuery] = useState('');

  // Shared state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const dbsqlAlreadyRegistered = existingServers.some(s => s.managed_type === 'databricks_sql');
  const registeredGenieIds = useMemo(
    () =>
      new Set(existingServers.filter(s => s.managed_type === 'databricks_genie').map(s => s.id)),
    [existingServers]
  );
  const reset = () => {
    setStep('select');
    setSelectedManagedType(null);
    setServerName('');
    setSelectedGenieSpaceId('');
    setGenieSpaces([]);
    setNextPageToken(undefined);
    setGenieSearchQuery('');
    setFormError(null);
  };

  const handleOpenChange = (v: boolean) => {
    onOpenChange(v);
    if (!v) reset();
  };

  // ─── Managed MCP helpers ───

  const fetchGenieSpaces = async (pageToken?: string) => {
    const isFirstPage = !pageToken;
    if (isFirstPage) setIsLoadingSpaces(true);
    else setIsLoadingMore(true);

    try {
      const res = await genieService.listGenieSpaces(pageToken);
      if (isFirstPage) {
        setGenieSpaces(res.spaces ?? []);
      } else {
        setGenieSpaces(prev => [...prev, ...(res.spaces ?? [])]);
      }
      setNextPageToken(res.next_page_token);
    } catch {
      setFormError(t('mcp.genieSpaceFetchError'));
    } finally {
      setIsLoadingSpaces(false);
      setIsLoadingMore(false);
    }
  };

  const handleGenieSelect = (spaceId: string) => {
    setSelectedGenieSpaceId(spaceId);
    const space = genieSpaces.find(s => s.space_id === spaceId);
    if (space) {
      setServerName(space.title);
    }
  };

  const previewUrl = useMemo(() => {
    if (!databricksHost) return '';
    if (selectedManagedType === 'databricks_sql') return buildDbsqlMcpUrl(databricksHost);
    if (selectedManagedType === 'databricks_genie' && selectedGenieSpaceId)
      return buildGenieMcpUrl(databricksHost, selectedGenieSpaceId);
    return '';
  }, [databricksHost, selectedManagedType, selectedGenieSpaceId]);

  const availableGenieSpaces = useMemo(() => {
    const q = genieSearchQuery.toLowerCase().trim();
    return genieSpaces.filter(s => {
      if (registeredGenieIds.has(`genie_${s.space_id}`)) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) || (s.description?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [genieSpaces, registeredGenieIds, genieSearchQuery]);

  const handleManagedSubmit = async () => {
    setFormError(null);

    if (!serverName.trim()) {
      setFormError(t('mcp.displayNameRequired'));
      return;
    }

    if (selectedManagedType === 'databricks_genie' && !selectedGenieSpaceId) {
      setFormError(t('mcp.selectGenieSpace'));
      return;
    }

    setIsSubmitting(true);
    try {
      await mcpServerService.create({
        id: selectedManagedType === 'databricks_sql' ? 'dbsql' : selectedGenieSpaceId,
        name: serverName.trim(),
        type: 'http',
        managed_type: selectedManagedType!,
      });
      toast.success(t('mcp.addSuccess'));
      handleOpenChange(false);
      onCreated();
    } catch (err) {
      const detail = err instanceof Error ? err.message : '';
      if (detail.includes('409') || detail.toLowerCase().includes('already')) {
        setFormError(t('mcp.duplicateError'));
      } else {
        setFormError(detail || t('mcp.addError'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── Tile click handler ───

  const handleTileClick = async (tileType: McpTileConfig['type']) => {
    setFormError(null);

    if (tileType === 'databricks_sql') {
      setSelectedManagedType('databricks_sql');
      setServerName('Databricks SQL');
      setStep('configure-managed');
      return;
    }

    if (tileType === 'databricks_genie') {
      setSelectedManagedType('databricks_genie');
      setStep('configure-managed');
      await fetchGenieSpaces();
      return;
    }

    if (tileType === 'unity_ai_gateway') {
      setStep('configure-unity-gateway');
      return;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t('mcp.addMcpServer')}</DialogTitle>
          <DialogDescription>{t('mcp.addMcpServerDescription')}</DialogDescription>
        </DialogHeader>

        {formError && (
          <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-md text-sm shrink-0">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {formError}
          </div>
        )}

        {/* ─── Step: Tile Selection ─── */}
        {step === 'select' && (
          <div className="overflow-y-auto">
            <div className="grid grid-cols-3 gap-3">
              {MCP_TILES.map(tile => {
                const Icon = tile.icon;
                const isDisabled =
                  tile.disabled ||
                  (tile.type === 'databricks_sql' && dbsqlAlreadyRegistered) ||
                  (tile.type === 'custom' && !databricksHost);
                const tileClassName = cn(
                  'flex flex-col items-center gap-2 p-4 rounded-lg border border-border bg-card',
                  'hover:bg-accent/50 transition-colors text-center',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                );
                const tileContent = (
                  <>
                    <Icon className="h-8 w-8 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">{t(tile.labelKey)}</p>
                      <p className="text-xs text-muted-foreground mt-1">{t(tile.descriptionKey)}</p>
                    </div>
                    {tile.disabledBadgeKey && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                        <Construction className="h-3 w-3" />
                        {t(tile.disabledBadgeKey)}
                      </span>
                    )}
                    {tile.type === 'databricks_sql' && dbsqlAlreadyRegistered && (
                      <p className="text-xs text-amber-500">{t('mcp.dbsqlAlreadyRegistered')}</p>
                    )}
                  </>
                );

                if (tile.type === 'custom' && databricksHost) {
                  return (
                    <a
                      key={tile.type}
                      href={`https://${databricksHost}/ml/ai-gateway/mcp`}
                      target="_blank"
                      rel="noreferrer"
                      className={tileClassName}
                    >
                      {tileContent}
                    </a>
                  );
                }

                return (
                  <button
                    key={tile.type}
                    type="button"
                    disabled={isDisabled}
                    className={tileClassName}
                    onClick={() => handleTileClick(tile.type)}
                  >
                    {tileContent}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── Step: Managed MCP Configuration ─── */}
        {step === 'configure-managed' && (
          <div className="flex flex-col gap-4 min-h-0 flex-1">
            <Button
              variant="ghost"
              size="sm"
              className="self-start shrink-0"
              onClick={() => {
                setStep('select');
                setFormError(null);
              }}
            >
              &larr; {t('mcp.selectServerType')}
            </Button>

            {/* Genie space scrollable list */}
            {selectedManagedType === 'databricks_genie' && (
              <div className="flex flex-col gap-2 min-h-0 flex-1">
                <Label className="shrink-0">{t('mcp.selectGenieSpace')}</Label>
                <Input
                  value={genieSearchQuery}
                  onChange={e => setGenieSearchQuery(e.target.value)}
                  placeholder={t('mcp.genieSearchPlaceholder')}
                  className="shrink-0"
                />
                {isLoadingSpaces ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : (
                  <div className="overflow-y-auto border border-border rounded-lg min-h-0 flex-1 max-h-[40vh]">
                    <div className="space-y-0.5 p-1">
                      {availableGenieSpaces.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                          <Sparkles className="h-8 w-8 mb-2 opacity-50" />
                          <p className="text-sm">{t('mcp.empty')}</p>
                        </div>
                      )}
                      {availableGenieSpaces.map(space => (
                        <button
                          key={space.space_id}
                          type="button"
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors border',
                            selectedGenieSpaceId === space.space_id
                              ? 'bg-primary/10 border-primary/30'
                              : 'hover:bg-accent/50 border-transparent'
                          )}
                          onClick={() => handleGenieSelect(space.space_id)}
                        >
                          <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{space.title}</p>
                            {space.description && (
                              <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                                {space.description}
                              </p>
                            )}
                          </div>
                        </button>
                      ))}
                      {nextPageToken && (
                        <div className="flex justify-center py-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isLoadingMore}
                            onClick={() => fetchGenieSpaces(nextPageToken)}
                          >
                            {isLoadingMore ? (
                              <Loader2 className="h-4 w-4 animate-spin mr-1" />
                            ) : (
                              <Plus className="h-4 w-4 mr-1" />
                            )}
                            {t('common.loadMore')}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Display name */}
            <div className="space-y-2 shrink-0">
              <Label htmlFor="managed-display-name">{t('mcp.displayName')}</Label>
              <Input
                id="managed-display-name"
                value={serverName}
                onChange={e => setServerName(e.target.value)}
                placeholder={t('mcp.displayNamePlaceholder')}
              />
            </div>

            {/* URL preview */}
            {previewUrl && (
              <div className="space-y-1 shrink-0">
                <Label className="text-xs text-muted-foreground">{t('mcp.url')}</Label>
                <p className="text-xs font-mono text-muted-foreground/70 bg-muted p-2 rounded truncate">
                  {previewUrl}
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 shrink-0">
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={isSubmitting}
              >
                {t('common.cancel')}
              </Button>
              <Button onClick={handleManagedSubmit} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                {t('mcp.addManagedServer')}
              </Button>
            </div>
          </div>
        )}

        {/* ─── Step: Unity AI Gateway Configuration ─── */}
        {step === 'configure-unity-gateway' && (
          <UnityAiGatewayStep
            existingServers={existingServers}
            onBack={() => {
              setStep('select');
              setFormError(null);
            }}
            onCreated={onCreated}
            onClose={() => handleOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ───────────────────────────────────────────────

export function McpContent() {
  const { t } = useTranslation();
  const { databricksHost } = useUser();
  const [allServers, setAllServers] = useState<McpServerRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Custom server dialog state
  const [dialogMode, setDialogMode] = useState<'add' | 'edit' | null>(null);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState<ServerFormState>(EMPTY_FORM);

  // Add MCP dialog state
  const [showAddDialog, setShowAddDialog] = useState(false);

  const [enabledServers, setEnabledServers] = useState<Record<string, boolean>>({});

  const fetchServers = useCallback(async () => {
    try {
      const response = await mcpServerService.list();
      const servers = response.mcp_servers ?? [];
      setAllServers(servers);
      // サーバーレスポンスの is_disabled フィールドから有効状態を構築
      const enabled: Record<string, boolean> = {};
      for (const s of servers) {
        enabled[s.id] = !s.is_disabled;
      }
      setEnabledServers(enabled);
    } catch (err) {
      const detail = err instanceof Error ? err.message : '';
      setFetchError(detail ? `${t('mcp.customFetchError')}: ${detail}` : t('mcp.customFetchError'));
    }
  }, [t]);

  useEffect(() => {
    setIsLoading(true);
    fetchServers().finally(() => setIsLoading(false));
  }, [fetchServers]);

  const { managedServers, externalServers, customServers } = useMemo(() => {
    const managed: McpServerRecord[] = [];
    const external: McpServerRecord[] = [];
    const custom: McpServerRecord[] = [];
    for (const s of allServers) {
      if (s.managed_type === 'unity_ai_gateway') {
        external.push(s);
      } else if (s.managed_type != null) {
        managed.push(s);
      } else {
        custom.push(s);
      }
    }
    managed.sort((a, b) => a.id.localeCompare(b.id));
    custom.sort((a, b) => a.id.localeCompare(b.id));
    return {
      managedServers: managed,
      externalServers: prioritizeSystemAiAgentExternalServers(external),
      customServers: custom,
    };
  }, [allServers]);

  const handleToggle = (key: string, checked: boolean) => {
    setEnabledServers(prev => ({ ...prev, [key]: checked }));
    // バックグラウンドで API に保存（is_disabled は checked の反転）
    mcpServerService.update(key, { is_disabled: !checked }).catch(() => {
      // 失敗時にリバート
      setEnabledServers(prev => ({ ...prev, [key]: !checked }));
      toast.error(t('mcp.settingsSaveError'));
    });
  };

  // ─── Custom server dialog handlers ───
  const closeDialog = () => {
    setDialogMode(null);
    setEditingServerId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const openEditDialog = (server: McpServerRecord) => {
    setEditingServerId(server.id);
    setForm(serverToFormState(server));
    setFormError(null);
    setDialogMode('edit');
  };

  const validateForm = (): string | null => {
    if (dialogMode === 'add') {
      if (!form.id.trim()) return t('mcp.idRequired');
      if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(form.id.trim())) return t('mcp.idInvalid');
    }
    if (!form.serverName.trim()) return t('mcp.displayNameRequired');
    if ((form.type === 'http' || form.type === 'sse') && !form.url.trim())
      return t('mcp.urlRequired');
    if (form.type === 'stdio' && !form.command.trim()) return t('mcp.commandRequired');
    return null;
  };

  const handleSubmit = async () => {
    setFormError(null);
    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    const payload = buildFormPayload(form);

    setIsSubmitting(true);
    try {
      if (dialogMode === 'add') {
        await mcpServerService.create({ id: form.id.trim(), ...payload });
        toast.success(t('mcp.addSuccess'));
      } else if (editingServerId) {
        await mcpServerService.update(editingServerId, payload);
        toast.success(t('mcp.editSuccess'));
      }
      closeDialog();
      await fetchServers();
    } catch (err) {
      const detail = err instanceof Error ? err.message : '';
      setFormError(detail || t(dialogMode === 'add' ? 'mcp.addError' : 'mcp.editError'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (server: McpServerRecord) => {
    if (!confirm(t('mcp.deleteConfirm', { name: server.name }))) return;
    try {
      await mcpServerService.remove(server.id);
      toast.success(t('mcp.deleteSuccess'));
      await fetchServers();
    } catch {
      toast.error(t('mcp.deleteError'));
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-xl font-bold">{t('mcp.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('mcp.description')}</p>
        </div>
        <Button size="sm" onClick={() => setShowAddDialog(true)}>
          <Plus className="h-4 w-4 mr-1" />
          {t('mcp.addMcpServer')}
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {fetchError && (
          <div className="flex items-center gap-2 p-3 mb-4 bg-destructive/10 text-destructive rounded-md text-sm">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {fetchError}
          </div>
        )}

        {/* Managed MCP section */}
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-muted-foreground mb-2">
            {t('mcp.managedSection')}
          </h2>
          {managedServers.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <DatabaseSearch className="h-10 w-10 mb-3 opacity-50" />
              <p className="text-sm">{t('mcp.managedEmpty')}</p>
            </div>
          )}
          <div className="space-y-2">
            {managedServers.map(server => {
              const isEnabled = enabledServers[server.id] ?? true;

              return (
                <ManagedServerCard
                  key={server.id}
                  server={server}
                  idPrefix="managed"
                  isEnabled={isEnabled}
                  databricksHost={databricksHost}
                  loginLabel={t('mcp.login')}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                />
              );
            })}
          </div>
        </section>

        {/* External MCP section */}
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-muted-foreground mb-2">
            {t('mcp.externalSection')}
          </h2>
          {externalServers.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Network className="h-10 w-10 mb-3 opacity-50" />
              <p className="text-sm">{t('mcp.externalEmpty')}</p>
            </div>
          )}
          <div className="space-y-2">
            {externalServers.map(server => {
              const isEnabled = enabledServers[server.id] ?? true;

              return (
                <ManagedServerCard
                  key={server.id}
                  server={server}
                  idPrefix="external"
                  isEnabled={isEnabled}
                  databricksHost={databricksHost}
                  loginLabel={t('mcp.login')}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                />
              );
            })}
          </div>
        </section>

        {customServers.length > 0 && (
          <section className="mb-6">
            <h2 className="text-sm font-semibold text-muted-foreground mb-2">
              {t('mcp.customSection')}
            </h2>
            <div className="space-y-2">
              {customServers.map(server => {
                const isEnabled = enabledServers[server.id] ?? false;

                return (
                  <div
                    key={server.id}
                    className="group flex items-center justify-between p-4 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex-1 min-w-0 mr-4">
                      <div className="flex items-center gap-2">
                        <ServerTypeIcon type={server.type} />
                        <Label
                          htmlFor={`custom-${server.id}`}
                          className="font-medium cursor-pointer"
                        >
                          {server.name}
                        </Label>
                        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          {server.type}
                        </span>
                      </div>
                      <ServerSubtitle server={server} />
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => openEditDialog(server)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Switch
                        id={`custom-${server.id}`}
                        checked={isEnabled}
                        onCheckedChange={checked => handleToggle(server.id, checked)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive invisible group-hover:visible"
                        onClick={() => handleDelete(server)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* Add MCP dialog */}
      <AddMcpDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onCreated={fetchServers}
        databricksHost={databricksHost}
        existingServers={allServers}
      />

      {/* Custom server form dialog */}
      {dialogMode && (
        <ServerFormDialog
          mode={dialogMode}
          open
          onOpenChange={open => {
            if (!open) closeDialog();
          }}
          form={form}
          onFormChange={setForm}
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
          formError={formError}
        />
      )}
    </div>
  );
}

export function McpPage() {
  return <McpContent />;
}
