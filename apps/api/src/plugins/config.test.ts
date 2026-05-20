import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import configPlugin from './config.js';

describe('config plugin', () => {
  let app: FastifyInstance;
  let originalEnv: NodeJS.ProcessEnv;
  const lakebaseEndpoint = 'projects/test-project/branches/test-branch/endpoints/test-endpoint';

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Create a fresh Fastify instance for each test
    app = Fastify({
      logger: false, // Disable logging in tests
    });
  });

  afterEach(async () => {
    // Restore original environment
    process.env = originalEnv;

    // Close Fastify instance
    await app.close();
  });

  describe('successful configuration loading', () => {
    it('should load config with all required environment variables', async () => {
      // Set required environment variables
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      process.env.LAKEBASE_ENDPOINT = lakebaseEndpoint;
      process.env.PGAPPNAME = 'ccbricks';
      process.env.PGDATABASE = 'databricks-postgres';
      process.env.PGHOST = 'lakebase.example.databricks.com';
      process.env.PGUSER = 'service-principal-client-id';

      await app.register(configPlugin);

      // Verify config is available
      expect(app.config).toBeDefined();
      expect(app.config.DATABRICKS_HOST).toBe('test.databricks.com');
      expect(app.config.LAKEBASE_ENDPOINT).toBe(lakebaseEndpoint);
      expect(app.config).not.toHaveProperty('DATABASE_URL');
    });

    it('should use default values for optional environment variables', async () => {
      // Set only required environment variables
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      // Set NODE_ENV to 'test' to prevent loading .env file
      process.env.NODE_ENV = 'test';
      await app.register(configPlugin);

      // Verify default values
      expect(app.config.NODE_ENV).toBe('test');
      expect(app.config.PORT).toBe(8003);
      expect(app.config.DATABRICKS_APP_PORT).toBe(8000);
      expect(app.config.DATABRICKS_APP_NAME).toBe('');
      expect(app.config.DATABRICKS_WORKSPACE_ID).toBe('');
      expect(app.config.LAKEBASE_ENDPOINT).toBe('');
      expect(app.config.PGAPPNAME).toBe('');
      expect(app.config.PGDATABASE).toBe('');
      expect(app.config.PGHOST).toBe('');
      expect(app.config.PGPORT).toBe('');
      expect(app.config.PGSSLMODE).toBe('');
      expect(app.config.PGUSER).toBe('');
    });

    it('should accept valid NODE_ENV values', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';

      const envValues: Array<'development' | 'production' | 'test'> = [
        'development',
        'production',
        'test',
      ];

      for (const env of envValues) {
        const testApp = Fastify({ logger: false });
        process.env.NODE_ENV = env;

        await testApp.register(configPlugin);

        expect(testApp.config.NODE_ENV).toBe(env);

        await testApp.close();
      }
    });

    it('should accept custom PORT value', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      process.env.PORT = '9000';

      await app.register(configPlugin);

      expect(app.config.PORT).toBe(9000);
    });

    it('should construct ANTHROPIC_BASE_URL from DATABRICKS_HOST', async () => {
      process.env.DATABRICKS_HOST = 'myworkspace.databricks.com';
      process.env.DATABRICKS_WORKSPACE_ID = '1234567890';

      await app.register(configPlugin);

      expect(app.config.ANTHROPIC_BASE_URL).toBe(
        'https://myworkspace.databricks.com/ai-gateway/anthropic'
      );
    });

    it('should honor explicitly set ANTHROPIC_BASE_URL', async () => {
      process.env.DATABRICKS_HOST = 'myworkspace.databricks.com';
      process.env.DATABRICKS_WORKSPACE_ID = '1234567890';
      process.env.ANTHROPIC_BASE_URL = 'https://custom.example.com/anthropic';

      await app.register(configPlugin);

      expect(app.config.ANTHROPIC_BASE_URL).toBe('https://custom.example.com/anthropic');
    });

    it('should not have Anthropic model config (now managed via app_settings)', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';

      await app.register(configPlugin);

      // Model settings are now stored in app_settings DB table, not in env vars
      expect(app.config).not.toHaveProperty('ANTHROPIC_DEFAULT_OPUS_MODEL');
      expect(app.config).not.toHaveProperty('ANTHROPIC_DEFAULT_SONNET_MODEL');
      expect(app.config).not.toHaveProperty('ANTHROPIC_DEFAULT_HAIKU_MODEL');
    });
  });

  describe('validation errors', () => {
    it('should use empty string default when LAKEBASE_ENDPOINT is missing', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';

      await app.register(configPlugin);

      expect(app.config.LAKEBASE_ENDPOINT).toBe('');
    });

    it('should fail when DATABRICKS_HOST is missing', async () => {
      await expect(app.register(configPlugin)).rejects.toThrow();
    });

    it('should fail when NODE_ENV has invalid value', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      process.env.NODE_ENV = 'invalid';

      await expect(app.register(configPlugin)).rejects.toThrow();
    });

    it('should fail when PORT is not an integer', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      process.env.PORT = 'not-a-number';

      await expect(app.register(configPlugin)).rejects.toThrow();
    });

    it('should fail when DATABRICKS_APP_PORT is not an integer', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      process.env.DATABRICKS_APP_PORT = 'not-a-number';

      await expect(app.register(configPlugin)).rejects.toThrow();
    });

    it('should fail when Lakebase is enabled without required PostgreSQL variables', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      process.env.LAKEBASE_ENDPOINT = lakebaseEndpoint;
      process.env.PGAPPNAME = 'ccbricks';
      process.env.PGUSER = 'service-principal-client-id';

      await expect(app.register(configPlugin)).rejects.toThrow(
        'Missing required environment variable(s): PGHOST, PGDATABASE'
      );
    });

    it('should fail when PGSSLMODE is invalid', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      process.env.PGSSLMODE = 'invalid';

      await expect(app.register(configPlugin)).rejects.toThrow();
    });
  });

  describe('directory configuration', () => {
    it('should use default directory paths when HOME is set', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      process.env.HOME = '/test/home';
      // Note: Default paths are evaluated at module load time, so we need to set them explicitly
      process.env.CCBRICKS_BASE_DIR = '/test/home/users';

      await app.register(configPlugin);

      expect(app.config.CCBRICKS_BASE_DIR).toBe('/test/home/users');
    });

    it('should allow custom CCBRICKS_BASE_DIR', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      process.env.CCBRICKS_BASE_DIR = '/custom/users';

      await app.register(configPlugin);

      expect(app.config.CCBRICKS_BASE_DIR).toBe('/custom/users');
    });
  });

  describe('Databricks configuration', () => {
    it('should accept optional Databricks environment variables', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      process.env.DATABRICKS_APP_NAME = 'my-app';
      process.env.DATABRICKS_WORKSPACE_ID = 'workspace-123';
      process.env.DATABRICKS_CLIENT_ID = 'client-id';
      process.env.DATABRICKS_CLIENT_SECRET = 'client-secret';

      await app.register(configPlugin);

      expect(app.config.DATABRICKS_APP_NAME).toBe('my-app');
      expect(app.config.DATABRICKS_WORKSPACE_ID).toBe('workspace-123');
      expect(app.config.DATABRICKS_CLIENT_ID).toBe('client-id');
      expect(app.config.DATABRICKS_CLIENT_SECRET).toBe('client-secret');
    });

    it('should accept Lakebase PostgreSQL environment variables injected by Databricks Apps', async () => {
      process.env.DATABRICKS_HOST = 'test.databricks.com';
      process.env.LAKEBASE_ENDPOINT = lakebaseEndpoint;
      process.env.PGAPPNAME = 'ccbricks';
      process.env.PGDATABASE = 'databricks-postgres';
      process.env.PGHOST = 'lakebase.example.databricks.com';
      process.env.PGPORT = '5432';
      process.env.PGSSLMODE = 'require';
      process.env.PGUSER = 'service-principal-client-id';

      await app.register(configPlugin);

      expect(app.config.LAKEBASE_ENDPOINT).toBe(lakebaseEndpoint);
      expect(app.config.PGAPPNAME).toBe('ccbricks');
      expect(app.config.PGDATABASE).toBe('databricks-postgres');
      expect(app.config.PGHOST).toBe('lakebase.example.databricks.com');
      expect(app.config.PGPORT).toBe('5432');
      expect(app.config.PGSSLMODE).toBe('require');
      expect(app.config.PGUSER).toBe('service-principal-client-id');
    });
  });
});
