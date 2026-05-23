// apps/api/src/db/schema.ts
import {
  pgTable,
  uuid,
  timestamp,
  text,
  boolean,
  index,
  pgPolicy,
  jsonb,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// =====================================================
// Enums
// =====================================================
// (No enums defined)

// =====================================================
// Tables
// =====================================================

/**
 * users テーブル
 * ユーザーの基本情報を管理
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email'),
  isAdmin: boolean('is_admin').notNull().default(true),
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

/**
 * user_settings テーブル
 * ユーザーごとの設定を管理
 */
export const userSettings = pgTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  opusModelId: text('opus_model_id'),
  sonnetModelId: text('sonnet_model_id'),
  haikuModelId: text('haiku_model_id'),
  allowedTools: jsonb('allowed_tools').$type<string[] | null>(),
  disallowedTools: jsonb('disallowed_tools').$type<string[] | null>(),
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .default(sql`now()`),
}).enableRLS();

/**
 * user_settings の RLS ポリシー
 * ユーザーは自分のデータのみアクセス可能
 */
export const userSettingsPolicy = pgPolicy('user_settings_user_isolation_policy', {
  for: 'all',
  to: 'public',
  using: sql`user_id = current_setting('app.user_id', true)`,
  withCheck: sql`user_id = current_setting('app.user_id', true)`,
}).link(userSettings);

/**
 * sessions テーブル
 * セッション情報を管理
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title'),
    status: text('status').notNull().default('init'), // 'init' | 'running' | 'idle' | 'error' | 'archived'
    sdkSessionId: uuid('sdk_session_id'),
    context: jsonb('context'), // SessionContextResponse
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  table => ({
    // user_id インデックス（RLSクエリ高速化）
    userIdIdx: index('sessions_user_id_idx').on(table.userId),
    // updated_at インデックス（ソート用）
    updatedAtIdx: index('sessions_updated_at_idx').on(table.updatedAt),
    // status インデックス（フィルタリング用）
    statusIdx: index('sessions_status_idx').on(table.status),
    // アクティブセッション用部分インデックス（status != 'archived' のみ）
    activeSessionsIdx: index('sessions_active_idx')
      .on(table.userId, table.updatedAt)
      .where(sql`status != 'archived'`),
  })
).enableRLS();

/**
 * sessions の RLS ポリシー
 * ユーザーは自分のセッションのみアクセス可能
 */
export const sessionsPolicy = pgPolicy('sessions_user_isolation_policy', {
  for: 'all',
  to: 'public',
  using: sql`user_id = current_setting('app.user_id', true)`,
  withCheck: sql`user_id = current_setting('app.user_id', true)`,
}).link(sessions);

/**
 * session_events テーブル
 * セッションイベントを時系列で管理
 *
 * 主キー: uuid
 * 順序: created_at でソート
 */
export const sessionEvents = pgTable(
  'session_events',
  {
    uuid: uuid('uuid').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    subtype: text('subtype'),
    message: jsonb('message').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  table => ({
    // (session_id, created_at) インデックス - 時系列クエリ用
    sessionCreatedAtIdx: index('session_events_session_created_at_idx').on(
      table.sessionId,
      table.createdAt
    ),
  })
);

/**
 * app_settings テーブル
 * アプリケーション全体のグローバル設定を管理（key-value）
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

/**
 * mcp_servers テーブル
 * ユーザーごとの MCP サーバー設定を管理
 * 複合 PK (user_id, id) — id はそのまま MCP 設定キーとして使用
 */
export const mcpServers = pgTable(
  'mcp_servers',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(), // 'stdio' | 'http' | 'sse'
    url: text('url'),
    headers: jsonb('headers'), // Record<string, string>
    command: text('command'),
    args: jsonb('args'), // string[]
    env: jsonb('env'), // Record<string, string>
    managedType: text('managed_type'), // null = custom, 'databricks_sql' | 'databricks_genie' | 'databricks_vector_search'
    isDisabled: boolean('is_disabled').notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  table => ({
    pk: primaryKey({ columns: [table.userId, table.id] }),
  })
).enableRLS();

/**
 * mcp_servers の RLS ポリシー
 * ユーザーは自分のデータのみアクセス可能
 */
export const mcpServersPolicy = pgPolicy('mcp_servers_user_isolation_policy', {
  for: 'all',
  to: 'public',
  using: sql`user_id = current_setting('app.user_id', true)`,
  withCheck: sql`user_id = current_setting('app.user_id', true)`,
}).link(mcpServers);

// =====================================================
// Type Exports
// =====================================================

// Insert types (for creating new records)
export type InsertUser = typeof users.$inferInsert;
export type InsertUserSettings = typeof userSettings.$inferInsert;
export type InsertSession = typeof sessions.$inferInsert;
export type InsertSessionEvent = typeof sessionEvents.$inferInsert;
export type InsertAppSettings = typeof appSettings.$inferInsert;
export type InsertMcpServer = typeof mcpServers.$inferInsert;

// Select types (for querying records)
export type User = typeof users.$inferSelect;
export type UserSettings = typeof userSettings.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type SessionEvent = typeof sessionEvents.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
