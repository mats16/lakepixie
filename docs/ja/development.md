# ローカル開発ガイド

このガイドでは、ccbricks をローカルで開発するためのセットアップと実行方法を説明します。

## 前提条件

- **Node.js**: 22.x（LTS）
- **npm**: 10.0.0 以上
- **PostgreSQL**: 14 以上（ローカルまたはリモート）
- **Git**: バージョン管理用

## アーキテクチャ概要

ローカル開発では、アプリケーションは 2 つのサーバーで動作します:

```
┌────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────┐          ┌─────────────────────────┐ │
│  │ Vite Dev Server     │ headers  │ Fastify Backend         │ │
│  │ (port 3003)         │─────────▶│ (port 8003)             │ │
│  │ ├─ React HMR        │ emulated │ └─ /api/* (API routes)  │ │
│  │ └─ /api/* proxy     │          │                         │ │
│  └─────────────────────┘          └─────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

- **Vite Dev Server (port 3003)**: Hot Module Replacement 機能付きで React フロントエンドを配信
- **Fastify Backend (port 8003)**: API リクエストを処理
- **API プロキシ**: Vite が自動的に `/api/*` リクエストをバックエンドにプロキシし、認証ヘッダーを注入

## 1. リポジトリのセットアップ

### 1.1 リポジトリのクローン

```bash
git clone https://github.com/mats16/ccbricks.git
cd ccbricks
```

### 1.2 依存関係のインストール

```bash
npm install
```

これにより、すべてのワークスペース（apps と packages）の依存関係がインストールされます。

## 2. データベースのセットアップ

ローカル開発では、デフォルトで `${CCBRICKS_BASE_DIR}/db/ccbricks.sqlite`
の SQLite を使用します。Lakebase を使用する場合は `LAKEBASE_ENDPOINT`
を設定します。Databricks Apps では、バインドした Lakebase リソースに対して
`PGAPPNAME`, `PGDATABASE`, `PGHOST`, `PGPORT`, `PGSSLMODE`, `PGUSER`
が自動的に注入されます。
Lakebase のテーブルは `{PGAPPNAME}_schema_{ハイフンを除いたPGUSER}` という
アプリ専用 PostgreSQL schema に作成され、API は migration と通常クエリの前に
`search_path` をその schema に設定します。

### 2.1 任意: Lakebase でのローカル開発

ローカルで Lakebase を使用する場合は、`LAKEBASE_ENDPOINT` と対象の
Lakebase branch/database 用 PostgreSQL 変数（`PGAPPNAME`, `PGDATABASE`,
`PGHOST`, `PGPORT`, `PGSSLMODE`, `PGUSER`）を設定します。
`LAKEBASE_ENDPOINT` が空の場合、API は SQLite を使用し PostgreSQL 変数は無視します。

### 2.2 データベースマイグレーション

Lakebase のマイグレーションはサーバー起動時に自動的に適用されます。
SQLite は起動時にローカルテーブルを作成します。手動でマイグレーションを実行する場合:

```bash
cd apps/api

# マイグレーションファイルを生成（スキーマ変更時）
npm run db:generate

# 選択された Drizzle 設定に対して手動でマイグレーションを適用
# Lakebase モードでは LAKEBASE_ENDPOINT, PGHOST, PGDATABASE が必要
npm run db:migrate

# またはスキーマを直接プッシュ（開発時のみ）
npm run db:push
```

## 3. 環境変数

### 3.1 .env ファイルの作成

サンプルファイルをコピーして設定します:

```bash
cp .env.example .env
```

### 3.2 必須変数

`.env` を編集して設定します:

```bash
# サーバー
PORT=8003
NODE_ENV=development

# データベース
# LAKEBASE_ENDPOINT が空の場合は SQLite フォールバックを使用
# Lakebase を使用する場合は LAKEBASE_ENDPOINT を設定（デプロイ時の PG* は自動注入）
LAKEBASE_ENDPOINT=

# 暗号化（必須 - 生成コマンド: openssl rand -hex 32）
ENCRYPTION_KEY=your-64-character-hex-key

# Databricks（必須）
DATABRICKS_HOST=your-workspace.cloud.databricks.com

# 開発環境: Databricks 認証ヘッダーのエミュレーション（ローカル認証に必須）
DATABRICKS_TOKEN=your-personal-access-token
DATABRICKS_USER_NAME=your-name
DATABRICKS_USER_ID=your-user-id
DATABRICKS_USER_EMAIL=your-email@example.com
```

### 3.3 オプション変数

```bash
# SQL Warehouse（Databricks SQL を使用する場合）
WAREHOUSE_ID=your-warehouse-id

# Anthropic API（DATABRICKS_HOST から自動構築; 必要に応じてオーバーライド）
ANTHROPIC_BASE_URL=https://your-workspace.cloud.databricks.com/ai-gateway/anthropic
# モデルのデフォルト設定（opus/sonnet/haiku）は管理画面から設定します

# ccbricks ベースディレクトリ
CCBRICKS_BASE_DIR=/path/to/base/directory
```

### 3.4 暗号化キーの生成

```bash
openssl rand -hex 32
```

出力を `.env` ファイルの `ENCRYPTION_KEY` にコピーしてください。

## 4. 開発サーバーの起動

### 4.1 すべてのアプリを起動

```bash
npm run dev
```

これにより、フロントエンドとバックエンドの両方が開発モードで起動します:
- フロントエンド: http://localhost:3003
- バックエンド: http://localhost:8003

### 4.2 個別のアプリを起動

```bash
# フロントエンドのみ
npm run dev --filter=@repo/web

# バックエンドのみ
npm run dev --filter=@repo/api
```

### 4.3 アプリケーションへのアクセス

ブラウザで http://localhost:3003 を開いてください。

## 5. 開発コマンド

| コマンド | 説明 |
|---------|------|
| `npm run dev` | すべてのアプリを開発モードで起動 |
| `npm run build` | すべてのパッケージをビルド |
| `npm run lint` | ESLint を実行 |
| `npm run format` | Prettier でコードをフォーマット |
| `npm run type-check` | TypeScript の型チェックを実行 |
| `npm run test` | テストを実行 |
| `npm run clean` | ビルド成果物と node_modules を削除 |

### Turborepo の操作

```bash
# 特定のパッケージをビルド
npm run build --filter=@repo/types

# 特定のアプリで dev を実行
npm run dev --filter=@repo/api

# キャッシュを無視して強制リビルド
npm run build --force
```

### データベースコマンド（apps/api 内）

```bash
cd apps/api

npm run db:generate   # スキーマ変更からマイグレーションファイルを生成
npm run db:migrate    # 保留中のマイグレーションを実行
npm run db:push       # スキーマを直接プッシュ（開発時のみ）
npm run db:studio     # Drizzle Studio を開く（データベース GUI）
```

## 6. 開発環境での認証

本番環境では、Databricks Apps のプロキシが認証を処理し、ヘッダー経由でユーザー情報を転送します。開発環境では、Vite が環境変数からヘッダーを注入してこれをエミュレートします。

### 仕組み

1. Vite 開発サーバーがポート 3003 でリクエストを受信
2. `/api/*` リクエストの場合、Vite がバックエンド（ポート 8003）にプロキシ
3. Vite が `.env` の値を使用して Databricks スタイルのヘッダーを注入
4. バックエンドが本番環境と同様にヘッダーからユーザー情報を読み取り

### エミュレートされるヘッダー

| ヘッダー | 環境変数 |
|--------|----------|
| `x-forwarded-user` | `DATABRICKS_USER_ID` |
| `x-forwarded-preferred-username` | `DATABRICKS_USER_NAME` |
| `x-forwarded-email` | `DATABRICKS_USER_EMAIL` |
| `x-forwarded-access-token` | `DATABRICKS_TOKEN` |

## 7. プロジェクト構成

```
ccbricks/
├── apps/
│   ├── web/               # React 19 + Vite 7 + shadcn/ui
│   │   ├── src/
│   │   │   ├── components/  # React コンポーネント
│   │   │   ├── contexts/    # React コンテキスト
│   │   │   ├── hooks/       # カスタムフック
│   │   │   ├── i18n/        # 国際化
│   │   │   └── services/    # API クライアント
│   │   └── CLAUDE.md        # フロントエンドガイドライン
│   └── api/               # Fastify 5 + Drizzle ORM
│       ├── src/
│       │   ├── db/          # データベーススキーマ
│       │   ├── plugins/     # Fastify プラグイン
│       │   ├── routes/      # API ルート
│       │   ├── services/    # ビジネスロジック
│       │   └── utils/       # ユーティリティ
│       └── CLAUDE.md        # バックエンドガイドライン
└── packages/
    ├── types/             # 共有 TypeScript 型定義
    ├── eslint-config/     # 共有 ESLint 設定
    └── typescript-config/ # 共有 TypeScript 設定
```

## トラブルシューティング

### ポートが既に使用中

```bash
# ポートを使用しているプロセスを検索
lsof -i :3003  # または :8003

# プロセスを終了
kill -9 <PID>
```

### スキーマ変更後の型エラー

1. まず types パッケージをビルド:
   ```bash
   npm run build --filter=@repo/types
   ```

2. エディタで TypeScript サーバーを再起動

### データベース接続エラー

1. SQLite を使用している場合は、`${CCBRICKS_BASE_DIR}/db` に書き込めることを確認
2. Lakebase を使用している場合は、`LAKEBASE_ENDPOINT`, `PGHOST`, `PGDATABASE`, `PGUSER`, `PGAPPNAME` を確認
3. Lakebase 認証または schema 権限エラーがないかアプリケーションログを確認

### Turborepo キャッシュの問題

```bash
# Turborepo キャッシュをクリア
rm -rf .turbo

# 完全なクリーンと再インストール
npm run clean && npm install
```

### API プロキシが動作しない

1. バックエンドがポート 8003 で起動していることを確認
2. `apps/web/vite.config.ts` の Vite 設定を確認
3. ブラウザコンソールで CORS エラーがないことを確認

### ローカルで認証が動作しない

1. すべての `DATABRICKS_*` 変数が `.env` に設定されていることを確認
2. `.env` を変更した後、Vite 開発サーバーを再起動
3. ブラウザの開発ツールでヘッダー注入を確認

## 関連リソース

- [デプロイガイド](./deployment.md) - Databricks Apps へのデプロイ
- [フロントエンドガイドライン](../../apps/web/CLAUDE.md) - React と UI 開発
- [バックエンドガイドライン](../../apps/api/CLAUDE.md) - API とデータベース開発
