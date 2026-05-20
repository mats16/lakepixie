import { FastifyPluginAsync } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import type {
  McpServerCreateRequest,
  McpServerUpdateRequest,
  McpServerRecord,
  McpServerListResponse,
  McpServerType,
  ManagedMcpType,
  ApiError,
} from '@repo/types';
import { mcpServers, type InsertMcpServer } from '../db/schema.js';

const VALID_TYPES: McpServerType[] = ['stdio', 'http', 'sse'];
import { sanitizeToIdSegment } from '../utils/sanitize.js';

const VALID_MANAGED_TYPES: ManagedMcpType[] = [
  'databricks_sql',
  'databricks_genie',
  'databricks_vector_search',
  'unity_ai_gateway',
];
/** 小文字英数とアンダースコアのみ、連続アンダースコア禁止 */
const VALID_ID_PATTERN = /^[a-z0-9]+(_[a-z0-9]+)*$/;

function toRecord(row: typeof mcpServers.$inferSelect): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type as McpServerType,
    managed_type: (row.managedType as ManagedMcpType) ?? undefined,
    url: row.url ?? undefined,
    headers: (row.headers as Record<string, string>) ?? undefined,
    command: row.command ?? undefined,
    args: (row.args as string[]) ?? undefined,
    env: (row.env as Record<string, string>) ?? undefined,
    is_disabled: row.isDisabled,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const mcpServersRoute: FastifyPluginAsync = async fastify => {
  // ユーザーの MCP サーバー一覧
  fastify.get<{ Reply: McpServerListResponse | ApiError }>(
    '/mcp-servers',
    async (request, reply) => {
      const { user } = request.ctx!;
      if (!user.id) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'User ID not found in request context',
          statusCode: 401,
        });
      }

      const rows = await fastify.withUserContext(user.id, async tx =>
        tx
          .select()
          .from(mcpServers)
          .where(eq(mcpServers.userId, user.id))
          .orderBy(desc(mcpServers.createdAt))
      );

      return reply.send({
        mcp_servers: rows.map(row => toRecord(row)),
      });
    }
  );

  // サーバー登録
  fastify.post<{
    Body: McpServerCreateRequest;
    Reply: McpServerRecord | ApiError;
  }>('/mcp-servers', async (request, reply) => {
    const { user } = request.ctx!;
    if (!user.id) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'User ID not found in request context',
        statusCode: 401,
      });
    }

    const { managed_type } = request.body;

    // --- Managed MCP サーバー登録 ---
    if (managed_type) {
      if (!VALID_MANAGED_TYPES.includes(managed_type)) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: `managed_type must be one of: ${VALID_MANAGED_TYPES.join(', ')}`,
          statusCode: 400,
        });
      }

      if (managed_type === 'databricks_vector_search') {
        return reply.status(501).send({
          error: 'NotImplemented',
          message: 'Vector Search MCP is not yet available',
          statusCode: 501,
        });
      }

      const { name } = request.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'name is required',
          statusCode: 400,
        });
      }

      const databricksHost = fastify.config.DATABRICKS_HOST;
      let generatedId: string;
      let generatedUrl: string;

      if (managed_type === 'databricks_sql') {
        generatedId = 'dbsql';
        generatedUrl = `https://${databricksHost}/api/2.0/mcp/sql`;
      } else if (managed_type === 'unity_ai_gateway') {
        // Unity AI Gateway: id に connection name を渡す
        const connectionName = request.body.id;
        if (!connectionName || typeof connectionName !== 'string' || !connectionName.trim()) {
          return reply.status(400).send({
            error: 'BadRequest',
            message: 'id (connection name) is required for unity_ai_gateway type',
            statusCode: 400,
          });
        }
        const trimmedName = connectionName.trim();
        const sanitized = sanitizeToIdSegment(trimmedName);
        if (!sanitized) {
          return reply.status(400).send({
            error: 'BadRequest',
            message: `Connection name "${trimmedName}" cannot be converted to a valid ID`,
            statusCode: 400,
          });
        }
        generatedId = `external_${sanitized}`;
        generatedUrl = `https://${databricksHost}/api/2.0/mcp/external/${trimmedName}`;
      } else {
        // Genie Space: id に space_id を渡す
        const genieSpaceId = request.body.id;
        if (!genieSpaceId || typeof genieSpaceId !== 'string' || !genieSpaceId.trim()) {
          return reply.status(400).send({
            error: 'BadRequest',
            message: 'id (genie_space_id) is required for databricks_genie type',
            statusCode: 400,
          });
        }
        const trimmedSpaceId = genieSpaceId.trim();
        generatedId = `genie_${trimmedSpaceId}`;
        generatedUrl = `https://${databricksHost}/api/2.0/mcp/genie/${trimmedSpaceId}`;
      }

      const rows = (await fastify.withUserContext(user.id, async tx =>
        tx
          .insert(mcpServers)
          .values({
            userId: user.id,
            id: generatedId,
            name: name.trim(),
            type: 'http',
            url: generatedUrl,
            managedType: managed_type,
          })
          .onConflictDoNothing({ target: [mcpServers.userId, mcpServers.id] })
          .returning()
      )) as Array<typeof mcpServers.$inferSelect>;

      if (rows.length === 0) {
        return reply.status(409).send({
          error: 'Conflict',
          message: `MCP server "${generatedId}" is already registered`,
          statusCode: 409,
        });
      }

      return reply.status(201).send(toRecord(rows[0]));
    }

    // --- Custom MCP サーバー登録 ---
    const { id, name, type, url, headers, command, args, env } = request.body;

    if (!id || typeof id !== 'string' || !id.trim()) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'id is required',
        statusCode: 400,
      });
    }

    if (!VALID_ID_PATTERN.test(id.trim())) {
      return reply.status(400).send({
        error: 'BadRequest',
        message:
          'id must contain only lowercase alphanumeric characters and single underscores (no consecutive underscores)',
        statusCode: 400,
      });
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'name is required',
        statusCode: 400,
      });
    }

    if (!type || !VALID_TYPES.includes(type)) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: `type must be one of: ${VALID_TYPES.join(', ')}`,
        statusCode: 400,
      });
    }

    if ((type === 'http' || type === 'sse') && (!url || !url.trim())) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'url is required for http/sse type',
        statusCode: 400,
      });
    }

    if (type === 'stdio' && (!command || !command.trim())) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'command is required for stdio type',
        statusCode: 400,
      });
    }

    const trimmedId = id.trim();
    const rows = (await fastify.withUserContext(user.id, async tx =>
      tx
        .insert(mcpServers)
        .values({
          userId: user.id,
          id: trimmedId,
          name: name.trim(),
          type,
          url: url?.trim() || null,
          headers: headers ?? null,
          command: command?.trim() || null,
          args: args ?? null,
          env: env ?? null,
        })
        .onConflictDoNothing({ target: [mcpServers.userId, mcpServers.id] })
        .returning()
    )) as Array<typeof mcpServers.$inferSelect>;

    if (rows.length === 0) {
      return reply.status(409).send({
        error: 'Conflict',
        message: `MCP server "${trimmedId}" is already registered`,
        statusCode: 409,
      });
    }

    return reply.status(201).send(toRecord(rows[0]));
  });

  // サーバー更新
  fastify.patch<{
    Params: { id: string };
    Body: McpServerUpdateRequest;
    Reply: McpServerRecord | ApiError;
  }>('/mcp-servers/:id', async (request, reply) => {
    const { user } = request.ctx!;
    if (!user.id) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'User ID not found in request context',
        statusCode: 401,
      });
    }

    const { id } = request.params;
    const { name, type, url, headers, command, args, env, is_disabled } = request.body;

    const updates: Partial<InsertMcpServer> = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'name must be a non-empty string',
          statusCode: 400,
        });
      }
      updates.name = name.trim();
    }

    if (type !== undefined) {
      if (!VALID_TYPES.includes(type)) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: `type must be one of: ${VALID_TYPES.join(', ')}`,
          statusCode: 400,
        });
      }
      updates.type = type;
    }

    if (url !== undefined) updates.url = url?.trim() || null;
    if (headers !== undefined) updates.headers = headers ?? null;
    if (command !== undefined) updates.command = command?.trim() || null;
    if (args !== undefined) updates.args = args ?? null;
    if (env !== undefined) updates.env = env ?? null;
    if (is_disabled !== undefined) updates.isDisabled = is_disabled;

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'No fields to update',
        statusCode: 400,
      });
    }

    const [row] = await fastify.withUserContext(user.id, async tx =>
      tx
        .update(mcpServers)
        .set(updates)
        .where(and(eq(mcpServers.userId, user.id), eq(mcpServers.id, id)))
        .returning()
    );

    if (!row) {
      return reply.status(404).send({
        error: 'NotFound',
        message: 'MCP server not found',
        statusCode: 404,
      });
    }

    return reply.send(toRecord(row));
  });

  // サーバー削除
  fastify.delete<{
    Params: { id: string };
    Reply: { success: true } | ApiError;
  }>('/mcp-servers/:id', async (request, reply) => {
    const { user } = request.ctx!;
    if (!user.id) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'User ID not found in request context',
        statusCode: 401,
      });
    }

    const { id } = request.params;

    const deleted = await fastify.withUserContext(user.id, async tx =>
      tx
        .delete(mcpServers)
        .where(and(eq(mcpServers.userId, user.id), eq(mcpServers.id, id)))
        .returning({ id: mcpServers.id })
    );

    if (deleted.length === 0) {
      return reply.status(404).send({
        error: 'NotFound',
        message: 'MCP server not found',
        statusCode: 404,
      });
    }

    return reply.send({ success: true });
  });
};

export default mcpServersRoute;
