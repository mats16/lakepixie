import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawnAsync } = vi.hoisted(() => ({
  mockSpawnAsync: vi.fn(),
}));

vi.mock('../utils/spawn.js', () => ({
  spawnAsync: mockSpawnAsync,
}));

import { getLocalGitDiffSummary } from './local-git.service.js';

describe('local-git.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('summarizes local git diff totals for a branch range', async () => {
    mockSpawnAsync.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'merge-base') {
        return { stdout: 'abc123\n', stderr: '' };
      }
      if (args[0] === 'diff') {
        return { stdout: '9\t1\tREADME.md\n-\t-\timage.png\n', stderr: '' };
      }
      if (args[0] === 'rev-list') {
        return { stdout: '0\t2\n', stderr: '' };
      }
      if (args[0] === 'ls-files') {
        return { stdout: '', stderr: '' };
      }
      throw new Error('unexpected command');
    });

    await expect(getLocalGitDiffSummary('/tmp/repo', 'main', 'ccbricks/test')).resolves.toEqual({
      ahead_by: 2,
      behind_by: 0,
      total_commits: 2,
      additions: 9,
      deletions: 1,
    });
    expect(mockSpawnAsync).toHaveBeenCalledWith(
      'git',
      ['merge-base', 'main', 'ccbricks/test'],
      expect.objectContaining({ cwd: '/tmp/repo' })
    );
    expect(mockSpawnAsync).toHaveBeenCalledWith(
      'git',
      ['diff', '--numstat', '--ignore-submodules=all', 'abc123'],
      expect.objectContaining({ cwd: '/tmp/repo' })
    );
    expect(mockSpawnAsync).toHaveBeenCalledWith(
      'git',
      ['rev-list', '--left-right', '--count', 'main...ccbricks/test'],
      expect.objectContaining({ cwd: '/tmp/repo' })
    );
    expect(mockSpawnAsync).toHaveBeenCalledWith(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      expect.objectContaining({ cwd: '/tmp/repo' })
    );
  });

  it('includes untracked text file additions in local diff totals', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ccbricks-local-git-'));
    try {
      await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
      await fs.writeFile(path.join(cwd, 'src', 'new.ts'), 'one\ntwo\nthree', 'utf8');

      mockSpawnAsync.mockImplementation(async (_command: string, args: string[]) => {
        if (args[0] === 'merge-base') {
          return { stdout: 'abc123\n', stderr: '' };
        }
        if (args[0] === 'diff') {
          return { stdout: '4\t2\tREADME.md\n', stderr: '' };
        }
        if (args[0] === 'rev-list') {
          return { stdout: '0\t1\n', stderr: '' };
        }
        if (args[0] === 'ls-files') {
          return { stdout: 'src/new.ts\0', stderr: '' };
        }
        throw new Error('unexpected command');
      });

      await expect(getLocalGitDiffSummary(cwd, 'main', 'ccbricks/test')).resolves.toMatchObject({
        additions: 7,
        deletions: 2,
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('throws when merge-base does not find a common ancestor', async () => {
    mockSpawnAsync.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'merge-base') {
        return { stdout: '\n', stderr: '' };
      }
      if (args[0] === 'rev-list') {
        return { stdout: '0\t0\n', stderr: '' };
      }
      if (args[0] === 'ls-files') {
        return { stdout: '', stderr: '' };
      }
      throw new Error('unexpected command');
    });

    await expect(getLocalGitDiffSummary('/tmp/repo', 'main', 'ccbricks/test')).rejects.toThrow(
      'No common ancestor between main and ccbricks/test'
    );
    expect(mockSpawnAsync).not.toHaveBeenCalledWith(
      'git',
      ['diff', '--numstat', '--ignore-submodules=all', expect.any(String)],
      expect.anything()
    );
  });
});
