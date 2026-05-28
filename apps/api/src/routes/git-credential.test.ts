import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const mockResolveGitCredentialRequest = vi.hoisted(() => vi.fn());

vi.mock('../services/git-credential.service.js', () => ({
  resolveGitCredentialRequest: mockResolveGitCredentialRequest,
}));

import gitCredentialRoute from './git-credential.js';

describe('git credential route', () => {
  it('handles authorized requests without a body as an empty credential request', async () => {
    mockResolveGitCredentialRequest.mockResolvedValue('');
    const app = Fastify({ logger: false });
    await app.register(gitCredentialRoute, { prefix: '/api' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/internal/git-credential',
      headers: {
        authorization: 'Bearer unknown-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');

    await app.close();
  });
});
