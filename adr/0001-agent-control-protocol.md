# ADR 0001: Keep SDK Control Requests Behind the Backend

## Status

Accepted

## Context

Claude Agent SDK uses internal `control_request` messages, including `can_use_tool`, between the Claude CLI process and the SDK host. In ccbricks, the browser communicates with the Fastify backend through application-level HTTP, SSE, and WebSocket protocols.

`AskUserQuestion` is surfaced to the browser as a ccbricks UI interaction. The browser response payload is optimized for UI state, for example `header -> selected label`, while the SDK expects `updatedInput.answers` in the tool-specific shape.

## Decision

The browser must not send SDK `can_use_tool` requests directly.

The browser sends ccbricks application-level control requests, such as `ask_user_question_answer`, to the backend. The backend owns SDK-facing control flow: it resolves the pending `canUseTool` callback and returns the SDK `PermissionResult`/`control_response` to Claude Agent SDK.

Payload normalization happens at the backend boundary. UI-facing payloads may use display-oriented keys, but SDK-facing `updatedInput` must be transformed to the shape expected by `@anthropic-ai/claude-agent-sdk`.

## Consequences

- Browser protocol remains stable and independent from Claude Agent SDK internal control request shapes.
- SDK request IDs and cancellation behavior remain owned by the backend SDK host.
- Backend code must include explicit adapters when UI payloads differ from SDK tool input/output contracts.
