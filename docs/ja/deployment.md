# デプロイガイド

このガイドでは、ccbricks を Databricks Apps にデプロイする方法を説明します。

## 前提条件

- Databricks CLI がインストール・設定済みであること
- Apps が有効な Databricks ワークスペースへのアクセス
- Lakebase を使用する場合は、Lakebase 対応リージョンの Databricks ワークスペース

## 1. データベースのセットアップ

### 1.1 Lakebase モード

DAB (Databricks Asset Bundles) が Lakebase Postgres プロジェクトを作成し、
アプリに `lakebase` リソースとしてバインドします。手動で Lakebase リソースを作成したり、
データベース接続用の secret を管理したりする必要はありません。

Lakebase を使用する場合は、以下の設定が有効になっていることを確認してください。

- [resources/ccbricks.app.yaml](../../resources/ccbricks.app.yaml) の `resources.apps.ccbricks_app.resources` にある `lakebase` binding
- [resources/ccbricks.app.yaml](../../resources/ccbricks.app.yaml) の `resources.postgres_projects.ccbricks_db`
- [app.yaml](../../app.yaml) の `LAKEBASE_ENDPOINT` 環境変数

Databricks Apps は、バインドしたリソースに対して
PostgreSQL 接続用の環境変数（`PGAPPNAME`, `PGDATABASE`, `PGHOST`,
`PGPORT`, `PGSSLMODE`, `PGUSER`）を自動的に注入します。
起動時に API は `{PGAPPNAME}_schema_{ハイフンを除いたPGUSER}` という
アプリ専用 PostgreSQL schema を作成し、`search_path` をその schema に設定して
マイグレーションを実行します。

### 1.2 Lakebase 非対応リージョンでの SQLite モード

Lakebase 非対応リージョンにデプロイする場合は、Lakebase の DAB 定義と
`LAKEBASE_ENDPOINT` の注入をコメントアウトしてください。

1. [app.yaml](../../app.yaml) で `LAKEBASE_ENDPOINT` をコメントアウトします。

```yaml
#- name: LAKEBASE_ENDPOINT
#  valueFrom: lakebase
```

2. [resources/ccbricks.app.yaml](../../resources/ccbricks.app.yaml) で、アプリの `lakebase` binding をコメントアウトします。

```yaml
#resources:
#  - name: lakebase
#    postgres:
#      branch: ${resources.postgres_projects.ccbricks_db.id}/branches/production
#      database: ${resources.postgres_projects.ccbricks_db.id}/branches/production/databases/databricks-postgres
#      permission: CAN_CONNECT_AND_CREATE
```

3. 同じ [resources/ccbricks.app.yaml](../../resources/ccbricks.app.yaml) で、`postgres_projects` 定義をコメントアウトします。

```yaml
#postgres_projects:
#  ccbricks_db:
#    project_id: ccbricks-db-${bundle.target}
```

`LAKEBASE_ENDPOINT` が注入されない場合、API は SQLite モードで起動します。
Databricks Apps 上では `CCBRICKS_BASE_DIR=/home/app` のため、SQLite データベースは
`/home/app/db/ccbricks.sqlite` に作成されます。

### 1.3 アプリケーションユーザー

Lakebase リソースをアプリに追加すると、Databricks はアプリのサービスプリンシパル用の
PostgreSQL ロールを作成または再利用し、接続と作成の権限を付与します。

**重要:** このアプリケーションは Row-Level Security (RLS) を使用し、`current_setting('app.user_id', true)` でユーザーを識別します。アプリケーションは各リクエストでこのセッション変数を設定し、ユーザー分離を強制します。

SQLite モードでは PostgreSQL RLS は使用されません。Lakebase 非対応リージョン向けの
フォールバックまたは検証用途として使用してください。

### 1.4 データベースマイグレーション

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

Lakebase 接続用の secret を作成・管理する必要はありません。GitHub OAuth client secret
とアプリケーション暗号鍵は、アプリが Databricks Secrets のアプリ用 scope に保存します。

- `github-oauth-client-secret`（管理画面から保存）
- `encryption-active-key-version`（未設定時に自動生成）
- `encryption-key-v<version>`（未設定時またはローテーション時に自動生成）

アプリの service principal に、アプリ用 scope の secret を作成・読み取り・書き込みできる権限を付与してください。

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

1. Lakebase モードでは、`lakebase` resource binding が `LAKEBASE_ENDPOINT` と `PG*` を注入していることを確認
2. SQLite モードでは、`LAKEBASE_ENDPOINT` がコメントアウトされ、`/home/app/db` に書き込めることを確認
3. Databricks Apps と Lakebase 間のネットワーク接続を確認
4. アプリのサービスプリンシパルが connect/create 権限を持っていることを確認

### マイグレーションの失敗

1. Lakebase モードでは、アプリのサービスプリンシパルが app schema にオブジェクトを作成できることを確認
2. SQLite モードでは、SQLite ファイルと `db` ディレクトリに書き込めることを確認
3. 競合する可能性のある既存のオブジェクトを確認
4. マイグレーション SQL ファイルにエラーがないか確認

### アプリケーション起動の問題

1. Databricks Apps コンソールでアプリケーションログを確認
2. アプリ用 secret scope を作成・更新できる権限があることを確認
3. デプロイ前にビルドが正常に完了していることを確認

## 環境別の設定

| 設定               | 開発環境                              | 本番環境                        |
| ------------------ | ------------------------------------- | ------------------------------- |
| バンドルターゲット | `dev`                                 | `prod`                          |
| データベース       | Lakebase または SQLite                | Lakebase または SQLite          |
| アプリ名           | `ccbricks-dev-<user-id>`              | `ccbricks-prod`                 |
| ワークスペースパス | `/Workspace/Users/<user>/.bundle/...` | `/Workspace/Shared/.bundle/...` |

## セキュリティに関する考慮事項

1. **Lakebase 権限:** DAB が作成・バインドするアプリのサービスプリンシパルを使用し、環境ごとにリソースを分離
2. **暗号化キー:** 各環境に固有のキーを生成
3. **シークレットスコープ:** アプリ用 secret scope へのアクセスを適切に制限
4. **ネットワークセキュリティ:** 可能な限りプライベートエンドポイントを設定
