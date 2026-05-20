import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import { TitleService, type TitleServiceConfig } from './title.service.js';

// Create mock function for chat.completions.create
const mockCreate = vi.fn();

// Mock OpenAI module
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

describe('TitleService', () => {
  let service: TitleService;
  const defaultConfig: TitleServiceConfig = {
    databricksHost: 'test.databricks.com',
  };
  const defaultModel = 'databricks-claude-haiku-4-5';

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TitleService(defaultConfig);
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      const config: TitleServiceConfig = {
        databricksHost: 'custom.databricks.com',
      };
      const customService = new TitleService(config);
      expect(customService).toBeInstanceOf(TitleService);
    });
  });

  describe('generateTitle', () => {
    it('should return generated title and app_name from LLM', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: 'React Component Development',
                app_name: 'react-component-dev',
              }),
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Help me create a React component',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result).toEqual({
        title: 'React Component Development',
        app_name: 'react-component-dev',
        branch_name: expect.stringMatching(/^ccbricks\/react-component-dev-[a-f0-9]{8}$/),
      });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'databricks-claude-haiku-4-5',
          max_tokens: 150,
          response_format: expect.objectContaining({ type: 'json_schema' }),
          messages: [
            {
              role: 'user',
              content: expect.stringContaining('Help me create a React component'),
            },
          ],
        })
      );
    });

    it('should return fallback title when LLM returns empty content', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: '',
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Test message',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('General coding session');
      expect(result.app_name).toMatch(/^[a-z0-9]{26}$/);
      expect(result.branch_name).toMatch(/^ccbricks\/[a-z0-9]{26}-[a-f0-9]{8}$/);
    });

    it('should return fallback title when choices array is empty', async () => {
      mockCreate.mockResolvedValue({
        choices: [],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Test message',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('General coding session');
      expect(result.app_name).toMatch(/^[a-z0-9]{26}$/);
      expect(result.branch_name).toMatch(/^ccbricks\/[a-z0-9]{26}-[a-f0-9]{8}$/);
    });

    it('should return fallback title when message content is null', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: null,
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Test message',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('General coding session');
      expect(result.app_name).toMatch(/^[a-z0-9]{26}$/);
      expect(result.branch_name).toMatch(/^ccbricks\/[a-z0-9]{26}-[a-f0-9]{8}$/);
    });

    it('should generate unique branch names for each request', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: 'React Component Development',
                app_name: 'react-component-dev',
              }),
            },
          },
        ],
      });

      const first = await service.generateTitle({
        firstSessionMessage: 'Help me create a React component',
        accessToken: 'test-token',
        model: defaultModel,
      });
      const second = await service.generateTitle({
        firstSessionMessage: 'Help me create a React component',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(first.branch_name).not.toBe(second.branch_name);
    });

    it('should throw error when API fails', async () => {
      mockCreate.mockRejectedValue(new Error('API error'));

      await expect(
        service.generateTitle({
          firstSessionMessage: 'Test message',
          accessToken: 'test-token',
          model: defaultModel,
        })
      ).rejects.toThrow('API error');
    });

    it('should clean double quotes from title', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: '"Python Data Analysis"',
                app_name: 'python-data-analysis',
              }),
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Analyze CSV',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('Python Data Analysis');
      expect(result.app_name).toBe('python-data-analysis');
    });

    it('should clean single quotes from title', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "'React Component'",
                app_name: 'react-component',
              }),
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Create React component',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('React Component');
    });

    it('should clean backticks from title', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: '`API Integration`',
                app_name: 'api-integration',
              }),
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Integrate API',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('API Integration');
    });

    it('should clean markdown bold formatting', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: '**React Component** Development',
                app_name: 'react-component-dev',
              }),
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Create React component',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('React Component Development');
    });

    it('should clean markdown italic formatting', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: '*React Component* Development',
                app_name: 'react-component-dev',
              }),
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Create React component',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('React Component Development');
    });

    it('should trim whitespace from title', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: '  Python Data Analysis  ',
                app_name: 'python-data-analysis',
              }),
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Analyze data',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('Python Data Analysis');
    });

    it('should handle Japanese messages', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: 'React Component Implementation',
                app_name: 'react-component-impl',
              }),
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Reactコンポーネントを作成してください',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('React Component Implementation');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining('Reactコンポーネントを作成してください'),
            }),
          ]),
        })
      );
    });

    it('should return fallback when cleaned title is empty', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: '""',
                app_name: 'general-session',
              }),
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Test',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('General coding session');
    });

    it('should generate fallback app_name when app_name is invalid', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: 'Valid Title',
                app_name: 'INVALID_APP_NAME!',
              }),
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Test',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('Valid Title');
      expect(result.app_name).toMatch(/^[a-z0-9]{26}$/);
    });

    it('should return fallback when JSON parsing fails', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: 'not valid json',
            },
          },
        ],
      });

      const result = await service.generateTitle({
        firstSessionMessage: 'Test',
        accessToken: 'test-token',
        model: defaultModel,
      });

      expect(result.title).toBe('General coding session');
      expect(result.app_name).toMatch(/^[a-z0-9]{26}$/);
    });
  });
});
