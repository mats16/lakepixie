# 外部セッション API 連携ガイド

[English](../en/integration.md)

このドキュメントは、外部システムから ccbricks の `POST /api/sessions` を呼び出し、Claude Agent セッションとして作業を依頼する連携にフォーカスしたガイドです。

作成日: 2026-06-09

## スコープ

この連携は、外部システムから Claude に次のような作業をさせたい場合に使います。

- Databricks Job を起動または調査し、結果を要約する
- 失敗した run、SQL query、Workspace file、repository の状態を調査する
- Agent が利用できる tool を使って複数ステップの Databricks 操作を実行する
- Workspace または Git source を修正し、レビュー可能な outcome を返す

`POST /api/sessions` は非同期のタスク投入 API です。`201` は ccbricks がセッションを受け付けて初期化したことを表し、Claude の作業完了は意味しません。進捗と最終回答は session stream または events から取得してください。

外部システムが Claude の判断を必要とせず、決定的に Databricks Job を起動するだけなら、Databricks Jobs API を直接呼んでください。現在の ccbricks には read-only の Jobs proxy endpoint はありますが、`jobs/run-now` の proxy endpoint はありません。

## 権限モデル

Databricks App への入場、Agent runtime の実行主体、ユーザー代理 token は分けて考えます。

| 観点                                    | 使われる権限                                                               | 現在の挙動                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| ccbricks App への入場                   | 外部呼び出し元の OAuth Bearer token。Service Principal の M2M OAuth を推奨 | Databricks Apps が `Authorization: Bearer ...` を検証してから ccbricks にリクエストを渡す                        |
| ccbricks から Databricks API を呼ぶ権限 | ccbricks App に割り当てられた service principal                            | `apps/api/src/lib/databricks-auth.ts` が `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET` を使う              |
| forwarded user token                    | Databricks Apps が転送する `x-forwarded-access-token`                      | Workspace source export と一部の OBO-token MCP server 設定で使う。Service Principal 呼び出し時の挙動は未検証です |

重要な注意点は、caller identity は App への入場権限であり、Agent 内の Databricks 操作は基本的に ccbricks App の service principal として実行されることです。Databricks Job を外部呼び出し元 service principal の権限で実行する必要がある場合は、Databricks Jobs API を直接呼ぶか、呼び出し元 token を明示的に使う専用 proxy を追加してください。

PAT では Databricks Apps の公開 URL を呼び出せません。`/api/health` と `/api/sessions` を含む ccbricks App へのアクセスには OAuth Bearer token が必要です。PAT は Databricks workspace REST API では使える場合がありますが、ccbricks App への入場には使わないでください。

## 前提条件

- ccbricks が Databricks Apps 上に deploy され、起動していること
- 外部呼び出し元に、対象 Databricks App の `CAN USE` 権限があること
- Service Principal 呼び出しでは OAuth secret が発行済みであること
- ccbricks App の service principal に、Claude に依頼する作業に必要な Databricks 権限があること
  - 対象 Jobs の実行または閲覧権限
  - SQL warehouses、Unity Catalog objects、Workspace files などへのアクセス権限
- 指定する `session_context.model` が ccbricks の admin settings で許可されていること
- Git repository sources を使う場合、想定する呼び出し経路で GitHub OAuth と repository permission が設定されていること

## 1. App へのアクセス token を取得する

ccbricks App へのすべてのリクエストには OAuth Bearer token を使います。

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

Databricks SDK を使う場合は、`WorkspaceClient().config.authenticate()` で `Authorization` header を生成できます。

## 2. ccbricks への疎通を確認する

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

## 3. Claude Agent セッションを作成する

`POST /api/sessions` の初回 user event に、Claude に依頼したい作業を入れます。

```bash
export JOB_ID="11223344"
export EXTERNAL_REQUEST_ID="$(uuidgen | tr "[:upper:]" "[:lower:]")"
export JOB_IDEMPOTENCY_TOKEN="$(uuidgen | tr "[:upper:]" "[:lower:]")"
export MESSAGE_UUID="$(uuidgen | tr "[:upper:]" "[:lower:]")"

curl -fsS --request POST "${CCBRICKS_APP_URL}/api/sessions" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON | tee /tmp/ccbricks-session.json
{
  "title": "External request ${EXTERNAL_REQUEST_ID}: run job ${JOB_ID}",
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
          "content": "External request ${EXTERNAL_REQUEST_ID}: Databricks job_id=${JOB_ID} を idempotency_token=${JOB_IDEMPOTENCY_TOKEN} で起動してください。起動後、run_id、run_page_url、確認できた実行主体、現在の状態、発生したエラーを返してください。起動できない場合は、どの permission、tool、API call が不足しているかを具体的に説明してください。"
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

重要な点:

- `session_context.model` は `databricks-claude-sonnet-4-6` のような許可済みの実モデル ID を指定します。`sonnet` のような短縮名は後方互換用です。
- create request は `{ "type": "event", "data": { ... } }` wrapper 形式です。追加メッセージでは使いません。
- create 時の `data.session_id` は空文字で送ります。実際の session ID はレスポンスで返ります。
- 無人実行では `permission_mode: "auto"` を使ってください。`plan` mode は plan approval loop が必要です。
- runtime tool や Databricks API だけで完結する作業では、`sources: []` と `outcomes: []` で問題ありません。
- `POST /api/sessions` 自体には idempotency key がありません。返却された session ID を保存し、client 側 timeout 時に同じ副作用のある作業を無条件で再投入しないでください。副作用のある作業では、external request ID と Databricks job idempotency token を prompt に含めてください。

## 4. Claude の進捗と最終回答を読む

長時間セッションでは SSE を推奨します。

```bash
export SESSION_ID="$(jq -r ".id" /tmp/ccbricks-session.json)"

curl -N "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}/stream" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}"
```

ポーリングも可能です。

```bash
curl -fsS "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq

curl -fsS "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}/events?limit=100" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq
```

ポーリングする場合は、2-5 秒程度の間隔とバックオフを入れてください。`session_status` が `idle`, `error`, `archived` になったら終了し、`after` cursor または response の `last_id` で同じ event の再取得を避けます。

セッション状態の目安:

| `session_status` | 意味                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `init`           | セッション作成直後。Workspace export、git clone、Agent 起動準備中です。 |
| `running`        | Claude Agent が実行中です。                                             |
| `idle`           | Claude Agent が現在の応答を完了しています。                             |
| `error`          | setup または Agent 実行で失敗しています。                               |
| `archived`       | セッションが archive 済みです。                                         |

Event stream には Claude Agent SDK message が流れます。session が `idle` になった後の最終 `assistant` または `result` message を canonical response として扱い、監査用に event log 全体を保存してください。

## 5. 追加指示を送る

追加メッセージでは、flat な SDK user event 形式を使います。create 時の `{ "type": "event", "data": ... }` wrapper は使い回さないでください。

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
        "content": "この run の完了まで監視を続けてください。失敗した場合は、失敗した task、error class、推奨される次の対応を特定してください。"
      }
    }
  ]
}
JSON
```

`permission_mode: "plan"` を使う場合、呼び出し側は `exit_plan_mode` を監視し、`exit_plan_mode_response` control request を返す必要があります。無人連携では、その approval loop がない限り plan mode を避けてください。

## 6. 実行中のセッションを中断する

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

上記は Bash の例です。Python、JavaScript、Windows PowerShell などで実装する場合は、その実行環境で UUID を生成してください。`$(uuidgen ...)` のような shell expression を文字列として送らないでください。

## 7. Payload リファレンス

### `SessionCreateRequest`

| フィールド                         | 必須 | 説明                                                                     |
| ---------------------------------- | ---- | ------------------------------------------------------------------------ |
| `title`                            | 任意 | 人間が読める session title。可能なら external request ID を含めます。    |
| `events`                           | 必須 | 初回 user message。1 件以上の wrapped event が必要です。                 |
| `session_context.model`            | 必須 | 許可済みの実モデル ID。                                                  |
| `session_context.permission_mode`  | 任意 | `auto`, `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk` |
| `session_context.effort_level`     | 任意 | `low`, `medium`, `high`, `xhigh`, `max`                                  |
| `session_context.sources`          | 必須 | Databricks Workspace paths または Git repositories。空配列も可能です。   |
| `session_context.outcomes`         | 必須 | 期待する出力先。空配列も可能です。                                       |
| `session_context.allowed_tools`    | 任意 | 追加で許可する Claude Code または MCP tool pattern。                     |
| `session_context.disallowed_tools` | 任意 | 禁止する Claude Code または MCP tool pattern。                           |
| `session_context.mcp_config`       | 任意 | セッション単位の MCP server 設定。                                       |

外部連携では、初回 prompt に objective、resource IDs、許可する副作用、必須の出力項目、失敗時の報告形式を明確に書いてください。Claude には自然言語タスクとして渡るため、prompt の曖昧さは運用上の曖昧さになります。

## 8. Sources と outcomes

Claude の working directory に Databricks Workspace file や Git repository が必要な場合だけ、sources と outcomes を使います。`Job run を調査して error を要約する` のような運用タスクでは空配列で構いません。

### Workspace source の例

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

Workspace source export では `x-forwarded-access-token` が使われます。Service Principal M2M 呼び出し時の挙動は未検証なので、外部連携で Workspace sources を使う前に小さい directory で export を検証してください。

`x-forwarded-access-token` がない場合、現在の実装は session を失敗させず、warning log を出して Workspace export を skip します。この経路を end-to-end で検証するまで、export された file に prompt が依存しないようにしてください。

### Git repository source の例

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
        "branches": ["ccbricks/external-request-123"]
      }
    }
  ]
}
```

現在、`allow_unrestricted_git_push` は `true` である必要があります。read-only の Git repository session は validation で拒否されます。Git session は強い権限を持つものとして扱い、専用 branch を使い、本番 branch は避け、`outcomes.git_info.branches` で期待する branch を明示してください。

## 9. MCP と tool 制御

`allowed_tools` と `disallowed_tools` は user settings と merge されます。無人セッションではここで tool を制約します。たとえば SQL write が必要でない限り、`mcp__dbsql__execute_sql` は `disallowed_tools` に入れておきます。

`mcp_config` は標準の `mcpServers` 形式です。

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

`http` / `sse` MCP server では、ccbricks が forwarded OBO token を `Authorization` header として注入します。OBO token がない場合、それらの server は Agent runtime に追加されません。`stdio` server は app runtime 上で local command を実行するため、信頼済み設定に限定してください。

## 10. エラーハンドリング

よくある response:

| Status | Meaning                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `201`  | Session が作成されました。進捗と最終出力は stream または events から読んでください。                                        |
| `400`  | invalid payload、invalid session context、invalid model、invalid event shape、archived state などです。                     |
| `401`  | App OAuth authentication 失敗、App access に PAT を使っている、user ID missing、または GitHub authorization required です。 |
| `503`  | requested Git source に対して GitHub OAuth が設定されていません。                                                           |
| `500`  | internal setup、telemetry、Agent startup failure などです。                                                                 |

推奨する retry behavior:

- `POST /api/sessions` が client 側で timeout した場合、同じ副作用のある task をすぐ再投入しないでください。integration state で external request ID に対応する session が既にないか確認します。
- Claude に Databricks Job 起動を依頼する場合は、prompt に Databricks `idempotency_token` を含めます。
- `/stream`, `/events`, `/sessions/:id` の read は backoff 付きで retry します。
- auditability のため、`session_id`、external request ID、model ID、initial prompt、final event IDs を保存します。

## 運用前チェックリスト

1. Service Principal M2M OAuth token で `${CCBRICKS_APP_URL}/api/health` が `200` になる。
2. caller service principal に Databricks App の `CAN USE` 権限がある。
3. ccbricks App service principal に、prompt が必要とする Jobs、SQL warehouses、Unity Catalog objects、Workspace paths、repositories への権限がある。
4. `POST /api/sessions` が `201` を返し、`/api/sessions/:id/stream` または `/api/sessions/:id/events` から Claude Agent events を取得できる。
5. integration が `idle`, `error`, `archived` の session state を検知できる。
6. 副作用のある prompt に external request ID と Databricks idempotency token が含まれている。
7. ccbricks App access に PAT を使っていない。Workspace source export、Git source handling、OBO-token MCP servers は本番運用前に end-to-end で検証済みである。

## 参考リンク

- Databricks Apps の API token authentication: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/connect-local
- Databricks Apps の authorization model: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth
- Databricks Apps が転送する HTTP headers: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/http-headers
- Service Principal OAuth M2M: https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m
- Jobs API `run-now`: https://docs.databricks.com/api/workspace/jobs/runNow
