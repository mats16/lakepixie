import OpenAI from 'openai';
import { typeid } from 'typeid-js';
import { randomUUID } from 'node:crypto';
import type { GenerateTitleResponse } from '@repo/types';

// Constants for title generation
const TITLE_GENERATION_PROMPT = `Generate a short, concise title (3-6 words) and a Databricks Apps app_name for a coding session based on the following first message.

Rules for app_name:
- Lowercase alphanumeric characters and hyphens only (regex: /^[a-z0-9][a-z0-9-]*$/)
- Maximum 26 characters
- Descriptive and derived from the title

Respond in the specified JSON format.

Message: `;

const MAX_TOKENS = 150;
const FALLBACK_TITLE = 'General coding session';
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds

const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const APP_NAME_MAX_LENGTH = 26;

const RESPONSE_FORMAT: OpenAI.ChatCompletionCreateParams['response_format'] = {
  type: 'json_schema',
  json_schema: {
    name: 'title_response',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        app_name: { type: 'string' },
      },
      required: ['title', 'app_name'],
      additionalProperties: false,
    },
  },
};

/**
 * Cleans up the generated title by removing common LLM artifacts.
 * - Removes surrounding quotes (single, double, backticks)
 * - Removes markdown formatting
 * - Trims whitespace
 */
function cleanTitle(rawTitle: string): string {
  let cleaned = rawTitle.trim();

  // Remove surrounding quotes (", ', `)
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('`') && cleaned.endsWith('`'))
  ) {
    cleaned = cleaned.slice(1, -1);
  }

  // Remove markdown bold/italic
  cleaned = cleaned.replace(/\*\*/g, '').replace(/\*/g, '');

  // Remove markdown code formatting
  cleaned = cleaned.replace(/`/g, '');

  return cleaned.trim();
}

/**
 * Validates that app_name matches the required pattern and length.
 */
function isValidAppName(appName: string): boolean {
  return (
    appName.length > 0 && appName.length <= APP_NAME_MAX_LENGTH && APP_NAME_PATTERN.test(appName)
  );
}

/**
 * Generates a fallback app_name using typeid (no prefix).
 * Format: {base32_uuidv7} (exactly 26 characters)
 */
function generateFallbackAppName(): string {
  return typeid().toString().replaceAll('_', '-');
}

function generateBranchName(appName: string): string {
  const safeAppName = isValidAppName(appName) ? appName : 'session';
  const shortId = randomUUID().replaceAll('-', '').slice(0, 8);
  return `ccbricks/${safeAppName}-${shortId}`;
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
   * Generates a title and app_name for a coding session based on the first message.
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
      const appName = generateFallbackAppName();
      return {
        title: FALLBACK_TITLE,
        app_name: appName,
        branch_name: generateBranchName(appName),
      };
    }

    try {
      const parsed = JSON.parse(rawContent) as { title?: string; app_name?: string };

      const title = parsed.title ? cleanTitle(parsed.title) : '';
      const appName = parsed.app_name ?? '';
      const safeAppName = isValidAppName(appName) ? appName : generateFallbackAppName();

      return {
        title: title || FALLBACK_TITLE,
        app_name: safeAppName,
        branch_name: generateBranchName(safeAppName),
      };
    } catch {
      const appName = generateFallbackAppName();
      return {
        title: FALLBACK_TITLE,
        app_name: appName,
        branch_name: generateBranchName(appName),
      };
    }
  }
}
