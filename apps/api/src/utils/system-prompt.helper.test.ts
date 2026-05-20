import { describe, it, expect } from 'vitest';
import type { ResolvedSessionOutcome } from '@repo/types';
import {
  buildSystemPromptConfig,
  createWorkspacePushInstruction,
  createDatabricksAppsInstruction,
  createGitRepositoryInstruction,
  type SystemPromptConfig,
} from './system-prompt.helper.js';

describe('createWorkspacePushInstruction', () => {
  it('should generate instruction with workspace path', () => {
    const result = createWorkspacePushInstruction('/Workspace/Users/test@example.com/project');

    expect(result).toContain('Databricks Workspace Push Requirements');
    expect(result).toContain('/Workspace/Users/test@example.com/project');
    expect(result).toContain('workspace-push');
  });

  it('should include CLI reference with environment variable', () => {
    const result = createWorkspacePushInstruction('/Workspace/test');

    expect(result).toContain('CLI Reference');
    expect(result).toContain('SESSION_WORKSPACE_PATH');
    expect(result).toContain('workspace-push --list "$SESSION_WORKSPACE_PATH"');
    expect(result).toContain('workspace-push . "$SESSION_WORKSPACE_PATH"');
  });

  it('should include task instructions', () => {
    const result = createWorkspacePushInstruction('/Workspace/test');

    expect(result).toContain('Your task is to complete the request');
    expect(result).toContain('DEVELOP');
    expect(result).toContain('PUSH');
  });
});

describe('buildSystemPromptConfig', () => {
  it('should return base config for empty outcomes', () => {
    const result = buildSystemPromptConfig([]);

    expect(result).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
  });

  it('should return base config for undefined outcomes', () => {
    const result = buildSystemPromptConfig();

    expect(result).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
  });

  it('should return config with Workspace instruction for workspace-only outcome', () => {
    const outcomes: ResolvedSessionOutcome[] = [
      { type: 'databricks_workspace', path: '/Workspace/test' },
    ];

    const result = buildSystemPromptConfig(outcomes);

    expect(result.type).toBe('preset');
    expect(result.preset).toBe('claude_code');
    expect('append' in result).toBe(true);
    if ('append' in result) {
      expect(result.append).toContain('Databricks Workspace Push Requirements');
    }
  });

  it('should use first workspace path when multiple workspaces exist', () => {
    const outcomes: ResolvedSessionOutcome[] = [
      { type: 'databricks_workspace', path: '/Workspace/first' },
      { type: 'databricks_workspace', path: '/Workspace/second' },
    ];

    const result = buildSystemPromptConfig(outcomes);

    expect('append' in result).toBe(true);
    if ('append' in result) {
      expect(result.append).toContain('/Workspace/first');
    }
  });

  it('should return config with Apps instruction for apps-only outcome', () => {
    const outcomes: ResolvedSessionOutcome[] = [{ type: 'databricks_apps', name: 'app-abc123' }];

    const result = buildSystemPromptConfig(outcomes);

    expect(result.type).toBe('preset');
    expect(result.preset).toBe('claude_code');
    expect(result.append).toBeDefined();
    expect(result.append).toContain('Databricks Apps Deployment');
    expect(result.append).toContain('app-abc123');
  });

  it('should return config with both instructions for workspace + apps outcomes', () => {
    const outcomes: ResolvedSessionOutcome[] = [
      { type: 'databricks_workspace', path: '/Workspace/test' },
      { type: 'databricks_apps', name: 'app-xyz789' },
    ];

    const result = buildSystemPromptConfig(outcomes);

    expect(result.append).toBeDefined();
    expect(result.append).toContain('Databricks Workspace Push Requirements');
    expect(result.append).toContain('Databricks Apps Deployment');
    expect(result.append).toContain('app-xyz789');
  });

  it('should return config with Git repository instruction for git outcome', () => {
    const outcomes: ResolvedSessionOutcome[] = [
      {
        type: 'git_repository',
        git_info: {
          type: 'github',
          repo: 'aws-startup-community/aws-startup-case-studies-jp',
          branches: ['ccbricks/hobe-piyp-fuga'],
        },
      },
    ];

    const result = buildSystemPromptConfig(outcomes);

    expect(result.append).toBeDefined();
    expect(result.append).toContain('Git Development Branch Requirements');
    expect(result.append).toContain(
      'aws-startup-community/aws-startup-case-studies-jp: Develop on branch `ccbricks/hobe-piyp-fuga`'
    );
    expect(result.append).toContain('git push -u origin <branch-name>');
    expect(result.append).toContain('Do NOT create a pull request');
  });
});

describe('createDatabricksAppsInstruction', () => {
  it('should generate instruction with app name', () => {
    const result = createDatabricksAppsInstruction('app-abc123');

    expect(result).toContain('Databricks Apps Deployment');
    expect(result).toContain('app-abc123');
    expect(result).toContain('databricks apps create app-abc123');
    expect(result).toContain('databricks apps deploy app-abc123');
    expect(result).toContain('databricks apps get app-abc123');
  });

  it('should include environment variable reference', () => {
    const result = createDatabricksAppsInstruction('app-test');

    expect(result).toContain('SESSION_APP_NAME');
  });

  it('should include workflow steps', () => {
    const result = createDatabricksAppsInstruction('app-test');

    expect(result).toContain('DEVELOP');
    expect(result).toContain('DEPLOY');
    expect(result).toContain('VERIFY');
  });
});

describe('createGitRepositoryInstruction', () => {
  it('should generate Git branch requirements from outcome', () => {
    const result = createGitRepositoryInstruction({
      type: 'git_repository',
      git_info: {
        type: 'github',
        repo: 'mats16/ccbricks',
        branches: ['claude/review-git-instructions-CsqDV'],
      },
    });

    expect(result).toContain('Git Development Branch Requirements');
    expect(result).toContain(
      'mats16/ccbricks: Develop on branch `claude/review-git-instructions-CsqDV`'
    );
    expect(result).toContain('NEVER');
    expect(result).toContain('git fetch origin <branch-name>');
    expect(result).toContain('git pull origin <branch-name>');
  });
});

describe('SystemPromptConfig type', () => {
  it('should match expected structure without append', () => {
    const config: SystemPromptConfig = {
      type: 'preset',
      preset: 'claude_code',
    };

    expect(config.type).toBe('preset');
    expect(config.preset).toBe('claude_code');
  });

  it('should match expected structure with append', () => {
    const config: SystemPromptConfig = {
      type: 'preset',
      preset: 'claude_code',
      append: 'Additional instructions',
    };

    expect(config.type).toBe('preset');
    expect(config.preset).toBe('claude_code');
    expect(config.append).toBe('Additional instructions');
  });
});
