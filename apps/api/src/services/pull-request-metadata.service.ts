import OpenAI from 'openai';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalGitPullRequestContext } from './local-git.service.js';
import { cleanLlmTitle, truncateForPrompt } from '../utils/llm-text.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOKENS = 1_500;
const MAX_TEMPLATE_CHARS = 20_000;
const MAX_TOTAL_TEMPLATE_CHARS = 40_000;

const RESPONSE_FORMAT: OpenAI.ChatCompletionCreateParams['response_format'] = {
  type: 'json_schema',
  json_schema: {
    name: 'pull_request_metadata_response',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
  },
};

export interface PullRequestTemplate {
  path: string;
  content: string;
}

export interface PullRequestMetadata {
  title: string;
  body: string;
}

export interface GeneratePullRequestMetadataParams {
  accessToken: string;
  model: string;
  repository: string;
  base: string;
  head: string;
  fallbackTitle: string;
  language?: string;
  sessionTitle?: string;
  gitContext: LocalGitPullRequestContext;
  templates: PullRequestTemplate[];
}

export interface PullRequestMetadataServiceConfig {
  databricksHost: string;
}

function fallbackBody(params: GeneratePullRequestMetadataParams): string {
  const stat = params.gitContext.diffStat || params.gitContext.fileStatus || 'No diff summary.';
  return `## Summary\n- ${params.fallbackTitle}\n\n## Changes\n\`\`\`\n${stat}\n\`\`\``;
}

function formatTemplates(templates: PullRequestTemplate[]): string {
  if (templates.length === 0) return 'No pull request template was found under .github.';

  let totalChars = 0;
  return templates
    .map(template => {
      const remainingChars = Math.max(MAX_TOTAL_TEMPLATE_CHARS - totalChars, 0);
      const content = truncateForPrompt(
        template.content,
        Math.min(MAX_TEMPLATE_CHARS, remainingChars)
      );
      totalChars += content.length;
      return `Template: ${template.path}\n${content}`;
    })
    .join('\n\n---\n\n');
}

function getRequestedLanguage(language: string | undefined): string {
  const trimmed = language?.trim();
  if (!trimmed) return 'English';
  return truncateForPrompt(trimmed, 64);
}

function buildPrompt(params: GeneratePullRequestMetadataParams): string {
  return `Generate a GitHub pull request title and description for this change.

Requirements:
- Use the provided git diff, file list, and commit list as the source of truth.
- Use a concise, specific title. Prefer an imperative style when it fits.
- The description must be useful Markdown for a reviewer.
- If a pull request template exists under .github, follow that template's structure and instructions.
- Preserve relevant template headings, checklist syntax, and placeholders when they apply.
- Do not claim tests were run unless the diff or commit context clearly shows that.
- Do not invent issue numbers, reviewers, screenshots, or deployment details.
- Respond only with JSON matching the requested schema.

Requested output language: ${getRequestedLanguage(params.language)}
Repository: ${params.repository}
Base branch: ${params.base}
Head branch: ${params.head}
Existing session title: ${params.sessionTitle ?? params.fallbackTitle}

Pull request templates:
${formatTemplates(params.templates)}

Commits:
${params.gitContext.commits || '(none)'}

Changed files:
${params.gitContext.fileStatus || '(none)'}

Diff stat:
${params.gitContext.diffStat || '(none)'}

Diff:
${params.gitContext.diff || '(empty)'}`;
}

async function readTemplateFile(
  cwd: string,
  filePath: string
): Promise<PullRequestTemplate | null> {
  const content = await readFile(path.join(cwd, filePath), 'utf-8').catch(() => null);
  if (content === null || content.trim().length === 0) return null;
  return {
    path: filePath,
    content: truncateForPrompt(content.trim(), MAX_TEMPLATE_CHARS),
  };
}

async function collectPullRequestTemplatePaths(githubDir: string): Promise<string[]> {
  const entries = await readdir(githubDir, { withFileTypes: true }).catch(() => []);
  const templatePaths: string[] = [];

  for (const entry of entries) {
    const lowerName = entry.name.toLowerCase();
    if (entry.isFile() && lowerName === 'pull_request_template.md') {
      templatePaths.push(path.join('.github', entry.name));
    }

    if (entry.isDirectory() && lowerName === 'pull_request_template') {
      const templateDir = path.join(githubDir, entry.name);
      const templateEntries = await readdir(templateDir, { withFileTypes: true }).catch(() => []);
      for (const templateEntry of templateEntries) {
        if (templateEntry.isFile() && templateEntry.name.toLowerCase().endsWith('.md')) {
          templatePaths.push(path.join('.github', entry.name, templateEntry.name));
        }
      }
    }
  }

  return [...new Set(templatePaths)].sort();
}

export async function readPullRequestTemplates(cwd: string): Promise<PullRequestTemplate[]> {
  const templatePaths = await collectPullRequestTemplatePaths(path.join(cwd, '.github'));
  const templates = await Promise.all(
    templatePaths.map(filePath => readTemplateFile(cwd, filePath))
  );
  return templates.filter((template): template is PullRequestTemplate => template !== null);
}

export class PullRequestMetadataService {
  private readonly config: PullRequestMetadataServiceConfig;

  constructor(config: PullRequestMetadataServiceConfig) {
    this.config = config;
  }

  async generateMetadata(params: GeneratePullRequestMetadataParams): Promise<PullRequestMetadata> {
    const client = new OpenAI({
      baseURL: `https://${this.config.databricksHost}/serving-endpoints`,
      apiKey: params.accessToken,
      timeout: REQUEST_TIMEOUT_MS,
    });

    const response = await client.chat.completions.create({
      model: params.model,
      max_tokens: MAX_TOKENS,
      response_format: RESPONSE_FORMAT,
      messages: [
        {
          role: 'user',
          content: buildPrompt(params),
        },
      ],
    });

    const rawContent = response.choices[0]?.message?.content;
    if (!rawContent) {
      return {
        title: params.fallbackTitle,
        body: fallbackBody(params),
      };
    }

    try {
      const parsed = JSON.parse(rawContent) as { title?: string; body?: string };
      const title = parsed.title ? cleanLlmTitle(parsed.title) : '';
      const body = parsed.body?.trim() ?? '';
      return {
        title: title || params.fallbackTitle,
        body: body || fallbackBody(params),
      };
    } catch {
      return {
        title: params.fallbackTitle,
        body: fallbackBody(params),
      };
    }
  }
}
