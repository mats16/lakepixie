import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { FastifyPluginAsync } from 'fastify';
import type { UserResponse, ApiError } from '@repo/types';
import { getOrCreateUser } from '../services/user.service.js';

const require = createRequire(import.meta.url);

function tryReadVersionFromJson(path: string): string | null {
  try {
    const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof json === 'object' &&
      json !== null &&
      'version' in json &&
      typeof json.version === 'string'
    ) {
      return json.version;
    }
  } catch {
    // 本番パッケージング次第で manifest.json などが同梱されないことがあるため、
    // バージョン取得失敗時は null を返し、API 起動自体は継続させる
  }
  return null;
}

const claudeAgentSdkRoot = (() => {
  try {
    return dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
  } catch {
    return null;
  }
})();
const claudeAgentSdkVersion = claudeAgentSdkRoot
  ? tryReadVersionFromJson(join(claudeAgentSdkRoot, 'package.json'))
  : null;
const claudeCodeVersion = claudeAgentSdkRoot
  ? tryReadVersionFromJson(join(claudeAgentSdkRoot, 'manifest.json'))
  : null;

const userRoute: FastifyPluginAsync = async fastify => {
  fastify.get<{ Reply: UserResponse | ApiError }>('/user', async (request, reply) => {
    // preHandlerで必ず設定されるため、ctxは常に存在する
    const { user: requestUser } = request.ctx!;

    if (!requestUser.id) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'User ID not found in request context',
        statusCode: 401,
      });
    }

    const user = await getOrCreateUser(fastify, {
      id: requestUser.id,
      name: requestUser.name,
      email: requestUser.email,
    });

    return reply.send({
      user,
      databricks_host: fastify.config.DATABRICKS_HOST,
      claude_agent_sdk_version: claudeAgentSdkVersion,
      claude_code_version: claudeCodeVersion,
    });
  });
};

export default userRoute;
