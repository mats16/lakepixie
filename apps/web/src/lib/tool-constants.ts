/** 表示対象外のイベントタイプ（MessageArea でフィルタ） */
export const HIDDEN_EVENT_TYPES = new Set(['system', 'stream_event']);

/** 入力サマリーを省略するツール（ツール名のみ表示） */
export const TOOL_NAMES_OMIT_INPUT_SUMMARY = new Set([
  'TodoWrite',
  'AskUserQuestion',
  'ExitPlanMode',
]);
