# External Session API Integration Guide

[日本語](../ja/integration.md)

This guide focuses on external automation that asks Claude to work through ccbricks by creating a Claude Agent session with `POST /api/sessions`.

Created: 2026-06-09

## Scope

Use this integration when an external system needs Claude to:

- run or inspect a Databricks Job and summarize the result
- investigate a failed run, SQL query, Workspace file, or repository state
- perform multi-step Databricks operations through the tools available to the Agent
- modify a Workspace or Git source and return a reviewable outcome

`POST /api/sessions` is an asynchronous task submission API. A `201` response means that ccbricks accepted and initialized the session; it does not mean that Claude has finished the work. Read the session stream or events to track progress and collect the final answer.

If the external system only needs a deterministic Databricks Job trigger and does not need Claude reasoning, call the Databricks Jobs API directly instead. ccbricks currently has read-only Jobs proxy endpoints, but no `jobs/run-now` proxy endpoint.

## Identity Model

Treat access to the Databricks App, the Agent runtime identity, and delegated user tokens separately.

| Concern                               | Identity or credential                                                            | Current behavior                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Access to the ccbricks App            | OAuth token from the external caller. Service Principal M2M OAuth is recommended. | Databricks Apps validates `Authorization: Bearer ...` before the request reaches ccbricks.                    |
| Databricks API calls made by ccbricks | The service principal assigned to the ccbricks App                                | `apps/api/src/lib/databricks-auth.ts` uses `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET`.               |
| Forwarded user token                  | `x-forwarded-access-token` from Databricks Apps                                   | Used for Workspace source export and some OBO-token MCP server setup. Service Principal behavior is untested. |

The practical result is that an external service principal can call ccbricks, but Databricks operations performed inside the Agent generally run as the ccbricks App service principal. If a Databricks Job must run as the external caller service principal, use the Databricks Jobs API directly or add a dedicated proxy that explicitly uses the caller token.

PATs are supported by Databricks workspace REST APIs as a legacy authentication method. Calling the Databricks Apps public URL with a PAT is unverified. Prefer OAuth Bearer tokens for App access, and verify `/api/health` before relying on PATs.

## Prerequisites

- ccbricks is deployed and running on Databricks Apps.
- The external caller user or service principal has `CAN USE` permission on the Databricks App.
- For service-principal callers, an OAuth secret has been created.
- The ccbricks App service principal has the Databricks permissions needed by Claude's task:
  - permission to run or inspect target Jobs
  - access to SQL warehouses, Unity Catalog objects, Workspace files, and other required resources
- The requested `session_context.model` is allowed in ccbricks admin settings.
- If using Git repository sources, GitHub OAuth and repository permissions are configured for the caller path you expect.

## 1. Get an App Access Token

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

## 2. Verify ccbricks Connectivity

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

## 3. Create a Claude Agent Session

Send the work request as the first user event in `POST /api/sessions`.

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
          "content": "External request ${EXTERNAL_REQUEST_ID}: start Databricks job_id=${JOB_ID} with idempotency_token=${JOB_IDEMPOTENCY_TOKEN}. After starting it, return the run_id, run_page_url, observed execution identity, current state, and any errors. If you cannot start the job, explain exactly which permission, tool, or API call is missing."
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

Important details:

- `session_context.model` should be an actual allowed model ID, for example `databricks-claude-sonnet-4-6`. The UI also normally resolves selections to actual model IDs before sending them. Short names such as `sonnet` exist only for backward compatibility.
- The first event must use the session-create wrapper shape: `{ "type": "event", "data": { ... } }`.
- `data.session_id` is sent as an empty string on create. ccbricks returns the real session ID in the response.
- Use `permission_mode: "auto"` for unattended automation. `permission_mode: "plan"` requires the caller to handle plan approval events.
- `sources: []` and `outcomes: []` are valid for tasks that only need runtime tools or Databricks APIs.
- The session API itself has no idempotency key. Store the returned session ID and avoid blindly retrying a timed-out create request. Put your external request ID and Databricks job idempotency token in the prompt when the task may trigger side effects.

## 4. Read Claude's Progress and Final Answer

Prefer SSE for long-running sessions:

```bash
export SESSION_ID="$(jq -r ".id" /tmp/ccbricks-session.json)"

curl -N "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}/stream" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}"
```

Polling is also supported:

```bash
curl -fsS "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq

curl -fsS "${CCBRICKS_APP_URL}/api/sessions/${SESSION_ID}/events?limit=100" \
  -H "Authorization: Bearer ${CCBRICKS_TOKEN}" \
  | jq
```

When polling, use a bounded interval such as 2-5 seconds with backoff. Stop when `session_status` becomes `idle`, `error`, or `archived`. Use the `after` cursor or response `last_id` to avoid repeatedly fetching the same events.

Session status reference:

| `session_status` | Meaning                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `init`           | Session created; Workspace export, git clone, or Agent startup is in progress. |
| `running`        | Claude Agent is running.                                                       |
| `idle`           | Claude Agent has completed the current response.                               |
| `error`          | Setup or Agent execution failed.                                               |
| `archived`       | Session has been archived.                                                     |

Event streams contain Claude Agent SDK messages. In external automation, treat the final `assistant` or `result` message after the session becomes `idle` as the canonical response, and keep the full event log for auditability.

## 5. Send Follow-Up Instructions

Follow-up messages use the flat SDK user event shape. Do not reuse the create-time `{ "type": "event", "data": ... }` wrapper.

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
        "content": "Continue monitoring the run until completion. If it fails, identify the failed task, error class, and recommended next action."
      }
    }
  ]
}
JSON
```

If `permission_mode: "plan"` is used, the caller must watch for an `exit_plan_mode` request and respond with an `exit_plan_mode_response` control request. For unattended integrations, avoid plan mode unless that approval loop is implemented.

## 6. Abort an Active Session

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

## 7. Payload Reference

### `SessionCreateRequest`

| Field                              | Required | Description                                                                 |
| ---------------------------------- | -------- | --------------------------------------------------------------------------- |
| `title`                            | No       | Human-readable session title. Include an external request ID when possible. |
| `events`                           | Yes      | Initial user message. At least one wrapped event is required.               |
| `session_context.model`            | Yes      | Allowed actual model ID.                                                    |
| `session_context.permission_mode`  | No       | `auto`, `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`    |
| `session_context.effort_level`     | No       | `low`, `medium`, `high`, `xhigh`, `max`                                     |
| `session_context.sources`          | Yes      | Databricks Workspace paths or Git repositories. Empty array is allowed.     |
| `session_context.outcomes`         | Yes      | Expected output destinations. Empty array is allowed.                       |
| `session_context.allowed_tools`    | No       | Additional Claude Code or MCP tool patterns to allow.                       |
| `session_context.disallowed_tools` | No       | Claude Code or MCP tool patterns to block.                                  |
| `session_context.mcp_config`       | No       | Session-scoped MCP server configuration.                                    |

For external automation, keep the first prompt explicit about the objective, resource IDs, allowed side effects, required output fields, and failure reporting format. Claude is receiving a natural-language task, so ambiguity in the prompt becomes operational ambiguity.

## 8. Sources and Outcomes

Use sources and outcomes when Claude needs a working directory populated from Databricks Workspace files or Git repositories. Leave them empty for pure operational tasks such as "inspect this Job run and summarize the error."

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

If `x-forwarded-access-token` is missing, the current implementation logs a warning and skips Workspace export instead of failing the session. Do not make the prompt depend on exported files until this path is verified end to end.

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
        "branches": ["ccbricks/external-request-123"]
      }
    }
  ]
}
```

`allow_unrestricted_git_push` must currently be `true`; read-only Git repository sessions are rejected during session validation. Treat Git sessions as privileged. Use dedicated branches, avoid production branches, and make the expected branch explicit in `outcomes.git_info.branches`.

## 9. MCP and Tool Controls

`allowed_tools` and `disallowed_tools` are merged with user settings. Use them to constrain unattended sessions. For example, keep `mcp__dbsql__execute_sql` in `disallowed_tools` unless SQL writes are explicitly required.

`mcp_config` follows the standard `mcpServers` shape:

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

## 10. Error Handling

Common responses:

| Status | Meaning                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------ |
| `201`  | Session was created. Read stream or events for progress and final output.                        |
| `400`  | Invalid payload, invalid session context, invalid model, invalid event shape, or archived state. |
| `401`  | App authentication failed, user ID is missing, or GitHub authorization is required.              |
| `503`  | GitHub OAuth is not configured for a requested Git source.                                       |
| `500`  | Internal setup, telemetry, or Agent startup failure.                                             |

Recommended retry behavior:

- If `POST /api/sessions` times out client-side, do not immediately submit the same side-effecting task again. Check whether a session with the external request ID already exists in your own integration state.
- If the prompt asks Claude to trigger a Databricks Job, include a Databricks `idempotency_token` in the instruction.
- Retry reads from `/stream`, `/events`, and `/sessions/:id` with backoff.
- Store `session_id`, external request ID, model ID, initial prompt, and final event IDs for auditability.

## Pre-Production Checklist

1. A Service Principal M2M OAuth token can call `${CCBRICKS_APP_URL}/api/health` and receive `200`.
2. The caller service principal has `CAN USE` permission on the Databricks App.
3. The ccbricks App service principal has access to the target Jobs, SQL warehouses, Unity Catalog objects, Workspace paths, and repositories needed by the prompt.
4. `POST /api/sessions` returns `201`, and `/api/sessions/:id/stream` or `/api/sessions/:id/events` produces Claude Agent events.
5. The integration detects `idle`, `error`, and `archived` session states.
6. Side-effecting prompts include external request IDs and Databricks idempotency tokens.
7. PAT usage, Workspace source export, Git source handling, and OBO-token MCP servers are verified end to end before production use.

## References

- Databricks Apps API token authentication: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/connect-local
- Databricks Apps authorization model: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth
- HTTP headers forwarded by Databricks Apps: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/http-headers
- Service Principal OAuth M2M: https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m
- Personal Access Tokens: https://docs.databricks.com/aws/en/dev-tools/auth/pat
- Jobs API `run-now`: https://docs.databricks.com/api/workspace/jobs/runNow
