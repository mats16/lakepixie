import type {
  GitRepositoryBranchDetailResponse,
  GitRepositoryBranchListResponse,
  GitRepositoryListResponse,
  GitRepositoryPullRequest,
  GitRepositoryPullRequestCreateRequest,
  GitRepositoryPullRequestListResponse,
  GitRepositoryPullRequestStateFilter,
} from '@repo/types';
import { apiClient } from './api-client';

function splitRepositoryFullName(repositoryFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repositoryFullName.split('/');
  if (!owner || !repo) {
    throw new Error('Invalid repository full name');
  }
  return { owner, repo };
}

function repositoryPath(repositoryFullName: string): string {
  const { owner, repo } = splitRepositoryFullName(repositoryFullName);
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export const gitRepositoryService = {
  async search(query: string): Promise<GitRepositoryListResponse> {
    const params = new URLSearchParams();
    if (query.trim()) {
      params.set('q', query.trim());
    }
    const queryString = params.toString();
    return apiClient<GitRepositoryListResponse>(
      `/api/repos${queryString ? `?${queryString}` : ''}`
    );
  },

  async listBranches(repositoryFullName: string): Promise<GitRepositoryBranchListResponse> {
    return apiClient<GitRepositoryBranchListResponse>(
      `${repositoryPath(repositoryFullName)}/branches`
    );
  },

  async getBranch(
    repositoryFullName: string,
    branchName: string,
    baseBranch?: string
  ): Promise<GitRepositoryBranchDetailResponse> {
    const params = new URLSearchParams();
    if (baseBranch) params.set('base', baseBranch);
    const queryString = params.toString();
    return apiClient<GitRepositoryBranchDetailResponse>(
      `${repositoryPath(repositoryFullName)}/branches/${encodeURIComponent(branchName)}${queryString ? `?${queryString}` : ''}`
    );
  },

  async listPullRequests(
    repositoryFullName: string,
    query: { head?: string; base?: string; state?: GitRepositoryPullRequestStateFilter }
  ): Promise<GitRepositoryPullRequestListResponse> {
    const params = new URLSearchParams();
    if (query.head) params.set('head', query.head);
    if (query.base) params.set('base', query.base);
    if (query.state) params.set('state', query.state);
    const queryString = params.toString();
    return apiClient<GitRepositoryPullRequestListResponse>(
      `${repositoryPath(repositoryFullName)}/pulls${queryString ? `?${queryString}` : ''}`
    );
  },

  async getPullRequest(
    repositoryFullName: string,
    pullNumber: number
  ): Promise<GitRepositoryPullRequest> {
    return apiClient<GitRepositoryPullRequest>(
      `${repositoryPath(repositoryFullName)}/pulls/${pullNumber}`
    );
  },

  async createPullRequest(
    repositoryFullName: string,
    request: GitRepositoryPullRequestCreateRequest
  ): Promise<GitRepositoryPullRequest> {
    return apiClient<GitRepositoryPullRequest>(`${repositoryPath(repositoryFullName)}/pulls`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },
};
