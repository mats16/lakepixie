import type { FastifyInstance } from 'fastify';
import type {
  TelemetryCatalogListResponse,
  TelemetrySchemaListResponse,
  TelemetrySetupRequest,
  TelemetrySetupResponse,
} from '@repo/types';
import { getAuthProvider } from '../lib/databricks-auth.js';
import { updateAppSettings } from './admin.service.js';

interface DatabricksErrorResponse {
  error_code?: string;
  message?: string;
}

interface CatalogsResponse {
  catalogs?: Array<{
    name?: string;
    catalog_type?: string;
    provider_name?: string;
    share_name?: string;
  }>;
  next_page_token?: string;
}

interface SchemasResponse {
  schemas?: Array<{ name?: string }>;
  next_page_token?: string;
}

interface UcTablePrefixResponse {
  catalog_name?: string;
  schema_name?: string;
  table_prefix?: string;
  spans_table_name?: string;
  logs_table_name?: string;
  metrics_table_name?: string;
}

interface TraceLocationResponse {
  uc_table_prefix?: UcTablePrefixResponse;
}

interface ExperimentResponse {
  experiment_id?: string;
  experiment?: {
    experiment_id?: string;
  };
}

interface DatabricksRequestOptions {
  method: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  searchParams?: Record<string, string>;
  token?: string;
}

export class TelemetrySetupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetrySetupValidationError';
  }
}

export class TelemetrySetupDatabricksError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly errorCode?: string
  ) {
    super(message);
    this.name = 'TelemetrySetupDatabricksError';
  }
}

export class TelemetrySetupAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetrySetupAuthorizationError';
  }
}

const MAX_PAGES = 100;
const UC_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const EXPERIMENT_NAME_PATTERN = /^[^/\s][^/]{0,79}$/;

function assertUcName(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!UC_NAME_PATTERN.test(trimmed)) {
    throw new TelemetrySetupValidationError(
      `${fieldName} must contain only letters, numbers, underscores, or hyphens`
    );
  }
  return trimmed;
}

function resolveExperimentPath(fastify: FastifyInstance, experimentName: string): string {
  const appName = fastify.config.DATABRICKS_APP_NAME.trim();
  if (!appName) {
    throw new TelemetrySetupValidationError('DATABRICKS_APP_NAME is required');
  }

  const trimmed = experimentName.trim();
  if (!EXPERIMENT_NAME_PATTERN.test(trimmed)) {
    throw new TelemetrySetupValidationError(
      'experiment_name must be 1-80 characters and must not contain slash'
    );
  }

  return `/Shared/${appName}/experiments/${trimmed}`;
}

function isWritableTelemetryCatalog(
  catalog: NonNullable<CatalogsResponse['catalogs']>[number]
): boolean {
  return catalog.name?.trim() !== '' && catalog.catalog_type === 'MANAGED_CATALOG';
}

async function getToken(fastify: FastifyInstance): Promise<string> {
  return getAuthProvider(fastify).getToken();
}

async function parseDatabricksError(response: Response): Promise<DatabricksErrorResponse> {
  try {
    const parsed = (await response.json()) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    return {
      error_code: typeof record.error_code === 'string' ? record.error_code : undefined,
      message: typeof record.message === 'string' ? record.message : undefined,
    };
  } catch {
    return {};
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof TelemetrySetupDatabricksError &&
    (error.statusCode === 409 ||
      error.errorCode === 'RESOURCE_ALREADY_EXISTS' ||
      error.errorCode === 'ALREADY_EXISTS' ||
      error.message.includes('already exists'))
  );
}

async function databricksRequest<T>(
  fastify: FastifyInstance,
  path: string,
  options: DatabricksRequestOptions
): Promise<T> {
  const token = options.token ?? (await getToken(fastify));
  const url = new URL(path, `https://${fastify.config.DATABRICKS_HOST}`);
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: options.method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (response.ok) {
    return (await response.json().catch(() => ({}))) as T;
  }

  const error = await parseDatabricksError(response);
  throw new TelemetrySetupDatabricksError(
    response.status,
    error.message || `Databricks API returned ${response.status}`,
    error.error_code
  );
}

export async function listTelemetryCatalogs(
  fastify: FastifyInstance
): Promise<TelemetryCatalogListResponse> {
  const catalogs = new Set<string>();
  let pageToken: string | undefined;
  let pageCount = 0;

  do {
    const response = await databricksRequest<CatalogsResponse>(
      fastify,
      '/api/2.1/unity-catalog/catalogs',
      {
        method: 'GET',
        searchParams: pageToken ? { page_token: pageToken } : undefined,
      }
    );
    for (const catalog of (response.catalogs ?? []).filter(isWritableTelemetryCatalog)) {
      if (catalog.name) catalogs.add(catalog.name);
    }
    pageToken = response.next_page_token;
    pageCount++;
  } while (pageToken && pageCount < MAX_PAGES);

  return { catalogs: [...catalogs].sort((a, b) => a.localeCompare(b)) };
}

export async function listTelemetrySchemas(
  fastify: FastifyInstance,
  catalogName: string
): Promise<TelemetrySchemaListResponse> {
  const catalog = assertUcName(catalogName, 'catalog_name');
  const schemas = new Set<string>();
  let pageToken: string | undefined;
  let pageCount = 0;

  do {
    const response = await databricksRequest<SchemasResponse>(
      fastify,
      '/api/2.1/unity-catalog/schemas',
      {
        method: 'GET',
        searchParams: {
          catalog_name: catalog,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }
    );
    for (const schema of response.schemas ?? []) {
      if (schema.name) schemas.add(schema.name);
    }
    pageToken = response.next_page_token;
    pageCount++;
  } while (pageToken && pageCount < MAX_PAGES);

  return { schemas: [...schemas].sort((a, b) => a.localeCompare(b)) };
}

async function grantTelemetryTablePrivileges(
  fastify: FastifyInstance,
  params: {
    oboToken: string;
    catalogName: string;
    schemaName: string;
  }
): Promise<void> {
  const servicePrincipal = fastify.config.DATABRICKS_CLIENT_ID.trim();
  if (!servicePrincipal) {
    throw new TelemetrySetupValidationError('DATABRICKS_CLIENT_ID is required');
  }

  await databricksRequest<Record<string, never>>(
    fastify,
    `/api/2.1/unity-catalog/permissions/catalog/${encodeURIComponent(params.catalogName)}`,
    {
      method: 'PATCH',
      token: params.oboToken,
      body: {
        changes: [
          {
            principal: servicePrincipal,
            add: ['USE_CATALOG'],
          },
        ],
      },
    }
  );

  await databricksRequest<Record<string, never>>(
    fastify,
    `/api/2.1/unity-catalog/permissions/schema/${encodeURIComponent(
      `${params.catalogName}.${params.schemaName}`
    )}`,
    {
      method: 'PATCH',
      token: params.oboToken,
      body: {
        changes: [
          {
            principal: servicePrincipal,
            add: ['USE_SCHEMA', 'CREATE_TABLE'],
          },
        ],
      },
    }
  );
}

async function createTraceLocation(
  fastify: FastifyInstance,
  catalogName: string,
  schemaName: string,
  tablePrefix: string
): Promise<UcTablePrefixResponse> {
  const response = await databricksRequest<TraceLocationResponse>(
    fastify,
    '/api/5.0/mlflow/tracing/locations',
    {
      method: 'POST',
      body: {
        uc_table_prefix: {
          catalog_name: catalogName,
          schema_name: schemaName,
          table_prefix: tablePrefix,
        },
      },
    }
  );
  return response.uc_table_prefix ?? {};
}

async function ensureWorkspaceDirectory(fastify: FastifyInstance, path: string): Promise<void> {
  try {
    await databricksRequest<Record<string, never>>(fastify, '/api/2.0/workspace/mkdirs', {
      method: 'POST',
      body: { path },
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

function getParentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

async function getExperimentByName(
  fastify: FastifyInstance,
  experimentPath: string
): Promise<string | null> {
  try {
    const response = await databricksRequest<ExperimentResponse>(
      fastify,
      '/api/2.0/mlflow/experiments/get-by-name',
      {
        method: 'GET',
        searchParams: { experiment_name: experimentPath },
      }
    );
    return response.experiment?.experiment_id ?? null;
  } catch {
    return null;
  }
}

async function createOrGetExperiment(
  fastify: FastifyInstance,
  experimentPath: string
): Promise<string> {
  try {
    const response = await databricksRequest<ExperimentResponse>(
      fastify,
      '/api/2.0/mlflow/experiments/create',
      {
        method: 'POST',
        body: { name: experimentPath },
      }
    );
    if (response.experiment_id) return response.experiment_id;
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    const existingExperimentId = await getExperimentByName(fastify, experimentPath);
    if (existingExperimentId) return existingExperimentId;
    throw error;
  }

  throw new TelemetrySetupDatabricksError(502, 'Missing experiment_id in Databricks response');
}

async function linkExperimentTraceLocation(
  fastify: FastifyInstance,
  experimentId: string,
  ucTablePrefix: UcTablePrefixResponse
): Promise<void> {
  await databricksRequest<Record<string, never>>(
    fastify,
    `/api/5.0/mlflow/experiments/${encodeURIComponent(experimentId)}/trace-location:link`,
    {
      method: 'POST',
      body: {
        experiment_id: experimentId,
        uc_table_prefix: ucTablePrefix,
      },
    }
  );
}

export async function setupTelemetry(
  fastify: FastifyInstance,
  request: TelemetrySetupRequest,
  oboToken?: string
): Promise<TelemetrySetupResponse> {
  const catalogName = assertUcName(request.catalog_name, 'catalog_name');
  const schemaName = assertUcName(request.schema_name, 'schema_name');
  const tablePrefix = assertUcName(request.table_prefix, 'table_prefix');
  const experimentPath = resolveExperimentPath(fastify, request.experiment_name);

  if (!oboToken) {
    throw new TelemetrySetupAuthorizationError(
      'OBO access token is required to grant telemetry table privileges'
    );
  }
  await grantTelemetryTablePrivileges(fastify, { oboToken, catalogName, schemaName });

  const ucTablePrefix = await createTraceLocation(fastify, catalogName, schemaName, tablePrefix);
  const metricsTable =
    ucTablePrefix.metrics_table_name ?? `${catalogName}.${schemaName}.${tablePrefix}_otel_metrics`;
  const logsTable =
    ucTablePrefix.logs_table_name ?? `${catalogName}.${schemaName}.${tablePrefix}_otel_logs`;
  const tracesTable =
    ucTablePrefix.spans_table_name ?? `${catalogName}.${schemaName}.${tablePrefix}_otel_spans`;
  const resolvedUcTablePrefix = {
    ...ucTablePrefix,
    catalog_name: ucTablePrefix.catalog_name ?? catalogName,
    schema_name: ucTablePrefix.schema_name ?? schemaName,
    table_prefix: ucTablePrefix.table_prefix ?? tablePrefix,
    metrics_table_name: metricsTable,
    logs_table_name: logsTable,
    spans_table_name: tracesTable,
  };

  await ensureWorkspaceDirectory(fastify, getParentPath(experimentPath));
  const experimentId = await createOrGetExperiment(fastify, experimentPath);
  await linkExperimentTraceLocation(fastify, experimentId, resolvedUcTablePrefix);

  await updateAppSettings(fastify, {
    otel_metrics_table_name: metricsTable,
    otel_logs_table_name: logsTable,
    otel_traces_table_name: tracesTable,
  });

  return {
    otel_metrics_table_name: metricsTable,
    otel_logs_table_name: logsTable,
    otel_traces_table_name: tracesTable,
    experiment_id: experimentId,
    experiment_path: experimentPath,
  };
}
