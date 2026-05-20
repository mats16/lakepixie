// apps/api/drizzle.config.ts
import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// 現在のファイルのディレクトリパスを取得
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// プロジェクトルートの .env ファイルを読み込む
config({ path: path.join(__dirname, '../../.env') });

function getPostgresUrl(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  if (process.env.PGHOST && process.env.PGDATABASE) {
    const user = encodeURIComponent(process.env.PGUSER || 'postgres');
    const host = process.env.PGHOST;
    const port = process.env.PGPORT || '5432';
    const database = encodeURIComponent(process.env.PGDATABASE);
    const sslMode = encodeURIComponent(process.env.PGSSLMODE || 'require');
    return `postgresql://${user}@${host}:${port}/${database}?sslmode=${sslMode}`;
  }

  return 'postgresql://localhost:5432/ccbricks';
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
