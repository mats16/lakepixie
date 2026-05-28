import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import configPlugin from '../plugins/config.js';
import requestDecoratorPlugin from '../plugins/request-decorator.js';
import sessionAppRoute from './session-app.js';
import { SessionId } from '../models/session.model.js';
import { createDatabricksAppForSession } from '../services/session.service.js';

vi.mock('../services/session.service.js', () => {
  class SessionAppCreateError extends Error {
    constructor(
      public readonly statusCode: 400 | 401 | 404 | 409 | 500,
      message: string
    ) {
      super(message);
      this.name = 'SessionAppCreateError';
    }
  }

  return {
    createDatabricksAppForSession: vi.fn(),
    SessionAppCreateError,
  };
});

vi.mock('../lib/databricks-auth.js', () => ({
  getAuthProvider: vi.fn().mockReturnValue({
    type: 'oauth-m2m',
    getEnvVars: vi.fn(() => ({ DATABRICKS_HOST: 'https://test.databricks.com' })),
    getToken: vi.fn().mockResolvedValue('test-sp-token'),
  }),
}));

const TEST_USER_HEADERS = {
  'x-forwarded-user': 'test-user-id',
  'x-forwarded-preferred-username': 'Test User',
  'x-forwarded-email': 'test@example.com',
  'x-forwarded-access-token': 'test-obo-token',
};

describe('session app route', () => {
  let app: FastifyInstance;
  let originalEnv: NodeJS.ProcessEnv;
  let tempDir: string;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    process.env.DATABRICKS_HOST = 'test.databricks.com';
    process.env.NODE_ENV = 'test';
    tempDir = await mkdtemp(join(tmpdir(), 'ccbricks-session-app-test-'));
    app = Fastify({ logger: false });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    process.env = originalEnv;
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function registerPlugins() {
    await app.register(configPlugin);
    app.config.CCBRICKS_BASE_DIR = tempDir;
    await app.register(requestDecoratorPlugin);
    await app.register(sessionAppRoute, { prefix: '/api' });
  }

  it('passes request body context to the create service', async () => {
    const sessionId = new SessionId();
    vi.mocked(createDatabricksAppForSession).mockResolvedValue({
      session: {
        id: sessionId.toString(),
        title: 'Test',
        session_status: 'running',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        session_context: null,
      },
      name: 'shiny-hello-world-1234abcd',
      description: 'A simple Shiny app.',
      workspace_path: '/Workspace/Users/test/app',
      sp_permission_status: 'granted',
      notification_status: 'sent',
    });
    await registerPlugins();

    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId.toString()}/app/create`,
      headers: TEST_USER_HEADERS,
      payload: { context: 'Session title: Shiny Hello World' },
    });

    expect(response.statusCode).toBe(201);
    expect(createDatabricksAppForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-id',
        sessionId: expect.any(SessionId),
        context: 'Session title: Shiny Hello World',
      })
    );
  });
});
