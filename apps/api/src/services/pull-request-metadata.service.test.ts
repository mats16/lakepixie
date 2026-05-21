import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  PullRequestMetadataService,
  readPullRequestTemplates,
} from './pull-request-metadata.service.js';

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

describe('PullRequestMetadataService', () => {
  const service = new PullRequestMetadataService({
    databricksHost: 'test.databricks.com',
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates pull request metadata with the configured haiku model and templates', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: 'Generate PR Metadata',
              body: '## Summary\n- Adds generated PR metadata',
            }),
          },
        },
      ],
    });

    const result = await service.generateMetadata({
      accessToken: 'test-token',
      model: 'databricks-claude-haiku-4-5',
      repository: 'acme/widgets',
      base: 'main',
      head: 'ccbricks/test',
      fallbackTitle: 'Update widgets',
      language: 'ja',
      sessionTitle: 'Update widgets',
      templates: [{ path: '.github/pull_request_template.md', content: '## Summary\n## Tests' }],
      gitContext: {
        commits: 'abc1234 add metadata generation',
        diffStat: 'apps/api/src/routes/git-repositories.ts | 20 +++++',
        fileStatus: 'M\tapps/api/src/routes/git-repositories.ts',
        diff: 'diff --git a/file b/file',
      },
    });

    expect(result).toEqual({
      title: 'Generate PR Metadata',
      body: '## Summary\n- Adds generated PR metadata',
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'databricks-claude-haiku-4-5',
        response_format: expect.objectContaining({ type: 'json_schema' }),
        messages: [
          {
            role: 'user',
            content: expect.stringContaining('If a pull request template exists under .github'),
          },
        ],
      })
    );
    expect(mockCreate.mock.calls[0]?.[0].messages[0].content).toContain(
      '.github/pull_request_template.md'
    );
    expect(mockCreate.mock.calls[0]?.[0].messages[0].content).toContain(
      'Requested output language: ja'
    );
  });

  it('falls back when the model returns invalid JSON', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'not json' } }],
    });

    const result = await service.generateMetadata({
      accessToken: 'test-token',
      model: 'databricks-claude-haiku-4-5',
      repository: 'acme/widgets',
      base: 'main',
      head: 'ccbricks/test',
      fallbackTitle: 'Update widgets',
      templates: [],
      gitContext: {
        commits: '',
        diffStat: 'apps/web/src/App.tsx | 2 +',
        fileStatus: 'M\tapps/web/src/App.tsx',
        diff: '',
      },
    });

    expect(result.title).toBe('Update widgets');
    expect(result.body).toContain('apps/web/src/App.tsx | 2 +');
  });
});

describe('readPullRequestTemplates', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ccbricks-pr-template-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads root and directory pull request templates under .github', async () => {
    await mkdir(join(tempDir, '.github', 'PULL_REQUEST_TEMPLATE'), { recursive: true });
    await writeFile(join(tempDir, '.github', 'pull_request_template.md'), '## Summary');
    await writeFile(join(tempDir, '.github', 'PULL_REQUEST_TEMPLATE', 'bug.md'), '## Bug');

    const templates = await readPullRequestTemplates(tempDir);

    expect(templates).toEqual([
      { path: '.github/PULL_REQUEST_TEMPLATE/bug.md', content: '## Bug' },
      { path: '.github/pull_request_template.md', content: '## Summary' },
    ]);
  });
});
