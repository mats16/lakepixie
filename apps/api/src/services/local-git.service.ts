import type { GitRepositoryCompareSummary } from '@repo/types';
import { spawnAsync } from '../utils/spawn.js';
import { truncateForPrompt } from '../utils/llm-text.js';

const LOCAL_GIT_COMMAND_TIMEOUT_MS = 10_000;
const LOCAL_GIT_PR_CONTEXT_TIMEOUT_MS = 20_000;
const MAX_DIFF_CHARS = 60_000;

export interface LocalGitPullRequestContext {
  commits: string;
  diffStat: string;
  fileStatus: string;
  diff: string;
}

function repositoryUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

function compareUrl(owner: string, repo: string, base: string, head: string): string {
  return `${repositoryUrl(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
}

function parseNumstat(
  stdout: string
): Pick<GitRepositoryCompareSummary, 'additions' | 'deletions'> {
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
): Pick<GitRepositoryCompareSummary, 'ahead_by' | 'behind_by' | 'total_commits'> {
  const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
  const aheadBy = Number.isFinite(ahead) ? ahead : 0;
  return {
    ahead_by: aheadBy,
    behind_by: Number.isFinite(behind) ? behind : 0,
    total_commits: aheadBy,
  };
}

export async function getLocalGitCompareSummary(
  cwd: string,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<GitRepositoryCompareSummary> {
  const range = `${base}...${head}`;
  const [diff, counts] = await Promise.all([
    spawnAsync('git', ['diff', '--numstat', '--ignore-submodules=all', range], {
      cwd,
      timeout: LOCAL_GIT_COMMAND_TIMEOUT_MS,
    }),
    spawnAsync('git', ['rev-list', '--left-right', '--count', range], {
      cwd,
      timeout: LOCAL_GIT_COMMAND_TIMEOUT_MS,
    }),
  ]);

  return {
    html_url: compareUrl(owner, repo, base, head),
    ...parseRevListCounts(counts.stdout),
    ...parseNumstat(diff.stdout),
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
