import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_MODEL_SETTINGS } from '../constants/model-defaults.js';

const mocks = vi.hoisted(() => ({
  getAllowedModelIds: vi.fn(),
  getAppSettings: vi.fn(),
}));

vi.mock('./admin.service.js', () => ({
  getAllowedModelIds: mocks.getAllowedModelIds,
  getAppSettings: mocks.getAppSettings,
  resolveModelSettings: vi.fn(settings => ({
    opusModel: settings.default_opus_model,
    sonnetModel: settings.default_sonnet_model,
    haikuModel: settings.default_haiku_model,
  })),
}));

import {
  getUserSettings,
  updateUserSettings,
  UserSettingsValidationError,
} from './user-settings.service.js';

const appSettings = {
  app_title: 'ccbricks',
  welcome_heading: 'Claude Code on Databricks',
  databricks_app_name: 'ccbricks',
  default_new_user_role: 'admin',
  default_opus_model: DEFAULT_MODEL_SETTINGS.default_opus_model,
  default_sonnet_model: DEFAULT_MODEL_SETTINGS.default_sonnet_model,
  default_haiku_model: DEFAULT_MODEL_SETTINGS.default_haiku_model,
  allowed_model_ids: [
    DEFAULT_MODEL_SETTINGS.default_opus_model,
    DEFAULT_MODEL_SETTINGS.default_sonnet_model,
    DEFAULT_MODEL_SETTINGS.default_haiku_model,
    'databricks-claude-sonnet-custom',
  ],
  otel_metrics_table_name: null,
  otel_logs_table_name: null,
  otel_traces_table_name: null,
} as const;

function createMockFastify(rows: Array<{ key: string; value: string }> = []): FastifyInstance {
  const tx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };

  return {
    withUserContext: vi.fn(async (_userId: string, callback: (tx: unknown) => Promise<unknown>) =>
      callback(tx)
    ),
    __tx: tx,
  } as unknown as FastifyInstance;
}

describe('user-settings.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAppSettings.mockResolvedValue(appSettings);
    mocks.getAllowedModelIds.mockResolvedValue(appSettings.allowed_model_ids);
  });

  it('resolves invalid user settings through app defaults and allowed models', async () => {
    const fastify = createMockFastify([
      { key: 'opus_model_id', value: 'not-allowed' },
      { key: 'sonnet_model_id', value: 'databricks-claude-sonnet-custom' },
    ]);

    const settings = await getUserSettings(fastify, 'user-1');

    expect(settings.opus_model_id).toBe(DEFAULT_MODEL_SETTINGS.default_opus_model);
    expect(settings.sonnet_model_id).toBe('databricks-claude-sonnet-custom');
    expect(settings.haiku_model_id).toBe(DEFAULT_MODEL_SETTINGS.default_haiku_model);
  });

  it('rejects personal model ids outside the allowed list', async () => {
    const fastify = createMockFastify();

    await expect(
      updateUserSettings(fastify, 'user-1', { opus_model_id: 'databricks-claude-opus-blocked' })
    ).rejects.toBeInstanceOf(UserSettingsValidationError);
  });

  it('upserts and deletes personal settings', async () => {
    const fastify = createMockFastify();
    const tx = (
      fastify as unknown as {
        __tx: { insert: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
      }
    ).__tx;

    await updateUserSettings(fastify, 'user-1', {
      opus_model_id: DEFAULT_MODEL_SETTINGS.default_opus_model,
      haiku_model_id: null,
    });

    expect(tx.insert).toHaveBeenCalledOnce();
    expect(tx.delete).toHaveBeenCalledOnce();
  });
});
