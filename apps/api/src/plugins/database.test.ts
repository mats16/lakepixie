// apps/api/src/plugins/database.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import configPlugin from './config.js';
import databasePlugin, { RLSContextError } from './database.js';

const {
  mockCreateLakebasePool,
  mockPoolEnd,
  mockPoolQuery,
  mockPoolConnect,
  mockClientQuery,
  mockClientRelease,
  mockMigrate,
} = vi.hoisted(() => {
  const mockPoolEnd = vi.fn();
  const mockPoolQuery = vi.fn().mockResolvedValue({ rows: [] });
  const mockClientRelease = vi.fn();
  const mockClientQuery = vi.fn(async (query: string) => {
    if (query.includes('information_schema.tables')) {
      return {
        rows: [
          {
            has_app_tables: false,
            has_app_migration_history: false,
            has_legacy_migration_history: false,
          },
        ],
      };
    }
    return { rows: [] };
  });
  const mockPoolConnect = vi.fn(async () => ({
    query: mockClientQuery,
    release: mockClientRelease,
  }));
  const mockCreateLakebasePool = vi.fn(() => ({
    end: mockPoolEnd,
    query: mockPoolQuery,
    connect: mockPoolConnect,
  }));

  const mockMigrate = vi.fn();

  return {
    mockCreateLakebasePool,
    mockPoolEnd,
    mockPoolQuery,
    mockPoolConnect,
    mockClientQuery,
    mockClientRelease,
    mockMigrate,
  };
});

vi.mock('@databricks/appkit', () => ({
  createLakebasePool: mockCreateLakebasePool,
}));
vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: mockMigrate,
}));

const TEST_LAKEBASE_ENDPOINT = 'projects/test-project/branches/test-branch/endpoints/test-endpoint';
const TEST_PGAPPNAME = 'ccbricks';
const TEST_PGUSER = 'service-principal-client-id';
const TEST_PGHOST = 'lakebase.example.databricks.com';
const TEST_PGDATABASE = 'databricks-postgres';

describe('database plugin', () => {
  let app: FastifyInstance;
  let originalEnv: NodeJS.ProcessEnv;
  let testBaseDir = '';

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    testBaseDir = mkdtempSync(join(tmpdir(), 'ccbricks-database-test-'));

    // Set required environment variables for config plugin
    process.env.DATABRICKS_HOST = 'test.databricks.com';
    process.env.CCBRICKS_BASE_DIR = testBaseDir;
    delete process.env.LAKEBASE_ENDPOINT;
    delete process.env.PGAPPNAME;
    delete process.env.PGUSER;
    delete process.env.PGHOST;
    delete process.env.PGDATABASE;
    mockCreateLakebasePool.mockClear();
    mockPoolEnd.mockClear();
    mockPoolQuery.mockClear();
    mockPoolConnect.mockClear();
    mockClientQuery.mockClear();
    mockClientRelease.mockClear();
    mockMigrate.mockClear();
    mockClientQuery.mockImplementation(async (query: string) => {
      if (query.includes('information_schema.tables')) {
        return {
          rows: [
            {
              has_app_tables: false,
              has_app_migration_history: false,
              has_legacy_migration_history: false,
            },
          ],
        };
      }
      return { rows: [] };
    });

    // Create a fresh Fastify instance for each test
    app = Fastify({
      logger: false, // Disable logging in tests
    });
  });

  afterEach(async () => {
    // Restore original environment
    process.env = originalEnv;

    // Close Fastify instance (will trigger onClose hook)
    try {
      await app.close();
    } finally {
      rmSync(testBaseDir, { recursive: true, force: true });
      testBaseDir = '';
    }
  });

  describe('successful initialization', () => {
    it('should initialize database connection and decorate fastify.db', async () => {
      // Register config plugin first (dependency)
      await app.register(configPlugin);

      // Register database plugin
      await app.register(databasePlugin);

      // Verify db is decorated
      expect(app.db).toBeDefined();
      expect(typeof app.db).toBe('object');
    });

    it('should use Lakebase when LAKEBASE_ENDPOINT is set', async () => {
      process.env.LAKEBASE_ENDPOINT = TEST_LAKEBASE_ENDPOINT;
      process.env.PGAPPNAME = TEST_PGAPPNAME;
      process.env.PGUSER = TEST_PGUSER;
      process.env.PGHOST = TEST_PGHOST;
      process.env.PGDATABASE = TEST_PGDATABASE;

      await app.register(configPlugin);
      await app.register(databasePlugin);

      expect(app.db).toBeDefined();
      expect(app.isSqlite).toBe(false);
      expect(mockCreateLakebasePool).toHaveBeenCalledTimes(1);
      expect(mockPoolQuery).toHaveBeenCalledWith(
        'create schema if not exists "ccbricks_schema_serviceprincipalclientid"'
      );
    });

    it('should use SQLite when LAKEBASE_ENDPOINT is missing', async () => {
      await app.register(configPlugin);
      await app.register(databasePlugin);

      expect(app.db).toBeDefined();
      expect(app.isSqlite).toBe(true);
      expect(mockCreateLakebasePool).not.toHaveBeenCalled();
    });

    it('should add missing columns for intermediate SQLite user_settings tables', async () => {
      const { default: Database } = await import('better-sqlite3');
      const dataDir = join(testBaseDir, 'db');
      mkdirSync(dataDir, { recursive: true });
      const dbPath = join(dataDir, 'ccbricks.sqlite');
      const setupClient = new Database(dbPath);
      setupClient.exec(`
        CREATE TABLE "users" (
          "id" TEXT PRIMARY KEY
        );
        CREATE TABLE "user_settings" (
          "user_id" TEXT PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
          "opus_model_id" TEXT,
          "sonnet_model_id" TEXT,
          "haiku_model_id" TEXT
        );
      `);
      setupClient.close();

      await app.register(configPlugin);
      await app.register(databasePlugin);

      const verifyClient = new Database(dbPath, { readonly: true });
      const columns = verifyClient
        .prepare("SELECT name FROM pragma_table_info('user_settings')")
        .all() as Array<{ name: string }>;
      verifyClient.close();

      expect(columns.map(column => column.name)).toEqual(
        expect.arrayContaining(['allowed_tools', 'disallowed_tools', 'created_at', 'updated_at'])
      );
    });

    it('should have access to schema through fastify.db', async () => {
      await app.register(configPlugin);
      await app.register(databasePlugin);

      // Verify schema is accessible
      expect(app.db).toBeDefined();

      // TypeScript should allow querying
      // (実際のクエリはテストDB接続が必要なため、型チェックのみ)
      expect(typeof app.db.query).toBe('object');
    });

    it('should close Lakebase database connection on app close', async () => {
      process.env.LAKEBASE_ENDPOINT = TEST_LAKEBASE_ENDPOINT;
      process.env.PGAPPNAME = TEST_PGAPPNAME;
      process.env.PGUSER = TEST_PGUSER;
      process.env.PGHOST = TEST_PGHOST;
      process.env.PGDATABASE = TEST_PGDATABASE;

      await app.register(configPlugin);
      await app.register(databasePlugin);

      // Verify db is available
      expect(app.db).toBeDefined();

      // Close app (should trigger onClose hook)
      await app.close();

      expect(mockPoolEnd).toHaveBeenCalledTimes(1);
    });

    it('should run Lakebase migrations in the app schema', async () => {
      process.env.LAKEBASE_ENDPOINT = TEST_LAKEBASE_ENDPOINT;
      process.env.PGAPPNAME = TEST_PGAPPNAME;
      process.env.PGUSER = TEST_PGUSER;
      process.env.PGHOST = TEST_PGHOST;
      process.env.PGDATABASE = TEST_PGDATABASE;

      await app.register(configPlugin);
      app.config.NODE_ENV = 'development';
      await app.register(databasePlugin);

      expect(mockMigrate).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          migrationsSchema: 'ccbricks_schema_serviceprincipalclientid',
        })
      );
      expect(mockClientQuery).toHaveBeenCalledWith(
        'set search_path to "ccbricks_schema_serviceprincipalclientid"'
      );
    });

    it('should release Lakebase clients when setting search_path fails', async () => {
      process.env.LAKEBASE_ENDPOINT = TEST_LAKEBASE_ENDPOINT;
      process.env.PGAPPNAME = TEST_PGAPPNAME;
      process.env.PGUSER = TEST_PGUSER;
      process.env.PGHOST = TEST_PGHOST;
      process.env.PGDATABASE = TEST_PGDATABASE;
      mockClientQuery.mockRejectedValueOnce(new Error('set search_path failed'));

      await app.register(configPlugin);
      app.config.NODE_ENV = 'development';

      await expect(app.register(databasePlugin)).rejects.toThrow('set search_path failed');
      expect(mockClientRelease).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should provide a release callback for callback-style Lakebase connect', async () => {
      process.env.LAKEBASE_ENDPOINT = TEST_LAKEBASE_ENDPOINT;
      process.env.PGAPPNAME = TEST_PGAPPNAME;
      process.env.PGUSER = TEST_PGUSER;
      process.env.PGHOST = TEST_PGHOST;
      process.env.PGDATABASE = TEST_PGDATABASE;

      await app.register(configPlugin);
      await app.register(databasePlugin);

      const pool = mockCreateLakebasePool.mock.results[0]?.value;
      await new Promise<void>((resolve, reject) => {
        pool.connect(
          (error: Error | undefined, _client: unknown, release: (error?: unknown) => void) => {
            if (error) {
              reject(error);
              return;
            }
            release('release-error');
            resolve();
          }
        );
      });

      expect(mockClientRelease).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('validation errors', () => {
    it('should fail when config plugin is not registered (missing dependency)', async () => {
      // Try to register database plugin without config plugin
      await expect(app.register(databasePlugin)).rejects.toThrow();
    });

    it('should continue using SQLite when LAKEBASE_ENDPOINT is unset', async () => {
      await app.register(configPlugin);
      await app.register(databasePlugin);

      expect(app.isSqlite).toBe(true);
      expect(mockCreateLakebasePool).not.toHaveBeenCalled();
    });
  });

  describe('database operations', () => {
    it('should support basic query structure (type check)', async () => {
      await app.register(configPlugin);
      await app.register(databasePlugin);

      // Verify database instance is available
      expect(app.db).toBeDefined();
      expect(typeof app.db).toBe('object');

      // Verify basic Drizzle ORM methods are available
      expect(typeof app.db.select).toBe('function');
      expect(typeof app.db.insert).toBe('function');
      expect(typeof app.db.update).toBe('function');
      expect(typeof app.db.delete).toBe('function');
    });
  });

  describe('withUserContext', () => {
    it('should decorate fastify.withUserContext', async () => {
      await app.register(configPlugin);
      await app.register(databasePlugin);

      expect(app.withUserContext).toBeDefined();
      expect(typeof app.withUserContext).toBe('function');
    });

    it('should throw RLSContextError for empty userId', async () => {
      await app.register(configPlugin);
      await app.register(databasePlugin);

      await expect(app.withUserContext('', async () => {})).rejects.toThrow(RLSContextError);
      await expect(app.withUserContext('', async () => {})).rejects.toThrow(
        'must be a non-empty string'
      );
    });

    it('should throw RLSContextError for whitespace-only userId', async () => {
      await app.register(configPlugin);
      await app.register(databasePlugin);

      await expect(app.withUserContext('   ', async () => {})).rejects.toThrow(RLSContextError);
      await expect(app.withUserContext('   ', async () => {})).rejects.toThrow(
        'cannot be empty or whitespace only'
      );
    });

    it('should throw RLSContextError for null/undefined userId', async () => {
      await app.register(configPlugin);
      await app.register(databasePlugin);

      // @ts-expect-error - Testing runtime behavior with invalid input
      await expect(app.withUserContext(null, async () => {})).rejects.toThrow(RLSContextError);
      // @ts-expect-error - Testing runtime behavior with invalid input
      await expect(app.withUserContext(undefined, async () => {})).rejects.toThrow(RLSContextError);
    });

    it('RLSContextError should include userId in error', async () => {
      await app.register(configPlugin);
      await app.register(databasePlugin);

      try {
        await app.withUserContext('   ', async () => {});
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RLSContextError);
        expect((error as RLSContextError).userId).toBe('   ');
      }
    });
  });
});
