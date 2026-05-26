import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabricksAppsClient } from './databricks-apps-client.js';

const TEST_HOST = 'test-workspace.databricks.com';
const TEST_TOKEN = 'test-token-123';

function createMockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe('DatabricksAppsClient', () => {
  let client: DatabricksAppsClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = DatabricksAppsClient.fromToken(TEST_HOST, TEST_TOKEN);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates an app with explicit compute startup', async () => {
    fetchSpy.mockResolvedValueOnce(createMockResponse(200, { name: 'test-app' }));

    await client.create('test-app', {
      description: 'A test app created from ccbricks.',
      noCompute: false,
    });

    const [url, options] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://test-workspace.databricks.com/api/2.0/apps?no_compute=false'
    );
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({
      name: 'test-app',
      description: 'A test app created from ccbricks.',
    });
    expect((options.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it('starts an app before deployment', async () => {
    fetchSpy.mockResolvedValueOnce(createMockResponse(200, {}));

    await client.start('test-app');

    const [url, options] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://test-workspace.databricks.com/api/2.0/apps/test-app/start'
    );
    expect(options.method).toBe('POST');
  });

  it('ignores 404 when deleting an app', async () => {
    fetchSpy.mockResolvedValueOnce(createMockResponse(404, { error_code: 'NOT_FOUND' }));

    await expect(client.delete('missing-app')).resolves.toBeUndefined();

    const [url, options] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://test-workspace.databricks.com/api/2.0/apps/missing-app');
    expect(options.method).toBe('DELETE');
  });

  it('rejects deployment responses without deployment_id', async () => {
    fetchSpy.mockResolvedValueOnce(createMockResponse(200, { status: { state: 'PENDING' } }));

    await expect(
      client.deploy('test-app', {
        sourceCodePath: '/Workspace/Users/test/app',
        mode: 'SNAPSHOT',
      })
    ).rejects.toThrow("missing 'deployment_id' field");
  });
});
