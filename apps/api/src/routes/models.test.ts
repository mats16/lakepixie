import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import configPlugin from '../plugins/config.js';
import modelsRoute from './models.js';

const { mockGetAuthProvider, mockGetToken } = vi.hoisted(() => {
  const getToken = vi.fn();
  return {
    mockGetToken: getToken,
    mockGetAuthProvider: vi.fn(() => ({
      type: 'oauth-m2m',
      getEnvVars: vi.fn(),
      getToken,
    })),
  };
});

vi.mock('../lib/databricks-auth.js', () => ({
  getAuthProvider: mockGetAuthProvider,
}));

describe('models route', () => {
  let app: FastifyInstance;
  let originalEnv: NodeJS.ProcessEnv;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.DATABRICKS_HOST = 'test.databricks.com';
    process.env.NODE_ENV = 'test';

    app = Fastify({ logger: false });

    vi.clearAllMocks();
    mockGetToken.mockResolvedValue('test-sp-token');

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
    await app.close();
  });

  async function registerPlugins() {
    await app.register(configPlugin);
    await app.register(modelsRoute, { prefix: '/api' });
  }

  it('uses the service principal token to list serving endpoints', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        endpoints: [
          { name: 'databricks-claude-sonnet-4-6' },
          { name: 'databricks-claude-opus-4-6' },
          { name: 'unrelated-model' },
          { name: 'databricks-claude-haiku-4-5' },
        ],
      }),
    });

    await registerPlugins();

    const response = await app.inject({
      method: 'GET',
      url: '/api/models',
      headers: {
        'x-forwarded-access-token': 'obo-token-that-should-not-be-used',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://test.databricks.com/api/2.0/serving-endpoints',
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer test-sp-token',
        },
      }
    );
    expect(response.json()).toEqual({
      opus: ['databricks-claude-opus-4-6'],
      sonnet: ['databricks-claude-sonnet-4-6'],
      haiku: ['databricks-claude-haiku-4-5'],
    });
  });

  it('returns 401 when the service principal token is unavailable', async () => {
    mockGetToken.mockRejectedValue(new Error('Service Principal token is not available'));

    await registerPlugins();

    const response = await app.inject({
      method: 'GET',
      url: '/api/models',
    });

    expect(response.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: 'Unauthorized',
      message: 'Access token is required (Service Principal)',
      statusCode: 401,
    });
  });

  it('returns 502 when serving endpoint fetch fails unexpectedly', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await registerPlugins();

    const response = await app.inject({
      method: 'GET',
      url: '/api/models',
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: 'UpstreamError',
      message: 'Failed to reach Databricks serving endpoints',
      statusCode: 502,
    });
  });
});
