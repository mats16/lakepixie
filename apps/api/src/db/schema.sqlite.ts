// apps/api/src/db/schema.sqlite.ts
import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// updated_at は ORM ではなく DB トリガーで管理し、PG/SQLite 間の一貫性を保つ
const CURRENT_TIMESTAMP_MS = sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;

/**
 * users テーブル
 * ユーザーの基本情報を管理
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email'),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(CURRENT_TIMESTAMP_MS),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(CURRENT_TIMESTAMP_MS),
});

/**
 * user_settings テーブル
 * ユーザーごとの設定を管理
 */
export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  opusModelId: text('opus_model_id'),
  sonnetModelId: text('sonnet_model_id'),
  haikuModelId: text('haiku_model_id'),
  allowedTools: text('allowed_tools', { mode: 'json' }).$type<string[] | null>(),
  disallowedTools: text('disallowed_tools', { mode: 'json' }).$type<string[] | null>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(CURRENT_TIMESTAMP_MS),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(CURRENT_TIMESTAMP_MS),
});

/**
 * sessions テーブル
 * セッション情報を管理
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title'),
    status: text('status').notNull().default('init'),
    sdkSessionId: text('sdk_session_id'),
    context: text('context', { mode: 'json' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CURRENT_TIMESTAMP_MS),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CURRENT_TIMESTAMP_MS),
  },
  table => ({
    userIdIdx: index('sessions_user_id_idx').on(table.userId),
    updatedAtIdx: index('sessions_updated_at_idx').on(table.updatedAt),
    statusIdx: index('sessions_status_idx').on(table.status),
  })
);

/**
 * session_events テーブル
 * セッションイベントを時系列で管理
 */
export const sessionEvents = sqliteTable(
  'session_events',
  {
    uuid: text('uuid').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    subtype: text('subtype'),
    message: text('message', { mode: 'json' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CURRENT_TIMESTAMP_MS),
  },
  table => ({
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
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(CURRENT_TIMESTAMP_MS),
});

/**
 * mcp_servers テーブル
 * ユーザーごとの MCP サーバー設定を管理
 * 複合 PK (user_id, id) — id はそのまま MCP 設定キーとして使用
 */
export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(), // 'stdio' | 'http' | 'sse'
    url: text('url'),
    headers: text('headers', { mode: 'json' }), // Record<string, string>
    command: text('command'),
    args: text('args', { mode: 'json' }), // string[]
    env: text('env', { mode: 'json' }), // Record<string, string>
    managedType: text('managed_type'), // null = custom, 'databricks_sql' | 'databricks_genie' | 'databricks_vector_search'
    isDisabled: integer('is_disabled', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CURRENT_TIMESTAMP_MS),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CURRENT_TIMESTAMP_MS),
  },
  table => ({
    pk: primaryKey({ columns: [table.userId, table.id] }),
  })
);

/**
 * github_user_authorizations テーブル
 * ユーザーごとの GitHub OAuth user-to-server token を暗号化して保持
 */
export const githubUserAuthorizations = sqliteTable(
  'github_user_authorizations',
  {
    userId: text('user_id')
      .primaryKey()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    githubUserId: text('github_user_id').notNull(),
    githubLogin: text('github_login').notNull(),
    accessTokenCiphertext: text('access_token_ciphertext').notNull(),
    accessTokenIv: text('access_token_iv').notNull(),
    accessTokenAuthTag: text('access_token_auth_tag').notNull(),
    accessTokenKeyVersion: text('access_token_key_version').notNull(),
    refreshTokenCiphertext: text('refresh_token_ciphertext'),
    refreshTokenIv: text('refresh_token_iv'),
    refreshTokenAuthTag: text('refresh_token_auth_tag'),
    refreshTokenKeyVersion: text('refresh_token_key_version'),
    tokenExpiresAt: integer('token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CURRENT_TIMESTAMP_MS),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CURRENT_TIMESTAMP_MS),
  },
  table => ({
    githubLoginIdx: index('github_user_authorizations_login_idx').on(table.githubLogin),
  })
);

/**
 * github_oauth_states テーブル
 * GitHub OAuth authorization code flow の state/PKCE 検証用
 */
export const githubOAuthStates = sqliteTable(
  'github_oauth_states',
  {
    state: text('state').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeVerifierCiphertext: text('code_verifier_ciphertext').notNull(),
    codeVerifierIv: text('code_verifier_iv').notNull(),
    codeVerifierAuthTag: text('code_verifier_auth_tag').notNull(),
    codeVerifierKeyVersion: text('code_verifier_key_version').notNull(),
    redirectAfter: text('redirect_after'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CURRENT_TIMESTAMP_MS),
  },
  table => ({
    userIdIdx: index('github_oauth_states_user_id_idx').on(table.userId),
    expiresAtIdx: index('github_oauth_states_expires_at_idx').on(table.expiresAt),
  })
);

// =====================================================
// Type Exports
// =====================================================

export type InsertUser = typeof users.$inferInsert;
export type InsertUserSettings = typeof userSettings.$inferInsert;
export type InsertSession = typeof sessions.$inferInsert;
export type InsertSessionEvent = typeof sessionEvents.$inferInsert;
export type InsertAppSettings = typeof appSettings.$inferInsert;
export type InsertMcpServer = typeof mcpServers.$inferInsert;
export type InsertGithubUserAuthorization = typeof githubUserAuthorizations.$inferInsert;
export type InsertGithubOAuthState = typeof githubOAuthStates.$inferInsert;

export type User = typeof users.$inferSelect;
export type UserSettings = typeof userSettings.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type SessionEvent = typeof sessionEvents.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
export type GithubUserAuthorization = typeof githubUserAuthorizations.$inferSelect;
export type GithubOAuthState = typeof githubOAuthStates.$inferSelect;
