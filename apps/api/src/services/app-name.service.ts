import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import type { GenerateAppMetadataResponse, GenerateAppNameResponse } from '@repo/types';

const APP_METADATA_GENERATION_PROMPT = `Generate concise Databricks App metadata from the provided context.

Rules for name:
- Return a short lowercase English slug.
- Use only words that describe the app or project.
- Do not include random suffixes, dates, user names, or workspace paths.
- Do not include a "databricks" or "app" prefix unless it is meaningfully part of the project.

Rules for description:
- Return one short sentence describing what the app does.
- Do not mention internal workspace paths, user emails, or implementation details.
- Keep it under 160 characters.

Respond in the specified JSON format.

Context:
`;

const MAX_TOKENS = 180;
const REQUEST_TIMEOUT_MS = 30_000;
const APP_NAME_MAX_LENGTH = 30;
const APP_NAME_SUFFIX_LENGTH = 8;
const FALLBACK_APP_NAME = 'generated-app';
const APP_DESCRIPTION_MAX_LENGTH = 500;
const FALLBACK_APP_DESCRIPTION = 'App created from a ccbricks session.';

const RESPONSE_FORMAT: OpenAI.ChatCompletionCreateParams['response_format'] = {
  type: 'json_schema',
  json_schema: {
    name: 'app_metadata_response',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['name', 'description'],
      additionalProperties: false,
    },
  },
};

function getContextSuffix(context: string): string {
  return createHash('sha256').update(context.trim()).digest('hex').slice(0, APP_NAME_SUFFIX_LENGTH);
}

function toAppNameSlug(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return slug || null;
}

export function buildDatabricksAppName(candidate: string, context: string): string {
  const suffix = getContextSuffix(context);
  const base = toAppNameSlug(candidate) ?? toAppNameSlug(context) ?? FALLBACK_APP_NAME;
  const maxBaseLength = APP_NAME_MAX_LENGTH - suffix.length - 1;
  const trimmedBase = base.slice(0, maxBaseLength).replace(/-+$/g, '') || FALLBACK_APP_NAME;
  return `${trimmedBase}-${suffix}`;
}

export function isValidDatabricksAppName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])$/.test(name);
}

function buildDatabricksAppDescription(candidate: string): string {
  const description = candidate.trim().replace(/\s+/g, ' ').slice(0, APP_DESCRIPTION_MAX_LENGTH);
  return description || FALLBACK_APP_DESCRIPTION;
}

function buildFallbackAppMetadata(context: string): GenerateAppMetadataResponse {
  return {
    name: buildDatabricksAppName('', context),
    description: FALLBACK_APP_DESCRIPTION,
  };
}

function parseAppMetadata(rawContent: string, context: string): GenerateAppMetadataResponse {
  const parsed = JSON.parse(rawContent) as { name?: string; description?: string };
  return {
    name: buildDatabricksAppName(parsed.name ?? '', context),
    description: buildDatabricksAppDescription(parsed.description ?? ''),
  };
}

export interface AppNameServiceConfig {
  databricksHost: string;
}

export interface GenerateAppNameParams {
  context: string;
  accessToken: string;
  model: string;
}

export class AppNameService {
  constructor(private readonly config: AppNameServiceConfig) {}

  async generateAppMetadata(params: GenerateAppNameParams): Promise<GenerateAppMetadataResponse> {
    const { context, accessToken, model } = params;
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
          content: APP_METADATA_GENERATION_PROMPT + context,
        },
      ],
    });

    const rawContent = response.choices[0]?.message?.content;
    if (!rawContent) {
      return buildFallbackAppMetadata(context);
    }

    try {
      return parseAppMetadata(rawContent, context);
    } catch {
      return buildFallbackAppMetadata(context);
    }
  }

  async generateAppName(params: GenerateAppNameParams): Promise<GenerateAppNameResponse> {
    const metadata = await this.generateAppMetadata(params);
    return { name: metadata.name };
  }
}
