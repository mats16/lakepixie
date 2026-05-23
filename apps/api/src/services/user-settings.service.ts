import type { FastifyInstance } from 'fastify';
import type { UpdateUserSettingsRequest, UserSettingsResponse } from '@repo/types';
import { and, eq, inArray } from 'drizzle-orm';
import { userSettings } from '../db/schema.js';
import { DEFAULT_MODEL_SETTINGS } from '../constants/model-defaults.js';
import { getAllowedModelIds, getAppSettings, resolveModelSettings } from './admin.service.js';
import { groupModelIdsByTier } from './model-serving.service.js';

export const USER_MODEL_SETTING_KEYS = [
  'opus_model_id',
  'sonnet_model_id',
  'haiku_model_id',
] as const;

export type UserModelSettingKey = (typeof USER_MODEL_SETTING_KEYS)[number];
export type LegacyModelTier = 'opus' | 'sonnet' | 'haiku';

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
  return params.tierModelIds[0] ?? params.hardcodedDefaultModelId;
}

async function getUserModelSettingMap(
  fastify: FastifyInstance,
  userId: string
): Promise<Map<string, string>> {
  const rows = await fastify.withUserContext(userId, async tx =>
    tx
      .select({ key: userSettings.key, value: userSettings.value })
      .from(userSettings)
      .where(inArray(userSettings.key, [...USER_MODEL_SETTING_KEYS]))
  );

  return new Map(rows.map(row => [row.key, row.value]));
}

export async function getUserSettings(
  fastify: FastifyInstance,
  userId: string
): Promise<UserSettingsResponse> {
  const [appSettings, userSettingMap] = await Promise.all([
    getAppSettings(fastify),
    getUserModelSettingMap(fastify, userId),
  ]);
  const appModelSettings = resolveModelSettings(appSettings);
  const allowedModelIds = new Set(appSettings.allowed_model_ids);
  const allowedModelIdsByTier = groupModelIdsByTier(appSettings.allowed_model_ids);

  return {
    opus_model_id: selectModelId({
      userModelId: userSettingMap.get('opus_model_id'),
      appDefaultModelId: appModelSettings.opusModel,
      tierModelIds: allowedModelIdsByTier.opus,
      hardcodedDefaultModelId: DEFAULT_MODEL_SETTINGS.default_opus_model,
      allowedModelIds,
    }),
    sonnet_model_id: selectModelId({
      userModelId: userSettingMap.get('sonnet_model_id'),
      appDefaultModelId: appModelSettings.sonnetModel,
      tierModelIds: allowedModelIdsByTier.sonnet,
      hardcodedDefaultModelId: DEFAULT_MODEL_SETTINGS.default_sonnet_model,
      allowedModelIds,
    }),
    haiku_model_id: selectModelId({
      userModelId: userSettingMap.get('haiku_model_id'),
      appDefaultModelId: appModelSettings.haikuModel,
      tierModelIds: allowedModelIdsByTier.haiku,
      hardcodedDefaultModelId: DEFAULT_MODEL_SETTINGS.default_haiku_model,
      allowedModelIds,
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
  const entries = USER_MODEL_SETTING_KEYS.flatMap(key => {
    const value = settings[key];
    return value === undefined ? [] : [{ key, value }];
  });

  for (const entry of entries) {
    if (entry.value !== null && !allowedModelIds.has(entry.value)) {
      throw new UserSettingsValidationError(`${entry.key} must be an allowed model id or null`);
    }
  }

  await fastify.withUserContext(userId, async tx => {
    for (const entry of entries) {
      if (entry.value === null) {
        await tx
          .delete(userSettings)
          .where(and(eq(userSettings.userId, userId), eq(userSettings.key, entry.key)));
      } else {
        await tx
          .insert(userSettings)
          .values({ userId, key: entry.key, value: entry.value })
          .onConflictDoUpdate({
            target: [userSettings.userId, userSettings.key],
            set: { value: entry.value },
          });
      }
    }
  });

  return getUserSettings(fastify, userId);
}

export async function resolveSessionModelId(
  fastify: FastifyInstance,
  userId: string,
  requestedModelId: string
): Promise<string> {
  const trimmed = requestedModelId.trim();
  if (!trimmed) {
    throw new UserSettingsValidationError('session_context.model must be a non-empty string');
  }

  const userSettings = await getUserSettings(fastify, userId);
  if (isLegacyModelTier(trimmed)) {
    return getTierValues(userSettings, trimmed);
  }

  const allowedModelIds = new Set(await getAllowedModelIds(fastify));
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
