const GIT_REPOSITORY_DIRECTORY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function validateGitRepositoryDirectoryName(repoName: string): void {
  if (
    !repoName ||
    repoName === '.' ||
    repoName === '..' ||
    repoName.includes('/') ||
    repoName.includes('\\') ||
    repoName.includes('\0') ||
    !GIT_REPOSITORY_DIRECTORY_NAME_PATTERN.test(repoName)
  ) {
    throw new Error(`Invalid git repository name: ${repoName}`);
  }
}

export function getGitRepositoryNameFromFullName(fullName: string): string {
  const [owner, repoName, extra] = fullName.split('/');
  if (!owner || repoName === undefined || extra !== undefined) {
    throw new Error(`Invalid GitHub repository full name: ${fullName}`);
  }
  validateGitRepositoryDirectoryName(repoName);
  return repoName;
}
