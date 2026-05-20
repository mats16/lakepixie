# デプロイガイド

このガイドでは、ccbricks を Databricks Apps にデプロイする方法を説明します。

## 前提条件

- Databricks CLI がインストール・設定済みであること
- Apps が有効な Databricks ワークスペースへのアクセス
- 永続化用の Databricks Lakebase リソース

## 1. データベースのセットアップ

### 1.1 Lakebase リソースの作成

bundle は Lakebase Postgres プロジェクトを定義し、アプリに `lakebase`
リソースとしてバインドします。Databricks Apps は、バインドしたリソースに対して
PostgreSQL 接続用の環境変数（`PGAPPNAME`, `PGDATABASE`, `PGHOST`,
`PGPORT`, `PGSSLMODE`, `PGUSER`）を自動的に注入します。
起動時に API は `{PGAPPNAME}_schema_{ハイフンを除いたPGUSER}` という
アプリ専用 PostgreSQL schema を作成し、`search_path` をその schema に設定して
マイグレーションを実行します。

### 1.2 アプリケーションユーザー

Lakebase リソースをアプリに追加すると、Databricks はアプリのサービスプリンシパル用の
PostgreSQL ロールを作成または再利用し、接続と作成の権限を付与します。

**重要:** このアプリケーションは Row-Level Security (RLS) を使用し、`current_setting('app.user_id', true)` でユーザーを識別します。アプリケーションは各リクエストでこのセッション変数を設定し、ユーザー分離を強制します。

### 1.3 データベースマイグレーション

データベースマイグレーションはサーバー起動時に自動的に適用されます。デプロイ時に手動でマイグレーションを実行する必要はありません。

以下の場合、自動マイグレーションは無効化されます:
- 環境変数 `DISABLE_AUTO_MIGRATION=true` が設定されている場合
- 環境変数 `NODE_ENV=test` が設定されている場合

**ローカル開発または手動マイグレーションの場合:**

```bash
# Lakebase モードを使用
export LAKEBASE_ENDPOINT="projects/.../branches/.../endpoints/..."
export PGAPPNAME="ccbricks"
export PGDATABASE="databricks-postgres"
export PGHOST="..."
export PGPORT="5432"
export PGSSLMODE="require"
export PGUSER="service-principal-client-id"

# api ディレクトリに移動
cd apps/api

# マイグレーションファイルを生成（スキーマ変更時）
npm run db:generate

# 手動でマイグレーションを適用（オプション）
npm run db:migrate
```

## 2. シークレットの設定

Databricks シークレットスコープを作成し、必要なシークレットを追加します。

### 2.1 シークレットスコープの作成

```bash
# 開発環境
databricks secrets create-scope ccbricks-dev

# 本番環境
databricks secrets create-scope ccbricks-prod
```

### 2.2 必要なシークレットの追加

**暗号化キー:**

機密データ（OAuth トークンなど）を暗号化するための安全な暗号化キーを生成します。32 バイト（64 文字の 16 進数）のランダムキーが必要です。

```bash
ENCRYPTION_KEY=$(openssl rand -hex 32)
databricks secrets put-secret ccbricks-[dev|prod] encryption-key --string-value "$ENCRYPTION_KEY"
```

## 3. Asset Bundles によるデプロイ

> **デフォルトターゲット:** `databricks.yaml` ではデフォルトで `dev` ターゲットが使用されるように設定されています。開発環境へのデプロイでは `--target` を省略できます。

### 3.1 バンドル設定の検証

```bash
databricks bundle validate [--target prod]
```

### 3.2 Databricks へのデプロイ

```bash
databricks bundle deploy [--target prod]
```

### 3.3 アプリケーションの起動

```bash
databricks bundle run ccbricks_app [--target prod]
```

### 3.4 デプロイの確認

デプロイ後、アプリケーションのステータスを確認します。

```bash
# デプロイされたアプリを一覧表示
databricks apps list

# アプリの詳細を取得
databricks apps get ccbricks-dev-<user-id>
```

## トラブルシューティング

### データベース接続の問題

1. `lakebase` resource binding が `LAKEBASE_ENDPOINT` と `PG*` を注入していることを確認
2. Databricks Apps と Lakebase 間のネットワーク接続を確認
3. アプリのサービスプリンシパルが connect/create 権限を持っていることを確認

### マイグレーションの失敗

1. アプリのサービスプリンシパルが app schema にオブジェクトを作成できることを確認
2. 競合する可能性のある既存のオブジェクトを確認
3. マイグレーション SQL ファイルにエラーがないか確認

### アプリケーション起動の問題

1. Databricks Apps コンソールでアプリケーションログを確認
2. 必要なすべてのシークレットが設定されていることを確認
3. デプロイ前にビルドが正常に完了していることを確認

## 環境別の設定

| 設定 | 開発環境 | 本番環境 |
|------|----------|----------|
| バンドルターゲット | `dev` | `prod` |
| シークレットスコープ | `ccbricks-dev` | `ccbricks-prod` |
| アプリ名 | `ccbricks-dev-<user-id>` | `ccbricks-prod` |
| ワークスペースパス | `/Workspace/Users/<user>/.bundle/...` | `/Workspace/Shared/.bundle/...` |

## セキュリティに関する考慮事項

1. **Lakebase 権限:** アプリのサービスプリンシパルを使用し、環境ごとにリソースを分離
2. **暗号化キー:** 各環境に固有のキーを生成
3. **シークレットスコープ:** シークレットスコープへのアクセスを適切に制限
4. **ネットワークセキュリティ:** 可能な限りプライベートエンドポイントを設定
