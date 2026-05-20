import { FastifyPluginAsync } from 'fastify';
import type {
  AdminUserListResponse,
  UpdateUserRoleRequest,
  AppSettingsResponse,
  UpdateAppSettingsRequest,
  GitHubAppAuthResponse,
  UpdateGitHubAppAuthRequest,
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
  getGitHubAppAuthStatus,
  updateGitHubAppAuth,
} from '../services/github-app-auth.service.js';
import { DatabricksSecretsPermissionError } from '../services/databricks-secrets.service.js';

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

  // GitHub App 認証設定取得（private key は返さない）
  fastify.get<{ Reply: GitHubAppAuthResponse | ApiError }>(
    '/admin/github-app-auth',
    { preHandler: guard },
    async (_request, reply) => {
      try {
        const status = await getGitHubAppAuthStatus(fastify);
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

  // GitHub App 認証設定更新（App ID は app_settings、private key は Databricks Secrets に保存）
  fastify.patch<{
    Body: UpdateGitHubAppAuthRequest;
    Reply: GitHubAppAuthResponse | ApiError;
  }>('/admin/github-app-auth', { preHandler: guard }, async (request, reply) => {
    const body = request.body;
    const settings: UpdateGitHubAppAuthRequest = {};

    if (body.github_app_id !== undefined) {
      if (body.github_app_id !== null && typeof body.github_app_id !== 'string') {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'github_app_id must be a string or null',
          statusCode: 400,
        });
      }

      const value = body.github_app_id?.trim() ?? null;
      if (value !== null && value !== '' && !/^\d{1,20}$/.test(value)) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'github_app_id must be a numeric GitHub App ID or null',
          statusCode: 400,
        });
      }
      settings.github_app_id = value || null;
    }

    if (body.github_app_private_key !== undefined) {
      if (body.github_app_private_key !== null && typeof body.github_app_private_key !== 'string') {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'github_app_private_key must be a string or null',
          statusCode: 400,
        });
      }

      const value = body.github_app_private_key?.trim() ?? null;
      if (value !== null && value !== '' && !value.includes('BEGIN')) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'github_app_private_key must be a PEM private key or null',
          statusCode: 400,
        });
      }
      settings.github_app_private_key = value || null;
    }

    try {
      const updated = await updateGitHubAppAuth(fastify, settings);
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
};

export default adminRoute;
