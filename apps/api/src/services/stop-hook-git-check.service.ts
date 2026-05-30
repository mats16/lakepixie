import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  StopHookInput,
} from '@anthropic-ai/claude-agent-sdk';

const STOP_HOOK_GIT_COMMAND_TIMEOUT_MS = 60_000;
const STOP_HOOK_GIT_COMMAND_KILL_GRACE_MS = 1_000;
const UNCOMMITTED_CHANGES_MESSAGE =
  'There are uncommitted changes in the repository. Please commit and push these changes to the remote branch.';
const UNTRACKED_FILES_MESSAGE =
  'There are untracked files in the repository. Please commit and push these changes to the remote branch.';

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface GitCommandOptions {
  cwd: string;
  signal?: AbortSignal;
}

export type GitCommandRunner = (
  args: string[],
  options: GitCommandOptions
) => Promise<GitCommandResult>;

function continueHook(): HookJSONOutput {
  return { continue: true };
}

function blockHook(reason: string): HookJSONOutput {
  return { decision: 'block', reason };
}

function isStopHookInput(input: HookInput): input is StopHookInput {
  return input.hook_event_name === 'Stop';
}

function parsePositiveCount(stdout: string): number {
  const count = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function parseLsRemoteHead(stdout: string): string | null {
  const [objectId] = stdout.trim().split(/\s+/);
  return objectId || null;
}

async function resolveComparablePath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function isSameFilesystemPath(left: string, right: string): Promise<boolean> {
  if (left === '' || right === '') return false;
  const [resolvedLeft, resolvedRight] = await Promise.all([
    resolveComparablePath(left),
    resolveComparablePath(right),
  ]);
  return resolvedLeft === resolvedRight;
}

async function countUnpushedCommits(
  git: GitCommandRunner,
  cwd: string,
  range: string,
  signal: AbortSignal | undefined
): Promise<number> {
  const result = await git(['rev-list', range, '--count'], { cwd, signal });
  if (result.exitCode !== 0) return 0;
  return parsePositiveCount(result.stdout);
}

export async function defaultGitCommandRunner(
  args: string[],
  options: GitCommandOptions
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      shell: false,
      signal: options.signal,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killGraceTimeoutId: NodeJS.Timeout | null = null;

    const timeoutId = setTimeout(() => {
      stderr += `Command timed out after ${STOP_HOOK_GIT_COMMAND_TIMEOUT_MS}ms`;
      child.kill('SIGTERM');
      killGraceTimeoutId = setTimeout(() => {
        child.kill('SIGKILL');
        settle({ exitCode: 1, stdout, stderr });
      }, STOP_HOOK_GIT_COMMAND_KILL_GRACE_MS);
    }, STOP_HOOK_GIT_COMMAND_TIMEOUT_MS);

    function settle(result: GitCommandResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (killGraceTimeoutId) clearTimeout(killGraceTimeoutId);
      resolve(result);
    }

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', code => {
      settle({
        exitCode: typeof code === 'number' ? code : 1,
        stdout,
        stderr,
      });
    });

    child.on('error', error => {
      if (settled) return;
      clearTimeout(timeoutId);
      if (killGraceTimeoutId) clearTimeout(killGraceTimeoutId);
      if (error.name === 'AbortError') {
        settled = true;
        reject(error);
        return;
      }
      settle({ exitCode: 1, stdout, stderr: stderr || error.message });
    });
  });
}

export async function runStopHookGitCheck(
  input: StopHookInput,
  options: { git?: GitCommandRunner; signal?: AbortSignal } = {}
): Promise<HookJSONOutput> {
  if (input.stop_hook_active) return continueHook();

  const git = options.git ?? defaultGitCommandRunner;
  const { cwd } = input;
  const signal = options.signal;

  const gitRoot = await git(['rev-parse', '--show-toplevel'], { cwd, signal });
  if (gitRoot.exitCode !== 0) return continueHook();

  const gitRootPath = gitRoot.stdout.trim();
  const isSessionGitRoot = await isSameFilesystemPath(gitRootPath, cwd);
  if (!isSessionGitRoot) {
    return continueHook();
  }

  const remotes = await git(['remote'], { cwd, signal });
  if (remotes.stdout.trim() === '') return continueHook();

  const unstagedDiff = await git(['diff', '--quiet'], { cwd, signal });
  if (unstagedDiff.exitCode !== 0) return blockHook(UNCOMMITTED_CHANGES_MESSAGE);

  const stagedDiff = await git(['diff', '--cached', '--quiet'], { cwd, signal });
  if (stagedDiff.exitCode !== 0) return blockHook(UNCOMMITTED_CHANGES_MESSAGE);

  const untrackedFiles = await git(['ls-files', '--others', '--exclude-standard'], {
    cwd,
    signal,
  });
  if (untrackedFiles.stdout.trim() !== '') {
    return blockHook(UNTRACKED_FILES_MESSAGE);
  }

  const branch = await git(['branch', '--show-current'], { cwd, signal });
  const currentBranch = branch.stdout.trim();
  if (!currentBranch) return continueHook();

  const head = await git(['rev-parse', 'HEAD'], { cwd, signal });
  const localHead = head.stdout.trim();
  if (head.exitCode !== 0 || !localHead) return continueHook();

  const remoteBranch = await git(['ls-remote', 'origin', `refs/heads/${currentBranch}`], {
    cwd,
    signal,
  });
  if (remoteBranch.exitCode !== 0) return continueHook();

  const remoteHead = parseLsRemoteHead(remoteBranch.stdout);
  if (remoteHead) {
    if (remoteHead === localHead) return continueHook();

    const unpushed = await countUnpushedCommits(git, cwd, `${remoteHead}..HEAD`, signal);
    if (unpushed > 0) {
      return blockHook(
        `There are ${unpushed} unpushed commit(s) on branch '${currentBranch}'. Please push these changes to the remote repository.`
      );
    }
    return blockHook(
      `Remote branch '${currentBranch}' does not match the local HEAD. Please push these changes to the remote repository.`
    );
  }

  const unpushed = await countUnpushedCommits(git, cwd, 'origin/HEAD..HEAD', signal);
  if (unpushed > 0) {
    return blockHook(
      `Branch '${currentBranch}' has ${unpushed} unpushed commit(s) and no remote branch. Please push these changes to the remote repository.`
    );
  }

  return continueHook();
}

export function createStopHookGitCheck(git?: GitCommandRunner): HookCallback {
  return async (input, _toolUseID, options) => {
    if (!isStopHookInput(input)) return continueHook();
    return runStopHookGitCheck(input, { git, signal: options.signal });
  };
}
