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
    opusModel: 'databricks-claude-opus-4-7',
    sonnetModel: 'databricks-claude-sonnet-4-6',
    haikuModel: 'databricks-claude-haiku-4-5',
  }),
}));

/** Helper to create a structured output response from the mock LLM */
function createStructuredResponse(data: { title: string; branch_name: string }) {
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
    it('should return generated title and branch_name from LLM', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: 'React Component Development',
          branch_name: 'react-component-dev',
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
      expect(body).not.toHaveProperty('app_name');
      expect(body.branch_name).toMatch(/^ccbricks\/react-component-dev-[a-f0-9]{8}$/);

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
          branch_name: 'sp-token-test',
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
      expect(body.branch_name).toMatch(/^ccbricks\/sp-token-test-[a-f0-9]{8}$/);
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
          branch_name: 'pat-priority-test',
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
      expect(body.branch_name).toMatch(/^ccbricks\/pat-priority-test-[a-f0-9]{8}$/);

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

    it('should return fallback title and content-based branch_name when LLM returns empty content', async () => {
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
      expect(body.branch_name).toMatch(/^ccbricks\/help-me-with-something-[a-f0-9]{8}$/);
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
      expect(body.branch_name).toMatch(/^ccbricks\/test-message-[a-f0-9]{8}$/);
    });

    it('should fall back to title when generated branch_name has no usable slug', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: 'Valid Title',
          branch_name: '!!!',
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
      expect(body.branch_name).toMatch(/^ccbricks\/valid-title-[a-f0-9]{8}$/);
    });

    it('should truncate generated branch_name when it exceeds 48 characters', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: 'Valid Title',
          branch_name: 'this-is-a-very-long-branch-name-that-exceeds-forty-eight-chars',
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
      expect(body.branch_name).toMatch(
        /^ccbricks\/this-is-a-very-long-branch-name-that-exceeds-for-[a-f0-9]{8}$/
      );
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
      expect(body.branch_name).toMatch(/^ccbricks\/test-message-[a-f0-9]{8}$/);
    });

    it('should clean up LLM artifacts - remove surrounding quotes from title', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: '"Python Data Analysis"',
          branch_name: 'python-data-analysis',
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
      expect(body.branch_name).toMatch(/^ccbricks\/python-data-analysis-[a-f0-9]{8}$/);
    });

    it('should clean up LLM artifacts - remove markdown formatting from title', async () => {
      mockCreate.mockResolvedValue(
        createStructuredResponse({
          title: '**React Component** Development',
          branch_name: 'react-component-dev',
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
          branch_name: 'api-integration',
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
          branch_name: 'python-data-analysis',
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
          branch_name: 'react-component-impl',
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
      expect(body.branch_name).toMatch(/^ccbricks\/react-component-impl-[a-f0-9]{8}$/);

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
          branch_name: 'test-title',
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
