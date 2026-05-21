import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppSettingsResponse } from '@repo/types';
import { DEFAULT_MODEL_SETTINGS } from '../constants/model-defaults.js';
import { getAppSettings, resolveModelSettings } from './admin.service.js';

const baseSettings = {
  app_title: 'ccbricks',
  welcome_heading: 'Claude Code on Databricks',
  default_new_user_role: 'admin',
  default_opus_model: DEFAULT_MODEL_SETTINGS.default_opus_model,
  default_sonnet_model: DEFAULT_MODEL_SETTINGS.default_sonnet_model,
  default_haiku_model: DEFAULT_MODEL_SETTINGS.default_haiku_model,
  otel_metrics_table_name: null,
  otel_logs_table_name: null,
  otel_traces_table_name: null,
} satisfies AppSettingsResponse;

describe('admin.service model defaults', () => {
  it('returns configured default model constants when model settings are missing', async () => {
    const where = vi.fn().mockResolvedValue([]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const fastify = { db: { select } } as unknown as FastifyInstance;

    await expect(getAppSettings(fastify)).resolves.toMatchObject(DEFAULT_MODEL_SETTINGS);
  });

  it('uses configured model settings when present', () => {
    const settings = {
      ...baseSettings,
      default_opus_model: 'databricks-claude-opus-custom',
      default_sonnet_model: 'databricks-claude-sonnet-custom',
      default_haiku_model: 'databricks-claude-haiku-custom',
    } satisfies AppSettingsResponse;

    expect(resolveModelSettings(settings)).toEqual({
      opusModel: 'databricks-claude-opus-custom',
      sonnetModel: 'databricks-claude-sonnet-custom',
      haikuModel: 'databricks-claude-haiku-custom',
    });
  });

  it('falls back to configured constants for legacy nullable model settings', () => {
    const settings = {
      ...baseSettings,
      default_opus_model: null,
      default_sonnet_model: null,
      default_haiku_model: null,
    } as unknown as AppSettingsResponse;

    expect(resolveModelSettings(settings)).toEqual({
      opusModel: DEFAULT_MODEL_SETTINGS.default_opus_model,
      sonnetModel: DEFAULT_MODEL_SETTINGS.default_sonnet_model,
      haikuModel: DEFAULT_MODEL_SETTINGS.default_haiku_model,
    });
  });
});
