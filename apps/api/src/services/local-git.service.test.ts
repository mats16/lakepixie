import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawnAsync } = vi.hoisted(() => ({
  mockSpawnAsync: vi.fn(),
}));

vi.mock('../utils/spawn.js', () => ({
  spawnAsync: mockSpawnAsync,
}));

import { getLocalGitCompareSummary } from './local-git.service.js';

describe('local-git.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('summarizes local git diff totals for a branch range', async () => {
    mockSpawnAsync.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'diff') {
        return { stdout: '9\t1\tREADME.md\n-\t-\timage.png\n', stderr: '' };
      }
      if (args[0] === 'rev-list') {
        return { stdout: '0\t2\n', stderr: '' };
      }
      throw new Error('unexpected command');
    });

    await expect(
      getLocalGitCompareSummary('/tmp/repo', 'acme', 'widgets', 'main', 'ccbricks/test')
    ).resolves.toEqual({
      html_url: 'https://github.com/acme/widgets/compare/main...ccbricks%2Ftest',
      ahead_by: 2,
      behind_by: 0,
      total_commits: 2,
      additions: 9,
      deletions: 1,
    });
    expect(mockSpawnAsync).toHaveBeenCalledWith(
      'git',
      ['diff', '--numstat', '--ignore-submodules=all', 'main...ccbricks/test'],
      expect.objectContaining({ cwd: '/tmp/repo' })
    );
    expect(mockSpawnAsync).toHaveBeenCalledWith(
      'git',
      ['rev-list', '--left-right', '--count', 'main...ccbricks/test'],
      expect.objectContaining({ cwd: '/tmp/repo' })
    );
  });
});
