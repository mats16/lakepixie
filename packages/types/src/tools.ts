/**
 * Claude Code preset tools controlled by user settings.
 * MCP tools are controlled separately through MCP server/session settings.
 */
export const CLAUDE_CODE_PRESET_TOOLS = [
  'Task',
  'TaskOutput',
  'Bash',
  'Glob',
  'Grep',
  'ExitPlanMode',
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'KillShell',
  'AskUserQuestion',
  'Skill',
  'EnterPlanMode',
] as const;

export type ClaudeCodePresetTool = (typeof CLAUDE_CODE_PRESET_TOOLS)[number];
