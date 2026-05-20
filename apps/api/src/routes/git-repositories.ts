import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type {
  ApiError,
  GitRepositoryBranchListResponse,
  GitRepositoryListResponse,
} from '@repo/types';
import {
  GitHubAppAuthNotConfiguredError,
  listGitHubAppRepositoryBranches,
  listGitHubAppRepositories,
} from '../services/github-app-auth.service.js';

function canUseEmptyRepositoryList(error: unknown): boolean {
  return (
    error instanceof GitHubAppAuthNotConfiguredError ||
    (error instanceof Error && error.message.includes('Service Principal token is not available'))
  );
}

function decodeRepositoryName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function setRepositoryCacheHeaders(reply: FastifyReply, maxAgeSeconds: number): void {
  reply.header('Cache-Control', `private, max-age=${maxAgeSeconds}`);
}

const REPOSITORIES_BROWSER_CACHE_SECONDS = 300;
const BRANCHES_BROWSER_CACHE_SECONDS = 60;

const gitRepositoriesRoute: FastifyPluginAsync = async fastify => {
  fastify.get<{ Querystring: { q?: string }; Reply: GitRepositoryListResponse | ApiError }>(
    '/repositories',
    async (request, reply) => {
      const { user } = request.ctx!;
      if (!user.id) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'User ID not found in request context',
          statusCode: 401,
        });
      }

      const searchQuery = request.query.q?.trim() ?? '';

      try {
        const repositories = await listGitHubAppRepositories(fastify, searchQuery);
        setRepositoryCacheHeaders(reply, REPOSITORIES_BROWSER_CACHE_SECONDS);
        return reply.send({ repositories });
      } catch (error) {
        if (canUseEmptyRepositoryList(error)) {
          fastify.log.debug({ error }, 'GitHub App auth is not configured for repository listing');
          return reply.send({ repositories: [] });
        }

        fastify.log.warn({ error }, 'Failed to list repositories from GitHub App installation');
        return reply.status(502).send({
          error: 'GitHub repository list unavailable',
          message: 'Failed to list repositories from GitHub App installation',
          statusCode: 502,
        });
      }
    }
  );

  fastify.get<{
    Params: { repo_name: string };
    Reply: GitRepositoryBranchListResponse | ApiError;
  }>('/repositories/:repo_name/branches', async (request, reply) => {
    const { user } = request.ctx!;
    if (!user.id) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'User ID not found in request context',
        statusCode: 401,
      });
    }

    const repository = decodeRepositoryName(request.params.repo_name);

    try {
      const branches = await listGitHubAppRepositoryBranches(fastify, repository);
      setRepositoryCacheHeaders(reply, BRANCHES_BROWSER_CACHE_SECONDS);
      return reply.send({ branches });
    } catch (error) {
      if (canUseEmptyRepositoryList(error)) {
        fastify.log.debug(
          { error, repository },
          'GitHub App auth is not configured for branch listing'
        );
        return reply.send({ branches: [] });
      }

      fastify.log.warn(
        { error, repository },
        'Failed to list branches from GitHub App installation'
      );
      return reply.status(502).send({
        error: 'GitHub repository branch list unavailable',
        message: 'Failed to list branches from GitHub App installation',
        statusCode: 502,
      });
    }
  });
};

export default gitRepositoriesRoute;
