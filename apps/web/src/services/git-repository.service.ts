import type { GitRepositoryBranchListResponse, GitRepositoryListResponse } from '@repo/types';
import { apiClient } from './api-client';

export const gitRepositoryService = {
  async search(query: string): Promise<GitRepositoryListResponse> {
    const params = new URLSearchParams();
    if (query.trim()) {
      params.set('q', query.trim());
    }
    const queryString = params.toString();
    return apiClient<GitRepositoryListResponse>(
      `/api/repositories${queryString ? `?${queryString}` : ''}`
    );
  },

  async listBranches(repositoryFullName: string): Promise<GitRepositoryBranchListResponse> {
    return apiClient<GitRepositoryBranchListResponse>(
      `/api/repositories/${encodeURIComponent(repositoryFullName)}/branches`
    );
  },
};
