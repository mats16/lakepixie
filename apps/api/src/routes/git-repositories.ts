import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import path from 'node:path';
import type {
  ApiError,
  GitRepositoryBranchDetailResponse,
  GitRepositoryBranchListResponse,
  GitRepositoryListResponse,
  GitRepositoryPullRequest,
  GitRepositoryPullRequestCreateRequest,
  GitRepositoryPullRequestListResponse,
  GitRepositoryPullRequestStateFilter,
} from '@repo/types';
import {
  createGitHubAppPullRequest,
  getGitHubAppPullRequest,
  getGitHubAppRepositoryBranch,
  GitHubAppAuthError,
  GitHubAppAuthNotConfiguredError,
  listGitHubAppPullRequests,
  listGitHubAppRepositoryBranches,
  listGitHubAppRepositories,
  normalizePullRequestCreateHead,
} from '../services/github-app-auth.service.js';
import { getLocalGitPullRequestContext } from '../services/local-git.service.js';
import {
  PullRequestMetadataService,
  readPullRequestTemplates,
} from '../services/pull-request-metadata.service.js';
import { getModelSettings } from '../services/admin.service.js';
import { getSession } from '../services/session.service.js';
import { createUserContext } from '../lib/user-context.js';
import { SessionId } from '../models/session.model.js';
import { validatePathWithinBase } from '../utils/path-validation.js';

function canUseEmptyRepositoryList(error: unknown): boolean {
  return (
    error instanceof GitHubAppAuthNotConfiguredError ||
    (error instanceof Error && error.message.includes('Service Principal token is not available'))
  );
}

function decodePathParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getRepositoryFullName(params: { owner: string; repo: string }): string {
  return `${decodePathParam(params.owner)}/${decodePathParam(params.repo)}`;
}

function setRepositoryCacheHeaders(reply: FastifyReply, maxAgeSeconds: number): void {
  reply.header('Cache-Control', `private, max-age=${maxAgeSeconds}`);
}

function getErrorDetails(error: unknown): unknown {
  if (error instanceof GitHubAppAuthError) {
    return error.details ?? error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseSessionId(value: string): SessionId | null {
  try {
    return SessionId.fromString(value);
  } catch {
    return null;
  }
}

const REPOSITORIES_BROWSER_CACHE_SECONDS = 300;
const BRANCHES_BROWSER_CACHE_SECONDS = 60;
const BRANCH_DETAIL_BROWSER_CACHE_SECONDS = 30;

const gitRepositoriesRoute: FastifyPluginAsync = async fastify => {
  fastify.get<{ Querystring: { q?: string }; Reply: GitRepositoryListResponse | ApiError }>(
    '/repos',
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
    Params: { owner: string; repo: string };
    Reply: GitRepositoryBranchListResponse | ApiError;
  }>('/repos/:owner/:repo/branches', async (request, reply) => {
    const { user } = request.ctx!;
    if (!user.id) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'User ID not found in request context',
        statusCode: 401,
      });
    }

    const repository = getRepositoryFullName(request.params);

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

  fastify.get<{
    Params: { owner: string; repo: string; branch_name: string };
    Querystring: { base?: string };
    Reply: GitRepositoryBranchDetailResponse | ApiError;
  }>('/repos/:owner/:repo/branches/:branch_name', async (request, reply) => {
    const { user } = request.ctx!;
    if (!user.id) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'User ID not found in request context',
        statusCode: 401,
      });
    }

    const repository = getRepositoryFullName(request.params);
    const branch = decodePathParam(request.params.branch_name);

    try {
      const branchDetail = await getGitHubAppRepositoryBranch(fastify, repository, branch);
      setRepositoryCacheHeaders(reply, BRANCH_DETAIL_BROWSER_CACHE_SECONDS);
      return reply.send(branchDetail);
    } catch (error) {
      fastify.log.warn({ error, repository, branch }, 'Failed to get GitHub branch details');
      return reply.status(502).send({
        error: 'GitHub repository branch unavailable',
        message: 'Failed to get GitHub branch details',
        details: getErrorDetails(error),
        statusCode: 502,
      });
    }
  });

  fastify.get<{
    Params: { owner: string; repo: string };
    Querystring: { head?: string; base?: string; state?: GitRepositoryPullRequestStateFilter };
    Reply: GitRepositoryPullRequestListResponse | ApiError;
  }>('/repos/:owner/:repo/pulls', async (request, reply) => {
    const { user } = request.ctx!;
    if (!user.id) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'User ID not found in request context',
        statusCode: 401,
      });
    }

    const repository = getRepositoryFullName(request.params);

    try {
      const pulls = await listGitHubAppPullRequests(fastify, repository, {
        head: request.query.head,
        base: request.query.base,
        state: request.query.state,
      });
      return reply.send({ pulls });
    } catch (error) {
      fastify.log.warn({ error, repository }, 'Failed to list GitHub pull requests');
      return reply.status(502).send({
        error: 'GitHub pull request list unavailable',
        message: 'Failed to list GitHub pull requests',
        details: getErrorDetails(error),
        statusCode: 502,
      });
    }
  });

  fastify.get<{
    Params: { owner: string; repo: string; pull_number: string };
    Reply: GitRepositoryPullRequest | ApiError;
  }>('/repos/:owner/:repo/pulls/:pull_number', async (request, reply) => {
    const { user } = request.ctx!;
    if (!user.id) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'User ID not found in request context',
        statusCode: 401,
      });
    }

    const repository = getRepositoryFullName(request.params);
    const pullNumber = Number(request.params.pull_number);
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'pull_number must be a positive integer',
        statusCode: 400,
      });
    }

    try {
      const pull = await getGitHubAppPullRequest(fastify, repository, pullNumber);
      return reply.send(pull);
    } catch (error) {
      fastify.log.warn({ error, repository, pullNumber }, 'Failed to get GitHub pull request');
      return reply.status(502).send({
        error: 'GitHub pull request unavailable',
        message: 'Failed to get GitHub pull request',
        details: getErrorDetails(error),
        statusCode: 502,
      });
    }
  });

  fastify.post<{
    Params: { owner: string; repo: string };
    Body: GitRepositoryPullRequestCreateRequest;
    Reply: GitRepositoryPullRequest | ApiError;
  }>('/repos/:owner/:repo/pulls', async (request, reply) => {
    const { user } = request.ctx!;
    if (!user.id) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'User ID not found in request context',
        statusCode: 401,
      });
    }

    const { head, base } = request.body;
    const requestedTitle = request.body.title?.trim() ?? '';
    const trimmedHead = head?.trim() ?? '';
    const trimmedBase = base?.trim() ?? '';
    const sessionIdValue = request.body.session_id?.trim() ?? '';
    const language = request.body.language?.trim();
    if (!requestedTitle || !trimmedHead || !trimmedBase) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'title, head, and base are required',
        statusCode: 400,
      });
    }

    const repository = getRepositoryFullName(request.params);

    try {
      let pullTitle = requestedTitle;
      let pullBody = request.body.body?.trim();

      if (sessionIdValue) {
        try {
          const sessionId = parseSessionId(sessionIdValue);
          if (!sessionId) {
            return reply.status(400).send({
              error: 'BadRequest',
              message: 'session_id must be a valid session ID',
              statusCode: 400,
            });
          }

          const session = await getSession(fastify, user.id, sessionId);
          const sessionContext = session?.session_context;
          if (!sessionContext) {
            return reply.status(404).send({
              error: 'NotFound',
              message: 'Session not found',
              statusCode: 404,
            });
          }

          const sessionsBaseDir = path.join(fastify.config.CCBRICKS_BASE_DIR, 'sessions');
          const cwd = await validatePathWithinBase(sessionContext.cwd, sessionsBaseDir);
          const localHead = normalizePullRequestCreateHead(
            decodePathParam(request.params.owner),
            trimmedHead
          );
          const [gitContext, templates, modelSettings] = await Promise.all([
            getLocalGitPullRequestContext(cwd, trimmedBase, localHead),
            readPullRequestTemplates(cwd),
            getModelSettings(fastify),
          ]);
          const ctx = createUserContext(fastify, request);
          const accessToken = await ctx.getAuthProvider().getToken();
          const metadataService = new PullRequestMetadataService({
            databricksHost: fastify.config.DATABRICKS_HOST,
          });
          const metadata = await metadataService.generateMetadata({
            accessToken,
            model: modelSettings.haikuModel,
            repository,
            base: trimmedBase,
            head: localHead,
            fallbackTitle: pullTitle,
            ...(language ? { language } : {}),
            ...(session.title ? { sessionTitle: session.title } : {}),
            gitContext,
            templates,
          });

          pullTitle = metadata.title;
          pullBody = metadata.body;
        } catch (error) {
          fastify.log.warn({ error, repository }, 'Failed to generate pull request metadata');
          return reply.status(502).send({
            error: 'Pull request metadata generation unavailable',
            message: 'Failed to generate pull request title and description',
            details: getErrorDetails(error),
            statusCode: 502,
          });
        }
      }

      const pull = await createGitHubAppPullRequest(fastify, repository, {
        title: pullTitle,
        ...(pullBody ? { body: pullBody } : {}),
        head: trimmedHead,
        base: trimmedBase,
        ...(request.body.draft !== undefined ? { draft: request.body.draft } : {}),
      });
      return reply.status(201).send(pull);
    } catch (error) {
      fastify.log.warn({ error, repository }, 'Failed to create GitHub pull request');
      return reply.status(502).send({
        error: 'GitHub pull request create unavailable',
        message: 'Failed to create GitHub pull request',
        details: getErrorDetails(error),
        statusCode: 502,
      });
    }
  });
};

export default gitRepositoriesRoute;
