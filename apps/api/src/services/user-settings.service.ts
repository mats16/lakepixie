import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import {
  CLAUDE_CODE_PRESET_TOOLS,
  type UpdateUserSettingsRequest,
  type UserSettingsResponse,
} from '@repo/types';
import { eq } from 'drizzle-orm';
import { userSettings, type InsertUserSettings, type UserSettings } from '../db/schema.js';
import { DEFAULT_MODEL_SETTINGS } from '../constants/model-defaults.js';
import { getAllowedModelIds, getAppSettings, resolveModelSettings } from './admin.service.js';
import { groupModelIdsByTier } from './model-serving.service.js';

export const USER_MODEL_SETTING_KEYS = [
  'opus_model_id',
  'sonnet_model_id',
  'haiku_model_id',
] as const;

export type UserModelSettingKey = (typeof USER_MODEL_SETTING_KEYS)[number];
export const USER_ALLOWED_TOOLS_SETTING_KEY = 'allowed_tools';
export const USER_DISALLOWED_TOOLS_SETTING_KEY = 'disallowed_tools';
export const USER_CLAUDE_LANGUAGE_SETTING_KEY = 'claude_language';
export type LegacyModelTier = 'opus' | 'sonnet' | 'haiku';
type UserSettingsUpdates = Partial<
  Pick<
    InsertUserSettings,
    | 'opusModelId'
    | 'sonnetModelId'
    | 'haikuModelId'
    | 'claudeLanguage'
    | 'allowedTools'
    | 'disallowedTools'
  >
>;

const USER_MODEL_SETTING_COLUMNS = [
  { requestKey: 'opus_model_id', column: 'opusModelId' },
  { requestKey: 'sonnet_model_id', column: 'sonnetModelId' },
  { requestKey: 'haiku_model_id', column: 'haikuModelId' },
] as const satisfies readonly {
  requestKey: UserModelSettingKey;
  column: keyof Pick<InsertUserSettings, 'opusModelId' | 'sonnetModelId' | 'haikuModelId'>;
}[];

const LEGACY_TIER_TO_USER_SETTING_KEY = {
  opus: 'opus_model_id',
  sonnet: 'sonnet_model_id',
  haiku: 'haiku_model_id',
} as const satisfies Record<LegacyModelTier, UserModelSettingKey>;

function isLegacyModelTier(value: string): value is LegacyModelTier {
  return value === 'opus' || value === 'sonnet' || value === 'haiku';
}

function getTierValues<T>(values: Record<UserModelSettingKey, T>, tier: LegacyModelTier): T {
  return values[LEGACY_TIER_TO_USER_SETTING_KEY[tier]];
}

function selectModelId(params: {
  userModelId?: string;
  appDefaultModelId: string;
  tierModelIds: string[];
  hardcodedDefaultModelId: string;
  allowedModelIds: Set<string>;
}): string {
  if (params.userModelId && params.allowedModelIds.has(params.userModelId)) {
    return params.userModelId;
  }
  if (params.allowedModelIds.has(params.appDefaultModelId)) {
    return params.appDefaultModelId;
  }
  return params.tierModelIds[0] ?? [...params.allowedModelIds][0] ?? params.hardcodedDefaultModelId;
}

function normalizeToolList(tools: string[]): string[] {
  return [...new Set(tools.map(tool => tool.trim()).filter(tool => tool.length > 0))];
}

function parseToolList(
  value: string[] | string | null | undefined,
  defaultTools: string[],
  options?: { logger?: FastifyBaseLogger; settingKey: string }
): string[] {
  if (!value) return [...defaultTools];

  if (Array.isArray(value)) {
    return normalizeToolList(value);
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [...defaultTools];

    return normalizeToolList(parsed.filter((tool): tool is string => typeof tool === 'string'));
  } catch (error) {
    options?.logger?.warn(
      { err: error, settingKey: options.settingKey },
      'Failed to parse stored tool list, using defaults'
    );
    return [...defaultTools];
  }
}

function validateToolList(settingKey: string, tools: string[]): void {
  if (tools.some(tool => tool.trim().length === 0)) {
    throw new UserSettingsValidationError(`${settingKey} must contain only non-empty strings`);
  }
}

function normalizeClaudeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    throw new UserSettingsValidationError(
      `${USER_CLAUDE_LANGUAGE_SETTING_KEY} must be a non-empty string or null`
    );
  }
  if (normalized.length > 64) {
    throw new UserSettingsValidationError(
      `${USER_CLAUDE_LANGUAGE_SETTING_KEY} must be 64 characters or fewer`
    );
  }
  return normalized;
}

function parseStoredClaudeLanguage(
  value: string | null | undefined,
  logger?: FastifyBaseLogger
): string | null {
  if (value == null) return null;

  try {
    return normalizeClaudeLanguage(value);
  } catch (error) {
    logger?.warn(
      { err: error, settingKey: USER_CLAUDE_LANGUAGE_SETTING_KEY },
      'Failed to parse stored Claude language, using default'
    );
    return null;
  }
}

async function getUserSettingRow(
  fastify: FastifyInstance,
  userId: string
): Promise<UserSettings | undefined> {
  const rows = (await fastify.withUserContext(userId, async tx =>
    tx.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1)
  )) as UserSettings[];

  return rows[0];
}

export async function getUserSettings(
  fastify: FastifyInstance,
  userId: string
): Promise<UserSettingsResponse> {
  const [appSettings, userSettingRow] = await Promise.all([
    getAppSettings(fastify),
    getUserSettingRow(fastify, userId),
  ]);
  const appModelSettings = resolveModelSettings(appSettings);
  const allowedModelIds = new Set(appSettings.allowed_model_ids);
  const allowedModelIdsByTier = groupModelIdsByTier(appSettings.allowed_model_ids);

  return {
    opus_model_id: selectModelId({
      userModelId: userSettingRow?.opusModelId ?? undefined,
      appDefaultModelId: appModelSettings.opusModel,
      tierModelIds: allowedModelIdsByTier.opus,
      hardcodedDefaultModelId: DEFAULT_MODEL_SETTINGS.default_opus_model,
      allowedModelIds,
    }),
    sonnet_model_id: selectModelId({
      userModelId: userSettingRow?.sonnetModelId ?? undefined,
      appDefaultModelId: appModelSettings.sonnetModel,
      tierModelIds: allowedModelIdsByTier.sonnet,
      hardcodedDefaultModelId: DEFAULT_MODEL_SETTINGS.default_sonnet_model,
      allowedModelIds,
    }),
    haiku_model_id: selectModelId({
      userModelId: userSettingRow?.haikuModelId ?? undefined,
      appDefaultModelId: appModelSettings.haikuModel,
      tierModelIds: allowedModelIdsByTier.haiku,
      hardcodedDefaultModelId: DEFAULT_MODEL_SETTINGS.default_haiku_model,
      allowedModelIds,
    }),
    claude_language: parseStoredClaudeLanguage(userSettingRow?.claudeLanguage, fastify.log),
    allowed_tools: parseToolList(userSettingRow?.allowedTools, [...CLAUDE_CODE_PRESET_TOOLS], {
      logger: fastify.log,
      settingKey: USER_ALLOWED_TOOLS_SETTING_KEY,
    }),
    disallowed_tools: parseToolList(userSettingRow?.disallowedTools, [], {
      logger: fastify.log,
      settingKey: USER_DISALLOWED_TOOLS_SETTING_KEY,
    }),
    allowed_model_ids: allowedModelIdsByTier,
  };
}

export async function updateUserSettings(
  fastify: FastifyInstance,
  userId: string,
  settings: UpdateUserSettingsRequest
): Promise<UserSettingsResponse> {
  const allowedModelIds = new Set(await getAllowedModelIds(fastify));
  const allowedTools = settings.allowed_tools;
  const disallowedTools = settings.disallowed_tools;
  const claudeLanguage = settings.claude_language;
  const updates: UserSettingsUpdates = {};

  for (const { requestKey, column } of USER_MODEL_SETTING_COLUMNS) {
    const value = settings[requestKey];
    if (value === undefined) continue;
    if (value !== null && !allowedModelIds.has(value)) {
      throw new UserSettingsValidationError(`${requestKey} must be an allowed model id or null`);
    }
    updates[column] = value;
  }
  if (allowedTools !== undefined && allowedTools !== null) {
    validateToolList(USER_ALLOWED_TOOLS_SETTING_KEY, allowedTools);
    updates.allowedTools = normalizeToolList(allowedTools);
  } else if (allowedTools === null) {
    updates.allowedTools = null;
  }
  if (disallowedTools !== undefined && disallowedTools !== null) {
    validateToolList(USER_DISALLOWED_TOOLS_SETTING_KEY, disallowedTools);
    updates.disallowedTools = normalizeToolList(disallowedTools);
  } else if (disallowedTools === null) {
    updates.disallowedTools = null;
  }
  if (claudeLanguage !== undefined && claudeLanguage !== null) {
    updates.claudeLanguage = normalizeClaudeLanguage(claudeLanguage);
  } else if (claudeLanguage === null) {
    updates.claudeLanguage = null;
  }

  if (Object.keys(updates).length > 0) {
    await fastify.withUserContext(userId, async tx => {
      await tx
        .insert(userSettings)
        .values({ userId, ...updates })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: updates,
        });
    });
  }

  return getUserSettings(fastify, userId);
}

export function resolveSessionModelIdFromSettings(
  userSettings: UserSettingsResponse,
  allowedModelIds: ReadonlySet<string>,
  requestedModelId: string
): string {
  const trimmed = requestedModelId.trim();
  if (!trimmed) {
    throw new UserSettingsValidationError('session_context.model must be a non-empty string');
  }

  if (isLegacyModelTier(trimmed)) {
    return getTierValues(userSettings, trimmed);
  }

  if (!allowedModelIds.has(trimmed)) {
    throw new UserSettingsValidationError('session_context.model must be an allowed model id');
  }

  return trimmed;
}

export class UserSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserSettingsValidationError';
  }
}
