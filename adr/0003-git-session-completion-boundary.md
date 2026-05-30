# ADR 0003: Git Session Completion Boundary

## Status

Accepted

## Context

Git repository sessions run in a local checkout on a designated session branch. The session runtime is not the durable handoff point, so completed work must be recoverable outside the local working directory after the session ends.

ccbricks needs a clear boundary between session delivery and later review workflow. A pushed branch represents delivered session output. A pull request represents a separate review and collaboration workflow.

## Decision

For Git repository sessions, completion is defined by the designated remote branch.

A Git session is complete when the relevant changes are committed to the designated local branch and that branch has been pushed to its corresponding remote branch.

The system may check this completion condition and notify or block the session from being treated as complete when the condition is not met.

Commit and push operations are part of Git session delivery. They must target only the branch assigned to the session.

Pull request creation is not part of Git session completion. A pull request is a separate user-visible review action and must require explicit user intent.

## Consequences

- The remote session branch is the durable handoff point for Git session output.
- Session completion does not depend on the local checkout surviving after the session ends.
- Features that consume completed Git session output can use the pushed branch as the source of truth.
- Pull request creation remains separate from delivery, so completing a session does not automatically start a review workflow.
- Implementations that validate completion should report missing commits or missing pushes clearly, without redefining pull request creation as part of completion.
