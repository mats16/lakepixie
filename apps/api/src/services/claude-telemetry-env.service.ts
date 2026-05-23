import type { AppSettingsResponse } from '@repo/types';

const OTEL_HTTP_PROTOBUF = 'http/protobuf';

export interface ClaudeTelemetryEnvParams {
  appSettings: Pick<
    AppSettingsResponse,
    | 'mlflow_experiment_id'
    | 'otel_metrics_table_name'
    | 'otel_logs_table_name'
    | 'otel_traces_table_name'
  >;
  databricksHost: string;
  databricksClientId: string;
  databricksClientSecret: string;
  databricksWorkspaceId?: string;
  databricksAppName?: string;
  nodeEnv: string;
}

export class TelemetryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetryConfigurationError';
  }
}

function buildSignalHeaders(tableName: string): string {
  return `content-type=application/x-protobuf,X-Databricks-UC-Table-Name=${tableName}`;
}

function buildResourceAttributes(params: ClaudeTelemetryEnvParams): string | undefined {
  const attributes: string[] = [];

  const workspaceId = params.databricksWorkspaceId?.trim();
  if (workspaceId) {
    attributes.push(`ccbricks.workspace_id=${encodeURIComponent(workspaceId)}`);
  }

  const appName = params.databricksAppName?.trim();
  if (appName) {
    attributes.push(`ccbricks.app_name=${encodeURIComponent(appName)}`);
  }

  const nodeEnv = params.nodeEnv.trim();
  if (nodeEnv) {
    attributes.push(`deployment.environment=${encodeURIComponent(nodeEnv)}`);
  }

  return attributes.length ? attributes.join(',') : undefined;
}

export function buildClaudeTelemetryEnv(params: ClaudeTelemetryEnvParams): Record<string, string> {
  const metricsTable = params.appSettings.otel_metrics_table_name;
  const logsTable = params.appSettings.otel_logs_table_name;
  const tracesTable = params.appSettings.otel_traces_table_name;
  if (!metricsTable && !logsTable && !tracesTable) return {};

  if (!params.databricksClientId || !params.databricksClientSecret) {
    throw new TelemetryConfigurationError(
      'Claude Code telemetry requires DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET because otelHeadersHelper uses Databricks service principal authentication.'
    );
  }

  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOG_USER_PROMPTS: '1',
    OTEL_LOG_TOOL_DETAILS: '1',
  };
  const mlflowExperimentId = params.appSettings.mlflow_experiment_id?.trim();
  if (mlflowExperimentId) {
    env.MLFLOW_EXPERIMENT_ID = mlflowExperimentId;
  }

  const resourceAttributes = buildResourceAttributes(params);
  if (resourceAttributes) {
    env.OTEL_RESOURCE_ATTRIBUTES = resourceAttributes;
  }

  if (metricsTable) {
    env.OTEL_METRICS_EXPORTER = 'otlp';
    env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = OTEL_HTTP_PROTOBUF;
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `https://${params.databricksHost}/api/2.0/otel/v1/metrics`;
    env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = buildSignalHeaders(metricsTable);
    env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = 'delta';
  }

  if (logsTable) {
    env.OTEL_LOGS_EXPORTER = 'otlp';
    env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = OTEL_HTTP_PROTOBUF;
    env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `https://${params.databricksHost}/api/2.0/otel/v1/logs`;
    env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = buildSignalHeaders(logsTable);
  }

  if (tracesTable) {
    env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = '1';
    env.OTEL_LOG_TOOL_CONTENT = '1';
    env.OTEL_TRACES_EXPORTER = 'otlp';
    env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = OTEL_HTTP_PROTOBUF;
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `https://${params.databricksHost}/api/2.0/otel/v1/traces`;
    env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = buildSignalHeaders(tracesTable);
  }

  return env;
}
