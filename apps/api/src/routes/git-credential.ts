import { FastifyPluginAsync } from 'fastify';
import type { ApiError } from '@repo/types';
import { resolveGitCredentialRequest } from '../services/git-credential.service.js';

interface GitCredentialRequestBody {
  input?: string;
}

const gitCredentialRoute: FastifyPluginAsync = async fastify => {
  fastify.post<{
    Body: GitCredentialRequestBody | undefined;
    Reply: string | ApiError;
  }>(
    '/internal/git-credential',
    {
      attachValidation: true,
      schema: {
        body: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
    },
    async (request, reply) => {
      const authorization = request.headers.authorization ?? '';
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Missing credential helper authorization',
          statusCode: 401,
        });
      }

      const input = typeof request.body?.input === 'string' ? request.body.input : '';
      const output = await resolveGitCredentialRequest(fastify, match[1], input);
      return reply.type('text/plain').send(output);
    }
  );
};

export default gitCredentialRoute;
