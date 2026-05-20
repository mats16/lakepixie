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
