import { describe, expect, it } from 'vitest';
import {
  buildClaudeTelemetryEnv,
  TelemetryConfigurationError,
  type ClaudeTelemetryEnvParams,
} from './claude-telemetry-env.service.js';

type ClaudeTelemetryEnvOverrides = Partial<Omit<ClaudeTelemetryEnvParams, 'appSettings'>> & {
  appSettings?: Partial<ClaudeTelemetryEnvParams['appSettings']>;
};

function createParams(overrides: ClaudeTelemetryEnvOverrides = {}): ClaudeTelemetryEnvParams {
  const { appSettings, ...params } = overrides;

  return {
    appSettings: {
      mlflow_experiment_id: null,
      otel_metrics_table_name: null,
      otel_logs_table_name: null,
      otel_traces_table_name: null,
      ...appSettings,
    },
    databricksHost: 'test.databricks.com',
    databricksClientId: 'client-id',
    databricksClientSecret: 'client-secret',
    databricksWorkspaceId: '1234567890',
    databricksAppName: 'ccbricks',
    nodeEnv: 'production',
    ...params,
  };
}

describe('buildClaudeTelemetryEnv', () => {
  it('returns no telemetry env when no telemetry tables are configured', () => {
    expect(buildClaudeTelemetryEnv(createParams())).toEqual({});
  });

  it('enables only metrics exporter when only a metrics table is configured', () => {
    const env = buildClaudeTelemetryEnv(
      createParams({
        appSettings: {
          otel_metrics_table_name: 'catalog.schema.metrics',
        },
      })
    );

    expect(env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOG_USER_PROMPTS: '1',
      OTEL_LOG_TOOL_DETAILS: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://test.databricks.com/api/2.0/otel/v1/metrics',
      OTEL_EXPORTER_OTLP_METRICS_HEADERS:
        'content-type=application/x-protobuf,X-Databricks-UC-Table-Name=catalog.schema.metrics',
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
    });
    expect(env).not.toHaveProperty('OTEL_LOGS_EXPORTER');
    expect(env).not.toHaveProperty('OTEL_TRACES_EXPORTER');
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENHANCED_TELEMETRY_BETA');
    expect(env).not.toHaveProperty('OTEL_LOG_TOOL_CONTENT');
  });

  it('enables only logs exporter when only a logs table is configured', () => {
    const env = buildClaudeTelemetryEnv(
      createParams({
        appSettings: {
          otel_logs_table_name: 'catalog.schema.logs',
        },
      })
    );

    expect(env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://test.databricks.com/api/2.0/otel/v1/logs',
      OTEL_EXPORTER_OTLP_LOGS_HEADERS:
        'content-type=application/x-protobuf,X-Databricks-UC-Table-Name=catalog.schema.logs',
    });
    expect(env).not.toHaveProperty('OTEL_METRICS_EXPORTER');
    expect(env).not.toHaveProperty('OTEL_TRACES_EXPORTER');
  });

  it('enables trace beta and tool content only when a traces table is configured', () => {
    const env = buildClaudeTelemetryEnv(
      createParams({
        appSettings: {
          otel_traces_table_name: 'catalog.schema.traces',
        },
      })
    );

    expect(env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
      OTEL_LOG_TOOL_CONTENT: '1',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://test.databricks.com/api/2.0/otel/v1/traces',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS:
        'content-type=application/x-protobuf,X-Databricks-UC-Table-Name=catalog.schema.traces',
    });
    expect(env).not.toHaveProperty('OTEL_METRICS_EXPORTER');
    expect(env).not.toHaveProperty('OTEL_LOGS_EXPORTER');
  });

  it('does not set debugging export intervals or raw API body logging', () => {
    const env = buildClaudeTelemetryEnv(
      createParams({
        appSettings: {
          otel_metrics_table_name: 'catalog.schema.metrics',
          otel_logs_table_name: 'catalog.schema.logs',
          otel_traces_table_name: 'catalog.schema.traces',
        },
      })
    );

    expect(env).not.toHaveProperty('OTEL_METRIC_EXPORT_INTERVAL');
    expect(env).not.toHaveProperty('OTEL_LOGS_EXPORT_INTERVAL');
    expect(env).not.toHaveProperty('OTEL_TRACES_EXPORT_INTERVAL');
    expect(env).not.toHaveProperty('OTEL_LOG_RAW_API_BODIES');
  });

  it('sets MLflow experiment ID when configured', () => {
    const env = buildClaudeTelemetryEnv(
      createParams({
        appSettings: {
          mlflow_experiment_id: '123',
          otel_traces_table_name: 'catalog.schema.traces',
        },
      })
    );

    expect(env.MLFLOW_EXPERIMENT_ID).toBe('123');
  });

  it('throws when telemetry is enabled without Databricks service principal credentials', () => {
    expect(() =>
      buildClaudeTelemetryEnv(
        createParams({
          databricksClientSecret: '',
          appSettings: {
            otel_metrics_table_name: 'catalog.schema.metrics',
          },
        })
      )
    ).toThrow(TelemetryConfigurationError);
  });

  it('sets safe OpenTelemetry resource attributes', () => {
    const env = buildClaudeTelemetryEnv(
      createParams({
        databricksWorkspaceId: 'workspace 123',
        databricksAppName: 'ccbricks, prod',
        appSettings: {
          otel_metrics_table_name: 'catalog.schema.metrics',
        },
      })
    );

    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'ccbricks.workspace_id=workspace%20123,ccbricks.app_name=ccbricks%2C%20prod,deployment.environment=production'
    );
  });
});
