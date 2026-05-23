import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CLAUDE_CODE_PRESET_TOOLS } from '@repo/types';
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
  mlflow_experiment_id: null,
  otel_metrics_table_name: null,
  otel_logs_table_name: null,
  otel_traces_table_name: null,
} as const;

type MockUserSettingsRow = {
  userId: string;
  opusModelId: string | null;
  sonnetModelId: string | null;
  haikuModelId: string | null;
  allowedTools: string[] | string | null;
  disallowedTools: string[] | string | null;
};

function createMockFastify(rows: MockUserSettingsRow[] = []): FastifyInstance {
  let storedRows = rows.map(row => ({ ...row }));
  let activeUserId: string | undefined;
  const makeRow = (
    values: Partial<MockUserSettingsRow> & { userId: string }
  ): MockUserSettingsRow => ({
    userId: values.userId,
    opusModelId: values.opusModelId ?? null,
    sonnetModelId: values.sonnetModelId ?? null,
    haikuModelId: values.haikuModelId ?? null,
    allowedTools: values.allowedTools ?? null,
    disallowedTools: values.disallowedTools ?? null,
  });
  const upsertValues = vi.fn((values: Partial<MockUserSettingsRow> & { userId: string }) => ({
    onConflictDoUpdate: vi.fn(async ({ set }: { set: Partial<MockUserSettingsRow> }) => {
      const index = storedRows.findIndex(row => row.userId === values.userId);
      const current = index >= 0 ? storedRows[index] : makeRow(values);
      const next = makeRow({ ...current, ...values, ...set, userId: values.userId });

      if (index >= 0) {
        storedRows[index] = next;
      } else {
        storedRows = [...storedRows, next];
      }
    }),
  }));
  const tx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn(async () =>
            activeUserId === undefined
              ? storedRows
              : storedRows.filter(row => row.userId === activeUserId)
          ),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: upsertValues,
    }),
  };

  return {
    withUserContext: vi.fn(async (userId: string, callback: (tx: unknown) => Promise<unknown>) => {
      activeUserId = userId;
      try {
        return await callback(tx);
      } finally {
        activeUserId = undefined;
      }
    }),
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
      {
        userId: 'user-1',
        opusModelId: 'not-allowed',
        sonnetModelId: 'databricks-claude-sonnet-custom',
        haikuModelId: null,
        allowedTools: null,
        disallowedTools: null,
      },
    ]);

    const settings = await getUserSettings(fastify, 'user-1');

    expect(settings.opus_model_id).toBe(DEFAULT_MODEL_SETTINGS.default_opus_model);
    expect(settings.sonnet_model_id).toBe('databricks-claude-sonnet-custom');
    expect(settings.haiku_model_id).toBe(DEFAULT_MODEL_SETTINGS.default_haiku_model);
    expect(settings.allowed_tools).toEqual(CLAUDE_CODE_PRESET_TOOLS);
    expect(settings.disallowed_tools).toEqual([]);
  });

  it('resolves saved preset and custom tool settings', async () => {
    const fastify = createMockFastify([
      {
        userId: 'user-1',
        opusModelId: null,
        sonnetModelId: null,
        haikuModelId: null,
        allowedTools: ['Read', 'WebSearch', 'Bash(*)'],
        disallowedTools: ['Bash', 'mcp__dbsql__*', '*'],
      },
    ]);

    const settings = await getUserSettings(fastify, 'user-1');

    expect(settings.allowed_tools).toEqual(['Read', 'WebSearch', 'Bash(*)']);
    expect(settings.disallowed_tools).toEqual(['Bash', 'mcp__dbsql__*', '*']);
  });

  it('reads settings for the requested user from the mock transaction', async () => {
    const fastify = createMockFastify([
      {
        userId: 'user-1',
        opusModelId: null,
        sonnetModelId: null,
        haikuModelId: null,
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
      },
      {
        userId: 'user-2',
        opusModelId: null,
        sonnetModelId: 'databricks-claude-sonnet-custom',
        haikuModelId: null,
        allowedTools: ['Write'],
        disallowedTools: ['WebSearch'],
      },
    ]);

    const settings = await getUserSettings(fastify, 'user-2');

    expect(settings.sonnet_model_id).toBe('databricks-claude-sonnet-custom');
    expect(settings.allowed_tools).toEqual(['Write']);
    expect(settings.disallowed_tools).toEqual(['WebSearch']);
  });

  it('does not fall back to hardcoded model ids when allowed endpoints have custom names', async () => {
    mocks.getAppSettings.mockResolvedValue({
      ...appSettings,
      default_opus_model: 'not-allowed-opus',
      default_sonnet_model: 'not-allowed-sonnet',
      default_haiku_model: 'not-allowed-haiku',
      allowed_model_ids: ['my-company-claude-endpoint'],
    });
    const fastify = createMockFastify();

    const settings = await getUserSettings(fastify, 'user-1');

    expect(settings.opus_model_id).toBe('my-company-claude-endpoint');
    expect(settings.sonnet_model_id).toBe('my-company-claude-endpoint');
    expect(settings.haiku_model_id).toBe('my-company-claude-endpoint');
  });

  it('resolves requested session models from a prefetched settings snapshot', async () => {
    const { resolveSessionModelIdFromSettings } = await import('./user-settings.service.js');
    const fastify = createMockFastify();
    const settings = await getUserSettings(fastify, 'user-1');

    expect(
      resolveSessionModelIdFromSettings(settings, new Set(appSettings.allowed_model_ids), 'sonnet')
    ).toBe(DEFAULT_MODEL_SETTINGS.default_sonnet_model);
    expect(
      resolveSessionModelIdFromSettings(
        settings,
        new Set(appSettings.allowed_model_ids),
        'databricks-claude-sonnet-custom'
      )
    ).toBe('databricks-claude-sonnet-custom');
    expect(() =>
      resolveSessionModelIdFromSettings(
        settings,
        new Set(appSettings.allowed_model_ids),
        'blocked-model'
      )
    ).toThrow('session_context.model must be an allowed model id');
  });

  it('rejects personal model ids outside the allowed list', async () => {
    const fastify = createMockFastify();

    await expect(
      updateUserSettings(fastify, 'user-1', { opus_model_id: 'databricks-claude-opus-blocked' })
    ).rejects.toBeInstanceOf(UserSettingsValidationError);
  });

  it('accepts custom allowed and disallowed tool patterns', async () => {
    const fastify = createMockFastify();

    await expect(
      updateUserSettings(fastify, 'user-1', {
        allowed_tools: ['Read', 'Bash(*)'],
        disallowed_tools: ['mcp__dbsql__*', '*'],
      })
    ).resolves.toMatchObject({
      allowed_tools: ['Read', 'Bash(*)'],
      disallowed_tools: ['mcp__dbsql__*', '*'],
    });
  });

  it('upserts personal settings', async () => {
    const fastify = createMockFastify();
    const tx = (
      fastify as unknown as {
        __tx: { insert: ReturnType<typeof vi.fn> };
      }
    ).__tx;

    await updateUserSettings(fastify, 'user-1', {
      opus_model_id: DEFAULT_MODEL_SETTINGS.default_opus_model,
      haiku_model_id: null,
      allowed_tools: ['Read', 'WebSearch'],
      disallowed_tools: ['Bash'],
    });

    expect(tx.insert).toHaveBeenCalledOnce();
  });
});
