import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { updateAppSettings } from './admin.service.js';
import {
  listTelemetryCatalogs,
  listTelemetrySchemas,
  setupTelemetry,
  TelemetrySetupValidationError,
} from './telemetry-setup.service.js';

vi.mock('../lib/databricks-auth.js', () => ({
  getAuthProvider: () => ({
    getToken: vi.fn().mockResolvedValue('sp-token'),
  }),
}));

vi.mock('./admin.service.js', () => ({
  updateAppSettings: vi.fn(),
}));

function createFastify(overrides: Partial<FastifyInstance['config']> = {}): FastifyInstance {
  return {
    config: {
      DATABRICKS_HOST: 'test.databricks.com',
      DATABRICKS_APP_NAME: 'ccbricks-app',
      DATABRICKS_CLIENT_ID: 'service-principal-client-id',
      ...overrides,
    },
  } as FastifyInstance;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('telemetry setup service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists catalogs across pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          catalogs: [
            { name: 'main', catalog_type: 'MANAGED_CATALOG' },
            { name: '__databricks_internal', catalog_type: 'INTERNAL_CATALOG' },
            { name: 'system', catalog_type: 'SYSTEM_CATALOG' },
            { name: 'shared_catalog', catalog_type: 'DELTASHARING_CATALOG' },
            { name: 'foreign_catalog', catalog_type: 'FOREIGN_CATALOG' },
            { name: 'legacy_catalog_without_type' },
          ],
          next_page_token: 'next',
        })
      )
      .mockResolvedValueOnce(jsonResponse({ catalogs: [{ name: 'samples' }] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listTelemetryCatalogs(createFastify())).resolves.toEqual({
      catalogs: ['main'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('page_token=next');
  });

  it('lists schemas for a catalog', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        schemas: [{ name: 'default' }, { name: 'observability' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listTelemetrySchemas(createFastify(), 'main')).resolves.toEqual({
      schemas: ['default', 'observability'],
    });

    expect(fetchMock.mock.calls[0][0]).toContain('catalog_name=main');
  });

  it('sets up telemetry for an existing catalog and schema', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(
        jsonResponse({
          uc_table_prefix: {
            catalog_name: 'main',
            schema_name: 'default',
            table_prefix: 'ccbricks',
            metrics_table_name: 'main.default.ccbricks_otel_metrics',
            logs_table_name: 'main.default.ccbricks_otel_logs',
            spans_table_name: 'main.default.ccbricks_otel_spans',
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ experiment_id: '123' }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      setupTelemetry(
        createFastify(),
        {
          catalog_name: 'main',
          schema_name: 'default',
          table_prefix: 'ccbricks',
          experiment_name: 'otel',
        },
        'obo-token'
      )
    ).resolves.toMatchObject({
      otel_metrics_table_name: 'main.default.ccbricks_otel_metrics',
      otel_logs_table_name: 'main.default.ccbricks_otel_logs',
      otel_traces_table_name: 'main.default.ccbricks_otel_spans',
      experiment_id: '123',
      experiment_path: '/Shared/ccbricks-app/experiments/otel',
    });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/2.1/unity-catalog/permissions/catalog/main');
    expect(fetchMock.mock.calls[1][0]).toContain(
      '/api/2.1/unity-catalog/permissions/schema/main.default'
    );
    expect(fetchMock.mock.calls[2][0]).toContain('/api/5.0/mlflow/tracing/locations');
    expect(fetchMock.mock.calls[3][0]).toContain('/api/2.0/workspace/mkdirs');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body as string)).toEqual({
      path: '/Shared/ccbricks-app/experiments',
    });
    expect(fetchMock.mock.calls[4][0]).toContain('/api/2.0/mlflow/experiments/create');
    expect(fetchMock.mock.calls[5][0]).toContain(
      '/api/5.0/mlflow/experiments/123/trace-location:link'
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      changes: [
        {
          principal: 'service-principal-client-id',
          add: ['USE_SCHEMA', 'CREATE_TABLE'],
        },
      ],
    });
    expect(updateAppSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        otel_metrics_table_name: 'main.default.ccbricks_otel_metrics',
        otel_logs_table_name: 'main.default.ccbricks_otel_logs',
        otel_traces_table_name: 'main.default.ccbricks_otel_spans',
      })
    );
  });

  it('rejects missing app name, missing obo token, and slash in experiment name', async () => {
    await expect(
      setupTelemetry(
        createFastify({ DATABRICKS_APP_NAME: '' }),
        {
          catalog_name: 'main',
          schema_name: 'default',
          table_prefix: 'ccbricks',
          experiment_name: 'otel',
        },
        'obo-token'
      )
    ).rejects.toBeInstanceOf(TelemetrySetupValidationError);

    await expect(
      setupTelemetry(createFastify(), {
        catalog_name: 'main',
        schema_name: 'default',
        table_prefix: 'ccbricks',
        experiment_name: 'otel',
      })
    ).rejects.toThrow('OBO access token is required');

    await expect(
      setupTelemetry(
        createFastify(),
        {
          catalog_name: 'main',
          schema_name: 'default',
          table_prefix: 'ccbricks',
          experiment_name: 'folder/otel',
        },
        'obo-token'
      )
    ).rejects.toBeInstanceOf(TelemetrySetupValidationError);
  });

  it('does not update settings when privilege grant fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'grant denied' }, 403));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      setupTelemetry(
        createFastify(),
        {
          catalog_name: 'main',
          schema_name: 'default',
          table_prefix: 'ccbricks',
          experiment_name: 'otel',
        },
        'obo-token'
      )
    ).rejects.toThrow('grant denied');

    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it('continues when the experiment parent directory already exists', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ uc_table_prefix: {} }))
      .mockResolvedValueOnce(jsonResponse({ error_code: 'RESOURCE_ALREADY_EXISTS' }, 409))
      .mockResolvedValueOnce(jsonResponse({ experiment_id: '123' }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      setupTelemetry(
        createFastify(),
        {
          catalog_name: 'main',
          schema_name: 'default',
          table_prefix: 'ccbricks',
          experiment_name: 'otel',
        },
        'obo-token'
      )
    ).resolves.toMatchObject({
      experiment_id: '123',
      experiment_path: '/Shared/ccbricks-app/experiments/otel',
    });
  });

  it('does not update settings when experiment link fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ uc_table_prefix: {} }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ experiment_id: '123' }))
      .mockResolvedValueOnce(jsonResponse({ message: 'link failed' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      setupTelemetry(
        createFastify(),
        {
          catalog_name: 'main',
          schema_name: 'default',
          table_prefix: 'ccbricks',
          experiment_name: 'otel',
        },
        'obo-token'
      )
    ).rejects.toThrow('link failed');

    expect(updateAppSettings).not.toHaveBeenCalled();
  });
});
