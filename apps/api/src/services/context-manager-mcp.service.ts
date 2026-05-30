import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { SessionContextResponse, SessionResponse, UpdateOutcomesResponse } from '@repo/types';

export const CONTEXT_MANAGER_MCP_SERVER_ID = 'session';

export const CONTEXT_MANAGER_MCP_READ_TOOL_NAMES = ['get_session_context', 'get_outcomes'] as const;

export const CONTEXT_MANAGER_MCP_WRITE_TOOL_NAMES = [
  'set_outcomes',
  'upsert_outcome',
  'remove_outcome',
] as const;

export const CONTEXT_MANAGER_TOOL_NAMES = [
  ...CONTEXT_MANAGER_MCP_READ_TOOL_NAMES,
  ...CONTEXT_MANAGER_MCP_WRITE_TOOL_NAMES,
] as const;

function toQualifiedContextManagerToolName(toolName: string): string {
  return `mcp__${CONTEXT_MANAGER_MCP_SERVER_ID}__${toolName}`;
}

export const CONTEXT_MANAGER_MCP_TOOLS = CONTEXT_MANAGER_TOOL_NAMES.map(
  toQualifiedContextManagerToolName
);

export const CONTEXT_MANAGER_MCP_WRITE_TOOLS = CONTEXT_MANAGER_MCP_WRITE_TOOL_NAMES.map(
  toQualifiedContextManagerToolName
);

interface ContextManagerMcpHandlers {
  getSessionContext(): Promise<SessionContextResponse>;
  setOutcomes(outcomes: unknown): Promise<SessionResponse>;
  upsertOutcome(outcome: unknown): Promise<SessionResponse>;
  removeOutcome(outcomeType: unknown): Promise<SessionResponse>;
}

const outcomeTypeSchema = z.enum(['databricks_workspace', 'databricks_apps', 'git_repository']);
const mutableOutcomeTypeSchema = z.enum(['databricks_workspace', 'databricks_apps']);
const outcomeSchema = z
  .object({
    type: outcomeTypeSchema,
  })
  .passthrough();
const mutableOutcomeSchema = z
  .object({
    type: mutableOutcomeTypeSchema,
  })
  .passthrough();
const contextManagerMcpWriteTools = new Set<string>(CONTEXT_MANAGER_MCP_WRITE_TOOLS);

export function isContextManagerMcpWriteTool(toolName: string): boolean {
  return contextManagerMcpWriteTools.has(toolName);
}

function jsonContent(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function updateResponse(session: SessionResponse): UpdateOutcomesResponse {
  if (!session.session_context) {
    throw new Error('Session context not found after outcomes update');
  }

  return {
    success: true,
    outcomes: session.session_context.outcomes,
    session_context: session.session_context,
  };
}

export function createContextManagerMcpServer(handlers: ContextManagerMcpHandlers): McpServer {
  const server = new McpServer({
    name: CONTEXT_MANAGER_MCP_SERVER_ID,
    version: '1.0.0',
  });

  server.registerTool(
    'get_session_context',
    {
      title: 'Get session context',
      description:
        'Return the current ccbricks session_context. This tool is read-only and exposes the session state the UI uses.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const sessionContext = await handlers.getSessionContext();
      return jsonContent({ session_context: sessionContext });
    }
  );

  server.registerTool(
    'get_outcomes',
    {
      title: 'Get session outcomes',
      description: 'Return the current session_context.outcomes array. This tool is read-only.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const sessionContext = await handlers.getSessionContext();
      return jsonContent({ outcomes: sessionContext.outcomes });
    }
  );

  server.registerTool(
    'set_outcomes',
    {
      title: 'Set session outcomes',
      description:
        'Replace session_context.outcomes after validation. Databricks Apps and Workspace outcomes may change; git_repository outcomes must be preserved.',
      inputSchema: {
        outcomes: z.array(outcomeSchema).describe('Complete replacement outcomes array.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ outcomes }) => {
      const session = await handlers.setOutcomes(outcomes);
      return jsonContent(updateResponse(session));
    }
  );

  server.registerTool(
    'upsert_outcome',
    {
      title: 'Upsert session outcome',
      description:
        'Add or replace one Databricks Apps or Workspace outcome by outcome.type after validation. git_repository outcomes cannot be changed through MCP.',
      inputSchema: {
        outcome: mutableOutcomeSchema.describe('Outcome object to add or replace by type.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ outcome }) => {
      const session = await handlers.upsertOutcome(outcome);
      return jsonContent(updateResponse(session));
    }
  );

  server.registerTool(
    'remove_outcome',
    {
      title: 'Remove session outcome',
      description:
        'Remove Databricks Apps or Workspace outcomes matching a type after validation. git_repository outcomes cannot be removed through MCP.',
      inputSchema: {
        type: mutableOutcomeTypeSchema.describe('Outcome type to remove.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ type }) => {
      const session = await handlers.removeOutcome(type);
      return jsonContent(updateResponse(session));
    }
  );

  return server;
}
