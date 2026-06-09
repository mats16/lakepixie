# 外部 API 連携ガイド

[English](./INTEGRATION.md)

このドキュメントは、Databricks Apps 上で動作する ccbricks を外部システムから直接呼び出し、Claude Agent セッションとしてジョブ実行や調査を開始するためのガイドです。

作成日: 2026-06-09

## 現状

- ccbricks は `/api/*` ルートを Fastify で公開しており、Databricks Apps の API token authentication で外部から呼び出せる前提です。
- ccbricks にある Databricks Jobs 向け API は、現在 `GET /api/databricks/jobs/list` と `GET /api/databricks/jobs/runs/list` のみです。`jobs/run-now` を中継するエンドポイントは未実装です。
- 外部から「Claude に作業させる」場合は、`POST /api/sessions` でセッションを作成し、初回ユーザーメッセージに実行したい内容を渡します。
- 外部から「Databricks Job を起動するだけ」の場合は、ccbricks を経由せず Databricks Jobs API `POST /api/2.2/jobs/run-now` を直接呼ぶほうが単純です。

## 認証と実行権限の考え方

外部連携では、App への入場、ccbricks 内部の実行主体、ユーザー代理トークンを分けて考えます。

| 観点                                      | 使われる権限                                                        | 現在の実装での扱い                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ccbricks App への入場                     | 外部呼び出し元の OAuth token。Service Principal の M2M OAuth を推奨 | Databricks Apps のリバースプロキシが `Authorization: Bearer ...` を検証する                                   |
| ccbricks 内から Databricks API を呼ぶ権限 | ccbricks App に割り当てられた service principal                     | `apps/api/src/lib/databricks-auth.ts` の `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET` を使う           |
| ユーザー代理トークン                      | Databricks Apps が転送する `x-forwarded-access-token`               | Workspace source の export でのみ使用。Jobs proxy や Agent 実行の Databricks API 呼び出しは基本的に App SP 側 |

つまり、外部の Service Principal token で ccbricks App を呼んでも、現在の ccbricks 内部実行は原則として「ccbricks App の service principal」権限で動きます。外部呼び出し元の Service Principal 権限で Databricks Jobs を起動したい場合は、ccbricks を経由せず Jobs API を直接呼ぶか、呼び出し元トークンを使う専用の中継実装を追加してください。

PAT については、Databricks workspace REST API では legacy な認証方式として使えますが、Databricks Apps の API token authentication は公式ドキュメント上 OAuth Bearer token を前提に説明されています。PAT で Databricks Apps の公開 URL を直接呼べるかは未検証です。運用前に「PAT で `/api/health` が 200 になるか」を確認してください。

## 前提条件

- ccbricks App が Databricks Apps 上で起動していること
- App に `/api/*` ルートが公開されていること
- 外部呼び出し元の user または service principal に、対象 Databricks App の `CAN USE` 権限があること
- Service Principal で外部から呼ぶ場合、OAuth secret が発行済みであること
- ccbricks App の service principal に、実行したい Databricks resources への必要権限があること
  - Jobs を実行する場合は対象 Job への実行権限
  - SQL warehouse / Unity Catalog / Workspace file などを使う場合は、それぞれの権限

## 方式 A: ccbricks セッションとして実行する

Claude Agent に自然言語で指示を渡し、Databricks CLI / MCP / Workspace 操作を含む作業を実行させる方式です。調査、修正、複数 API の組み合わせ、結果要約が必要な場合はこちらを使います。

### 1. 外部呼び出し用トークンを取得する

Service Principal の M2M OAuth 例です。

```bash
export DATABRICKS_HOST="https://<workspace-host>"
export DATABRICKS_CLIENT_ID="<caller-service-principal-client-id>"
export DATABRICKS_CLIENT_SECRET="<caller-service-principal-secret>"

export CCBRICKS_TOKEN="$(
  curl -fsS --request POST "${DATABRICKS_HOST}/oidc/v1/token" \
    --user "${DATABRICKS_CLIENT_ID}:${DATABRICKS_CLIENT_SECRET}" \
    --data "grant_type=client_credentials&scope=all-apis" \
  | jq -r ".access_token"
)"
```

Databricks SDK を使う場合は、`WorkspaceClient().config.authenticate()` で `Authorization` ヘッダーを生成できます。

### 2. 疎通確認

```bash
export CCBRICKS_APP_URL="https://<app-name>-<id>.<region>.databricksapps.com"

curl -fsS "${CCBRICKS_APP_URL}/api/health" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}"
```

期待レスポンス:

```json
{
  "status": "ok",
  "timestamp": "2026-06-09T00:00:00.000Z",
  "service": "claude-code-on-databricks"
}
```

### 3. セッションを作成して実行を開始する

`POST /api/sessions` は 201 を返した時点でセッション作成済みです。Claude Agent の実行はバックグラウンドで進みます。

```bash
export JOB_ID="11223344"
export IDEMPOTENCY_TOKEN="$(uuidgen | tr "[:upper:]" "[:lower:]")"
export MESSAGE_UUID="$(uuidgen | tr "[:upper:]" "[:lower:]")"

curl -fsS --request POST "${CCBRICKS_APP_URL}/api/sessions" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON | tee /tmp/ccbricks-session.json
{
  "title": "Run Databricks job ${JOB_ID}",
  "events": [
    {
      "type": "event",
      "data": {
        "uuid": "${MESSAGE_UUID}",
        "session_id": "",
        "type": "user",
        "parent_tool_use_id": null,
        "message": {
          "role": "user",
          "content": "Databricks job_id=${JOB_ID} を idempotency_token=${IDEMPOTENCY_TOKEN} で起動してください。起動後、run_id、run_page_url、現在の状態を返してください。"
        }
      }
    }
  ],
  "session_context": {
    "model": "databricks-claude-sonnet-4-6",
    "permission_mode": "auto",
    "effort_level": "high",
    "sources": [],
    "outcomes": [],
    "allowed_tools": [],
    "disallowed_tools": ["mcp__dbsql__execute_sql"]
  }
}
JSON
```

`session_context.model` は管理画面で許可された実モデル ID を指定します。UI も通常は選択値を `databricks-claude-sonnet-4-6` のような実モデル ID に解決してから送信します。API 側には `opus` / `sonnet` / `haiku` の短縮名を解決する後方互換がありますが、外部連携では実モデル ID を使ってください。

初回の `POST /api/sessions` は `{ "type": "event", "data": { ... } }` というラップされたイベント形式を使います。一方、追加指示を送る `POST /api/sessions/:id/events` は `{ "type": "user", ... }` というフラットな SDK イベント形式を使います。セッション作成用のイベントラッパーを追加メッセージに流用しないでください。

### 4. 結果を取得する

SSE でリアルタイムに読む場合:

```bash
export SESSION_ID="$(jq -r ".id" /tmp/ccbricks-session.json)"

curl -N "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}/stream" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}"
```

ポーリングで読む場合:

```bash
curl -fsS "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq

curl -fsS "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}/events?limit=100" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq
```

ポーリングする場合は、2-5 秒程度の間隔とバックオフを入れてください。`session_status` が `idle`, `error`, `archived` になったら終了し、イベント取得では `after` カーソルまたはレスポンスの `last_id` を使って同じイベントを繰り返し取得しないようにしてください。長時間セッションでは SSE を推奨します。

セッション状態の目安:

| `session_status` | 意味                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `init`           | セッション作成直後。workspace export / git clone / Agent 起動準備中 |
| `running`        | Agent 実行中                                                        |
| `idle`           | Agent 応答完了。追加メッセージを送れる                              |
| `error`          | セットアップまたは Agent 実行でエラー                               |
| `archived`       | アーカイブ済み                                                      |

### 5. 追加指示や中断を送る

追加メッセージ:

```bash
export NEXT_MESSAGE_UUID="$(uuidgen | tr "[:upper:]" "[:lower:]")"

curl -fsS --request POST "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}/events" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{
  "events": [
    {
      "type": "user",
      "uuid": "${NEXT_MESSAGE_UUID}",
      "session_id": "${SESSION_ID}",
      "parent_tool_use_id": null,
      "message": {
        "role": "user",
        "content": "この run の完了まで監視し、失敗した場合は原因を要約してください。"
      }
    }
  ]
}
JSON
```

上記は Bash の例です。Python、JavaScript、Windows PowerShell などで実装する場合は、その実行環境で UUID を生成してください。`$(uuidgen ...)` のようなシェル式を文字列として送らないでください。

中断:

```bash
curl -fsS --request POST "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}/events" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{
  "events": [
    {
      "type": "control_request",
      "request_id": "$(uuidgen | tr "[:upper:]" "[:lower:]")",
      "request": {
        "subtype": "abort"
      }
    }
  ]
}
JSON
```

## 方式 B: Databricks Job を直接起動する

Claude Agent を介さず、保存済み Databricks Job を単純に起動したいだけなら、Databricks Jobs API を直接呼びます。この場合、ジョブは `Authorization` に渡した token の主体で実行されます。

```bash
export DATABRICKS_HOST="https://<workspace-host>"
export DATABRICKS_TOKEN="<oauth-or-pat-token>"
export JOB_ID="11223344"
export IDEMPOTENCY_TOKEN="$(uuidgen | tr "[:upper:]" "[:lower:]")"

curl -fsS --request POST "${DATABRICKS_HOST}/api/2.2/jobs/run-now" \
  -H "Authorization: Bearer ${DATABRICKS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{
  "job_id": ${JOB_ID},
  "idempotency_token": "${IDEMPOTENCY_TOKEN}",
  "job_parameters": {
    "example_param": "example_value"
  }
}
JSON
```

レスポンス例:

```json
{
  "run_id": 455644833,
  "number_in_job": 455644833
}
```

run の状態確認:

```bash
export RUN_ID="455644833"

curl -fsS "${DATABRICKS_HOST}/api/2.2/jobs/runs/get?run_id=${RUN_ID}" \
  -H "Authorization: Bearer ${DATABRICKS_TOKEN}" \
  | jq
```

## 現在の ccbricks Jobs proxy API

ccbricks には Jobs API の読み取り用 proxy が実装されています。どちらも ccbricks App の service principal で Databricks Jobs API を呼びます。

### ジョブ一覧

```bash
curl -fsS "${CCBRICKS_APP_URL}/api/databricks/jobs/list?limit=20&name=my-job" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq
```

### Run 一覧

```bash
curl -fsS "${CCBRICKS_APP_URL}/api/databricks/jobs/runs/list?job_id=${JOB_ID}&limit=25" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq
```

## セッション payload リファレンス

### `SessionCreateRequest`

| フィールド                         | 必須 | 説明                                                                     |
| ---------------------------------- | ---- | ------------------------------------------------------------------------ |
| `title`                            | 任意 | セッションタイトル                                                       |
| `events`                           | 必須 | 初回ユーザーメッセージ。1 件以上必要                                     |
| `session_context.model`            | 必須 | 許可済み実モデル ID。例: `databricks-claude-sonnet-4-6`                  |
| `session_context.permission_mode`  | 任意 | `auto`, `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk` |
| `session_context.effort_level`     | 任意 | `low`, `medium`, `high`, `xhigh`, `max`                                  |
| `session_context.sources`          | 必須 | 作業対象の Databricks Workspace path または Git repository。空配列可     |
| `session_context.outcomes`         | 必須 | 期待する成果物。空配列可                                                 |
| `session_context.allowed_tools`    | 任意 | セッション単位で追加許可する MCP tool pattern                            |
| `session_context.disallowed_tools` | 任意 | セッション単位で禁止する MCP tool pattern                                |
| `session_context.mcp_config`       | 任意 | セッション単位の MCP 設定                                                |

外部からの無人実行では、基本的に `permission_mode: "auto"` を使ってください。`permission_mode: "plan"` は `exit_plan_mode` イベントを受け取り、`exit_plan_mode_response` を返す実装が必要です。応答しない場合、Agent は最大 10 分待機し、タイムアウトでセッションが失敗する可能性があります。

### Workspace source を指定する例

```json
{
  "sources": [
    {
      "type": "databricks_workspace",
      "path": "/Workspace/Users/user@example.com/project"
    }
  ],
  "outcomes": [
    {
      "type": "databricks_workspace",
      "path": "/Workspace/Users/user@example.com/project"
    }
  ]
}
```

Workspace source の export には `x-forwarded-access-token` が使われます。Service Principal M2M 呼び出しでこのヘッダーがどう渡るかは未検証です。Workspace source を使う外部連携では、最初に小さいディレクトリで export が成功するか確認してください。

`x-forwarded-access-token` がない場合、現在の実装はセッションを失敗させず、警告ログを出して Workspace export をスキップします。Service Principal M2M 連携では、この経路をエンドツーエンドで検証するまで Workspace source の指定を避けるか、セッション作業ディレクトリへの export に依存しないプロンプトにしてください。

### Git repository source を指定する例

```json
{
  "sources": [
    {
      "type": "git_repository",
      "url": "https://github.com/example/repo.git",
      "revision": "refs/heads/main",
      "sparse_checkout_paths": [],
      "allow_unrestricted_git_push": true
    }
  ],
  "outcomes": [
    {
      "type": "git_repository",
      "git_info": {
        "type": "github",
        "repo": "example/repo",
        "branches": ["ccbricks/job-run-11223344"]
      }
    }
  ]
}
```

Git repository source を使う場合は、ccbricks 側の GitHub OAuth 設定と外部呼び出し主体のユーザー分離に注意してください。

現在、`allow_unrestricted_git_push` は `true` である必要があります。読み取り専用の Git repository session はセッション検証で拒否されます。これは強い権限を持つモードとして扱い、専用リポジトリまたは専用ブランチを使い、本番ブランチは避け、`outcomes.git_info.branches` で期待するブランチを明示してください。

### MCP config の例

`mcp_config` は標準の `mcpServers` 形式です。セッション単位で MCP サーバーを追加する必要がない場合は省略してください。

```json
{
  "mcp_config": {
    "mcpServers": {
      "example_server": {
        "type": "http",
        "url": "https://example.com/mcp"
      }
    }
  },
  "allowed_tools": ["mcp__example_server__*"]
}
```

`http` / `sse` の MCP サーバーでは、ccbricks が forwarded OBO token を `Authorization` ヘッダーとして注入します。OBO token がない場合、そのサーバーは Agent runtime に追加されません。`stdio` サーバーは OBO token を必要としませんが、アプリ runtime 上でローカルコマンドを実行するため、信頼済み設定に限定してください。

## 運用前の検証チェックリスト

1. Service Principal M2M OAuth token で `${CCBRICKS_APP_URL}/api/health` が 200 になる。
2. 呼び出し元 service principal に Databricks App の `CAN USE` 権限がある。
3. ccbricks App の service principal に、対象 Job / SQL warehouse / Unity Catalog / Workspace path への権限がある。
4. `POST /api/sessions` が 201 を返し、`GET /api/sessions/:id/events` で `assistant` または `result` event を取得できる。
5. Job 実行を伴う場合、`GET /api/databricks/jobs/runs/list?job_id=...` または Databricks Jobs API `runs/get` で実行主体と状態を確認する。
6. PAT を使う場合、まず `${CCBRICKS_APP_URL}/api/health` で検証する。失敗する場合は OAuth token に切り替える。
7. 同じ外部リクエストを再送する可能性がある処理では、Databricks Jobs API の `idempotency_token` を必ず使う。

## 追加実装が必要なケース

### ccbricks 経由で `jobs/run-now` を直接公開したい

`apps/api/src/routes/jobs.ts` に `POST /jobs/run-now` を追加し、`packages/types/src/jobs.ts` に request / response 型を追加します。既存の `jobs/list` と同じ構造で Databricks Jobs API に中継できます。

注意点:

- そのまま実装すると ccbricks App の service principal 権限で実行されます。
- 外部呼び出し元 token の権限で実行したい場合は、`ctx.oboAccessToken` または Databricks Apps から転送される caller token の仕様を検証したうえで、AuthProvider の選択を設計する必要があります。
- 冪等性のため `idempotency_token` を必須または強く推奨にしてください。
- 許可する Job ID を allowlist 化することを推奨します。

### 外部システム向けの安定 API を作りたい

現在の `POST /api/sessions` は UI と共有される汎用セッション API です。外部ジョブ起動を本番運用するなら、次のような薄い専用 API を追加すると呼び出し側が安定します。

```http
POST /api/integrations/jobs/:job_id/run
```

内部では固定テンプレートからセッションを作る、または Databricks Jobs API を直接呼ぶ実装にします。これにより、外部連携側に Claude セッション payload の詳細を公開せずに済みます。

## 参考リンク

- Databricks Apps の API token authentication: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/connect-local
- Databricks Apps の authorization model: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth
- Databricks Apps が転送する HTTP headers: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/http-headers
- Service Principal OAuth M2M: https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m
- Personal Access Tokens: https://docs.databricks.com/aws/en/dev-tools/auth/pat
- Jobs API `run-now`: https://docs.databricks.com/api/workspace/jobs/runNow
