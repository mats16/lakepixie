import type { FastifyInstance } from 'fastify';
import type {
  AdminUserInfo,
  AppPublicSettingsResponse,
  AppSettingsResponse,
  UpdateAppSettingsRequest,
} from '@repo/types';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { users, appSettings } from '../db/schema.js';
import { TtlCache } from '../lib/ttl-cache.js';
import { DEFAULT_MODEL_SETTINGS } from '../constants/model-defaults.js';

const APP_TITLE_DEFAULT = 'ccbricks';
const WELCOME_HEADING_DEFAULT = 'Claude Code on Databricks';
const APP_SETTINGS_CACHE_KEY = 'app-settings';
const APP_SETTINGS_CACHE_TTL_MS = 60 * 1000;
const GITHUB_APP_ID_SETTING_KEY = 'github_app_id';
const appSettingsCache = new TtlCache<AppSettingsResponse>(APP_SETTINGS_CACHE_TTL_MS);

const MODEL_SETTINGS_KEYS = [
  'default_opus_model',
  'default_sonnet_model',
  'default_haiku_model',
] as const;
type ModelSettingsKey = (typeof MODEL_SETTINGS_KEYS)[number];

const ALL_SETTINGS_KEYS = [
  'app_title',
  'welcome_heading',
  'default_new_user_role',
  ...MODEL_SETTINGS_KEYS,
  'otel_metrics_table_name',
  'otel_logs_table_name',
  'otel_traces_table_name',
] as const;

function getModelSetting(map: Map<string, string>, key: ModelSettingsKey): string {
  return map.get(key) ?? DEFAULT_MODEL_SETTINGS[key];
}

/**
 * 全ユーザーを取得する（管理者用）
 * users テーブルは RLS 無効のため、全ユーザーを直接取得可能
 */
export async function getAllUsers(fastify: FastifyInstance): Promise<AdminUserInfo[]> {
  const rows = await fastify.db
    .select({
      id: users.id,
      email: users.email,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt);

  return rows.map(row => ({
    id: row.id,
    email: row.email ?? null,
    is_admin: Boolean(row.isAdmin),
    created_at: (row.createdAt as Date).toISOString(),
  }));
}

/**
 * ユーザーの Admin フラグを更新する
 * 最後の Admin の降格を防止する
 */
export async function updateUserIsAdmin(
  fastify: FastifyInstance,
  userId: string,
  isAdmin: boolean
): Promise<void> {
  if (!isAdmin) {
    // 対象が唯一の Admin なら降格を拒否（1クエリで判定）
    const [countResult] = await fastify.db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.isAdmin, true), sql`${users.id} != ${userId}`));

    if (Number(countResult.count) === 0) {
      throw new LastAdminError();
    }
  }

  await fastify.db.update(users).set({ isAdmin }).where(eq(users.id, userId));
}

/**
 * アプリケーション設定を取得する
 */
export async function getAppSettings(fastify: FastifyInstance): Promise<AppSettingsResponse> {
  const cached = appSettingsCache.get(APP_SETTINGS_CACHE_KEY);
  if (cached) return cached;

  const rows = await fastify.db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, [...ALL_SETTINGS_KEYS]));

  const map = new Map(rows.map(r => [r.key, r.value]));
  const roleValue = map.get('default_new_user_role');

  const settings = {
    app_title: map.get('app_title') ?? APP_TITLE_DEFAULT,
    welcome_heading: map.get('welcome_heading') ?? WELCOME_HEADING_DEFAULT,
    default_new_user_role: roleValue === 'admin' || roleValue === 'member' ? roleValue : 'admin',
    default_opus_model: getModelSetting(map, 'default_opus_model'),
    default_sonnet_model: getModelSetting(map, 'default_sonnet_model'),
    default_haiku_model: getModelSetting(map, 'default_haiku_model'),
    otel_metrics_table_name: map.get('otel_metrics_table_name') ?? null,
    otel_logs_table_name: map.get('otel_logs_table_name') ?? null,
    otel_traces_table_name: map.get('otel_traces_table_name') ?? null,
  };

  appSettingsCache.set(APP_SETTINGS_CACHE_KEY, settings);
  return settings;
}

/**
 * 全ユーザー向けに公開してよいアプリケーション設定を取得する
 */
export async function getPublicAppSettings(
  fastify: FastifyInstance
): Promise<AppPublicSettingsResponse> {
  const settings = await getAppSettings(fastify);
  return {
    app_title: settings.app_title,
    welcome_heading: settings.welcome_heading,
  };
}

/**
 * アプリケーション設定を更新する
 *
 * 各フィールドが存在する場合のみ更新。null の場合はキーを削除（デフォルトに戻す）。
 */
export async function updateAppSettings(
  fastify: FastifyInstance,
  settings: UpdateAppSettingsRequest
): Promise<void> {
  const entries: Array<{ key: string; value: string | null }> = [];

  for (const key of ALL_SETTINGS_KEYS) {
    const value = settings[key];
    if (value !== undefined) {
      entries.push({ key, value: value ?? null });
    }
  }

  if (entries.length === 0) return;

  for (const entry of entries) {
    if (entry.value === null) {
      await fastify.db.delete(appSettings).where(eq(appSettings.key, entry.key));
    } else {
      await fastify.db
        .insert(appSettings)
        .values({ key: entry.key, value: entry.value })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: entry.value },
        });
    }
  }

  appSettingsCache.delete(APP_SETTINGS_CACHE_KEY);
}

export async function getGitHubAppIdSetting(fastify: FastifyInstance): Promise<string | null> {
  const rows = await fastify.db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, GITHUB_APP_ID_SETTING_KEY))
    .limit(1);

  return rows[0]?.value.trim() || null;
}

export async function updateGitHubAppIdSetting(
  fastify: FastifyInstance,
  githubAppId: string | null
): Promise<void> {
  const value = githubAppId?.trim() ?? '';
  if (!value) {
    await fastify.db.delete(appSettings).where(eq(appSettings.key, GITHUB_APP_ID_SETTING_KEY));
    appSettingsCache.delete(APP_SETTINGS_CACHE_KEY);
    return;
  }

  await fastify.db
    .insert(appSettings)
    .values({ key: GITHUB_APP_ID_SETTING_KEY, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value },
    });
  appSettingsCache.delete(APP_SETTINGS_CACHE_KEY);
}

/**
 * 新規ユーザーのデフォルトロールが Admin かどうかを取得する
 */
export async function getDefaultNewUserIsAdmin(fastify: FastifyInstance): Promise<boolean> {
  const settings = await getAppSettings(fastify);
  return settings.default_new_user_role === 'admin';
}

/**
 * セッション・タイトル生成で使用するモデル設定
 */
export interface ModelSettings {
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
}

/**
 * モデル設定を取得する
 *
 * DB から読み取り、未設定の場合はハードコードデフォルトにフォールバックする。
 */
export async function getModelSettings(fastify: FastifyInstance): Promise<ModelSettings> {
  const settings = await getAppSettings(fastify);
  return resolveModelSettings(settings);
}

/**
 * AppSettingsResponse からモデル設定を導出する（DB クエリなし）
 */
export function resolveModelSettings(settings: AppSettingsResponse): ModelSettings {
  return {
    opusModel: settings.default_opus_model ?? DEFAULT_MODEL_SETTINGS.default_opus_model,
    sonnetModel: settings.default_sonnet_model ?? DEFAULT_MODEL_SETTINGS.default_sonnet_model,
    haikuModel: settings.default_haiku_model ?? DEFAULT_MODEL_SETTINGS.default_haiku_model,
  };
}

/**
 * 最後の Admin を降格しようとした場合のエラー
 */
export class LastAdminError extends Error {
  constructor() {
    super('Cannot remove the last admin');
    this.name = 'LastAdminError';
  }
}
