// apps/api/src/plugins/database.ts
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createLakebasePool } from '@databricks/appkit';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { NodePgClient, NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import * as pgSchema from '../db/schema.pg.js';
import path from 'path';
import { fileURLToPath } from 'url';

type AppDatabase = PostgresJsDatabase<typeof pgSchema>;
type LakebaseDatabase = NodePgDatabase<typeof pgSchema>;
type LakebasePool = ReturnType<typeof createLakebasePool>;
type LakebaseSslMode = 'require' | 'disable' | 'prefer';
type ReleasableClient = { release: (error?: Error | boolean) => void };
type ConnectCallback<T = unknown> = (
  err: Error | undefined,
  result?: T,
  release?: (error?: Error | boolean) => void
) => void;
type QueryCallback<T = unknown> = (err: Error | null, result?: T) => void;

/**
 * RLS対応トランザクションの型
 * Drizzle ORM のトランザクション内で使用可能なDB操作
 */
export type RLSTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/**
 * withUserContext のコールバック型
 */
export type WithUserContextCallback<T> = (tx: RLSTransaction) => Promise<T>;

/**
 * RLSコンテキスト設定エラー
 * ユーザーコンテキストの設定に失敗した場合にスローされる
 */
export class RLSContextError extends Error {
  constructor(
    message: string,
    public readonly userId: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'RLSContextError';
  }
}

// Fastify型拡張
declare module 'fastify' {
  interface FastifyInstance {
    db: AppDatabase;
    /** true の場合、SQLite フォールバックモードで動作中 */
    isSqlite: boolean;
    /**
     * RLS対応のユーザーコンテキスト付きトランザクションを実行
     *
     * PostgreSQL: セッション変数 `app.user_id` を設定し、RLSポリシーによるデータ分離を有効にする
     * SQLite: RLS なしの通常トランザクション（開発用）
     *
     * @param userId - ユーザーID（RLSポリシーで使用）
     * @param callback - トランザクション内で実行するコールバック
     * @returns コールバックの戻り値
     */
    withUserContext: <T>(userId: string, callback: WithUserContextCallback<T>) => Promise<T>;
  }
}

/**
 * userId バリデーション（PG/SQLite 共通）
 */
function validateUserId(userId: string): void {
  if (!userId || typeof userId !== 'string') {
    throw new RLSContextError('Invalid userId: must be a non-empty string', userId ?? '');
  }
  if (userId.trim() === '') {
    throw new RLSContextError('Invalid userId: cannot be empty or whitespace only', userId);
  }
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function releaseWithError(client: ReleasableClient, error?: unknown): void {
  if (error === undefined || typeof error === 'boolean' || error instanceof Error) {
    client.release(error);
    return;
  }
  client.release(toError(error));
}

function optionalEnv(value: string): string | undefined {
  return value.trim() || undefined;
}

function resolveLakebaseSchema(config: FastifyInstance['config']): string {
  const appName = config.PGAPPNAME || config.DATABRICKS_APP_NAME;
  const servicePrincipalId = config.PGUSER || config.DATABRICKS_CLIENT_ID;
  if (!appName || !servicePrincipalId) {
    throw new Error(
      'PGAPPNAME and PGUSER are required to resolve the Databricks Apps Lakebase schema.'
    );
  }
  return `${appName}_schema_${servicePrincipalId.replaceAll('-', '')}`;
}

function installSearchPath(pool: LakebasePool, schemaName: string): void {
  const searchPathSql = `set search_path to ${quoteIdent(schemaName)}`;
  const originalConnect = pool.connect.bind(pool);

  async function connectWithSearchPath() {
    const client = await originalConnect();
    try {
      await client.query(searchPathSql);
    } catch (error) {
      releaseWithError(client, error);
      throw error;
    }
    return client;
  }

  pool.connect = ((callback?: ConnectCallback) => {
    if (callback) {
      connectWithSearchPath().then(
        client =>
          callback(undefined, client, releaseError => releaseWithError(client, releaseError)),
        error => callback(toError(error))
      );
      return;
    }
    return connectWithSearchPath();
  }) as LakebasePool['connect'];

  pool.query = (async (...args: Parameters<LakebasePool['query']>) => {
    const lastArg = args.at(-1);
    const callback = typeof lastArg === 'function' ? (lastArg as QueryCallback) : undefined;
    const queryArgs = callback ? args.slice(0, -1) : args;
    const client = await connectWithSearchPath();
    try {
      const result = await client.query(...(queryArgs as Parameters<typeof client.query>));
      if (callback) {
        callback(null, result);
        return;
      }
      return result;
    } catch (error) {
      if (callback) {
        callback(toError(error));
        return;
      }
      throw error;
    } finally {
      client.release();
    }
  }) as LakebasePool['query'];
}

async function copyLegacyMigrationHistoryIfNeeded(
  pool: LakebasePool,
  schemaName: string
): Promise<void> {
  const { rows } = await pool.query<{
    has_app_tables: boolean;
    has_app_migration_history: boolean;
    has_legacy_migration_history: boolean;
  }>(
    `
      select
        exists (
          select 1
          from information_schema.tables
          where table_schema = $1
            and table_type = 'BASE TABLE'
            and table_name <> '__drizzle_migrations'
        ) as has_app_tables,
        exists (
          select 1
          from information_schema.tables
          where table_schema = $1
            and table_name = '__drizzle_migrations'
        ) as has_app_migration_history,
        exists (
          select 1
          from information_schema.tables
          where table_schema = 'drizzle'
            and table_name = '__drizzle_migrations'
        ) as has_legacy_migration_history
    `,
    [schemaName]
  );
  const status = rows[0];
  if (
    !status?.has_app_tables ||
    status.has_app_migration_history ||
    !status.has_legacy_migration_history
  ) {
    return;
  }

  const appHistoryTable = `${quoteIdent(schemaName)}.${quoteIdent('__drizzle_migrations')}`;
  const legacyHistoryTable = `${quoteIdent('drizzle')}.${quoteIdent('__drizzle_migrations')}`;
  await pool.query(
    `create table if not exists ${appHistoryTable} (like ${legacyHistoryTable} including all)`
  );
  await pool.query(
    `insert into ${appHistoryTable} ("hash", "created_at") select "hash", "created_at" from ${legacyHistoryTable}`
  );
}

/**
 * SQLite データベースを初期化する
 */
async function initSqlite(fastify: FastifyInstance) {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle: drizzleSqlite } = await import('drizzle-orm/better-sqlite3');
  const sqliteSchema = await import('../db/schema.sqlite.js');

  // データディレクトリを確保
  const dataDir = path.join(fastify.config.CCBRICKS_BASE_DIR, 'db');
  const { mkdirSync } = await import('fs');
  mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'ccbricks.sqlite');
  fastify.log.info({ dbPath }, 'Using SQLite database (LAKEBASE_ENDPOINT not set)');

  // SQLite クライアント作成
  const client = new Database(dbPath);

  // WAL モード & 外部キー制約を有効化 & ロック待機タイムアウト設定
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  client.pragma('busy_timeout = 5000');
  client.pragma('recursive_triggers = OFF');

  const userSettingsColumns = client
    .prepare("SELECT name FROM pragma_table_info('user_settings')")
    .all() as Array<{ name: string }>;
  const userSettingsColumnNames = new Set(userSettingsColumns.map(col => col.name));
  const hasLegacyUserSettings =
    userSettingsColumns.length > 0 && !userSettingsColumnNames.has('opus_model_id');
  const TS = `(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;
  const migrationTimestamp = Date.now();
  if (hasLegacyUserSettings) {
    client.exec(`
      DROP TRIGGER IF EXISTS "set_updated_at_user_settings";
      DROP TABLE IF EXISTS "user_settings";
    `);
  } else if (userSettingsColumns.length > 0) {
    if (!userSettingsColumnNames.has('allowed_tools')) {
      client.exec('ALTER TABLE "user_settings" ADD COLUMN "allowed_tools" TEXT;');
    }
    if (!userSettingsColumnNames.has('disallowed_tools')) {
      client.exec('ALTER TABLE "user_settings" ADD COLUMN "disallowed_tools" TEXT;');
    }
    if (!userSettingsColumnNames.has('created_at')) {
      client.exec(
        `ALTER TABLE "user_settings" ADD COLUMN "created_at" INTEGER NOT NULL DEFAULT ${migrationTimestamp};`
      );
    }
    if (!userSettingsColumnNames.has('updated_at')) {
      client.exec(
        `ALTER TABLE "user_settings" ADD COLUMN "updated_at" INTEGER NOT NULL DEFAULT ${migrationTimestamp};`
      );
    }
  }

  // テーブル作成（CREATE TABLE IF NOT EXISTS）
  // updated_at は ORM ではなく DB トリガーで管理し、PG/SQLite 間の一貫性を保つ
  client.exec(`
    CREATE TABLE IF NOT EXISTS "users" (
      "id" TEXT PRIMARY KEY,
      "email" TEXT,
      "is_admin" INTEGER NOT NULL DEFAULT 1,
      "created_at" INTEGER NOT NULL DEFAULT ${TS},
      "updated_at" INTEGER NOT NULL DEFAULT ${TS}
    );
    CREATE TABLE IF NOT EXISTS "user_settings" (
      "user_id" TEXT PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
      "opus_model_id" TEXT,
      "sonnet_model_id" TEXT,
      "haiku_model_id" TEXT,
      "allowed_tools" TEXT,
      "disallowed_tools" TEXT,
      "created_at" INTEGER NOT NULL DEFAULT ${TS},
      "updated_at" INTEGER NOT NULL DEFAULT ${TS}
    );
    CREATE TABLE IF NOT EXISTS "sessions" (
      "id" TEXT PRIMARY KEY,
      "user_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
      "title" TEXT,
      "status" TEXT NOT NULL DEFAULT 'init',
      "sdk_session_id" TEXT,
      "context" TEXT,
      "created_at" INTEGER NOT NULL DEFAULT ${TS},
      "updated_at" INTEGER NOT NULL DEFAULT ${TS}
    );
    CREATE TABLE IF NOT EXISTS "session_events" (
      "uuid" TEXT PRIMARY KEY,
      "session_id" TEXT NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
      "type" TEXT NOT NULL,
      "subtype" TEXT,
      "message" TEXT NOT NULL,
      "created_at" INTEGER NOT NULL DEFAULT ${TS}
    );
    CREATE TABLE IF NOT EXISTS "app_settings" (
      "key" TEXT PRIMARY KEY,
      "value" TEXT NOT NULL,
      "updated_at" INTEGER NOT NULL DEFAULT ${TS}
    );
    CREATE TABLE IF NOT EXISTS "mcp_servers" (
      "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "url" TEXT,
      "headers" TEXT,
      "command" TEXT,
      "args" TEXT,
      "env" TEXT,
      "managed_type" TEXT,
      "is_disabled" INTEGER NOT NULL DEFAULT 0,
      "created_at" INTEGER NOT NULL DEFAULT ${TS},
      "updated_at" INTEGER NOT NULL DEFAULT ${TS},
      PRIMARY KEY ("user_id", "id")
    );
    CREATE TABLE IF NOT EXISTS "github_user_authorizations" (
      "user_id" TEXT PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "github_user_id" TEXT NOT NULL,
      "github_login" TEXT NOT NULL,
      "access_token_ciphertext" TEXT NOT NULL,
      "access_token_iv" TEXT NOT NULL,
      "access_token_auth_tag" TEXT NOT NULL,
      "access_token_key_version" TEXT NOT NULL,
      "refresh_token_ciphertext" TEXT,
      "refresh_token_iv" TEXT,
      "refresh_token_auth_tag" TEXT,
      "refresh_token_key_version" TEXT,
      "token_expires_at" INTEGER,
      "refresh_token_expires_at" INTEGER,
      "created_at" INTEGER NOT NULL DEFAULT ${TS},
      "updated_at" INTEGER NOT NULL DEFAULT ${TS}
    );
    CREATE TABLE IF NOT EXISTS "github_oauth_states" (
      "state" TEXT PRIMARY KEY,
      "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "code_verifier_ciphertext" TEXT NOT NULL,
      "code_verifier_iv" TEXT NOT NULL,
      "code_verifier_auth_tag" TEXT NOT NULL,
      "code_verifier_key_version" TEXT NOT NULL,
      "redirect_after" TEXT,
      "expires_at" INTEGER NOT NULL,
      "created_at" INTEGER NOT NULL DEFAULT ${TS}
    );
    INSERT OR IGNORE INTO "app_settings" ("key", "value") VALUES ('app_title', 'ccbricks');
    INSERT OR IGNORE INTO "app_settings" ("key", "value") VALUES ('welcome_heading', 'Claude Code on Databricks');
    INSERT OR IGNORE INTO "app_settings" ("key", "value") VALUES ('default_new_user_role', 'admin');
    CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" ("user_id");
    CREATE INDEX IF NOT EXISTS "sessions_updated_at_idx" ON "sessions" ("updated_at");
    CREATE INDEX IF NOT EXISTS "sessions_status_idx" ON "sessions" ("status");
    CREATE INDEX IF NOT EXISTS "session_events_session_created_at_idx" ON "session_events" ("session_id", "created_at");
    CREATE INDEX IF NOT EXISTS "github_user_authorizations_login_idx" ON "github_user_authorizations" ("github_login");
    CREATE INDEX IF NOT EXISTS "github_oauth_states_user_id_idx" ON "github_oauth_states" ("user_id");
    CREATE INDEX IF NOT EXISTS "github_oauth_states_expires_at_idx" ON "github_oauth_states" ("expires_at");

    -- updated_at 自動更新トリガー（ミリ秒精度）
    -- WHEN ガードで updated_at が変更されていない場合のみ発火（再帰防止）
    DROP TRIGGER IF EXISTS "set_updated_at_users";
    CREATE TRIGGER "set_updated_at_users"
      AFTER UPDATE ON "users" FOR EACH ROW
      WHEN NEW."updated_at" = OLD."updated_at"
      BEGIN UPDATE "users" SET "updated_at" = ${TS} WHERE "id" = NEW."id"; END;
    DROP TRIGGER IF EXISTS "set_updated_at_user_settings";
    CREATE TRIGGER "set_updated_at_user_settings"
      AFTER UPDATE ON "user_settings" FOR EACH ROW
      WHEN NEW."updated_at" = OLD."updated_at"
      BEGIN UPDATE "user_settings" SET "updated_at" = ${TS} WHERE "user_id" = NEW."user_id"; END;
    DROP TRIGGER IF EXISTS "set_updated_at_sessions";
    CREATE TRIGGER "set_updated_at_sessions"
      AFTER UPDATE ON "sessions" FOR EACH ROW
      WHEN NEW."updated_at" = OLD."updated_at"
      BEGIN UPDATE "sessions" SET "updated_at" = ${TS} WHERE "id" = NEW."id"; END;
    DROP TRIGGER IF EXISTS "set_updated_at_app_settings";
    CREATE TRIGGER "set_updated_at_app_settings"
      AFTER UPDATE ON "app_settings" FOR EACH ROW
      WHEN NEW."updated_at" = OLD."updated_at"
      BEGIN UPDATE "app_settings" SET "updated_at" = ${TS} WHERE "key" = NEW."key"; END;
    DROP TRIGGER IF EXISTS "set_updated_at_mcp_servers";
    CREATE TRIGGER "set_updated_at_mcp_servers"
      AFTER UPDATE ON "mcp_servers" FOR EACH ROW
      WHEN NEW."updated_at" = OLD."updated_at"
      BEGIN UPDATE "mcp_servers" SET "updated_at" = ${TS} WHERE "user_id" = NEW."user_id" AND "id" = NEW."id"; END;
    DROP TRIGGER IF EXISTS "set_updated_at_github_user_authorizations";
    CREATE TRIGGER "set_updated_at_github_user_authorizations"
      AFTER UPDATE ON "github_user_authorizations" FOR EACH ROW
      WHEN NEW."updated_at" = OLD."updated_at"
      BEGIN UPDATE "github_user_authorizations" SET "updated_at" = ${TS} WHERE "user_id" = NEW."user_id"; END;
  `);

  // Drizzle ORM 初期化
  const db = drizzleSqlite({ client, schema: sqliteSchema });

  // Fastify インスタンスにデコレート（PG 型にキャスト）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastify.decorate('db', db as any);
  fastify.decorate('isSqlite', true);

  // SQLite 用 withUserContext（RLS なし、トランザクション不要）
  // better-sqlite3 のトランザクションは同期のみ対応のため、db を直接渡す
  fastify.decorate(
    'withUserContext',
    async <T>(userId: string, callback: WithUserContextCallback<T>): Promise<T> => {
      validateUserId(userId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return callback(db as any);
    }
  );

  fastify.log.info('SQLite database initialized');

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    fastify.log.info('Closing SQLite database...');
    client.close();
    fastify.log.info('SQLite database closed');
  });
}

/**
 * Lakebase PostgreSQL データベースを初期化する
 */
async function initLakebase(fastify: FastifyInstance) {
  const schemaName = resolveLakebaseSchema(fastify.config);
  const pgPort = optionalEnv(fastify.config.PGPORT);
  // AppKit の Lakebase pool は Databricks Apps が注入する PG* 環境変数を読む。
  const pool = createLakebasePool({
    endpoint: fastify.config.LAKEBASE_ENDPOINT,
    host: optionalEnv(fastify.config.PGHOST),
    database: optionalEnv(fastify.config.PGDATABASE),
    user: optionalEnv(fastify.config.PGUSER),
    port: pgPort ? Number(pgPort) : undefined,
    sslMode: optionalEnv(fastify.config.PGSSLMODE) as LakebaseSslMode | undefined,
    max: 10,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
  });
  await pool.query(`create schema if not exists ${quoteIdent(schemaName)}`);
  installSearchPath(pool, schemaName);

  // Drizzle ORM初期化
  const db: LakebaseDatabase = drizzlePg({
    client: pool as unknown as NodePgClient,
    schema: pgSchema,
  });

  // マイグレーション実行（テスト環境または DISABLE_AUTO_MIGRATION=true ではスキップ）
  const shouldSkipMigration =
    fastify.config.NODE_ENV === 'test' || fastify.config.DISABLE_AUTO_MIGRATION;

  if (!shouldSkipMigration) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const migrationsFolder = path.join(__dirname, '../../migrations');
    fastify.log.info({ migrationsFolder }, 'Running database migrations...');

    await copyLegacyMigrationHistoryIfNeeded(pool, schemaName);
    await migrate(db, { migrationsFolder, migrationsSchema: schemaName });

    fastify.log.info('Database migrations completed');
  } else {
    const reason = fastify.config.DISABLE_AUTO_MIGRATION
      ? 'DISABLE_AUTO_MIGRATION is set'
      : 'test environment';
    fastify.log.info({ reason }, 'Skipping database migrations');
  }

  // Fastifyインスタンスにデコレート
  fastify.decorate('db', db as unknown as AppDatabase);
  fastify.decorate('isSqlite', false);

  // RLS対応のユーザーコンテキスト付きトランザクションヘルパー
  fastify.decorate(
    'withUserContext',
    async <T>(userId: string, callback: WithUserContextCallback<T>): Promise<T> => {
      validateUserId(userId);

      return db.transaction(async tx => {
        try {
          await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
        } catch (error) {
          throw new RLSContextError(
            `Failed to set RLS context for user: ${error instanceof Error ? error.message : 'Unknown error'}`,
            userId,
            error instanceof Error ? error : undefined
          );
        }

        return callback(tx as unknown as RLSTransaction);
      });
    }
  );

  fastify.log.info({ schemaName }, 'Lakebase database connection established');

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    fastify.log.info('Closing Lakebase database connection...');
    await pool.end();
    fastify.log.info('Lakebase database connection closed');
  });
}

/**
 * Database Plugin
 *
 * LAKEBASE_ENDPOINT が設定されている場合は Lakebase PostgreSQL、
 * 未設定の場合は SQLite にフォールバックします。
 *
 * 依存関係:
 * - config: LAKEBASE_ENDPOINTを取得するため
 */
export default fp(
  async fastify => {
    try {
      if (fastify.config.LAKEBASE_ENDPOINT.trim() !== '') {
        await initLakebase(fastify);
      } else {
        fastify.log.warn('LAKEBASE_ENDPOINT is not set — using SQLite fallback');
        await initSqlite(fastify);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      fastify.log.error({ message }, 'Failed to initialize database connection');
      throw error;
    }
  },
  {
    name: 'db',
    dependencies: ['config'],
  }
);
