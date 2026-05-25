import type { SDKMessage, ToolResultContentBlock } from '@repo/types';
import {
  isSDKUserMessageEvent,
  isSDKAssistantMessageEvent,
  isToolResultContentBlock,
  isToolUseContentBlock,
  hasParentToolUseId,
} from '@repo/types';
import { TOOL_NAMES_OMIT_INPUT_SUMMARY } from './tool-constants';

export interface ToolResult {
  content: string;
  isError: boolean;
  toolUseResult?: unknown;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * SDKMessage[] から tool_result を抽出して Map に格納
 */
export function extractToolResults(events: SDKMessage[]): Map<string, ToolResult> {
  const toolResultMap = new Map<string, ToolResult>();

  for (const event of events) {
    if (!isSDKUserMessageEvent(event)) continue;

    const content = event.message.content;
    if (!Array.isArray(content)) continue;

    const toolResultBlocks: ToolResultContentBlock[] = [];
    for (const block of content) {
      if (isToolResultContentBlock(block)) {
        toolResultBlocks.push(block);
      }
    }
    const toolUseResult = toolResultBlocks.length === 1 ? event.tool_use_result : undefined;

    for (const block of toolResultBlocks) {
      toolResultMap.set(block.tool_use_id, {
        content:
          typeof block.content === 'string'
            ? block.content
            : block.content != null
              ? JSON.stringify(block.content)
              : '',
        isError: block.is_error ?? false,
        toolUseResult,
      });
    }
  }

  return toolResultMap;
}

/**
 * assistant メッセージの content から tool_use ブロックを抽出
 */
export function extractToolUseBlocks(assistantMsg: SDKMessage): ToolUseBlock[] {
  const toolUses: ToolUseBlock[] = [];

  if (!isSDKAssistantMessageEvent(assistantMsg)) return toolUses;

  const content = assistantMsg.message.content;
  if (!Array.isArray(content)) return toolUses;

  for (const block of content) {
    if (isToolUseContentBlock(block)) {
      toolUses.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }

  return toolUses;
}

/**
 * assistant メッセージの content から tool_use ブロックを Map として抽出
 * ID をキーとしてアクセスできるため、ループ内での検索が O(1) になる
 */
export function extractToolUseBlocksAsMap(assistantMsg: SDKMessage): Map<string, ToolUseBlock> {
  const toolUseMap = new Map<string, ToolUseBlock>();

  if (!isSDKAssistantMessageEvent(assistantMsg)) return toolUseMap;

  const content = assistantMsg.message.content;
  if (!Array.isArray(content)) return toolUseMap;

  for (const block of content) {
    if (isToolUseContentBlock(block)) {
      toolUseMap.set(block.id, {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }

  return toolUseMap;
}

/**
 * ToolUseContentBlock から id を取得（型安全）
 */
export function getToolUseId(block: unknown): string | null {
  if (isToolUseContentBlock(block)) {
    return block.id;
  }
  return null;
}

/**
 * ツール別の入力表示を取得
 */
export function getToolInputDisplay(
  name: string,
  input: Record<string, unknown>
): string | undefined {
  if (TOOL_NAMES_OMIT_INPUT_SUMMARY.has(name)) return undefined;

  if (name === 'Bash' && typeof input.command === 'string') return input.command;
  if (
    (name === 'Read' || name === 'Write' || name === 'Edit') &&
    typeof input.file_path === 'string'
  )
    return input.file_path;
  if ((name === 'Grep' || name === 'Glob') && typeof input.pattern === 'string')
    return input.pattern;
  if (name === 'NotebookEdit' && typeof input.notebook_path === 'string')
    return input.notebook_path;
  if (name === 'WebSearch' && typeof input.query === 'string') return input.query;
  if (name === 'WebFetch' && typeof input.url === 'string') return input.url;
  if (name === 'Task' && typeof input.description === 'string') return input.description;
  if (name === 'Agent' && input.subagent_type != null) return String(input.subagent_type);
  if (name === 'Skill' && typeof input.skill === 'string') return input.skill;
  if (
    (name === 'mcp__dbsql__execute_sql_read_only' || name === 'mcp__dbsql__execute_sql') &&
    typeof input.query === 'string'
  )
    return input.query;

  return JSON.stringify(input);
}

/**
 * 子イベント（parent_tool_use_id を持つイベント）をグループ化
 */
export function groupChildEvents(events: SDKMessage[]): Map<string, SDKMessage[]> {
  const childEventsMap = new Map<string, SDKMessage[]>();

  for (const event of events) {
    if (hasParentToolUseId(event)) {
      const parentToolUseId = event.parent_tool_use_id;
      const existing = childEventsMap.get(parentToolUseId) ?? [];
      existing.push(event);
      childEventsMap.set(parentToolUseId, existing);
    }
  }

  return childEventsMap;
}

/**
 * 子イベントからネストされたツール使用を抽出
 */
export interface NestedToolUse {
  name: string;
  input: string;
  result?: string;
  isError?: boolean;
}

export function extractNestedToolUses(
  childEvents: SDKMessage[],
  toolResultMap: Map<string, ToolResult>
): NestedToolUse[] {
  const tools: NestedToolUse[] = [];

  for (const event of childEvents) {
    if (!isSDKAssistantMessageEvent(event)) continue;

    const toolBlocks = extractToolUseBlocks(event);
    for (const toolBlock of toolBlocks) {
      const result = toolResultMap.get(toolBlock.id);
      tools.push({
        name: toolBlock.name,
        input: getToolInputDisplay(toolBlock.name, toolBlock.input) ?? '',
        result: result?.content,
        isError: result?.isError,
      });
    }
  }

  return tools;
}

/**
 * 子イベントのツール使用数をカウント
 */
export function countNestedToolUses(childEvents: SDKMessage[]): number {
  let count = 0;

  for (const event of childEvents) {
    if (!isSDKAssistantMessageEvent(event)) continue;

    const toolBlocks = extractToolUseBlocks(event);
    count += toolBlocks.length;
  }

  return count;
}
