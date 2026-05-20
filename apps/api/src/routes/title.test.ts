import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import configPlugin from '../plugins/config.js';
import requestDecoratorPlugin from '../plugins/request-decorator.js';
import titleRoute from './title.js';

// Create mock function for chat.completions.create
const mockCreate = vi.fn();

// Mock OpenAI module
vi.mock('openai', () => {
  const MockOpenAI = function (this: { chat: { completions: { create: MockInstance } } }) {
    this.chat = {
      completions: {
        create: mockCreate,
      },
    };
  };
  return { default: MockOpenAI };
});

// Mock typeid-js for deterministic fallback
vi.mock('typeid-js', () => ({
  typeid: vi.fn(() => ({
    toString: () => '01abc2def3ghi4jkl5mno6pqrs',
  })),
}));

// Mock UserContext
const mockGetAuthProvider = vi.fn();

vi.mock('../lib/user-context.js', () => ({
  createUserContext: vi.fn(() => ({
    userId: 'test-user',
    userHome: '/home/test-user',
    getAuthProvider: mockGetAuthProvider,
    oboAccessToken: undefined,
  })),
}));

// Mock admin.service to avoid DB dependency
vi.mock('../services/admin.service.js', () => ({
  getModelSettings: vi.fn().mockResolvedValue({
    opusModel: 'databricks-claude-opus-4-6',
    sonnetModel: 'databricks-claude-sonnet-4-6',
    haikuModel: 'databricks-claude-haiku-4-5',
  }),
}));

/** Helper to create a structured output response from the mock LLM */
function createStructuredResponse(data: { title: string; app_name: string }) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify(data),
        },
      },
    ],
  };
}

describe('title route', () => {
  let app: FastifyInstance;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Set required environment variables
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    process.env.DATABRICKS_HOST = 'test.databricks.com';
    process.env.NODE_ENV = 'test';

    // Create a fresh Fastify instance for each test
    app = Fastify({
      logger: false,
    });

    // Reset mocks
    vi.clearAllMocks();

    // Default: return SP auth provider
    mockGetAuthProvider.mockReturnValue({
      type: 'oauth-m2m',
      getEnvVars: vi.fn(),
      getToken: vi.fn().mockResolvedValue('test-sp-token'),
    });
  });

  afterEach(async () => {
    // Restore original environment
    process.env = originalEnv;

    // Close Fastify instance
    await app.close();
  });

  async function registerPlugins() {
    await app.register(configPlugin);
    await app.register(requestDecoratorPlugin);

    await app.register(titleRoute, { prefix: '/api' });
  }

  describe('POST /generate_title', () => {
    it('should return generated title and app_name from LLM', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: 'React Component Development',
          app_name: 'react-component-dev',
        })
      );

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Help me create a React component',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('React Component Development');
      expect(body.app_name).toBe('react-component-dev');
      expect(body.branch_name).toBe('ccbricks/hobe-piyp-fuga');

      // Verify OpenAI was called with response_format
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'databricks-claude-haiku-4-5',
          max_tokens: 150,
          response_format: expect.objectContaining({
            type: 'json_schema',
            json_schema: expect.objectContaining({
              name: 'title_response',
              strict: true,
            }),
          }),
          messages: [
            {
              role: 'user',
              content: expect.stringContaining('Help me create a React component'),
            },
          ],
        })
      );
    });

    it('should return 400 with ApiError when first_session_message is missing', async () => {
      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('ValidationError');
      expect(body.message).toBe('first_session_message is required and must be a non-empty string');
      expect(body.statusCode).toBe(400);
    });

    it('should return 400 with ApiError when first_session_message is empty string', async () => {
      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: '',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('ValidationError');
    });

    it('should return 400 with ApiError when first_session_message is not a string', async () => {
      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 123,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('ValidationError');
    });

    it('should return 401 when no token is available (SP token fetch fails)', async () => {
      // Mock: SP auth provider that throws on getToken
      mockGetAuthProvider.mockReturnValue({
        type: 'oauth-m2m',
        getEnvVars: vi.fn(),
        getToken: vi.fn().mockRejectedValue(new Error('Service Principal token is not available')),
      });

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Help me with Python',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Access token is required (Service Principal)');
    });

    it('should use SP token when PAT is not available', async () => {
      // Mock: SP auth provider
      mockGetAuthProvider.mockReturnValue({
        type: 'oauth-m2m',
        getEnvVars: vi.fn(),
        getToken: vi.fn().mockResolvedValue('test-sp-token'),
      });

      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: 'SP Token Test',
          app_name: 'sp-token-test',
        })
      );

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Test with SP token',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('SP Token Test');
      expect(body.app_name).toBe('sp-token-test');
      expect(body.branch_name).toBe('ccbricks/hobe-piyp-fuga');
    });

    it('should use PAT auth provider when available', async () => {
      // Mock: SP auth provider (PAT is no longer used)
      const mockAccessToken = vi.fn().mockResolvedValue('test-sp-token');
      mockGetAuthProvider.mockReturnValue({
        type: 'oauth-m2m',
        getEnvVars: vi.fn(),
        getToken: mockAccessToken,
      });

      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: 'PAT Priority Test',
          app_name: 'pat-priority-test',
        })
      );

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Test PAT priority',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('PAT Priority Test');
      expect(body.app_name).toBe('pat-priority-test');
      expect(body.branch_name).toBe('ccbricks/hobe-piyp-fuga');

      // Verify that getToken was called
      expect(mockAccessToken).toHaveBeenCalled();
    });

    it('should return 500 with ApiError when LLM call fails', async () => {
      mockCreate.mockRejectedValue(new Error('API error'));

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Help me with Python',
        },
      });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body.error).toBe('InternalServerError');
      expect(body.message).toBe('Failed to generate title');
      expect(body.statusCode).toBe(500);
    });

    it('should return fallback title and typeid app_name when LLM returns empty content', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: '',
            },
          },
        ],
      });

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Help me with something',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('General coding session');
      // Fallback uses typeid mock
      expect(body.app_name).toBe('01abc2def3ghi4jkl5mno6pqrs');
      expect(body.branch_name).toBe('ccbricks/hobe-piyp-fuga');
    });

    it('should return fallback when LLM returns null choices', async () => {
      mockCreate.mockResolvedValue({
        choices: [],
      });

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Test message',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('General coding session');
      expect(body.app_name).toBe('01abc2def3ghi4jkl5mno6pqrs');
    });

    it('should return fallback app_name when LLM returns invalid app_name', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: 'Valid Title',
          app_name: 'INVALID_APP_NAME!!',
        })
      );

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Test message',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('Valid Title');
      expect(body.app_name).toBe('01abc2def3ghi4jkl5mno6pqrs');
    });

    it('should return fallback app_name when app_name exceeds 26 characters', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: 'Valid Title',
          app_name: 'this-is-a-very-long-app-name-that-exceeds-thirty-chars',
        })
      );

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Test message',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('Valid Title');
      expect(body.app_name).toBe('01abc2def3ghi4jkl5mno6pqrs');
    });

    it('should return fallback when LLM returns invalid JSON', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: 'not valid json',
            },
          },
        ],
      });

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Test message',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('General coding session');
      expect(body.app_name).toBe('01abc2def3ghi4jkl5mno6pqrs');
    });

    it('should clean up LLM artifacts - remove surrounding quotes from title', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: '"Python Data Analysis"',
          app_name: 'python-data-analysis',
        })
      );

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Analyze this CSV file',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('Python Data Analysis');
      expect(body.app_name).toBe('python-data-analysis');
    });

    it('should clean up LLM artifacts - remove markdown formatting from title', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: '**React Component** Development',
          app_name: 'react-component-dev',
        })
      );

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Create a React component',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('React Component Development');
    });

    it('should clean up LLM artifacts - remove backticks from title', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: '`API Integration`',
          app_name: 'api-integration',
        })
      );

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Help me integrate an API',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('API Integration');
    });

    it('should trim whitespace from generated title', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: '  Python Data Analysis  ',
          app_name: 'python-data-analysis',
        })
      );

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Analyze this CSV file',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('Python Data Analysis');
    });

    it('should handle Japanese messages', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: 'React Component Implementation',
          app_name: 'react-component-impl',
        })
      );

      await registerPlugins();

      const response = await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Reactコンポーネントを作成してください',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('React Component Implementation');
      expect(body.app_name).toBe('react-component-impl');

      // Verify the Japanese message was passed to the LLM
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining('Reactコンポーネントを作成してください'),
            }),
          ]),
        })
      );
    });

    it('should use correct model from config', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: 'Test Title',
          app_name: 'test-title',
        })
      );

      await registerPlugins();

      await app.inject({
        method: 'POST',
        url: '/api/generate_title',
        payload: {
          first_session_message: 'Test message',
        },
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'databricks-claude-haiku-4-5',
        })
      );
    });
  });
});
