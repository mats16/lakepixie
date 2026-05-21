import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import type { GenerateTitleResponse } from '@repo/types';
import { cleanLlmTitle } from '../utils/llm-text.js';

const TITLE_GENERATION_PROMPT = `Generate a short, concise title (3-6 words) and a branch name slug for a coding session based on the following first message.

Rules for branch_name:
- Lowercase English words, numbers, and hyphens only (regex: /^[a-z0-9][a-z0-9-]*$/)
- Maximum 48 characters
- Descriptive and derived from the message content
- Do not include a "ccbricks/" prefix, "refs/heads/" prefix, or a random suffix

Respond in the specified JSON format.

Message: `;

const MAX_TOKENS = 150;
const FALLBACK_TITLE = 'General coding session';
const FALLBACK_BRANCH_SLUG = 'general-coding-session';
const REQUEST_TIMEOUT_MS = 30_000;

const BRANCH_PREFIX = 'ccbricks';
const BRANCH_SLUG_MAX_LENGTH = 48;

const RESPONSE_FORMAT: OpenAI.ChatCompletionCreateParams['response_format'] = {
  type: 'json_schema',
  json_schema: {
    name: 'title_response',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        branch_name: { type: 'string' },
      },
      required: ['title', 'branch_name'],
      additionalProperties: false,
    },
  },
};

function toBranchSlug(value: string): string | null {
  const slug = value
    .trim()
    .replace(/^refs\/heads\//i, '')
    .replace(new RegExp(`^${BRANCH_PREFIX}/`, 'i'), '')
    .replace(/-[a-f0-9]{8}$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, BRANCH_SLUG_MAX_LENGTH)
    .replace(/-$/g, '');

  return slug || null;
}

function resolveBranchSlug(...candidates: string[]): string {
  for (const candidate of candidates) {
    const slug = toBranchSlug(candidate);
    if (slug) return slug;
  }
  return FALLBACK_BRANCH_SLUG;
}

function generateBranchName(...slugCandidates: string[]): string {
  const safeSlug = resolveBranchSlug(...slugCandidates);
  const shortId = randomUUID().replaceAll('-', '').slice(0, 8);
  return `${BRANCH_PREFIX}/${safeSlug}-${shortId}`;
}

export interface TitleServiceConfig {
  databricksHost: string;
}

export interface GenerateTitleParams {
  firstSessionMessage: string;
  accessToken: string;
}

export class TitleService {
  private readonly config: TitleServiceConfig;

  constructor(config: TitleServiceConfig) {
    this.config = config;
  }

  /**
   * Generates a title and branch name for a coding session based on the first message.
   * Uses structured output (JSON schema) for reliable parsing.
   * @throws Error if the LLM call fails
   */
  async generateTitle(
    params: GenerateTitleParams & { model: string }
  ): Promise<GenerateTitleResponse> {
    const { firstSessionMessage, accessToken, model } = params;

    const client = new OpenAI({
      baseURL: `https://${this.config.databricksHost}/serving-endpoints`,
      apiKey: accessToken,
      timeout: REQUEST_TIMEOUT_MS,
    });

    const response = await client.chat.completions.create({
      model,
      max_tokens: MAX_TOKENS,
      response_format: RESPONSE_FORMAT,
      messages: [
        {
          role: 'user',
          content: TITLE_GENERATION_PROMPT + firstSessionMessage,
        },
      ],
    });

    const rawContent = response.choices[0]?.message?.content;

    if (!rawContent) {
      return {
        title: FALLBACK_TITLE,
        branch_name: generateBranchName(firstSessionMessage),
      };
    }

    try {
      const parsed = JSON.parse(rawContent) as { title?: string; branch_name?: string };

      const title = parsed.title ? cleanLlmTitle(parsed.title) : '';
      const safeTitle = title || FALLBACK_TITLE;

      return {
        title: safeTitle,
        branch_name: generateBranchName(parsed.branch_name ?? '', safeTitle, firstSessionMessage),
      };
    } catch {
      return {
        title: FALLBACK_TITLE,
        branch_name: generateBranchName(firstSessionMessage),
      };
    }
  }
}
