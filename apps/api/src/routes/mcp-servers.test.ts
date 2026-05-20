import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import configPlugin from '../plugins/config.js';
import requestDecoratorPlugin from '../plugins/request-decorator.js';
import mcpServersRoute from './mcp-servers.js';

describe('mcp-servers route', () => {
  let app: FastifyInstance;
  let originalEnv: NodeJS.ProcessEnv;
  let withUserContext: ReturnType<typeof vi.fn>;
  let values: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.DATABRICKS_HOST = 'test.databricks.com';
    process.env.NODE_ENV = 'test';

    app = Fastify({ logger: false });

    values = vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([
          {
            userId: 'user-123',
            id: 'dbsql',
            name: 'Databricks SQL',
            type: 'http',
            url: 'https://test.databricks.com/api/2.0/mcp/sql',
            headers: null,
            command: null,
            args: null,
            env: null,
            managedType: 'databricks_sql',
            isDisabled: false,
            createdAt: new Date('2026-05-21T00:00:00.000Z'),
            updatedAt: new Date('2026-05-21T00:00:00.000Z'),
          },
        ]),
      })),
    }));

    const tx = {
      insert: vi.fn(() => ({ values })),
    };

    withUserContext = vi.fn(async (_userId: string, callback: (tx: unknown) => Promise<unknown>) =>
      callback(tx)
    );
    app.decorate(
      'withUserContext',
      withUserContext as unknown as FastifyInstance['withUserContext']
    );
  });

  afterEach(async () => {
    process.env = originalEnv;
    await app.close();
  });

  async function registerPlugins() {
    await app.register(configPlugin);
    await app.register(requestDecoratorPlugin);
    await app.register(mcpServersRoute, { prefix: '/api/user' });
  }

  it('creates managed MCP servers inside the user RLS context', async () => {
    await registerPlugins();

    const response = await app.inject({
      method: 'POST',
      url: '/api/user/mcp-servers',
      headers: {
        'x-forwarded-user': 'user-123',
      },
      payload: {
        managed_type: 'databricks_sql',
        name: 'Databricks SQL',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(withUserContext).toHaveBeenCalledWith('user-123', expect.any(Function));
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        id: 'dbsql',
        managedType: 'databricks_sql',
      })
    );
  });
});
