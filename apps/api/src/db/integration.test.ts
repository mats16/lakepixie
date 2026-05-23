// apps/api/src/db/integration.test.ts
// 統合テスト: 実際のデータベースに接続してテスト
// Lakebase: .env / Databricks Apps が提供する LAKEBASE_ENDPOINT と PG* を使用

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { createLakebasePool } from '@databricks/appkit';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgClient, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql, eq, desc, lt } from 'drizzle-orm';
import path from 'path';
import { fileURLToPath } from 'url';
import * as schema from './schema.pg.js';

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function resolveLakebaseSchema(): string {
  const appName = process.env.PGAPPNAME || process.env.DATABRICKS_APP_NAME;
  const servicePrincipalId = process.env.PGUSER || process.env.DATABRICKS_CLIENT_ID;
  if (!appName || !servicePrincipalId) {
    throw new Error('PGAPPNAME and PGUSER are required for Lakebase integration tests.');
  }
  return `${appName}_schema_${servicePrincipalId.replaceAll('-', '')}`;
}

// .env をロード（ローカル開発用）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.join(__dirname, '../../../../.env') });

// テスト用のユーザーID
const TEST_USER_1 = 'test-user-1';
const TEST_USER_2 = 'test-user-2';
// sessions.id は uuid 型なので有効な UUID を使用
const TEST_SESSION_1 = '11111111-1111-1111-1111-111111111111';
const TEST_SESSION_2 = '22222222-2222-2222-2222-222222222222';

describe.skipIf(!process.env.LAKEBASE_ENDPOINT)('Database Integration Tests', () => {
  let pool: ReturnType<typeof createLakebasePool>;
  let db: NodePgDatabase<typeof schema>;
  let schemaName: string;

  /**
   * RLS 保護テーブルへのアクセス用ヘルパー
   * app.user_id を設定してからコールバックを実行
   */
  async function withTestUserContext<T>(
    userId: string,
    callback: (tx: typeof db) => Promise<T>
  ): Promise<T> {
    return db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
      return callback(tx as unknown as typeof db);
    });
  }

  beforeAll(async () => {
    schemaName = resolveLakebaseSchema();
    pool = createLakebasePool({ max: 1, options: `-c search_path=${schemaName}` });
    db = drizzle({ client: pool as unknown as NodePgClient, schema });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);

    // マイグレーション実行
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const migrationsFolder = path.join(__dirname, '../../migrations');
    await migrate(db, { migrationsFolder, migrationsSchema: schemaName });

    // 常に FORCE ROW LEVEL SECURITY を適用
    // 理由:
    // 1. BYPASSRLS 属性を持つユーザー（ローカル Neon など）は RLS をバイパスする
    // 2. テーブルオーナー（CI で testuser がマイグレーションを実行した場合など）も RLS をバイパスする
    // FORCE RLS により、どちらのケースでも RLS が強制される
    await pool.query('ALTER TABLE sessions FORCE ROW LEVEL SECURITY');
    await pool.query('ALTER TABLE user_settings FORCE ROW LEVEL SECURITY');
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  beforeEach(async () => {
    // テストデータをクリーンアップ
    // TRUNCATE は RLS をバイパスするため、ユーザーコンテキストなしで実行可能
    // CASCADE で外部キー参照を持つテーブルも一緒にクリア
    await pool.query('TRUNCATE TABLE session_events, sessions, user_settings, users CASCADE');
  });

  describe('sessionEvents table', () => {
    beforeEach(async () => {
      // テスト用ユーザーを作成（users テーブルは RLS なし）
      await db.insert(schema.users).values({ id: TEST_USER_1 });
      // セッションを作成（RLS 保護テーブルなのでユーザーコンテキストが必要）
      await withTestUserContext(TEST_USER_1, async tx => {
        await tx.insert(schema.sessions).values({
          id: TEST_SESSION_1,
          userId: TEST_USER_1,
          title: 'Test Session',
        });
      });
    });

    it('should insert events with uuid as primary key', async () => {
      const uuid1 = '11111111-1111-1111-1111-111111111111';
      const uuid2 = '22222222-2222-2222-2222-222222222222';

      await db.insert(schema.sessionEvents).values({
        uuid: uuid1,
        sessionId: TEST_SESSION_1,
        type: 'message',
        message: { content: 'First message' },
      });

      await db.insert(schema.sessionEvents).values({
        uuid: uuid2,
        sessionId: TEST_SESSION_1,
        type: 'message',
        message: { content: 'Second message' },
      });

      const events = await db.select().from(schema.sessionEvents);
      expect(events).toHaveLength(2);
      expect(events.map(e => e.uuid).sort()).toEqual([uuid1, uuid2].sort());
    });

    it('should store jsonb message correctly', async () => {
      const complexMessage = {
        type: 'user',
        content: 'Hello',
        metadata: {
          timestamp: '2024-01-01T00:00:00Z',
          tags: ['important', 'test'],
        },
      };

      const uuid = '77777777-7777-7777-7777-777777777777';
      await db.insert(schema.sessionEvents).values({
        uuid,
        sessionId: TEST_SESSION_1,
        type: 'message',
        message: complexMessage,
      });

      // データベースから取得して確認
      const [retrieved] = await db
        .select()
        .from(schema.sessionEvents)
        .where(eq(schema.sessionEvents.uuid, uuid));

      expect(retrieved.message).toEqual(complexMessage);
    });

    it('should reject duplicate uuid', async () => {
      const uuid = '88888888-8888-8888-8888-888888888888';

      await db.insert(schema.sessionEvents).values({
        uuid,
        sessionId: TEST_SESSION_1,
        type: 'message',
        message: { content: 'First' },
      });

      await expect(
        db.insert(schema.sessionEvents).values({
          uuid, // 同じ uuid
          sessionId: TEST_SESSION_1,
          type: 'message',
          message: { content: 'Second' },
        })
      ).rejects.toThrow();
    });
  });

  describe('RLS (Row Level Security)', () => {
    let skipRlsTests = false;

    beforeAll(async () => {
      // 現在のロールがBYPASSRLS属性を持っているかチェック
      // Neonのneondb_ownerなど、BYPASSRLS属性があるとRLSをバイパスするためテストをスキップ
      const result = await pool.query(
        'SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      skipRlsTests = result.rows[0]?.rolbypassrls === true;
      if (skipRlsTests) {
        console.log('Skipping RLS tests: current role has BYPASSRLS attribute');
      }
    });

    beforeEach(async () => {
      // 2人のユーザーを作成（users テーブルは RLS なし）
      await db.insert(schema.users).values([{ id: TEST_USER_1 }, { id: TEST_USER_2 }]);

      // 各ユーザーのセッションを作成（RLS 保護テーブル）
      await withTestUserContext(TEST_USER_1, async tx => {
        await tx.insert(schema.sessions).values({
          id: TEST_SESSION_1,
          userId: TEST_USER_1,
          title: 'User 1 Session',
        });
      });
      await withTestUserContext(TEST_USER_2, async tx => {
        await tx.insert(schema.sessions).values({
          id: TEST_SESSION_2,
          userId: TEST_USER_2,
          title: 'User 2 Session',
        });
      });

      // 各ユーザーの設定を作成（RLS 保護テーブル）
      await withTestUserContext(TEST_USER_1, async tx => {
        await tx.insert(schema.userSettings).values({
          userId: TEST_USER_1,
          key: 'opus_model_id',
          value: 'databricks-claude-opus-4-7',
        });
      });
      await withTestUserContext(TEST_USER_2, async tx => {
        await tx.insert(schema.userSettings).values({
          userId: TEST_USER_2,
          key: 'opus_model_id',
          value: 'databricks-claude-opus-4-6',
        });
      });
    });

    /**
     * RLSコンテキスト付きでクエリを実行するヘルパー
     * set_config を使用してパラメータを安全に渡す
     */
    async function withUserContext<T>(
      userId: string,
      callback: (tx: typeof db) => Promise<T>
    ): Promise<T> {
      return db.transaction(async tx => {
        // set_config の第3引数 true = is_local（SET LOCAL と同等）
        await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
        return callback(tx as unknown as typeof db);
      });
    }

    describe('sessions table', () => {
      it('should only return sessions for the current user', async () => {
        if (skipRlsTests) return;

        const user1Sessions = await withUserContext(TEST_USER_1, async tx => {
          return tx.select().from(schema.sessions);
        });

        expect(user1Sessions).toHaveLength(1);
        expect(user1Sessions[0].id).toBe(TEST_SESSION_1);
        expect(user1Sessions[0].userId).toBe(TEST_USER_1);
      });

      it('should not allow access to other users sessions', async () => {
        if (skipRlsTests) return;

        const user1Sessions = await withUserContext(TEST_USER_1, async tx => {
          return tx.select().from(schema.sessions).where(eq(schema.sessions.id, TEST_SESSION_2));
        });

        expect(user1Sessions).toHaveLength(0);
      });

      it('should allow user to update their own session', async () => {
        if (skipRlsTests) return;

        await withUserContext(TEST_USER_1, async tx => {
          await tx
            .update(schema.sessions)
            .set({ title: 'Updated Title' })
            .where(eq(schema.sessions.id, TEST_SESSION_1));
        });

        // RLS コンテキスト付きで確認
        const [updated] = await withUserContext(TEST_USER_1, async tx => {
          return tx.select().from(schema.sessions).where(eq(schema.sessions.id, TEST_SESSION_1));
        });

        expect(updated.title).toBe('Updated Title');
      });

      it('should not allow user to update other users session', async () => {
        if (skipRlsTests) return;

        await withUserContext(TEST_USER_1, async tx => {
          await tx
            .update(schema.sessions)
            .set({ title: 'Hacked Title' })
            .where(eq(schema.sessions.id, TEST_SESSION_2));
        });

        // User 2のセッションは変更されていないはず（User 2 のコンテキストで確認）
        const [notUpdated] = await withUserContext(TEST_USER_2, async tx => {
          return tx.select().from(schema.sessions).where(eq(schema.sessions.id, TEST_SESSION_2));
        });

        expect(notUpdated.title).toBe('User 2 Session');
      });
    });

    describe('user_settings table', () => {
      it('should only return settings for the current user', async () => {
        if (skipRlsTests) return;

        const user1Settings = await withUserContext(TEST_USER_1, async tx => {
          return tx.select().from(schema.userSettings);
        });

        expect(user1Settings).toHaveLength(1);
        expect(user1Settings[0].userId).toBe(TEST_USER_1);
        expect(user1Settings[0].key).toBe('opus_model_id');
        expect(user1Settings[0].value).toBe('databricks-claude-opus-4-7');
      });

      it('should allow user to update their own settings', async () => {
        if (skipRlsTests) return;

        await withUserContext(TEST_USER_1, async tx => {
          await tx
            .update(schema.userSettings)
            .set({ value: 'databricks-claude-opus-4-5' })
            .where(eq(schema.userSettings.userId, TEST_USER_1));
        });

        // RLS コンテキスト付きで確認
        const [updated] = await withUserContext(TEST_USER_1, async tx => {
          return tx
            .select()
            .from(schema.userSettings)
            .where(eq(schema.userSettings.userId, TEST_USER_1));
        });

        expect(updated.value).toBe('databricks-claude-opus-4-5');
      });
    });
  });

  describe('listSessions pagination', () => {
    // UUIDv7 風に辞書順で並ぶ UUID を使用
    const sessionIds = [
      '01900000-0000-7000-8000-000000000001',
      '01900000-0000-7000-8000-000000000002',
      '01900000-0000-7000-8000-000000000003',
      '01900000-0000-7000-8000-000000000004',
      '01900000-0000-7000-8000-000000000005',
    ];

    beforeEach(async () => {
      await db.insert(schema.users).values({ id: TEST_USER_1 });

      // 各セッションを個別に INSERT し、updated_at に時間差をつける
      for (const [i, id] of sessionIds.entries()) {
        await withTestUserContext(TEST_USER_1, async tx => {
          await tx.insert(schema.sessions).values({
            id,
            userId: TEST_USER_1,
            title: `Session ${id.slice(-1)}`,
          });
          // updated_at を明示的に設定（ID 順と一致するようにずらす）
          await tx
            .update(schema.sessions)
            .set({ updatedAt: new Date(1700000000000 + i * 1000) })
            .where(eq(schema.sessions.id, id));
        });
      }
    });

    it('should paginate through all sessions using updated_at DESC cursor', async () => {
      const allCollected: string[] = [];
      let cursorUpdatedAt: Date | undefined;
      let hasMore = true;
      let pages = 0;

      while (hasMore && pages < 10) {
        const result = await withTestUserContext(TEST_USER_1, async tx => {
          // listSessions と同じクエリロジックを再現（updated_at DESC ソート）
          const whereClause = cursorUpdatedAt
            ? lt(schema.sessions.updatedAt, cursorUpdatedAt)
            : undefined;
          const rows = await tx
            .select({ id: schema.sessions.id, updatedAt: schema.sessions.updatedAt })
            .from(schema.sessions)
            .where(whereClause)
            .orderBy(desc(schema.sessions.updatedAt))
            .limit(3); // limit=2 + 1 for has_more check

          const fetchedHasMore = rows.length > 2;
          const resultRows = fetchedHasMore ? rows.slice(0, 2) : rows;

          return {
            ids: resultRows.map(r => r.id),
            lastUpdatedAt:
              resultRows.length > 0 ? resultRows[resultRows.length - 1].updatedAt : undefined,
            hasMore: fetchedHasMore,
          };
        });

        allCollected.push(...result.ids);
        cursorUpdatedAt = result.lastUpdatedAt;
        hasMore = result.hasMore;
        pages++;
      }

      // 5つ全てのセッションが取得されること（重複なし・スキップなし）
      expect(allCollected).toHaveLength(5);
      expect(new Set(allCollected).size).toBe(5);

      // desc(updated_at) 順で返されること（updated_at が大きい = ID が大きい順）
      expect(allCollected).toEqual([
        '01900000-0000-7000-8000-000000000005',
        '01900000-0000-7000-8000-000000000004',
        '01900000-0000-7000-8000-000000000003',
        '01900000-0000-7000-8000-000000000002',
        '01900000-0000-7000-8000-000000000001',
      ]);

      // 3ページで取得されること (2, 2, 1)
      expect(pages).toBe(3);
    });

    it('should return has_more=false on the last page', async () => {
      const result = await withTestUserContext(TEST_USER_1, async tx => {
        const rows = await tx
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .orderBy(desc(schema.sessions.updatedAt))
          .limit(6); // 5件しかないので has_more=false

        return { count: rows.length, hasMore: rows.length > 5 };
      });

      expect(result.count).toBe(5);
      expect(result.hasMore).toBe(false);
    });
  });
});
