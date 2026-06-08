import { FastifyPluginAsync } from 'fastify';
import type {
  AdminUserListResponse,
  UpdateUserRoleRequest,
  AppSettingsResponse,
  UpdateAppSettingsRequest,
  GitHubOAuthAdminResponse,
  GitHubOAuthEncryptionKeyRotateResponse,
  UpdateGitHubOAuthAdminRequest,
  TelemetryCatalogListResponse,
  TelemetrySchemaListResponse,
  TelemetrySetupRequest,
  TelemetrySetupResponse,
  DatabricksSecretScopeResponse,
  ApiError,
} from '@repo/types';
import { adminGuard } from '../hooks/admin-guard.js';
import {
  getAllUsers,
  updateUserIsAdmin,
  updateAppSettings,
  getAppSettings,
  LastAdminError,
} from '../services/admin.service.js';
import {
  getGitHubOAuthAdminStatus,
  rotateGitHubOAuthEncryptionKey,
  updateGitHubOAuthAdminSettings,
} from '../services/github-oauth.service.js';
import { DatabricksSecretsPermissionError } from '../services/databricks-secrets.service.js';
import { getAppSecretScope } from '../services/encryption-key.service.js';
import { getGitHubOAuthRedirectUri } from './github-oauth.js';
import {
  listTelemetryCatalogs,
  listTelemetrySchemas,
  setupTelemetry,
  TelemetrySetupAuthorizationError,
  TelemetrySetupDatabricksError,
  TelemetrySetupValidationError,
} from '../services/telemetry-setup.service.js';

const GITHUB_OAUTH_CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GITHUB_OAUTH_CLIENT_SECRET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,511}$/;

function isGitHubOAuthClientId(value: string): boolean {
  return GITHUB_OAUTH_CLIENT_ID_PATTERN.test(value);
}

function isGitHubOAuthClientSecret(value: string): boolean {
  return GITHUB_OAUTH_CLIENT_SECRET_PATTERN.test(value);
}

function toTelemetryApiError(error: unknown): ApiError {
  if (error instanceof TelemetrySetupValidationError) {
    return {
      error: 'BadRequest',
      message: error.message,
      statusCode: 400,
    };
  }

  if (error instanceof TelemetrySetupDatabricksError) {
    return {
      error: 'DatabricksApiError',
      message: error.message,
      statusCode: error.statusCode,
    };
  }

  if (error instanceof TelemetrySetupAuthorizationError) {
    return {
      error: 'Unauthorized',
      message: error.message,
      statusCode: 401,
    };
  }

  return {
    error: 'InternalServerError',
    message: error instanceof Error ? error.message : 'Unknown error',
    statusCode: 500,
  };
}

const adminRoute: FastifyPluginAsync = async fastify => {
  const guard = adminGuard(fastify);

  // ユーザー一覧取得
  fastify.get<{ Reply: AdminUserListResponse | ApiError }>(
    '/admin/users',
    { preHandler: guard },
    async (_request, reply) => {
      const users = await getAllUsers(fastify);
      return reply.send({ users });
    }
  );

  // ユーザーのロール更新
  fastify.put<{
    Params: { id: string };
    Body: UpdateUserRoleRequest;
    Reply: { success: true } | ApiError;
  }>('/admin/users/:id/role', { preHandler: guard }, async (request, reply) => {
    const { id } = request.params;
    const { is_admin } = request.body;

    if (typeof is_admin !== 'boolean') {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'is_admin must be a boolean',
        statusCode: 400,
      });
    }

    try {
      await updateUserIsAdmin(fastify, id, is_admin);
      return reply.send({ success: true });
    } catch (error) {
      if (error instanceof LastAdminError) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: error.message,
          statusCode: 400,
        });
      }
      throw error;
    }
  });

  // アプリ設定取得
  fastify.get<{ Reply: AppSettingsResponse | ApiError }>(
    '/admin/settings',
    { preHandler: guard },
    async (_request, reply) => {
      const settings = await getAppSettings(fastify);
      return reply.send(settings);
    }
  );

  // アプリ設定更新（部分更新）
  fastify.patch<{
    Body: UpdateAppSettingsRequest;
    Reply: AppSettingsResponse | ApiError;
  }>('/admin/settings', { preHandler: guard }, async (request, reply) => {
    const body = request.body;

    // バリデーション: default_new_user_role
    if (
      body.default_new_user_role !== undefined &&
      body.default_new_user_role !== 'admin' &&
      body.default_new_user_role !== 'member'
    ) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: "default_new_user_role must be 'admin' or 'member'",
        statusCode: 400,
      });
    }

    // バリデーション: 表示名（null でデフォルトへ戻す）
    const settings: UpdateAppSettingsRequest = { ...body };
    for (const key of ['app_title', 'welcome_heading'] as const) {
      const value = settings[key];
      if (value !== undefined && value !== null) {
        if (typeof value !== 'string') {
          return reply.status(400).send({
            error: 'BadRequest',
            message: `${key} must be a non-empty string or null`,
            statusCode: 400,
          });
        }

        const trimmed = value.trim();
        if (trimmed.length === 0 || trimmed.length > 80) {
          return reply.status(400).send({
            error: 'BadRequest',
            message: `${key} must be between 1 and 80 characters`,
            statusCode: 400,
          });
        }
        settings[key] = trimmed;
      }
    }

    // バリデーション: モデル設定（null か 非空文字列のみ許可）
    for (const key of [
      'default_opus_model',
      'default_sonnet_model',
      'default_haiku_model',
    ] as const) {
      const value = settings[key];
      if (value !== undefined && value !== null && (typeof value !== 'string' || value === '')) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: `${key} must be a non-empty string or null`,
          statusCode: 400,
        });
      }
    }

    if (settings.allowed_model_ids !== undefined) {
      if (
        !Array.isArray(settings.allowed_model_ids) ||
        settings.allowed_model_ids.some(value => typeof value !== 'string' || value.trim() === '')
      ) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'allowed_model_ids must be an array of non-empty strings',
          statusCode: 400,
        });
      }
      settings.allowed_model_ids = [
        ...new Set(settings.allowed_model_ids.map(value => value.trim())),
      ];
    }

    const mlflowExperimentId = settings.mlflow_experiment_id;
    if (mlflowExperimentId !== undefined && mlflowExperimentId !== null) {
      if (
        typeof mlflowExperimentId !== 'string' ||
        !/^[1-9][0-9]*$/.test(mlflowExperimentId.trim())
      ) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'mlflow_experiment_id must be a positive numeric string or null',
          statusCode: 400,
        });
      }
      settings.mlflow_experiment_id = mlflowExperimentId.trim();
    }

    // バリデーション: OTEL テーブル名（null か Unity Catalog 3-part name のみ許可）
    for (const key of [
      'otel_metrics_table_name',
      'otel_logs_table_name',
      'otel_traces_table_name',
    ] as const) {
      const value = settings[key];
      if (value !== undefined && value !== null) {
        if (
          typeof value !== 'string' ||
          !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(value)
        ) {
          return reply.status(400).send({
            error: 'BadRequest',
            message: `${key} must be a Unity Catalog 3-part name (catalog.schema.table) or null`,
            statusCode: 400,
          });
        }
      }
    }

    await updateAppSettings(fastify, settings);
    const updated = await getAppSettings(fastify);
    return reply.send(updated);
  });

  fastify.get<{ Reply: TelemetryCatalogListResponse | ApiError }>(
    '/admin/telemetry/catalogs',
    { preHandler: guard },
    async (_request, reply) => {
      try {
        const result = await listTelemetryCatalogs(fastify);
        return reply.send(result);
      } catch (error) {
        const apiError = toTelemetryApiError(error);
        return reply.status(apiError.statusCode).send(apiError);
      }
    }
  );

  fastify.get<{
    Querystring: { catalog_name?: string };
    Reply: TelemetrySchemaListResponse | ApiError;
  }>('/admin/telemetry/schemas', { preHandler: guard }, async (request, reply) => {
    const catalogName = request.query.catalog_name;
    if (!catalogName) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'catalog_name is required',
        statusCode: 400,
      });
    }

    try {
      const result = await listTelemetrySchemas(fastify, catalogName);
      return reply.send(result);
    } catch (error) {
      const apiError = toTelemetryApiError(error);
      return reply.status(apiError.statusCode).send(apiError);
    }
  });

  fastify.post<{
    Body: TelemetrySetupRequest;
    Reply: TelemetrySetupResponse | ApiError;
  }>('/admin/telemetry/setup', { preHandler: guard }, async (request, reply) => {
    const body = request.body;
    if (
      !body ||
      typeof body.catalog_name !== 'string' ||
      typeof body.schema_name !== 'string' ||
      typeof body.table_prefix !== 'string' ||
      typeof body.experiment_name !== 'string'
    ) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'catalog_name, schema_name, table_prefix, and experiment_name are required',
        statusCode: 400,
      });
    }

    try {
      const result = await setupTelemetry(fastify, body, request.ctx?.user.oboAccessToken);
      return reply.send(result);
    } catch (error) {
      const apiError = toTelemetryApiError(error);
      return reply.status(apiError.statusCode).send(apiError);
    }
  });

  fastify.get<{ Reply: DatabricksSecretScopeResponse }>(
    '/admin/databricks/secrets/scope',
    { preHandler: guard },
    () => {
      return {
        app_secret_scope: getAppSecretScope(fastify),
      };
    }
  );

  // GitHub OAuth 設定取得（client secret は返さない）
  fastify.get<{ Reply: GitHubOAuthAdminResponse | ApiError }>(
    '/admin/github/oauth',
    { preHandler: guard },
    async (request, reply) => {
      try {
        const status = await getGitHubOAuthAdminStatus(fastify, getGitHubOAuthRedirectUri(request));
        return reply.send(status);
      } catch (error) {
        if (error instanceof DatabricksSecretsPermissionError) {
          return reply.status(400).send({
            error: 'BadRequest',
            message: error.message,
            statusCode: 400,
          });
        }
        throw error;
      }
    }
  );

  // GitHub OAuth 設定更新（client ID は app_settings、client secret は Databricks Secrets に保存）
  fastify.patch<{
    Body: UpdateGitHubOAuthAdminRequest;
    Reply: GitHubOAuthAdminResponse | ApiError;
  }>('/admin/github/oauth', { preHandler: guard }, async (request, reply) => {
    const body = request.body;
    const settings: UpdateGitHubOAuthAdminRequest = {};

    if (body.client_id !== undefined) {
      if (body.client_id !== null && typeof body.client_id !== 'string') {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'client_id must be a string or null',
          statusCode: 400,
        });
      }

      const value = body.client_id?.trim() ?? null;
      if (value !== null && value !== '' && !isGitHubOAuthClientId(value)) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'client_id must be a GitHub OAuth client ID',
          statusCode: 400,
        });
      }
      settings.client_id = value || null;
    }

    if (body.client_secret !== undefined) {
      if (body.client_secret !== null && typeof body.client_secret !== 'string') {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'client_secret must be a string or null',
          statusCode: 400,
        });
      }

      const value = body.client_secret?.trim() ?? null;
      if (value !== null && value !== '' && !isGitHubOAuthClientSecret(value)) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'client_secret must be a GitHub OAuth client secret',
          statusCode: 400,
        });
      }
      settings.client_secret = value || null;
    }

    try {
      const updated = await updateGitHubOAuthAdminSettings(
        fastify,
        settings,
        getGitHubOAuthRedirectUri(request)
      );
      return reply.send(updated);
    } catch (error) {
      if (error instanceof DatabricksSecretsPermissionError) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: error.message,
          statusCode: 400,
        });
      }
      throw error;
    }
  });

  fastify.post<{ Reply: GitHubOAuthEncryptionKeyRotateResponse | ApiError }>(
    '/admin/github/oauth/encryption-key/rotate',
    { preHandler: guard },
    async (_request, reply) => {
      try {
        const result = await rotateGitHubOAuthEncryptionKey(fastify);
        return reply.send(result);
      } catch (error) {
        if (error instanceof DatabricksSecretsPermissionError) {
          return reply.status(400).send({
            error: 'BadRequest',
            message: error.message,
            statusCode: 400,
          });
        }
        throw error;
      }
    }
  );
};

export default adminRoute;
