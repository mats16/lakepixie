import { describe, expect, it } from 'vitest';
import {
  __testing,
  parseGitHubRepository,
  toGitHubRepositoryFullName,
} from './github-oauth.service.js';

describe('github-oauth.service', () => {
  it('creates RFC 7636 S256 PKCE code challenges', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    expect(__testing.createCodeChallenge(verifier)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });

  it('normalizes GitHub repository identifiers without accepting other hosts', () => {
    expect(parseGitHubRepository('https://github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
    expect(toGitHubRepositoryFullName('acme/widgets')).toBe('acme/widgets');
    expect(() => parseGitHubRepository('https://gitlab.com/acme/widgets')).toThrow(
      'Only HTTPS GitHub repository URLs are supported'
    );
  });
});
