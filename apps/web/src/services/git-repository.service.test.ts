import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitRepositoryService } from './git-repository.service';

describe('gitRepositoryService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses GitHub-shaped /api/repos URLs', async () => {
    await gitRepositoryService.search('widget');
    await gitRepositoryService.listBranches('acme/widgets');
    await gitRepositoryService.getBranch('acme/widgets', 'ccbricks/test', 'main');
    await gitRepositoryService.listPullRequests('acme/widgets', {
      head: 'acme:ccbricks/test',
      base: 'main',
      state: 'open',
    });
    await gitRepositoryService.getPullRequest('acme/widgets', 4);
    await gitRepositoryService.createPullRequest('acme/widgets', {
      title: 'Update widgets',
      body: 'Generated PR body',
      head: 'acme:ccbricks/test',
      base: 'main',
      draft: true,
      session_id: '019729a8-0000-7000-8000-000000000000',
      language: 'ja',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/repos?q=widget', { headers: {} });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/repos/acme/widgets/branches', {
      headers: {},
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/repos/acme/widgets/branches/ccbricks%2Ftest?base=main',
      { headers: {} }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/repos/acme/widgets/pulls?head=acme%3Accbricks%2Ftest&base=main&state=open',
      { headers: {} }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/repos/acme/widgets/pulls/4', {
      headers: {},
    });
    expect(fetchMock).toHaveBeenNthCalledWith(6, '/api/repos/acme/widgets/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Update widgets',
        body: 'Generated PR body',
        head: 'acme:ccbricks/test',
        base: 'main',
        draft: true,
        session_id: '019729a8-0000-7000-8000-000000000000',
        language: 'ja',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
  });
});
