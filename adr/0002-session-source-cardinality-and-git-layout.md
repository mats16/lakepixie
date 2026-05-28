# ADR 0002: Session Source Cardinality and Git Checkout Layout

## Status

Accepted

## Context

Session creation accepts `sources` and `outcomes` that define where initial context comes from and where completed work should be delivered. Databricks Workspace sources are exported into the session working directory. Git repository sources are cloned before the Claude Code query starts.

The previous Git session shape assumed a single repository source and stored the repository identity on the `git_repository` outcome. That made the outcome represent both "which branch to work on" and "which repository this branch belongs to". Supporting multiple repositories in one session requires separating those concerns.

## Decision

A session may contain at most one `databricks_workspace` source. The API enforces this constraint, and the UI prevents users from adding more than one Workspace source.

Git repository sources may contain multiple repositories. When a session has multiple Git repository sources, each repository is cloned under the session working directory using its repository name:

```text
<session cwd>/
├── <repo_name>/
└── <repo_name>/
```

For single-repository Git sessions, the repository remains checked out directly in the session working directory for backward compatibility with existing workflows and persisted sessions.

`git_repository` outcomes describe the target branch or branches for the session. When multiple Git repository sources are used, the outcome must not specify `git_info.repo`; repository identity is derived from the corresponding sources. When a single Git repository source is used, `git_info.repo` may still be present for compatibility and UI affordances such as the Git status bar.

Git and Databricks Workspace sources may be combined in one session. The setup order depends on the number of Git sources:

- With one Workspace source and one Git source, only the Git source is cloned. Workspace export is skipped because cloning into a non-empty working directory can fail.
- With one Workspace source and multiple Git sources, the Workspace source is exported first, then each Git repository is cloned into its `<repo_name>/` subdirectory. If a matching `<repo_name>/` directory already exists from the Workspace export, it is removed before cloning so the Git checkout owns that directory.

Workspace delivery remains represented by a `databricks_workspace` outcome.

## Consequences

- Backend validation owns the source cardinality rules.
- The UI mirrors the API rules so invalid session payloads are not normally constructed.
- Claude Code sees multi-repository sessions as a parent working directory containing one checkout directory per repository.
- Mixed Workspace and single-repository Git sessions only include Git source files in the working directory.
- Mixed Workspace and multi-repository Git sessions include exported Workspace files plus repository subdirectory checkouts.
- Git status and pull request helper flows can continue to use the single-repository path. Multi-repository flows resolve the target repository from `sources` and operate inside the matching checkout directory.
- Existing single-repository sessions remain compatible because their checkout path and optional `git_info.repo` shape are preserved.
