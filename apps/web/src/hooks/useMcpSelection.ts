import { useState, useEffect, useMemo, useCallback } from 'react';
import { mcpServerService } from '@/services';
import { CLAUDE_CODE_PRESET_TOOLS } from '@/constants';
import type { McpConfig, McpServerEntry, McpServerRecord } from '@repo/types';

export interface McpSelectionItem {
  space_id: string;
  title: string;
  mcp_url: string;
  managed_type?: McpServerRecord['managed_type'];
  enabled: boolean;
}

interface UseMcpSelectionReturn {
  items: McpSelectionItem[];
  enabledCount: number;
  toggleItem: (spaceId: string) => void;
  /** グローバルで有効な全 MCP サーバーの設定（session_context.mcp_config 用） */
  buildMcpConfig: () => McpConfig | undefined;
  /** CLAUDE_CODE_PRESET_TOOLS + セッションで選択された MCP のツールパターン（session_context.allowed_tools 用） */
  buildAllowedTools: () => string[];
  /** セッションで無効化された MCP のツールパターン（session_context.disallowed_tools 用） */
  buildDisallowedTools: () => string[];
  isLoading: boolean;
}

export function useMcpSelection(): UseMcpSelectionReturn {
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // セッションレベルのトグル状態
  const [sessionOverrides, setSessionOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await mcpServerService
          .list()
          .catch(() => ({ mcp_servers: [] as McpServerRecord[] }));
        if (!cancelled) {
          setServers(res.mcp_servers ?? []);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const serverMap = useMemo(() => new Map(servers.map(s => [s.id, s])), [servers]);

  // グローバルで有効な全 MCP をセッションドロップダウン用にリスト化
  const items: McpSelectionItem[] = useMemo(() => {
    const result: McpSelectionItem[] = [];

    for (const server of servers) {
      // is_disabled のサーバーはスキップ
      if (server.is_disabled) continue;

      const displayUrl =
        server.type === 'stdio'
          ? [server.command, ...(server.args ?? [])].join(' ')
          : (server.url ?? '');

      result.push({
        space_id: server.id,
        title: server.name,
        mcp_url: displayUrl,
        managed_type: server.managed_type,
        enabled: sessionOverrides[server.id] ?? true,
      });
    }

    return result;
  }, [servers, sessionOverrides]);

  const enabledCount = useMemo(() => items.filter(i => i.enabled).length, [items]);

  const toggleItem = useCallback((spaceId: string) => {
    setSessionOverrides(prev => ({
      ...prev,
      [spaceId]: !(prev[spaceId] ?? true),
    }));
  }, []);

  /** サーバー ID から McpServerEntry を構築 */
  const buildServerEntry = useCallback(
    (serverId: string): McpServerEntry | undefined => {
      const server = serverMap.get(serverId);
      if (!server) return undefined;

      if (server.type === 'stdio') {
        return {
          type: 'stdio',
          command: server.command,
          args: server.args,
          env: server.env,
        };
      }

      return {
        type: server.type,
        url: server.url,
        headers: server.headers,
      };
    },
    [serverMap]
  );

  // グローバルで有効な全サーバーを mcpServers に含める（常に接続）
  const buildMcpConfig = useCallback((): McpConfig | undefined => {
    const allItems = items.filter(i => i.mcp_url);
    if (allItems.length === 0) return undefined;

    const mcpServers: McpConfig['mcpServers'] = {};
    for (const item of allItems) {
      const entry = buildServerEntry(item.space_id);
      if (entry) {
        mcpServers[item.space_id] = entry;
      } else {
        mcpServers[item.space_id] = { type: 'http', url: item.mcp_url };
      }
    }
    return { mcpServers };
  }, [items, buildServerEntry]);

  const buildToolPatterns = useCallback(
    (enabled: boolean): string[] =>
      items.filter(i => i.enabled === enabled && i.mcp_url).map(i => `mcp__${i.space_id}__*`),
    [items]
  );

  const buildAllowedTools = useCallback(
    (): string[] => [...CLAUDE_CODE_PRESET_TOOLS, ...buildToolPatterns(true)],
    [buildToolPatterns]
  );
  const buildDisallowedTools = useCallback(
    (): string[] => buildToolPatterns(false),
    [buildToolPatterns]
  );

  return {
    items,
    enabledCount,
    toggleItem,
    buildMcpConfig,
    buildAllowedTools,
    buildDisallowedTools,
    isLoading,
  };
}
