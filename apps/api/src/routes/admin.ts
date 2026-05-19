import { FastifyPluginAsync } from 'fastify';
import type {
  AdminUserListResponse,
  UpdateUserRoleRequest,
  AppSettingsResponse,
  UpdateAppSettingsRequest,
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
};

export default adminRoute;
