import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ApiError, GitHubOAuthAuthorizationResponse } from '@repo/types';
import {
  completeGitHubOAuthCallback,
  createGitHubOAuthAuthorizationUrl,
  deleteGitHubOAuthStateByState,
  getGitHubOAuthAuthorizationStatus,
  GitHubOAuthError,
  GitHubOAuthNotConfiguredError,
  revokeGitHubOAuthAuthorization,
} from '../services/github-oauth.service.js';

function getConfiguredOrigin(request: FastifyRequest): string | null {
  const configuredUrl = request.server.config.DATABRICKS_APP_URL.trim();
  if (!configuredUrl) return null;

  try {
    return new URL(configuredUrl).origin;
  } catch {
    request.log.warn({ configuredUrl }, 'Ignoring invalid DATABRICKS_APP_URL');
    return null;
  }
}

function getExternalOrigin(request: FastifyRequest): string {
  const configuredOrigin = getConfiguredOrigin(request);
  if (configuredOrigin) return configuredOrigin;

  if (request.server.config.NODE_ENV === 'production') {
    return `https://${request.server.config.DATABRICKS_HOST}`;
  }

  const forwardedHost = request.headers['x-forwarded-host'];
  const forwardedProto = request.headers['x-forwarded-proto'];
  const origin = request.headers.origin;
  const referer = request.headers.referer;

  if (typeof forwardedHost === 'string' && forwardedHost.trim()) {
    const proto =
      typeof forwardedProto === 'string' && forwardedProto.trim() ? forwardedProto : 'https';
    return `${proto}://${forwardedHost}`;
  }

  if (typeof origin === 'string' && origin.trim()) return origin;
  if (typeof referer === 'string' && referer.trim()) {
    try {
      return new URL(referer).origin;
    } catch {
      // Fall through to the request host.
    }
  }

  return `${request.protocol}://${request.headers.host ?? request.hostname}`;
}

export function getGitHubOAuthRedirectUri(request: FastifyRequest): string {
  return `${getExternalOrigin(request)}/api/github/oauth/callback`;
}

function sanitizeRedirectAfter(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return '/settings';
  }
  return value;
}

function appendGithubResult(path: string, result: 'connected' | 'error'): string {
  const url = new URL(path, 'https://ccbricks.local');
  url.searchParams.set('github', result);
  return `${url.pathname}${url.search}${url.hash}`;
}

function sendUnauthorized(): ApiError {
  return {
    error: 'Unauthorized',
    message: 'User ID not found in request context',
    statusCode: 401,
  };
}

const githubOAuthRoute: FastifyPluginAsync = async fastify => {
  fastify.get<{ Reply: GitHubOAuthAuthorizationResponse | ApiError }>(
    '/github/oauth/authorization',
    async (request, reply) => {
      const userId = request.ctx?.user.id;
      if (!userId) return reply.status(401).send(sendUnauthorized());

      const status = await getGitHubOAuthAuthorizationStatus(fastify, userId);
      return reply.send(status);
    }
  );

  fastify.get<{
    Querystring: { redirect_after?: string };
    Reply: ApiError;
  }>('/github/oauth/authorize', async (request, reply) => {
    const userId = request.ctx?.user.id;
    if (!userId) return reply.status(401).send(sendUnauthorized());

    try {
      const authorizationUrl = await createGitHubOAuthAuthorizationUrl({
        fastify,
        userId,
        redirectUri: getGitHubOAuthRedirectUri(request),
        redirectAfter: sanitizeRedirectAfter(request.query.redirect_after),
      });
      return reply.redirect(authorizationUrl);
    } catch (error) {
      if (error instanceof GitHubOAuthNotConfiguredError) {
        return reply.status(503).send({
          error: 'GitHubOAuthNotConfigured',
          message: 'GitHub OAuth is not configured',
          statusCode: 503,
        });
      }
      throw error;
    }
  });

  fastify.get<{
    Querystring: { code?: string; state?: string; error?: string };
    Reply: ApiError;
  }>('/github/oauth/callback', async (request, reply) => {
    const userId = request.ctx?.user.id;
    const fallbackRedirect = appendGithubResult('/settings', 'error');
    if (!userId) {
      if (request.query.state) {
        await deleteGitHubOAuthStateByState(fastify, request.query.state).catch(error => {
          fastify.log.warn({ error }, 'Failed to delete orphan GitHub OAuth state');
        });
      }
      return reply.redirect(fallbackRedirect);
    }

    if (request.query.error || !request.query.code || !request.query.state) {
      return reply.redirect(fallbackRedirect);
    }

    try {
      const redirectAfter = await completeGitHubOAuthCallback({
        fastify,
        userId,
        code: request.query.code,
        state: request.query.state,
        redirectUri: getGitHubOAuthRedirectUri(request),
      });
      return reply.redirect(appendGithubResult(redirectAfter, 'connected'));
    } catch (error) {
      fastify.log.warn({ error, userId }, 'GitHub OAuth callback failed');
      if (error instanceof GitHubOAuthError || error instanceof GitHubOAuthNotConfiguredError) {
        return reply.redirect(fallbackRedirect);
      }
      throw error;
    }
  });

  fastify.post<{ Reply: { success: true } | ApiError }>(
    '/github/oauth/revoke',
    async (request, reply) => {
      const userId = request.ctx?.user.id;
      if (!userId) return reply.status(401).send(sendUnauthorized());

      try {
        await revokeGitHubOAuthAuthorization(fastify, userId);
        return reply.send({ success: true });
      } catch (error) {
        if (error instanceof GitHubOAuthError || error instanceof GitHubOAuthNotConfiguredError) {
          return reply.status(502).send({
            error: 'GitHubOAuthRevokeFailed',
            message: 'Failed to revoke GitHub OAuth authorization',
            statusCode: 502,
          });
        }
        throw error;
      }
    }
  );
};

export default githubOAuthRoute;
