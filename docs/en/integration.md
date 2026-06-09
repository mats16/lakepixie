# External API Integration Guide

[日本語](../ja/integration.md)

This guide explains how to call ccbricks directly from an external system while it is running on Databricks Apps, and how to start job execution or investigation work as a Claude Agent session.

Created: 2026-06-09

## Current State

- ccbricks exposes Fastify routes under `/api/*`, so it is expected to be callable externally through Databricks Apps API token authentication.
- The current ccbricks Databricks Jobs APIs are read-only: `GET /api/databricks/jobs/list` and `GET /api/databricks/jobs/runs/list`. A proxy endpoint for `jobs/run-now` is not implemented yet.
- To ask Claude to perform work from an external system, create a session with `POST /api/sessions` and pass the requested work in the initial user message.
- If the external system only needs to trigger a Databricks Job, calling the Databricks Jobs API `POST /api/2.2/jobs/run-now` directly is simpler than going through ccbricks.

## Authentication and Execution Identity

Treat app access, the internal execution identity, and delegated user tokens as separate concerns.

| Concern                                   | Identity or credential                                                            | Current implementation                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Access to the ccbricks App                | OAuth token from the external caller. Service Principal M2M OAuth is recommended. | The Databricks Apps reverse proxy validates `Authorization: Bearer ...`.                                        |
| Databricks API calls made inside ccbricks | The service principal assigned to the ccbricks App                                | `apps/api/src/lib/databricks-auth.ts` uses `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET`.                 |
| User delegated token                      | `x-forwarded-access-token` forwarded by Databricks Apps                           | Used only for Workspace source export. Jobs proxy and Agent-side Databricks API calls generally use the App SP. |

This means that even if an external service principal token calls the ccbricks App, the current ccbricks runtime generally performs Databricks operations as the ccbricks App service principal. If you need Databricks Jobs to run as the external caller service principal, either call the Jobs API directly or add a dedicated proxy implementation that explicitly uses the caller token.

PATs are supported as a legacy authentication method for Databricks workspace REST APIs, but Databricks Apps API token authentication is documented around OAuth Bearer tokens. Calling the Databricks Apps public URL with a PAT is unverified. Before using PATs in production, first verify that the PAT can call `/api/health` successfully.

## Prerequisites

- The ccbricks App is running on Databricks Apps.
- The App exposes `/api/*` routes.
- The external caller user or service principal has `CAN USE` permission on the Databricks App.
- For service-principal-based external calls, an OAuth secret has been created.
- The ccbricks App service principal has the required permissions on the Databricks resources it will use:
  - Permission to run the target Job when running Jobs
  - Relevant permissions for SQL warehouses, Unity Catalog, Workspace files, and other resources

## Option A: Run as a ccbricks Session

Use this when you want Claude Agent to receive a natural-language instruction and perform work that may involve the Databricks CLI, MCP tools, Workspace operations, investigation, fixes, multiple API calls, or result summarization.

### 1. Get an External Caller Token

Service Principal M2M OAuth example:

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

When using the Databricks SDK, you can generate the `Authorization` header with `WorkspaceClient().config.authenticate()`.

### 2. Verify Connectivity

```bash
export CCBRICKS_APP_URL="https://<app-name>-<id>.<region>.databricksapps.com"

curl -fsS "${CCBRICKS_APP_URL}/api/health" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}"
```

Expected response:

```json
{
  "status": "ok",
  "timestamp": "2026-06-09T00:00:00.000Z",
  "service": "claude-code-on-databricks"
}
```

### 3. Create a Session and Start Execution

`POST /api/sessions` returns `201` once the session has been created. Claude Agent execution continues in the background.

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
          "content": "Start Databricks job_id=${JOB_ID} with idempotency_token=${IDEMPOTENCY_TOKEN}. After starting it, return the run_id, run_page_url, and current state."
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

`session_context.model` should be an actual model ID allowed in the admin settings. The UI also normally resolves selections to actual model IDs such as `databricks-claude-sonnet-4-6` before sending them. The API still has backward compatibility for resolving `opus` / `sonnet` / `haiku`, but external integrations should use actual model IDs.

The initial `POST /api/sessions` request uses the wrapped event shape `{ "type": "event", "data": { ... } }`. Follow-up requests to `POST /api/sessions/:id/events` use the flat SDK event shape `{ "type": "user", ... }`. Do not reuse the session-create event wrapper for follow-up messages.

### 4. Read Results

Use SSE for real-time events:

```bash
export SESSION_ID="$(jq -r ".id" /tmp/ccbricks-session.json)"

curl -N "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}/stream" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}"
```

Or poll the session and events:

```bash
curl -fsS "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq

curl -fsS "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}/events?limit=100" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq
```

When polling, use a bounded interval such as 2-5 seconds with backoff. Stop polling when `session_status` becomes `idle`, `error`, or `archived`, and use the `after` cursor or `last_id` from event responses to avoid repeatedly fetching the same events. Prefer SSE for long-running sessions.

Session status reference:

| `session_status` | Meaning                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `init`           | Session created; workspace export, git clone, or Agent startup is in progress. |
| `running`        | Agent is running.                                                              |
| `idle`           | Agent response completed; additional messages can be sent.                     |
| `error`          | Setup or Agent execution failed.                                               |
| `archived`       | Session has been archived.                                                     |

### 5. Send Follow-Up Instructions or Abort

Follow-up message:

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
        "content": "Monitor this run until completion and summarize the root cause if it fails."
      }
    }
  ]
}
JSON
```

Abort:

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

The examples above are Bash snippets. If you implement the same calls in Python, JavaScript, Windows PowerShell, or another client, generate UUIDs in that environment instead of sending shell expressions such as `$(uuidgen ...)` literally.

## Option B: Trigger a Databricks Job Directly

If you only need to trigger a saved Databricks Job without involving Claude Agent, call the Databricks Jobs API directly. In this mode, the Job runs as the identity represented by the token in the `Authorization` header.

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

Example response:

```json
{
  "run_id": 455644833,
  "number_in_job": 455644833
}
```

Check run status:

```bash
export RUN_ID="455644833"

curl -fsS "${DATABRICKS_HOST}/api/2.2/jobs/runs/get?run_id=${RUN_ID}" \
  -H "Authorization: Bearer ${DATABRICKS_TOKEN}" \
  | jq
```

## Current ccbricks Jobs Proxy APIs

ccbricks currently implements read-only Jobs API proxies. Both call the Databricks Jobs API as the ccbricks App service principal.

### List Jobs

```bash
curl -fsS "${CCBRICKS_APP_URL}/api/databricks/jobs/list?limit=20&name=my-job" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq
```

### List Runs

```bash
curl -fsS "${CCBRICKS_APP_URL}/api/databricks/jobs/runs/list?job_id=${JOB_ID}&limit=25" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq
```

## Session Payload Reference

### `SessionCreateRequest`

| Field                              | Required | Description                                                                        |
| ---------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `title`                            | No       | Session title                                                                      |
| `events`                           | Yes      | Initial user message. At least one event is required.                              |
| `session_context.model`            | Yes      | Allowed actual model ID, for example `databricks-claude-sonnet-4-6`.               |
| `session_context.permission_mode`  | No       | `auto`, `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`           |
| `session_context.effort_level`     | No       | `low`, `medium`, `high`, `xhigh`, `max`                                            |
| `session_context.sources`          | Yes      | Databricks Workspace paths or Git repositories to work on. Empty array is allowed. |
| `session_context.outcomes`         | Yes      | Expected outcomes. Empty array is allowed.                                         |
| `session_context.allowed_tools`    | No       | MCP tool patterns to additionally allow for the session.                           |
| `session_context.disallowed_tools` | No       | MCP tool patterns to disallow for the session.                                     |
| `session_context.mcp_config`       | No       | Session-scoped MCP configuration.                                                  |

For unattended external automation, prefer `permission_mode: "auto"`. `permission_mode: "plan"` requires the caller to handle `exit_plan_mode` events and send an `exit_plan_mode_response`; otherwise the Agent waits up to 10 minutes and the session can fail with a timeout.

### Workspace Source Example

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

Workspace source export uses `x-forwarded-access-token`. How this header behaves for Service Principal M2M calls is unverified. For external integrations that use Workspace sources, first validate export with a small directory.

If `x-forwarded-access-token` is missing, the current implementation logs a warning and skips Workspace export instead of failing the session. For Service Principal M2M integrations, avoid Workspace sources until you have verified this path end to end, or design the prompt so it does not depend on files being exported into the session working directory.

### Git Repository Source Example

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

When using Git repository sources, pay attention to ccbricks GitHub OAuth configuration and user isolation for the external caller identity.

`allow_unrestricted_git_push` must currently be `true`; read-only Git repository sessions are rejected during session validation. Treat this as a privileged mode: use dedicated repositories or branches, avoid production branches, and make the expected branch explicit in `outcomes.git_info.branches`.

### MCP Config Example

`mcp_config` follows the standard `mcpServers` shape. Omit it unless the external integration needs session-scoped MCP servers.

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

For `http` and `sse` MCP servers, ccbricks injects the forwarded OBO token as an `Authorization` header. If no OBO token is available, those servers are not added to the Agent runtime. `stdio` servers do not require OBO token injection but execute local commands in the app runtime, so use them only with trusted configuration.

## Pre-Production Verification Checklist

1. A Service Principal M2M OAuth token can call `${CCBRICKS_APP_URL}/api/health` and receive `200`.
2. The caller service principal has `CAN USE` permission on the Databricks App.
3. The ccbricks App service principal has permission for the target Job, SQL warehouse, Unity Catalog resources, and Workspace paths.
4. `POST /api/sessions` returns `201`, and `GET /api/sessions/:id/events` returns `assistant` or `result` events.
5. For Job execution, verify the execution identity and state with `GET /api/databricks/jobs/runs/list?job_id=...` or the Databricks Jobs API `runs/get`.
6. If using PATs, first verify `${CCBRICKS_APP_URL}/api/health`. If it fails, switch to OAuth tokens.
7. For retryable external requests, always use the Databricks Jobs API `idempotency_token`.

## Cases That Need Additional Implementation

### Expose `jobs/run-now` Directly Through ccbricks

Add `POST /jobs/run-now` to `apps/api/src/routes/jobs.ts`, and add request / response types to `packages/types/src/jobs.ts`. It can follow the same proxy pattern as the existing `jobs/list` route.

Notes:

- If implemented directly with the current auth provider, runs execute as the ccbricks App service principal.
- If runs must execute as the external caller token, first verify the `ctx.oboAccessToken` behavior or the caller token forwarding behavior in Databricks Apps, then design AuthProvider selection accordingly.
- Require or strongly recommend `idempotency_token` for idempotency.
- Consider an allowlist of Job IDs.

### Add a Stable API for External Systems

The current `POST /api/sessions` endpoint is a generic session API shared with the UI. For production external Job execution, a thin dedicated API can keep callers stable:

```http
POST /api/integrations/jobs/:job_id/run
```

Internally, this endpoint can either create a session from a fixed template or call the Databricks Jobs API directly. This avoids exposing the full Claude session payload shape to external integration callers.

## References

- Databricks Apps API token authentication: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/connect-local
- Databricks Apps authorization model: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth
- HTTP headers forwarded by Databricks Apps: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/http-headers
- Service Principal OAuth M2M: https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m
- Personal Access Tokens: https://docs.databricks.com/aws/en/dev-tools/auth/pat
- Jobs API `run-now`: https://docs.databricks.com/api/workspace/jobs/runNow
