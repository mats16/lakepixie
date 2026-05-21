import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { GitRepositoryDiffResponse } from '@repo/types';
import { spawnAsync } from '../utils/spawn.js';
import { truncateForPrompt } from '../utils/llm-text.js';
import { validatePathWithinBase } from '../utils/path-validation.js';

const LOCAL_GIT_COMMAND_TIMEOUT_MS = 10_000;
const LOCAL_GIT_PR_CONTEXT_TIMEOUT_MS = 20_000;
const MAX_DIFF_CHARS = 60_000;
const BINARY_SAMPLE_BYTES = 8192;
const LF = 0x0a;
const NUL = 0x00;

export interface LocalGitPullRequestContext {
  commits: string;
  diffStat: string;
  fileStatus: string;
  diff: string;
}

function parseNumstat(stdout: string): Pick<GitRepositoryDiffResponse, 'additions' | 'deletions'> {
  return stdout
    .split('\n')
    .filter(Boolean)
    .reduce(
      (summary, line) => {
        const [additions, deletions] = line.split('\t');
        return {
          additions: summary.additions + (Number(additions) || 0),
          deletions: summary.deletions + (Number(deletions) || 0),
        };
      },
      { additions: 0, deletions: 0 }
    );
}

function parseRevListCounts(
  stdout: string
): Pick<GitRepositoryDiffResponse, 'ahead_by' | 'behind_by' | 'total_commits'> {
  const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
  const aheadBy = Number.isFinite(ahead) ? ahead : 0;
  return {
    ahead_by: aheadBy,
    behind_by: Number.isFinite(behind) ? behind : 0,
    total_commits: aheadBy,
  };
}

function parseNullDelimitedPaths(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean);
}

async function isLikelyBinaryFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SAMPLE_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(NUL);
  } finally {
    await handle.close();
  }
}

async function countTextFileLines(filePath: string, size: number): Promise<number> {
  if (size === 0) return 0;

  let lines = 0;
  let lastByte: number | null = null;
  for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) {
    let index = chunk.indexOf(LF);
    while (index !== -1) {
      lines += 1;
      index = chunk.indexOf(LF, index + 1);
    }
    if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
  }

  return lastByte === LF ? lines : lines + 1;
}

async function countUntrackedFileAdditions(cwd: string, relativePath: string): Promise<number> {
  try {
    const filePath = await validatePathWithinBase(path.resolve(cwd, relativePath), cwd);
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || (await isLikelyBinaryFile(filePath))) return 0;
    return countTextFileLines(filePath, stat.size);
  } catch {
    return 0;
  }
}

async function getUntrackedAdditions(cwd: string): Promise<number> {
  const { stdout } = await spawnAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd,
    timeout: LOCAL_GIT_COMMAND_TIMEOUT_MS,
  });
  const counts = await Promise.all(
    parseNullDelimitedPaths(stdout).map(filePath => countUntrackedFileAdditions(cwd, filePath))
  );
  return counts.reduce((total, additions) => total + additions, 0);
}

export async function getLocalGitDiffSummary(
  cwd: string,
  base: string,
  head: string
): Promise<GitRepositoryDiffResponse> {
  const range = `${base}...${head}`;
  const diffPromise = spawnAsync('git', ['merge-base', base, head], {
    cwd,
    timeout: LOCAL_GIT_COMMAND_TIMEOUT_MS,
  }).then(mergeBase => {
    const workingTreeRange = mergeBase.stdout.trim();
    if (!workingTreeRange) {
      throw new Error(`No common ancestor between ${base} and ${head}`);
    }
    return spawnAsync('git', ['diff', '--numstat', '--ignore-submodules=all', workingTreeRange], {
      cwd,
      timeout: LOCAL_GIT_COMMAND_TIMEOUT_MS,
    });
  });

  const [diff, counts, untrackedAdditions] = await Promise.all([
    diffPromise,
    spawnAsync('git', ['rev-list', '--left-right', '--count', range], {
      cwd,
      timeout: LOCAL_GIT_COMMAND_TIMEOUT_MS,
    }),
    getUntrackedAdditions(cwd),
  ]);
  const trackedChanges = parseNumstat(diff.stdout);

  return {
    ...parseRevListCounts(counts.stdout),
    additions: trackedChanges.additions + untrackedAdditions,
    deletions: trackedChanges.deletions,
  };
}

export async function getLocalGitPullRequestContext(
  cwd: string,
  base: string,
  head: string
): Promise<LocalGitPullRequestContext> {
  const compareRange = `${base}...${head}`;
  const commitRange = `${base}..${head}`;
  const [commits, diffStat, fileStatus, diff] = await Promise.all([
    spawnAsync('git', ['log', '--oneline', '--no-decorate', commitRange], {
      cwd,
      timeout: LOCAL_GIT_PR_CONTEXT_TIMEOUT_MS,
    }),
    spawnAsync(
      'git',
      ['diff', '--stat', '--find-renames', '--ignore-submodules=all', compareRange],
      {
        cwd,
        timeout: LOCAL_GIT_PR_CONTEXT_TIMEOUT_MS,
      }
    ),
    spawnAsync(
      'git',
      ['diff', '--name-status', '--find-renames', '--ignore-submodules=all', compareRange],
      {
        cwd,
        timeout: LOCAL_GIT_PR_CONTEXT_TIMEOUT_MS,
      }
    ),
    spawnAsync(
      'git',
      ['diff', '--unified=3', '--find-renames', '--ignore-submodules=all', compareRange],
      {
        cwd,
        timeout: LOCAL_GIT_PR_CONTEXT_TIMEOUT_MS,
      }
    ),
  ]);

  return {
    commits: commits.stdout.trim(),
    diffStat: diffStat.stdout.trim(),
    fileStatus: fileStatus.stdout.trim(),
    diff: truncateForPrompt(diff.stdout.trim(), MAX_DIFF_CHARS),
  };
}
