import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import configPlugin from '../plugins/config.js';
import requestDecoratorPlugin from '../plugins/request-decorator.js';
import sessionRoute from './session.js';
import { SessionId } from '../models/session.model.js';
import { getLocalGitDiffSummary } from '../services/local-git.service.js';
import { validatePathWithinBase } from '../utils/path-validation.js';

// Mock session service
vi.mock('../services/session.service.js', () => ({
  SessionValidationError: class SessionValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SessionValidationError';
    }
  },
  createSession: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
  archiveSession: vi.fn(),
  sendMessageToSession: vi.fn(),
  canAbortSession: vi.fn(),
  executeAbort: vi.fn(),
  broadcastToSession: vi.fn(),
}));

// Mock session-events service
vi.mock('../services/session-events.service.js', () => ({
  listSessionEvents: vi.fn(),
  getSessionLastEventId: vi.fn(),
}));

vi.mock('../services/local-git.service.js', () => ({
  getLocalGitDiffSummary: vi.fn(),
}));

vi.mock('../utils/path-validation.js', () => ({
  validatePathWithinBase: vi.fn(async (targetPath: string) => targetPath),
}));

// Mock websocket manager
vi.mock('../services/websocket-manager.service.js', () => ({
  wsManager: {
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    broadcast: vi.fn(),
  },
}));

// Mock session stream hub
vi.mock('../services/session-stream-hub.service.js', () => ({
  encodeSseEvent: vi.fn(() => 'event: message\ndata: {}\n\n'),
  sessionStreamHub: {
    addConnection: vi.fn(() => vi.fn()),
    send: vi.fn(),
  },
}));

// Mock UserContext
vi.mock('../lib/user-context.js', () => ({
  createUserContext: vi.fn(() => ({
    userId: 'test-user',
    userHome: '/home/test-user',
    getAuthProvider: vi.fn().mockReturnValue({
      type: 'oauth-m2m',
      getEnvVars: vi.fn(),
      getToken: vi.fn().mockResolvedValue('test-sp-token'),
    }),
    oboAccessToken: undefined,
  })),
}));

// Test user headers for authentication
const TEST_USER_HEADERS = {
  'x-forwarded-user': 'test-user-id',
  'x-forwarded-preferred-username': 'Test User',
  'x-forwarded-email': 'test@example.com',
};

describe('session route - invalid session ID handling', () => {
  let app: FastifyInstance;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };

    process.env.DATABRICKS_HOST = 'test.databricks.com';
    process.env.NODE_ENV = 'test';

    app = Fastify({
      logger: false,
    });

    vi.clearAllMocks();
  });

  afterEach(async () => {
    process.env = originalEnv;
    await app.close();
  });

  async function registerPlugins() {
    await app.register(configPlugin);
    await app.register(requestDecoratorPlugin);
    await app.register(sessionRoute, { prefix: '/api' });
  }

  describe('GET /sessions/:session_id', () => {
    it('should return 404 for completely invalid session ID format', async () => {
      await registerPlugins();

      const response = await app.inject({
        method: 'GET',
        url: '/api/sessions/aaaaa',
        headers: TEST_USER_HEADERS,
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe('NotFound');
      expect(body.message).toBe('Session not found');
    });

    it('should return 404 for non-v7 UUID format', async () => {
      await registerPlugins();

      // Use a UUIDv4 format (version 4, not 7)
      const response = await app.inject({
        method: 'GET',
        url: '/api/sessions/550e8400-e29b-41d4-a716-446655440000',
        headers: TEST_USER_HEADERS,
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe('NotFound');
      expect(body.message).toBe('Session not found');
    });

    it('should return 404 for empty session ID', async () => {
      await registerPlugins();

      const response = await app.inject({
        method: 'GET',
        url: '/api/sessions/',
        headers: TEST_USER_HEADERS,
      });

      // Empty path segment results in 404 route not found
      expect(response.statusCode).toBe(404);
    });

    it('should accept valid session UUIDv7 format', async () => {
      const { getSession } = await import('../services/session.service.js');
      const mockGetSession = vi.mocked(getSession);
      mockGetSession.mockResolvedValue(null); // Session doesn't exist in DB

      await registerPlugins();

      const validSessionId = new SessionId().toString();
      const response = await app.inject({
        method: 'GET',
        url: `/api/sessions/${validSessionId}`,
        headers: TEST_USER_HEADERS,
      });

      // Should return 404 because session doesn't exist (not because ID is invalid)
      expect(response.statusCode).toBe(404);
      expect(mockGetSession).toHaveBeenCalled();
    });

    it('should return 401 when user is not authenticated', async () => {
      await registerPlugins();

      const response = await app.inject({
        method: 'GET',
        url: '/api/sessions/aaaaa',
        // No headers = no user
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('GET /sessions/:session_id/git-diff', () => {
    it('should return local git diff using source revision and outcome branch', async () => {
      const { getSession } = await import('../services/session.service.js');
      const sessionId = new SessionId();
      vi.mocked(getSession).mockResolvedValue({
        id: sessionId.toString(),
        title: 'Test',
        session_status: 'idle',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        session_context: {
          cwd: '/tmp/ccbricks/sessions/test-session',
          model: 'sonnet',
          sources: [
            {
              type: 'git_repository',
              url: 'https://github.com/acme/widgets',
              revision: 'refs/heads/main',
              sparse_checkout_paths: [],
              allow_unrestricted_git_push: true,
            },
          ],
          outcomes: [
            {
              type: 'git_repository',
              git_info: { type: 'github', repo: 'acme/widgets', branches: ['ccbricks/test'] },
            },
          ],
        },
      });
      vi.mocked(getLocalGitDiffSummary).mockResolvedValue({
        ahead_by: 2,
        behind_by: 0,
        total_commits: 2,
        additions: 9,
        deletions: 1,
      });

      await registerPlugins();
      const response = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId.toString()}/git-diff`,
        headers: TEST_USER_HEADERS,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ additions: 9, deletions: 1 });
      expect(validatePathWithinBase).toHaveBeenCalledWith(
        '/tmp/ccbricks/sessions/test-session',
        expect.stringContaining('/sessions')
      );
      expect(getLocalGitDiffSummary).toHaveBeenCalledWith(
        '/tmp/ccbricks/sessions/test-session',
        'main',
        'ccbricks/test'
      );
    });
  });

  describe('POST /sessions', () => {
    it('should return 400 for session validation errors', async () => {
      const { createSession, SessionValidationError } =
        await import('../services/session.service.js');
      vi.mocked(createSession).mockRejectedValue(
        new SessionValidationError('Only one git repository source is supported')
      );

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: TEST_USER_HEADERS,
        payload: {
          events: [
            {
              type: 'event',
              data: {
                uuid: crypto.randomUUID(),
                session_id: 'pending',
                type: 'user',
                parent_tool_use_id: null,
                message: { role: 'user', content: 'hello' },
              },
            },
          ],
          session_context: {
            model: 'sonnet',
            sources: [],
            outcomes: [],
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'BadRequest',
        message: 'Only one git repository source is supported',
        statusCode: 400,
      });
    });
  });

  describe('PATCH /sessions/:session_id', () => {
    it('should return 404 for invalid session ID format', async () => {
      await registerPlugins();

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/sessions/invalid-id',
        headers: TEST_USER_HEADERS,
        payload: { title: 'New Title' },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe('NotFound');
      expect(body.message).toBe('Session not found');
    });
  });

  describe('POST /sessions/:session_id/archive', () => {
    it('should return 404 for invalid session ID format', async () => {
      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/not-a-valid-id/archive',
        headers: TEST_USER_HEADERS,
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe('NotFound');
      expect(body.message).toBe('Session not found');
    });
  });

  describe('GET /sessions/:session_id/events', () => {
    it('should return 404 for invalid session ID format', async () => {
      await registerPlugins();

      const response = await app.inject({
        method: 'GET',
        url: '/api/sessions/random-string/events',
        headers: TEST_USER_HEADERS,
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe('NotFound');
      expect(body.message).toBe('Session not found');
    });

    it('should return 404 for special characters in session ID', async () => {
      await registerPlugins();

      const response = await app.inject({
        method: 'GET',
        url: '/api/sessions/session_!@%23$%25/events',
        headers: TEST_USER_HEADERS,
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe('NotFound');
    });
  });
});
