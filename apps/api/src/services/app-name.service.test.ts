import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import {
  AppNameService,
  buildDatabricksAppName,
  isValidDatabricksAppName,
  type AppNameServiceConfig,
} from './app-name.service.js';

const mockCreate = vi.fn();

vi.mock('openai', () => {
  const MockOpenAI = function (this: { chat: { completions: { create: MockInstance } } }) {
    this.chat = {
      completions: {
        create: mockCreate,
      },
    };
  };
  return { default: MockOpenAI };
});

describe('AppNameService', () => {
  let service: AppNameService;
  const defaultConfig: AppNameServiceConfig = {
    databricksHost: 'test.databricks.com',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AppNameService(defaultConfig);
  });

  it('generates sanitized app metadata from LLM output', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              name: 'Shiny Hello World App!',
              description: 'A simple Shiny visualization app.',
            }),
          },
        },
      ],
    });

    const result = await service.generateAppMetadata({
      context: 'Session title: Shiny Hello World\nWorkspace path: /Workspace/Users/test/app',
      accessToken: 'test-token',
      model: 'databricks-claude-haiku-4-5',
    });

    expect(result.name).toMatch(/^shiny-hello-world-app-[a-f0-9]{8}$/);
    expect(result.description).toBe('A simple Shiny visualization app.');
    expect(isValidDatabricksAppName(result.name)).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'databricks-claude-haiku-4-5',
        response_format: expect.objectContaining({ type: 'json_schema' }),
        messages: [
          {
            role: 'user',
            content: expect.stringContaining('Shiny Hello World'),
          },
        ],
      })
    );
  });

  it('falls back to context when LLM output is invalid', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ name: '!!!' }),
          },
        },
      ],
    });

    const result = await service.generateAppName({
      context: 'My Internal Dashboard',
      accessToken: 'test-token',
      model: 'databricks-claude-haiku-4-5',
    });

    expect(result.name).toMatch(/^my-internal-dashboard-[a-f0-9]{8}$/);
  });

  it('builds deterministic names for the same context', () => {
    const first = buildDatabricksAppName('Example App', 'same context');
    const second = buildDatabricksAppName('Example App', 'same context');

    expect(first).toBe(second);
    expect(isValidDatabricksAppName(first)).toBe(true);
  });
});
