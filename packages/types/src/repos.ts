/**
 * Databricks Repos API types
 * @see https://docs.databricks.com/api/workspace/repos
 */

// POST /api/2.0/repos - Create a repo
export interface ReposCreateRequest {
  /** Git repository URL (required) */
  url: string;
  /** Git provider: gitHub, gitHubEnterprise, bitbucketCloud, bitbucketServer, azureDevOpsServices, gitLab, gitLabEnterpriseEdition, awsCodeCommit */
  provider: string;
  /** Path in workspace where repo will be created */
  path?: string;
  /** Sparse checkout configuration */
  sparse_checkout?: {
    patterns: string[];
  };
}

export interface ReposCreateResponse {
  /** Repo ID */
  id: number;
  /** Path in workspace */
  path: string;
  /** Git repository URL */
  url: string;
  /** Git provider */
  provider: string;
  /** Current branch */
  branch: string;
  /** HEAD commit ID */
  head_commit_id: string;
  /** Sparse checkout configuration */
  sparse_checkout?: {
    patterns: string[];
  };
}

export interface GitRepositoryCandidate {
  /** owner/repo */
  full_name: string;
  /** HTTPS clone/browser URL */
  url: string;
  /** Default branch reported by GitHub */
  default_branch?: string;
  /** MCP server ID that returned this repository */
  mcp_server_id?: string;
}

export interface GitRepositoryListResponse {
  repositories: GitRepositoryCandidate[];
}

export interface GitRepositoryBranchCandidate {
  name: string;
  protected?: boolean;
}

export interface GitRepositoryBranchListResponse {
  branches: GitRepositoryBranchCandidate[];
}

export interface GitRepositoryCompareSummary {
  html_url: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  additions: number;
  deletions: number;
}

export type GitRepositoryDiffResponse = GitRepositoryCompareSummary;

export interface GitRepositoryBranchDetailResponse extends GitRepositoryBranchCandidate {
  html_url: string;
  compare: GitRepositoryCompareSummary | null;
}

export type GitRepositoryPullRequestState = 'open' | 'closed';

export type GitRepositoryPullRequestStateFilter = GitRepositoryPullRequestState | 'all';

export interface GitRepositoryPullRequest {
  number: number;
  title: string;
  state: GitRepositoryPullRequestState;
  draft: boolean;
  merged: boolean;
  html_url: string;
  additions?: number;
  deletions?: number;
  head: {
    ref: string;
    label: string;
  };
  base: {
    ref: string;
    label: string;
  };
}

export interface GitRepositoryPullRequestListResponse {
  pulls: GitRepositoryPullRequest[];
}

export interface GitRepositoryPullRequestCreateRequest {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
  session_id?: string;
  language?: string;
}
