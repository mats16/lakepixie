import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HookInput, StopHookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  createStopHookGitCheck,
  runStopHookGitCheck,
  type GitCommandRunner,
} from './stop-hook-git-check.service.js';

interface MockGitResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

const baseInput: StopHookInput = {
  hook_event_name: 'Stop',
  session_id: 'session-123',
  transcript_path: '/tmp/transcript.jsonl',
  cwd: '/tmp/repo',
  stop_hook_active: false,
};

const sessionGitRoot: MockGitResult = { stdout: `${baseInput.cwd}\n` };

function createGitRunner(results: MockGitResult[]): GitCommandRunner {
  return vi.fn<GitCommandRunner>(async () => {
    const result = results.shift();
    if (!result) throw new Error('Unexpected git command');
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  });
}

describe('stop-hook-git-check.service', () => {
  it('does nothing when the stop hook is already active', async () => {
    const git = createGitRunner([]);

    await expect(
      runStopHookGitCheck({ ...baseInput, stop_hook_active: true }, { git })
    ).resolves.toEqual({ continue: true });

    expect(git).not.toHaveBeenCalled();
  });

  it('does nothing outside a git repository', async () => {
    const git = createGitRunner([{ exitCode: 1 }]);

    await expect(runStopHookGitCheck(baseInput, { git })).resolves.toEqual({ continue: true });

    expect(git).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], {
      cwd: '/tmp/repo',
      signal: undefined,
    });
  });

  it('does nothing when git is discovered above the session cwd', async () => {
    const git = createGitRunner([{ stdout: '/tmp\n' }]);

    await expect(runStopHookGitCheck(baseInput, { git })).resolves.toEqual({ continue: true });

    expect(git).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], {
      cwd: '/tmp/repo',
      signal: undefined,
    });
    expect(git).toHaveBeenCalledTimes(1);
  });

  it('continues checking when git root and session cwd resolve to the same path', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ccbricks-stop-hook-'));

    try {
      const repoDir = path.join(tempDir, 'repo');
      const symlinkDir = path.join(tempDir, 'repo-link');
      await mkdir(repoDir);
      await symlink(repoDir, symlinkDir, 'dir');

      const git = createGitRunner([{ stdout: `${await realpath(repoDir)}\n` }, { stdout: '' }]);
      const input = { ...baseInput, cwd: symlinkDir };

      await expect(runStopHookGitCheck(input, { git })).resolves.toEqual({ continue: true });

      expect(git).toHaveBeenCalledWith(['remote'], {
        cwd: symlinkDir,
        signal: undefined,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does nothing when the repository has no remote', async () => {
    const git = createGitRunner([sessionGitRoot, { stdout: '' }]);

    await expect(runStopHookGitCheck(baseInput, { git })).resolves.toEqual({ continue: true });

    expect(git).toHaveBeenCalledTimes(2);
  });

  it('blocks when staged or unstaged changes exist', async () => {
    const git = createGitRunner([sessionGitRoot, { stdout: 'origin\n' }, { exitCode: 1 }]);

    await expect(runStopHookGitCheck(baseInput, { git })).resolves.toEqual({
      decision: 'block',
      reason:
        'There are uncommitted changes in the repository. Please commit and push these changes to the remote branch.',
    });

    expect(git).toHaveBeenCalledWith(['diff', '--quiet'], {
      cwd: '/tmp/repo',
      signal: undefined,
    });
  });

  it('blocks when only staged changes exist', async () => {
    const git = createGitRunner([sessionGitRoot, { stdout: 'origin\n' }, {}, { exitCode: 1 }]);

    await expect(runStopHookGitCheck(baseInput, { git })).resolves.toEqual({
      decision: 'block',
      reason:
        'There are uncommitted changes in the repository. Please commit and push these changes to the remote branch.',
    });

    expect(git).toHaveBeenCalledWith(['diff', '--cached', '--quiet'], {
      cwd: '/tmp/repo',
      signal: undefined,
    });
  });

  it('blocks when untracked files exist', async () => {
    const git = createGitRunner([
      sessionGitRoot,
      { stdout: 'origin\n' },
      {},
      {},
      { stdout: 'new-file.ts\n' },
    ]);

    await expect(runStopHookGitCheck(baseInput, { git })).resolves.toEqual({
      decision: 'block',
      reason:
        'There are untracked files in the repository. Please commit and push these changes to the remote branch.',
    });
  });

  it('blocks when the current branch has unpushed commits on its remote branch', async () => {
    const git = createGitRunner([
      sessionGitRoot,
      { stdout: 'origin\n' },
      {},
      {},
      { stdout: '' },
      { stdout: 'feature/test\n' },
      { stdout: 'abc123\n' },
      { stdout: '2\n' },
    ]);

    await expect(runStopHookGitCheck(baseInput, { git })).resolves.toEqual({
      decision: 'block',
      reason:
        "There are 2 unpushed commit(s) on branch 'feature/test'. Please push these changes to the remote repository.",
    });
  });

  it('blocks when the current branch has no remote branch but is ahead of origin HEAD', async () => {
    const git = createGitRunner([
      sessionGitRoot,
      { stdout: 'origin\n' },
      {},
      {},
      { stdout: '' },
      { stdout: 'feature/test\n' },
      { exitCode: 1 },
      { stdout: '3\n' },
    ]);

    await expect(runStopHookGitCheck(baseInput, { git })).resolves.toEqual({
      decision: 'block',
      reason:
        "Branch 'feature/test' has 3 unpushed commit(s) and no remote branch. Please push these changes to the remote repository.",
    });
  });

  it('does not block when rev-list fails for a branch without a remote branch', async () => {
    const git = createGitRunner([
      sessionGitRoot,
      { stdout: 'origin\n' },
      {},
      {},
      { stdout: '' },
      { stdout: 'feature/test\n' },
      { exitCode: 1 },
      { exitCode: 1 },
    ]);

    await expect(runStopHookGitCheck(baseInput, { git })).resolves.toEqual({ continue: true });
  });

  it('creates an SDK Stop hook callback', async () => {
    const git = createGitRunner([{ exitCode: 1 }]);
    const callback = createStopHookGitCheck(git);
    const sessionStartInput: HookInput = {
      hook_event_name: 'SessionStart',
      session_id: 'session-123',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/repo',
      source: 'startup',
    };

    await expect(
      callback(baseInput, undefined, { signal: new AbortController().signal })
    ).resolves.toEqual({ continue: true });
    await expect(
      callback(sessionStartInput, undefined, {
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ continue: true });
  });
});
