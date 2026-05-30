# ADR 0004: Manage Agent-Visible Session Outcomes Through Internal MCP

## Status

Accepted

## Context

Agents can create or modify external delivery targets such as Databricks Apps and Databricks Workspace paths from inside a session. Those operations can succeed outside ccbricks while the persisted `session_context` remains unchanged. The UI derives App and Workspace affordances from `session_context.outcomes`, so external changes that are not reflected there are invisible to the application.

CLI wrappers can help with specific operations, but they are awkward to expose reliably because they depend on `PATH` and mix external side effects with ccbricks state updates.

## Decision

ccbricks provides an internal `session` MCP server to every Claude session.

The MCP server is a session context manager. It may read the current `session_context`, read `session_context.outcomes`, and update only the `outcomes` array. It must not update `sources`, `cwd`, model settings, permission settings, MCP config, or tool permissions.

Outcome updates are validated by the backend before persistence:

- `databricks_workspace` outcomes must have a valid Workspace path.
- `databricks_apps` outcomes must have a valid resolved app name.
- At most one Workspace outcome and one Apps outcome may be present.
- Git outcomes must remain consistent with the session's Git sources.

After a successful outcome update, the backend broadcasts a `session_context_updated` message over the existing session stream so the UI can update its displayed session state.

The MCP server does not create Databricks Apps, push Workspace files, or perform external Databricks actions. Agents may use existing CLI/API tools for those side effects, then use `session` to record the resulting outcomes.

## Consequences

- The persisted session context remains the source of truth for UI-visible delivery targets.
- Agent-side Databricks operations can be reflected in the UI without relying on CLI wrappers being on `PATH`.
- Backend validation keeps context mutation narrowly scoped to outcomes.
- Existing Databricks operation flows remain usable, but completion instructions must tell agents to record outcomes through MCP.
