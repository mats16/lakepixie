export interface ClaudeModel {
  id: string;
  name: string;
  shortName?: string;
  descriptionKey?: string;
}

// セッション作成用モデル
export const SESSION_MODELS: ClaudeModel[] = [
  {
    id: 'opus',
    name: 'Opus',
    shortName: 'Opus',
    descriptionKey: 'sidebar.model.opusDesc',
  },
  {
    id: 'sonnet',
    name: 'Sonnet',
    shortName: 'Sonnet',
    descriptionKey: 'sidebar.model.sonnetDesc',
  },
  {
    id: 'haiku',
    name: 'Haiku',
    shortName: 'Haiku',
    descriptionKey: 'sidebar.model.haikuDesc',
  },
];

// サイドバーのエージェント選択用
export const AGENT_MODELS: ClaudeModel[] = [
  { id: 'claude-agent-databricks', name: 'claude-agent-databricks' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku', name: 'Claude Haiku' },
];

export const DEFAULT_SESSION_MODEL = SESSION_MODELS[1]; // Sonnet
export const DEFAULT_AGENT_MODEL = AGENT_MODELS[0];
