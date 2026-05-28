import { describe, expect, it } from 'vitest';
import {
  getGitRepositoryNameFromFullName,
  validateGitRepositoryDirectoryName,
} from './github-repository.js';

describe('github repository utilities', () => {
  it('extracts a safe checkout directory name from a GitHub full name', () => {
    expect(getGitRepositoryNameFromFullName('acme/widgets.git')).toBe('widgets.git');
    expect(getGitRepositoryNameFromFullName('acme/widgets-api_2')).toBe('widgets-api_2');
  });

  it('rejects repository directory names that are unsafe for local checkout paths', () => {
    expect(() => validateGitRepositoryDirectoryName('widgets')).not.toThrow();
    expect(() => getGitRepositoryNameFromFullName('acme/re po')).toThrow(
      'Invalid git repository name'
    );
    expect(() => getGitRepositoryNameFromFullName('acme/repo\0name')).toThrow(
      'Invalid git repository name'
    );
    expect(() => getGitRepositoryNameFromFullName('acme/.')).toThrow('Invalid git repository name');
    expect(() => getGitRepositoryNameFromFullName('acme/..')).toThrow(
      'Invalid git repository name'
    );
    expect(() => getGitRepositoryNameFromFullName('acme/widgets/extra')).toThrow(
      'Invalid GitHub repository full name'
    );
  });
});
