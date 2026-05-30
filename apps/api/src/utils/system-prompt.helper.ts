import type {
  DatabricksWorkspaceSource,
  GitRepositoryOutcome,
  GitRepositorySource,
  ResolvedDatabricksAppsOutcome,
  ResolvedSessionOutcome,
  SessionSource,
} from '@repo/types';
import { CONTEXT_MANAGER_MCP_ALLOWED_TOOLS } from '../services/context-manager-mcp.service.js';

/** systemPrompt の設定型 */
export interface SystemPromptConfig {
  type: 'preset';
  preset: 'claude_code';
  append?: string;
}

/**
 * outcomes に基づいて systemPrompt 設定を構築
 *
 * @param outcomes - セッションの outcomes 配列
 * @returns systemPrompt の設定オブジェクト
 *
 * @example
 * ```typescript
 * const config = buildSystemPromptConfig(session_context.outcomes);
 * // Use in query() options: systemPrompt: config
 * ```
 */
export function buildSystemPromptConfig(
  outcomes: ResolvedSessionOutcome[] = [],
  sources: SessionSource[] = []
): SystemPromptConfig {
  const workspaceOutcome = outcomes.find(
    (o): o is DatabricksWorkspaceSource => o.type === 'databricks_workspace'
  );
  const appsOutcome = outcomes.find(
    (o): o is ResolvedDatabricksAppsOutcome => o.type === 'databricks_apps'
  );
  const gitOutcome = outcomes.find((o): o is GitRepositoryOutcome => o.type === 'git_repository');

  const instructions: string[] = [createContextManagerInstruction()];

  if (workspaceOutcome?.path) {
    instructions.push(createWorkspacePushInstruction(workspaceOutcome.path));
  }
  if (appsOutcome?.name) {
    instructions.push(createDatabricksAppsInstruction(appsOutcome.name));
  }
  if (gitOutcome?.git_info.branches.length) {
    instructions.push(createGitRepositoryInstruction(gitOutcome, sources));
  }

  return {
    type: 'preset',
    preset: 'claude_code',
    append: instructions.join('\n\n'),
  };
}

/**
 * ccbricks の session_context を同期する internal MCP の使い方。
 */
export function createContextManagerInstruction(): string {
  const toolList = CONTEXT_MANAGER_MCP_ALLOWED_TOOLS.map(tool => `- \`${tool}\``).join('\n');
  return `
## ccbricks Session Context Manager

You have access to the \`ccbricks_context\` MCP server. It is the only supported way for you to update ccbricks UI session context.

Use it to:
- Read the current \`session_context\`
- Read \`session_context.outcomes\`
- Add, replace, or remove outcomes, or replace the full \`outcomes\` array

Rules:
1. You may update \`session_context.outcomes\` only.
2. Do not try to update \`sources\`, \`cwd\`, model settings, permission settings, MCP config, or tool permissions.
3. Record Databricks Apps only with the app name already assigned to this session.
4. Record Databricks Workspace paths only when they match the session's assigned workspace path or its descendants.
5. Keep existing unrelated outcomes unless the user explicitly asks to remove them.

Available MCP tools:
${toolList}
`.trim();
}

/**
 * Databricks Workspace にファイルをアップロードするための systemPrompt 追加指示を生成
 *
 * @param workspacePath - push 先の Databricks Workspace パス
 * @returns systemPrompt に追加する指示文字列
 *
 * @example
 * ```typescript
 * const instruction = createWorkspacePushInstruction('/Workspace/Users/user@example.com/project');
 * // Returns markdown instruction text for Claude
 * ```
 */
export function createWorkspacePushInstruction(workspacePath: string): string {
  return `
Your task is to complete the request described in the task description.

Instructions:
1. For questions: Research the codebase and provide a detailed answer
2. For implementations: Make the requested changes and push to Databricks Workspace

## Databricks Workspace Push Requirements

The workspace path is provided via the \`SESSION_WORKSPACE_PATH\` environment variable: \`${workspacePath}\`

### Important Instructions:

1. **DEVELOP** all your changes in the current working directory
2. **PUSH** your completed work to the specified Workspace path
3. **NEVER** push to a different workspace path without explicit permission
4. **UPDATE** the session outcomes with \`mcp__ccbricks_context__upsert_outcome\` after a successful push

### CLI Reference:

- To push all files from the session directory to workspace:
  \`workspace-push . "$SESSION_WORKSPACE_PATH"\`
- To check the upload result:
  \`workspace-push --list "$SESSION_WORKSPACE_PATH"\`

After a successful push, upsert this outcome:
\`{"type":"databricks_workspace","path":"${workspacePath}"}\`
`.trim();
}

/**
 * Databricks Apps へのデプロイ用 systemPrompt 追加指示を生成（CLI ベース）
 *
 * @param appName - 割り当て済みの Databricks App 名
 * @returns systemPrompt に追加する指示文字列
 */
export function createDatabricksAppsInstruction(appName: string): string {
  return `
## Databricks Apps Deployment

You have been assigned the app name: \`${appName}\`
The app name is also available via the \`SESSION_APP_NAME\` environment variable.

### Workflow:

1. **DEVELOP** your application in the current working directory
2. **PUSH** your code to the Workspace path (if configured)
3. **CREATE** the app (if it doesn't exist yet):
   \`databricks apps create ${appName}\`
4. **DEPLOY** the app from the Workspace source:
   \`databricks apps deploy ${appName} --source-code-path "$SESSION_WORKSPACE_PATH"\`
5. **VERIFY** deployment status:
   \`databricks apps get ${appName}\`

### Important:

- The app name \`${appName}\` is pre-assigned. Always use this exact name.
- Ensure your app has a valid \`app.yaml\` configuration file before deploying.
- After deploying, verify the app status shows \`RUNNING\` before reporting success.
- After creating or verifying the app, upsert this outcome with \`mcp__ccbricks_context__upsert_outcome\`:
  \`{"type":"databricks_apps","name":"${appName}"}\`
- Do not consider the work done until the app is successfully deployed and verified.
`.trim();
}

function parseGitHubRepositoryFullName(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;

  const [owner, rawRepo] = url.pathname.replace(/^\/+/, '').split('/');
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

interface SourceRepositoryInfo {
  fullName: string;
  repoName: string;
}

function getGitSourceRepositories(sources: SessionSource[]): SourceRepositoryInfo[] {
  return sources
    .filter((source): source is GitRepositorySource => source.type === 'git_repository')
    .map(source => {
      const fullName = parseGitHubRepositoryFullName(source.url);
      if (!fullName) return null;
      const repoName = fullName.split('/')[1];
      return repoName ? { fullName, repoName } : null;
    })
    .filter((source): source is SourceRepositoryInfo => source !== null);
}

function formatGitBranchLines(
  outcome: GitRepositoryOutcome,
  sourceRepositories: SourceRepositoryInfo[]
): string {
  const branches = outcome.git_info.branches;
  const branch = branches[0];

  if (sourceRepositories.length > 0 && branch) {
    return sourceRepositories
      .map(repository => {
        if (sourceRepositories.length > 1) {
          return `${repository.repoName}/ (${repository.fullName}): Develop on branch \`${branch}\``;
        }
        return `${repository.fullName}: Develop on branch \`${branch}\``;
      })
      .join('\n');
  }

  return branches
    .map(branchName => {
      if (outcome.git_info.repo) {
        return `${outcome.git_info.repo}: Develop on branch \`${branchName}\``;
      }
      return `Develop on branch \`${branchName}\``;
    })
    .join('\n');
}

function formatGitCheckoutLines(sourceRepositories: SourceRepositoryInfo[]): string {
  if (sourceRepositories.length <= 1) return '';

  const directoryLines = sourceRepositories
    .map(repository => `- \`${repository.repoName}/\`: ${repository.fullName}`)
    .join('\n');
  return `\n\nRepository checkout directories:\n${directoryLines}`;
}

/**
 * Git repository での開発ブランチ要件を systemPrompt に追加する。
 */
export function createGitRepositoryInstruction(
  outcome: GitRepositoryOutcome,
  sources: SessionSource[] = []
): string {
  const sourceRepositories = getGitSourceRepositories(sources);
  const branchLines = formatGitBranchLines(outcome, sourceRepositories);
  const checkoutLines = formatGitCheckoutLines(sourceRepositories);

  return `
## Git Development Branch Requirements

You are working on the following feature branches:

${branchLines}${checkoutLines}

### Important Instructions:

1. **DEVELOP** all your changes on the designated branch above
2. **COMMIT** your work with clear, descriptive commit messages
3. **PUSH** to the specified branch when your changes are complete
4. **CREATE** the branch locally if it doesn't exist yet
5. **NEVER** push to a different branch without explicit permission

Remember: All development and final pushes should go to the branches specified above.

## Git Operations

Follow these practices for git:

### For git push:

- Always use \`git push -u origin <branch-name>\`
- Only if push fails due to network errors retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s)
- Example retry logic: try push, wait 2s if failed, try again, wait 4s if failed, try again, etc.
- IMPORTANT: Do NOT create a pull request unless the user explicitly asks for one.

### For git fetch/pull:

- Prefer fetching specific branches: \`git fetch origin <branch-name>\`
- If network failures occur, retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s)
- For pulls use: \`git pull origin <branch-name>\`
`.trim();
}
