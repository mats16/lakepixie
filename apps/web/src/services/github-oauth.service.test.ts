import { describe, expect, it } from 'vitest';
import { githubOAuthService } from './github-oauth.service';

describe('githubOAuthService', () => {
  it('builds an authorization URL with the post-auth redirect path', () => {
    expect(githubOAuthService.getAuthorizeUrl('/?github=connected')).toBe(
      '/api/github/oauth/authorize?redirect_after=%2F%3Fgithub%3Dconnected'
    );
  });
});
