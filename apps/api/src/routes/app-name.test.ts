import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import configPlugin from '../plugins/config.js';
import requestDecoratorPlugin from '../plugins/request-decorator.js';
import appNameRoute from './app-name.js';

const mockCreate = vi.fn();
const mockGetAuthProvider = vi.fn();

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

vi.mock('../lib/user-context.js', () => ({
  createUserContext: vi.fn(() => ({
    userId: 'test-user',
    userHome: '/home/test-user',
    getAuthProvider: mockGetAuthProvider,
    oboAccessToken: undefined,
  })),
}));

vi.mock('../services/admin.service.js', () => ({
  getModelSettings: vi.fn().mockResolvedValue({
    opusModel: 'databricks-claude-opus-4-7',
    sonnetModel: 'databricks-claude-sonnet-4-6',
    haikuModel: 'databricks-claude-haiku-4-5',
  }),
}));

describe('app-name route', () => {
  let app: FastifyInstance;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.DATABRICKS_HOST = 'test.databricks.com';
    process.env.NODE_ENV = 'test';
    app = Fastify({ logger: false });
    vi.clearAllMocks();
    mockGetAuthProvider.mockReturnValue({
      type: 'oauth-m2m',
      getEnvVars: vi.fn(),
      getToken: vi.fn().mockResolvedValue('test-sp-token'),
    });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await app.close();
  });

  async function registerPlugins() {
    await app.register(configPlugin);
    await app.register(requestDecoratorPlugin);
    await app.register(appNameRoute, { prefix: '/api' });
  }

  it('returns a generated app name from caller-provided context', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ name: 'Shiny Hello World' }),
          },
        },
      ],
    });
    await registerPlugins();

    const response = await app.inject({
      method: 'POST',
      url: '/api/generate_app_name',
      payload: { context: 'Session title: Shiny Hello World' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toMatch(/^shiny-hello-world-[a-f0-9]{8}$/);
  });

  it('rejects empty context', async () => {
    await registerPlugins();

    const response = await app.inject({
      method: 'POST',
      url: '/api/generate_app_name',
      payload: { context: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'ValidationError',
      message: 'context is required and must be a non-empty string',
    });
  });
});
