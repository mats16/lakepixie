import type { SDKMessage } from '@repo/types';
import type { ToolResult } from '@/lib/message-utils';

export type { ToolResult };

export interface BaseToolUseProps {
  name: string;
  input: Record<string, unknown>;
  result?: ToolResult;
}

export interface ToolUseBlockProps extends BaseToolUseProps {
  childEvents?: SDKMessage[];
  toolResultMap: Map<string, ToolResult>;
}

export type ExitPlanModeOptimisticResult =
  | { type: 'approved' }
  | { type: 'rejected' }
  | { type: 'suggested'; message: string };

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}
