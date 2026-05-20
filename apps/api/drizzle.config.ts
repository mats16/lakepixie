// apps/api/drizzle.config.ts
import { defineConfig } from 'drizzle-kit';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadRootEnv } from './src/lib/load-env.js';

// 現在のファイルのディレクトリパスを取得
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadRootEnv();

function getPostgresUrl(): string {
  const host = process.env.PGHOST?.trim();
  const databaseName = process.env.PGDATABASE?.trim();
  if (!host || !databaseName) {
    throw new Error('PGHOST and PGDATABASE are required when LAKEBASE_ENDPOINT is set.');
  }

  const user = encodeURIComponent(process.env.PGUSER?.trim() || 'postgres');
  const port = process.env.PGPORT?.trim() || '5432';
  const database = encodeURIComponent(databaseName);
  const sslMode = encodeURIComponent(process.env.PGSSLMODE?.trim() || 'require');
  return `postgresql://${user}@${host}:${port}/${database}?sslmode=${sslMode}`;
}

const lakebaseEndpoint = process.env.LAKEBASE_ENDPOINT?.trim() ?? '';
const pgUrl = getPostgresUrl();

export default lakebaseEndpoint
  ? defineConfig({
      schema: './src/db/schema.pg.ts',
      out: './migrations',
      dialect: 'postgresql',
      dbCredentials: {
        url: pgUrl,
      },
      verbose: true,
      strict: true,
    })
  : defineConfig({
      schema: './src/db/schema.sqlite.ts',
      out: './migrations-sqlite',
      dialect: 'sqlite',
      dbCredentials: {
        url: path.join(
          process.env.CCBRICKS_BASE_DIR || path.join(__dirname, '../../tmp'),
          'db',
          'ccbricks.sqlite'
        ),
      },
      verbose: true,
      strict: true,
    });
