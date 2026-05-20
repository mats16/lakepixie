import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';

type DrizzleConfig = {
  dialect: string;
  dbCredentials: {
    url: string;
  };
};

async function loadConfig(caseName: string): Promise<DrizzleConfig> {
  const configUrl = pathToFileURL(path.join(import.meta.dirname, '../drizzle.config.ts')).href;
  const mod = await import(/* @vite-ignore */ `${configUrl}?case=${caseName}`);
  return mod.default as DrizzleConfig;
}

describe('drizzle config', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.NODE_ENV = 'test';
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should use SQLite when LAKEBASE_ENDPOINT is unset', async () => {
    process.env.LAKEBASE_ENDPOINT = '';
    delete process.env.PGHOST;
    delete process.env.PGDATABASE;

    const config = await loadConfig('sqlite');

    expect(config.dialect).toBe('sqlite');
  });

  it('should fail in Lakebase mode without PGHOST and PGDATABASE', async () => {
    process.env.LAKEBASE_ENDPOINT = 'projects/test-project/branches/test/endpoints/test';
    delete process.env.PGHOST;
    delete process.env.PGDATABASE;

    await expect(loadConfig('missing-pg')).rejects.toThrow(
      'PGHOST and PGDATABASE are required when LAKEBASE_ENDPOINT is set.'
    );
  });

  it('should ignore DATABASE_URL in Lakebase mode', async () => {
    process.env.LAKEBASE_ENDPOINT = 'projects/test-project/branches/test/endpoints/test';
    process.env.PGHOST = 'lakebase.example.databricks.com';
    process.env.PGDATABASE = 'databricks-postgres';
    process.env.PGUSER = 'service-principal-client-id';
    process.env.DATABASE_URL = 'postgresql://ignored.example.com/ignored';

    const config = await loadConfig('lakebase');

    expect(config.dialect).toBe('postgresql');
    expect(config.dbCredentials.url).toContain('lakebase.example.databricks.com');
    expect(config.dbCredentials.url).not.toContain('ignored.example.com');
  });
});
