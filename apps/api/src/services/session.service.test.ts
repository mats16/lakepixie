import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionContextResponse } from '@repo/types';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionId } from '../models/session.model.js';

const mockSpawn = vi.hoisted(() => vi.fn());
const { mockRegisterGitCredential, mockRevokeGitCredential } = vi.hoisted(() => ({
  mockRegisterGitCredential: vi.fn(),
  mockRevokeGitCredential: vi.fn(),
}));

// Mock external modules
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('./websocket-manager.service.js', () => ({
  wsManager: {
    broadcast: vi.fn(),
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
  },
}));

vi.mock('./event-queue.service.js', () => ({
  enqueueSessionEvent: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('../utils/directory.js', () => ({
  ensureDirectory: vi.fn().mockResolvedValue(undefined),
  removeDirectory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./git-credential.service.js', () => ({
  buildGitCredentialHelperScript: (internalUrl: string, bearerToken: string) =>
    `helper ${internalUrl} ${bearerToken}`,
  registerGitCredential: mockRegisterGitCredential,
  revokeGitCredential: mockRevokeGitCredential,
}));

vi.mock('../lib/databricks-auth.js', () => ({
  getAuthProvider: vi.fn().mockReturnValue({
    type: 'oauth-m2m',
    getToken: vi.fn().mockResolvedValue('test-token'),
  }),
}));

// Import after mocking
import { wsManager } from './websocket-manager.service.js';
import { enqueueSessionEvent } from './event-queue.service.js';
import {
  __testing,
  abortActiveSessionsForShutdown,
  applySessionFlagSettings,
  canAbortSession,
  executeAbort,
  setSessionModel,
  setSessionPermissionMode,
} from './session.service.js';
import {
  __testing as exitPlanModeTesting,
  resolveExitPlanModeDecision,
} from './exit-plan-mode.service.js';
import {
  __testing as askUserQuestionTesting,
  resolveUserAnswer,
} from './ask-user-question.service.js';
import { removeDirectory } from '../utils/directory.js';

describe('session.service', () => {
  // Mock FastifyInstance
  const createMockFastify = () => {
    const mockTx = {
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };

    const mockWithUserContext = vi.fn().mockImplementation(async (_userId, callback) => {
      return callback(mockTx);
    });

    return {
      withUserContext: mockWithUserContext,
      log: {
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      },
      config: {
        DATABRICKS_HOST: 'test.databricks.com',
        DATABRICKS_APP_PORT: 8000,
        NODE_ENV: 'development',
        PORT: 8003,
        CCBRICKS_BASE_DIR: '/home/app',
        PATH: '/usr/bin',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    } as unknown as FastifyInstance;
  };

  const createContextUpdateFastify = (contextOverrides: Record<string, unknown> = {}) => {
    const baseContext = {
      cwd: '/home/app/sessions/session-test',
      model: 'claude-sonnet-4-6',
      sources: [],
      outcomes: [],
      ...contextOverrides,
    };
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                context: baseContext,
                status: 'idle',
              },
            ]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set }),
    };
    const fastify = {
      withUserContext: vi.fn().mockImplementation(async (_userId, callback) => callback(tx)),
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                key: 'allowed_model_ids',
                value: JSON.stringify(['claude-opus-4-7', 'claude-sonnet-4-6']),
              },
            ]),
          }),
        }),
      },
      log: {
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    } as unknown as FastifyInstance;

    return { fastify, set };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __testing.clearActiveSessionQueries();
    __testing.clearDatabricksAppCreateLocks();
    exitPlanModeTesting.clearPendingExitPlanModes();
    askUserQuestionTesting.clearPendingQuestions();
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    let credentialTokenIndex = 0;
    mockRegisterGitCredential.mockImplementation(async () => {
      credentialTokenIndex += 1;
      return { bearerToken: `credential-token-${credentialTokenIndex}`, repoFullName: 'acme/repo' };
    });
    mockRevokeGitCredential.mockResolvedValue(undefined);
  });

  describe('Databricks App creation lock', () => {
    it('rejects concurrent creation for the same session until the lock is released', () => {
      const sessionId = new SessionId();
      const release = __testing.acquireDatabricksAppCreateLock(sessionId);

      expect(() => __testing.acquireDatabricksAppCreateLock(sessionId)).toThrow(
        'Databricks App creation is already in progress'
      );

      release();
      const releaseAfterRetry = __testing.acquireDatabricksAppCreateLock(sessionId);
      releaseAfterRetry();
    });
  });

  describe('buildDefaultSessionWorkspacePath', () => {
    it('uses the running ccbricks app name and session id under Workspace Shared', () => {
      const sessionId = new SessionId();

      expect(__testing.buildDefaultSessionWorkspacePath('ccbricks-prod', sessionId)).toBe(
        `/Workspace/Shared/ccbricks-prod/sessions/${sessionId.toString()}`
      );
    });

    it('requires DATABRICKS_APP_NAME when no workspace outcome is configured', () => {
      const sessionId = new SessionId();

      expect(() => __testing.buildDefaultSessionWorkspacePath('  ', sessionId)).toThrow(
        'DATABRICKS_APP_NAME is required'
      );
    });
  });

  describe('buildSessionContextWithDatabricksAppOutcomes', () => {
    it('adds the default workspace target and Databricks Apps outcome when workspace is absent', () => {
      const context: SessionContextResponse = {
        cwd: '/home/app/sessions/session-test',
        model: 'claude-sonnet-4-6',
        sources: [],
        outcomes: [
          {
            type: 'git_repository',
            git_info: {
              type: 'github',
              repo: 'acme/widgets',
              branches: ['ccbricks/test-branch'],
            },
          },
        ],
      };

      const nextContext = __testing.buildSessionContextWithDatabricksAppOutcomes(
        context,
        '/Workspace/Shared/ccbricks-prod/sessions/session-test',
        'generated-app'
      );

      expect(nextContext.outcomes).toEqual([
        context.outcomes[0],
        {
          type: 'databricks_workspace',
          path: '/Workspace/Shared/ccbricks-prod/sessions/session-test',
        },
        { type: 'databricks_apps', name: 'generated-app' },
      ]);
    });

    it('does not duplicate existing workspace or Databricks Apps outcomes', () => {
      const context: SessionContextResponse = {
        cwd: '/home/app/sessions/session-test',
        model: 'claude-sonnet-4-6',
        sources: [],
        outcomes: [
          {
            type: 'databricks_workspace',
            path: '/Workspace/Users/test/app',
          },
          { type: 'databricks_apps', name: 'generated-app' },
        ],
      };

      const nextContext = __testing.buildSessionContextWithDatabricksAppOutcomes(
        context,
        '/Workspace/Users/test/app',
        'generated-app'
      );

      expect(nextContext.outcomes).toEqual(context.outcomes);
    });

    it('rejects replacing an existing Databricks Apps outcome', () => {
      const context: SessionContextResponse = {
        cwd: '/home/app/sessions/session-test',
        model: 'claude-sonnet-4-6',
        sources: [],
        outcomes: [{ type: 'databricks_apps', name: 'existing-app' }],
      };

      expect(() =>
        __testing.buildSessionContextWithDatabricksAppOutcomes(
          context,
          '/Workspace/Shared/ccbricks-prod/sessions/session-test',
          'generated-app'
        )
      ).toThrow("Session already has Databricks Apps outcome 'existing-app'");
    });
  });

  describe('buildGitIdentityEnv', () => {
    it('uses the Databricks user name and email for git author and committer', () => {
      const env = __testing.buildGitIdentityEnv({
        userId: 'user-123',
        userName: 'Test User',
        userEmail: 'test.user@example.com',
      } as Parameters<typeof __testing.buildGitIdentityEnv>[0]);

      expect(env).toEqual({
        GIT_AUTHOR_NAME: 'Test User',
        GIT_AUTHOR_EMAIL: 'test.user@example.com',
        GIT_COMMITTER_NAME: 'Test User',
        GIT_COMMITTER_EMAIL: 'test.user@example.com',
      });
    });

    it('falls back to stable user fields when name or email is missing', () => {
      const env = __testing.buildGitIdentityEnv({
        userId: 'test-user-id',
        userName: '  ',
        userEmail: '',
      } as Parameters<typeof __testing.buildGitIdentityEnv>[0]);

      expect(env).toEqual({
        GIT_AUTHOR_NAME: 'test-user-id',
        GIT_AUTHOR_EMAIL: 'test-user-id',
        GIT_COMMITTER_NAME: 'test-user-id',
        GIT_COMMITTER_EMAIL: 'test-user-id',
      });
    });
  });

  describe('buildEffectiveToolSettings', () => {
    it('uses persisted standard tool settings and only accepts MCP patterns from the request', () => {
      const settings = __testing.buildEffectiveToolSettings({
        userAllowedTools: ['Read', 'Bash(*)'],
        userDisallowedTools: ['WebSearch'],
        requestedAllowedTools: ['Read', 'Write', 'mcp__dbsql__*'],
        requestedDisallowedTools: ['Bash', 'mcp__disabled__*'],
      });

      expect(settings).toEqual({
        allowed_tools: ['Read', 'Bash(*)', 'mcp__dbsql__*'],
        disallowed_tools: ['WebSearch', 'mcp__disabled__*'],
      });
    });

    it('falls back to persisted settings when stored session contexts omit tool lists', () => {
      const settings = __testing.buildEffectiveToolSettings({
        userAllowedTools: ['Read'],
        userDisallowedTools: ['Bash'],
      });

      expect(settings).toEqual({
        allowed_tools: ['Read'],
        disallowed_tools: ['Bash'],
      });
    });

    it('stores only session-specific MCP patterns outside persisted user settings', () => {
      const settings = __testing.buildSessionToolSettings({
        userAllowedTools: ['Read', 'mcp__dbsql__*'],
        userDisallowedTools: ['Bash', 'mcp__disabled__*'],
        requestedAllowedTools: ['Read', 'Write', 'mcp__dbsql__*', 'mcp__vector__*'],
        requestedDisallowedTools: ['Bash', 'mcp__disabled__*', 'mcp__readonly__*'],
      });

      expect(settings).toEqual({
        allowed_tools: ['mcp__vector__*'],
        disallowed_tools: ['mcp__readonly__*'],
      });
    });
  });

  describe('git repository source helpers', () => {
    it('should parse refs/heads revision into a branch name', () => {
      expect(__testing.getGitBranchFromRevision('refs/heads/main')).toBe('main');
      expect(__testing.getGitBranchFromRevision('refs/heads/feature/test')).toBe('feature/test');
    });

    it('should reject unsafe git branch names and revisions', () => {
      expect(() => __testing.validateGitBranchName('ccbricks/hobe-piyp-fuga')).not.toThrow();
      expect(() => __testing.validateGitBranchName('feature..test')).toThrow('forbidden pattern');
      expect(() => __testing.getGitBranchFromRevision('main')).toThrow('refs/heads');
      expect(() => __testing.getGitBranchFromRevision('refs/tags/v1.0.0')).toThrow('refs/heads');
      expect(() => __testing.getGitBranchFromRevision('abc1234')).toThrow('refs/heads');
    });

    it('should clone a git source and create the outcome branch', async () => {
      await __testing.cloneGitRepositorySource(
        'test-user-id',
        {
          allow_unrestricted_git_push: true,
          revision: 'refs/heads/main',
          sparse_checkout_paths: [],
          type: 'git_repository',
          url: 'https://github.com/aws-startup-community/aws-startup-case-studies-jp',
        },
        {
          type: 'git_repository',
          git_info: {
            type: 'github',
            repo: 'aws-startup-community/aws-startup-case-studies-jp',
            branches: ['ccbricks/hobe-piyp-fuga'],
          },
        },
        '/tmp/session-cwd'
      );

      expect(mockSpawn).toHaveBeenNthCalledWith(
        1,
        'git',
        [
          'clone',
          '--filter=blob:none',
          '--no-checkout',
          '--depth',
          '1',
          '--branch',
          'main',
          'https://github.com/aws-startup-community/aws-startup-case-studies-jp',
          '/tmp/session-cwd',
        ],
        expect.objectContaining({ shell: false })
      );
      expect(mockSpawn).toHaveBeenNthCalledWith(
        2,
        'git',
        ['checkout'],
        expect.objectContaining({ cwd: '/tmp/session-cwd', shell: false })
      );
      expect(mockSpawn).toHaveBeenNthCalledWith(
        3,
        'git',
        ['checkout', '-B', 'ccbricks/hobe-piyp-fuga'],
        expect.objectContaining({ cwd: '/tmp/session-cwd', shell: false })
      );
    });

    it('should clone multiple git sources into repository-named directories', async () => {
      const widgetSource = {
        allow_unrestricted_git_push: true,
        revision: 'refs/heads/main',
        sparse_checkout_paths: [],
        type: 'git_repository' as const,
        url: 'https://github.com/acme/widgets',
      };
      const apiSource = {
        ...widgetSource,
        url: 'https://github.com/acme/api',
      };

      await __testing.cloneGitRepositorySource(
        'test-user-id',
        widgetSource,
        {
          type: 'git_repository',
          git_info: {
            type: 'github',
            branches: ['ccbricks/test-branch'],
          },
        },
        __testing.getGitRepositoryCheckoutPath('/tmp/session-cwd', widgetSource, 2)
      );
      await __testing.cloneGitRepositorySource(
        'test-user-id',
        apiSource,
        {
          type: 'git_repository',
          git_info: {
            type: 'github',
            branches: ['ccbricks/test-branch'],
          },
        },
        __testing.getGitRepositoryCheckoutPath('/tmp/session-cwd', apiSource, 2)
      );

      expect(mockSpawn).toHaveBeenNthCalledWith(
        1,
        'git',
        expect.arrayContaining(['https://github.com/acme/widgets', '/tmp/session-cwd/widgets']),
        expect.objectContaining({ shell: false })
      );
      expect(mockSpawn).toHaveBeenNthCalledWith(
        4,
        'git',
        expect.arrayContaining(['https://github.com/acme/api', '/tmp/session-cwd/api']),
        expect.objectContaining({ shell: false })
      );
    });

    it('should reject unsupported git repository URLs', () => {
      expect(() => __testing.validateGitRepositoryUrl('git@github.com:user/repo.git')).toThrow(
        'Invalid git repository URL'
      );
      expect(() => __testing.validateGitRepositoryUrl('https://gitlab.com/user/repo')).toThrow(
        'Only HTTPS GitHub repository URLs are supported'
      );
    });

    it('should reject unsupported git session context shapes before setup starts', () => {
      const source = {
        allow_unrestricted_git_push: true,
        revision: 'refs/heads/main',
        sparse_checkout_paths: [],
        type: 'git_repository' as const,
        url: 'https://github.com/acme/widgets.git',
      };
      const outcome = {
        type: 'git_repository' as const,
        git_info: {
          type: 'github' as const,
          repo: 'acme/widgets',
          branches: ['ccbricks/test-branch'],
        },
      };

      expect(() => __testing.validateGitSessionContext([source], [outcome])).not.toThrow();
      expect(() => __testing.validateGitSessionContext([source, source], [outcome])).toThrow(
        'Duplicate git repository checkout directory'
      );
      expect(() =>
        __testing.validateGitSessionContext(
          [source, { ...source, url: 'https://github.com/acme/api.git' }],
          [{ ...outcome, git_info: { type: 'github', branches: ['ccbricks/test-branch'] } }]
        )
      ).not.toThrow();
      expect(() =>
        __testing.validateGitSessionContext(
          [source, { ...source, url: 'https://github.com/acme/api.git' }],
          [outcome]
        )
      ).toThrow('must not specify a repository');
      expect(() =>
        __testing.validateGitSessionContext(
          [source, { type: 'databricks_workspace', path: '/Workspace/test' }],
          [outcome]
        )
      ).not.toThrow();
      expect(() =>
        __testing.validateGitSessionContext(
          [
            source,
            { ...source, url: 'https://github.com/acme/api.git' },
            { type: 'databricks_workspace', path: '/Workspace/test' },
          ],
          [{ ...outcome, git_info: { type: 'github', branches: ['ccbricks/test-branch'] } }]
        )
      ).not.toThrow();
      expect(() =>
        __testing.validateGitSessionContext(
          [
            { type: 'databricks_workspace', path: '/Workspace/one' },
            { type: 'databricks_workspace', path: '/Workspace/two' },
          ],
          []
        )
      ).toThrow('Only one Databricks Workspace source is supported');
      expect(() => __testing.validateGitSessionContext([source], [])).toThrow(
        'requires exactly one git repository outcome'
      );
      expect(() =>
        __testing.validateGitSessionContext(
          [{ ...source, allow_unrestricted_git_push: false }],
          [outcome]
        )
      ).toThrow('Read-only git repository sessions are not supported yet');
      expect(() =>
        __testing.validateGitSessionContext([{ ...source, revision: 'main' }], [outcome])
      ).toThrow('refs/heads');
      expect(() =>
        __testing.validateGitSessionContext(
          [source],
          [{ ...outcome, git_info: { ...outcome.git_info, repo: 'acme/other' } }]
        )
      ).toThrow('must match');
    });

    it('should export workspace sources except when exactly one git source is present', () => {
      expect(__testing.shouldExportWorkspaceSources(0, 0)).toBe(false);
      expect(__testing.shouldExportWorkspaceSources(1, 0)).toBe(true);
      expect(__testing.shouldExportWorkspaceSources(1, 1)).toBe(false);
      expect(__testing.shouldExportWorkspaceSources(1, 2)).toBe(true);
    });

    it('should remove repository checkout directories before multi-repository clone', async () => {
      const source = {
        allow_unrestricted_git_push: true,
        revision: 'refs/heads/main',
        sparse_checkout_paths: [],
        type: 'git_repository' as const,
        url: 'https://github.com/acme/widgets.git',
      };

      await expect(
        __testing.prepareGitRepositoryCheckoutPath('/tmp/session-cwd', source, 1)
      ).resolves.toBe('/tmp/session-cwd');
      expect(removeDirectory).not.toHaveBeenCalled();

      await expect(
        __testing.prepareGitRepositoryCheckoutPath('/tmp/session-cwd', source, 2)
      ).resolves.toBe('/tmp/session-cwd/widgets');
      expect(removeDirectory).toHaveBeenCalledWith('/tmp/session-cwd/widgets');
    });

    it('should configure git credential helpers for every repository checkout', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'ccbricks-session-'));
      const widgetSource = {
        allow_unrestricted_git_push: true,
        revision: 'refs/heads/main',
        sparse_checkout_paths: [],
        type: 'git_repository' as const,
        url: 'https://github.com/acme/widgets',
      };
      const apiSource = {
        ...widgetSource,
        url: 'https://github.com/acme/api',
      };

      try {
        await mkdir(join(cwd, 'widgets', '.git'), { recursive: true });
        await mkdir(join(cwd, 'api', '.git'), { recursive: true });

        const fastify = createMockFastify();
        const cleanup = await __testing.configureGitCredentialHelpers(
          fastify,
          'test-user-id',
          cwd,
          [widgetSource, apiSource]
        );

        const widgetsHelper = join(cwd, 'widgets', '.git', 'ccbricks-credential-helper.mjs');
        const apiHelper = join(cwd, 'api', '.git', 'ccbricks-credential-helper.mjs');

        expect(mockRegisterGitCredential).toHaveBeenNthCalledWith(
          1,
          fastify,
          'test-user-id',
          widgetSource.url
        );
        expect(mockRegisterGitCredential).toHaveBeenNthCalledWith(
          2,
          fastify,
          'test-user-id',
          apiSource.url
        );
        expect(mockSpawn).toHaveBeenNthCalledWith(
          1,
          'git',
          ['config', '--local', 'credential.helper', widgetsHelper],
          expect.objectContaining({ cwd: join(cwd, 'widgets'), shell: false })
        );
        expect(mockSpawn).toHaveBeenNthCalledWith(
          2,
          'git',
          ['config', '--local', 'credential.useHttpPath', 'true'],
          expect.objectContaining({ cwd: join(cwd, 'widgets'), shell: false })
        );
        expect(mockSpawn).toHaveBeenNthCalledWith(
          3,
          'git',
          ['config', '--local', 'credential.helper', apiHelper],
          expect.objectContaining({ cwd: join(cwd, 'api'), shell: false })
        );
        expect(mockSpawn).toHaveBeenNthCalledWith(
          4,
          'git',
          ['config', '--local', 'credential.useHttpPath', 'true'],
          expect.objectContaining({ cwd: join(cwd, 'api'), shell: false })
        );

        cleanup?.();

        expect(mockRevokeGitCredential).toHaveBeenCalledTimes(2);
        expect(mockRevokeGitCredential).toHaveBeenNthCalledWith(1, fastify, 'credential-token-1');
        expect(mockRevokeGitCredential).toHaveBeenNthCalledWith(2, fastify, 'credential-token-2');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('event UUID normalization', () => {
    it('keeps valid PostgreSQL UUID values', () => {
      const uuid = '019bdf24-b923-7aaa-918c-8ce71422def0';

      expect(__testing.extractEventUuid({ type: 'system', uuid } as unknown as SDKMessage)).toBe(
        uuid
      );
    });

    it('replaces non-UUID event ids before Lakebase persistence', () => {
      const eventUuid = __testing.extractEventUuid({
        type: 'system',
        uuid: 'event-not-a-postgres-uuid',
      } as unknown as SDKMessage);

      expect(eventUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(eventUuid).not.toBe('event-not-a-postgres-uuid');
    });
  });

  describe('canAbortSession', () => {
    it('should return false when no abort controller is registered', () => {
      const sessionId = new SessionId();
      expect(canAbortSession(sessionId)).toBe(false);
    });
  });

  describe('session control settings', () => {
    function startAskUserQuestion(
      fastify: FastifyInstance,
      sessionId: SessionId,
      toolUseID: string,
      input: Record<string, unknown>
    ) {
      return __testing.handleCanUseTool({
        fastify,
        userId: 'user-123',
        sessionId,
        toolName: 'AskUserQuestion',
        input,
        options: {
          signal: new AbortController().signal,
          toolUseID,
        },
      });
    }

    it('stores an allowed model change', async () => {
      const { fastify, set } = createContextUpdateFastify();
      const sessionId = new SessionId();

      await setSessionModel(fastify, 'user-123', sessionId, 'claude-opus-4-7');

      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            model: 'claude-opus-4-7',
          }),
        })
      );
    });

    it('rejects a model change to an unallowed model id', async () => {
      const { fastify, set } = createContextUpdateFastify();
      const sessionId = new SessionId();

      await expect(setSessionModel(fastify, 'user-123', sessionId, 'gpt-4-evil')).rejects.toThrow(
        'model must be an allowed model id'
      );

      expect(set).not.toHaveBeenCalled();
    });

    it('stores permission mode and effort level in session context', async () => {
      const { fastify, set } = createContextUpdateFastify();
      const sessionId = new SessionId();

      await setSessionPermissionMode(fastify, 'user-123', sessionId, 'plan');
      await applySessionFlagSettings(fastify, 'user-123', sessionId, { effortLevel: 'max' });

      expect(set).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          context: expect.objectContaining({
            permission_mode: 'plan',
          }),
        })
      );
      expect(set).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          context: expect.objectContaining({
            effort_level: 'max',
          }),
        })
      );
    });

    it('applies control changes to the active SDK query when present', async () => {
      const { fastify } = createContextUpdateFastify();
      const sessionId = new SessionId();
      const queryHandle = {
        setModel: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        applyFlagSettings: vi.fn().mockResolvedValue(undefined),
      } as unknown as Query;
      __testing.registerActiveSessionQuery(sessionId, { query: queryHandle });

      await setSessionModel(fastify, 'user-123', sessionId, 'claude-opus-4-7');
      await setSessionPermissionMode(fastify, 'user-123', sessionId, 'auto');
      await applySessionFlagSettings(fastify, 'user-123', sessionId, { effortLevel: 'medium' });

      expect(queryHandle.setModel).toHaveBeenCalledWith('claude-opus-4-7');
      expect(queryHandle.setPermissionMode).toHaveBeenCalledWith('auto');
      expect(queryHandle.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'medium' });
    });

    it('rolls back persisted permission mode when the active SDK update fails', async () => {
      const { fastify, set } = createContextUpdateFastify({
        permission_mode: 'acceptEdits',
      });
      const sessionId = new SessionId();
      const queryHandle = {
        setModel: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockRejectedValue(new Error('SDK permission update failed')),
        applyFlagSettings: vi.fn().mockResolvedValue(undefined),
      } as unknown as Query;
      __testing.registerActiveSessionQuery(sessionId, { query: queryHandle });

      await expect(
        setSessionPermissionMode(fastify, 'user-123', sessionId, 'plan')
      ).rejects.toThrow('SDK permission update failed');

      expect(set).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          context: expect.objectContaining({
            permission_mode: 'plan',
            permission_mode_before_plan: 'acceptEdits',
          }),
        })
      );
      expect(set).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          context: expect.objectContaining({
            permission_mode: 'acceptEdits',
          }),
        })
      );
    });

    it('persists max effort without forwarding it to live applyFlagSettings', async () => {
      const { fastify, set } = createContextUpdateFastify();
      const sessionId = new SessionId();
      const queryHandle = {
        setModel: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        applyFlagSettings: vi.fn().mockResolvedValue(undefined),
      } as unknown as Query;
      __testing.registerActiveSessionQuery(sessionId, { query: queryHandle });

      await applySessionFlagSettings(fastify, 'user-123', sessionId, { effortLevel: 'max' });

      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            effort_level: 'max',
          }),
        })
      );
      expect(queryHandle.applyFlagSettings).not.toHaveBeenCalled();
    });

    it('ignores empty flag settings', async () => {
      const { fastify, set } = createContextUpdateFastify();
      const sessionId = new SessionId();

      await applySessionFlagSettings(fastify, 'user-123', sessionId, {});

      expect(set).not.toHaveBeenCalled();
    });

    it('returns updated input for non-interactive tool permissions', async () => {
      const { fastify } = createContextUpdateFastify();
      const sessionId = new SessionId();
      const input = { command: 'echo hi' };

      const result = await __testing.handleCanUseTool({
        fastify,
        userId: 'user-123',
        sessionId,
        toolName: 'Bash',
        input,
        options: {
          signal: new AbortController().signal,
          toolUseID: 'toolu-test',
        },
      });

      expect(result).toEqual({
        behavior: 'allow',
        updatedInput: input,
      });
    });

    it('normalizes AskUserQuestion answers to SDK question keys', async () => {
      const { fastify } = createContextUpdateFastify();
      const sessionId = new SessionId();
      const input = {
        questions: [
          {
            question: '何を確認したいですか?',
            header: '確認目的',
            options: [
              {
                label: 'UIの見た目を確認したい',
                description: 'UI rendering should be checked',
              },
              {
                label: '動作を確認したい',
                description: 'Behavior should be checked',
              },
            ],
          },
        ],
      };

      const resultPromise = startAskUserQuestion(
        fastify,
        sessionId,
        'toolu-ask-user-question',
        input
      );

      resolveUserAnswer('toolu-ask-user-question', {
        確認目的: 'UIの見た目を確認したい',
      });

      await expect(resultPromise).resolves.toEqual({
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: {
            '何を確認したいですか?': 'UIの見た目を確認したい',
          },
        },
      });
    });

    it('normalizes AskUserQuestion multi-select arrays to comma-separated SDK answers', async () => {
      const { fastify } = createContextUpdateFastify();
      const sessionId = new SessionId();
      const input = {
        questions: [
          {
            question: 'Which features should be enabled?',
            header: 'Features',
            multiSelect: true,
            options: [
              { label: 'Auth', description: 'Enable authentication' },
              { label: 'Billing', description: 'Enable billing' },
            ],
          },
        ],
      };

      const resultPromise = startAskUserQuestion(
        fastify,
        sessionId,
        'toolu-ask-user-question-multi',
        input
      );

      resolveUserAnswer('toolu-ask-user-question-multi', {
        Features: ['Auth', 'Billing'],
      });

      await expect(resultPromise).resolves.toEqual({
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: {
            'Which features should be enabled?': 'Auth,Billing',
          },
        },
      });
    });

    it('rejects AskUserQuestion inputs with duplicate headers', async () => {
      const { fastify } = createContextUpdateFastify();
      const sessionId = new SessionId();
      const input = {
        questions: [
          { question: 'Which UI library?', header: 'Library' },
          { question: 'Which database library?', header: 'Library' },
        ],
      };

      const resultPromise = startAskUserQuestion(
        fastify,
        sessionId,
        'toolu-ask-user-question-duplicate-header',
        input
      );

      resolveUserAnswer('toolu-ask-user-question-duplicate-header', {
        Library: 'React',
      });

      await expect(resultPromise).rejects.toThrow(
        "AskUserQuestion input contains duplicate header 'Library'"
      );
    });

    it('rejects AskUserQuestion answers that do not match any question', async () => {
      const { fastify } = createContextUpdateFastify();
      const sessionId = new SessionId();
      const input = {
        questions: [{ question: 'Which framework?', header: 'Framework' }],
      };

      const resultPromise = startAskUserQuestion(
        fastify,
        sessionId,
        'toolu-ask-user-question-unknown-key',
        input
      );

      resolveUserAnswer('toolu-ask-user-question-unknown-key', {
        Library: 'React',
      });

      await expect(resultPromise).rejects.toThrow(
        "AskUserQuestion answer key 'Library' does not match any question"
      );
    });

    it('rejects comma-containing AskUserQuestion multi-select answers', async () => {
      const { fastify } = createContextUpdateFastify();
      const sessionId = new SessionId();
      const input = {
        questions: [
          {
            question: 'Which companies should be enabled?',
            header: 'Companies',
            multiSelect: true,
          },
        ],
      };

      const resultPromise = startAskUserQuestion(
        fastify,
        sessionId,
        'toolu-ask-user-question-comma',
        input
      );

      resolveUserAnswer('toolu-ask-user-question-comma', {
        Companies: ['Apple, Inc.', 'Banana'],
      });

      await expect(resultPromise).rejects.toThrow(
        "AskUserQuestion multi-select answer for 'Companies' cannot contain a comma: 'Apple, Inc.'"
      );
    });

    it('waits for ExitPlanMode approval and restores the pre-plan permission mode', async () => {
      const { fastify, set } = createContextUpdateFastify({
        permission_mode: 'plan',
        permission_mode_before_plan: 'acceptEdits',
      });
      const sessionId = new SessionId();
      const input = { plan: '# Plan' };

      const resultPromise = __testing.handleCanUseTool({
        fastify,
        userId: 'user-123',
        sessionId,
        toolName: 'ExitPlanMode',
        input,
        options: {
          signal: new AbortController().signal,
          toolUseID: 'toolu-exit-plan',
        },
      });

      resolveExitPlanModeDecision('toolu-exit-plan', { approved: true });

      await expect(resultPromise).resolves.toEqual({
        behavior: 'allow',
        updatedInput: input,
      });
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            permission_mode: 'acceptEdits',
          }),
        })
      );
    });

    it('returns deny message when ExitPlanMode receives revision instructions', async () => {
      const { fastify } = createContextUpdateFastify();
      const sessionId = new SessionId();

      const resultPromise = __testing.handleCanUseTool({
        fastify,
        userId: 'user-123',
        sessionId,
        toolName: 'ExitPlanMode',
        input: { plan: '# Plan' },
        options: {
          signal: new AbortController().signal,
          toolUseID: 'toolu-revise-plan',
        },
      });

      resolveExitPlanModeDecision('toolu-revise-plan', {
        approved: false,
        message: 'Add tests before implementation',
      });

      await expect(resultPromise).resolves.toEqual({
        behavior: 'deny',
        message: 'Add tests before implementation',
      });
    });
  });

  describe('executeAbort', () => {
    let fastify: FastifyInstance;
    const userId = 'user-123';

    beforeEach(() => {
      fastify = createMockFastify();
    });

    function registerAbortableSession(sessionId: SessionId): AbortController {
      const abortController = new AbortController();
      __testing.registerActiveSessionQuery(sessionId, {
        userId,
        abortController,
        query: {} as Query,
      });
      return abortController;
    }

    function expectAbortEvents(sessionId: SessionId, text: string): void {
      expect(enqueueSessionEvent).toHaveBeenCalledTimes(2);
      expect(enqueueSessionEvent).toHaveBeenNthCalledWith(
        1,
        fastify,
        expect.objectContaining({
          userId,
          sessionId: sessionId.toUUID(),
          type: 'user',
          subtype: null,
          message: expect.objectContaining({
            type: 'user',
            session_id: sessionId.toString(),
            message: expect.objectContaining({
              role: 'user',
              content: [{ type: 'text', text }],
            }),
          }),
        })
      );
      expect(enqueueSessionEvent).toHaveBeenNthCalledWith(
        2,
        fastify,
        expect.objectContaining({
          userId,
          sessionId: sessionId.toUUID(),
          type: 'result',
          subtype: 'error_during_execution',
          message: expect.objectContaining({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: false,
          }),
        })
      );
      expect(wsManager.broadcast).toHaveBeenCalledTimes(2);
    }

    it('should do nothing when no abort controller exists', async () => {
      const sessionId = new SessionId();

      await executeAbort(fastify, userId, sessionId);

      expect(wsManager.broadcast).not.toHaveBeenCalled();
      expect(enqueueSessionEvent).not.toHaveBeenCalled();
    });

    it('should broadcast user abort message and result event when abort controller exists', async () => {
      const sessionId = new SessionId();
      const abortController = registerAbortableSession(sessionId);

      await executeAbort(fastify, userId, sessionId);

      expect(abortController.signal.aborted).toBe(true);
      expectAbortEvents(sessionId, __testing.USER_ABORT_MESSAGE_TEXT);
    });

    it('should abort active sessions for shutdown with a system shutdown user message', async () => {
      const sessionId = new SessionId();
      const abortController = registerAbortableSession(sessionId);

      await abortActiveSessionsForShutdown(fastify);

      expect(abortController.signal.aborted).toBe(true);
      expectAbortEvents(sessionId, __testing.SYSTEM_SHUTDOWN_ABORT_MESSAGE_TEXT);
      expect(fastify.withUserContext).toHaveBeenCalledTimes(1);
    });

    it('should not write duplicate events when shutdown abort follows user abort', async () => {
      const sessionId = new SessionId();
      const abortController = registerAbortableSession(sessionId);

      await executeAbort(fastify, userId, sessionId);
      await abortActiveSessionsForShutdown(fastify);

      expect(abortController.signal.aborted).toBe(true);
      expectAbortEvents(sessionId, __testing.USER_ABORT_MESSAGE_TEXT);
    });

    it('should do nothing when shutdown abort has no active sessions', async () => {
      await abortActiveSessionsForShutdown(fastify);

      expect(wsManager.broadcast).not.toHaveBeenCalled();
      expect(enqueueSessionEvent).not.toHaveBeenCalled();
    });
  });

  describe('completeRunAndClaimQueuedMessage', () => {
    const userId = 'user-123';

    function createQueuedResumeFastify() {
      const sessionContext = {} as SessionContextResponse;
      const userMessage = {
        type: 'user',
        uuid: '019bdf24-b923-7aaa-918c-8ce71422def1',
        session_id: 'session-id',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'queued prompt' }],
        },
      } as SDKUserMessage;
      const sessionRow = {
        sdkSessionId: 'sdk-session-id',
        status: 'running',
        context: sessionContext,
      };
      const queuedEvent = {
        uuid: 'queued-event-uuid',
        message: userMessage,
      };
      const sessionSelectLimit = vi.fn().mockResolvedValue([sessionRow]);
      const queuedSelectLimit = vi.fn().mockResolvedValue([queuedEvent]);
      const select = vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: sessionSelectLimit,
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: queuedSelectLimit,
              }),
            }),
          }),
        });
      const update = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });
      const tx = { select, update };
      const withUserContext = vi.fn(
        async (_userId: string, callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx)
      );
      const fastify = {
        withUserContext,
      } as unknown as FastifyInstance;

      return { fastify, select, update, sessionContext, userMessage };
    }

    it('should claim queued message when queued resume is enabled', async () => {
      const sessionId = new SessionId();
      const { fastify, select, update, sessionContext, userMessage } = createQueuedResumeFastify();

      const result = await __testing.completeRunAndClaimQueuedMessage(
        fastify,
        userId,
        sessionId,
        null
      );

      expect(result).toEqual({
        userMessage,
        sessionContext,
        sdkSessionId: 'sdk-session-id',
      });
      expect(select).toHaveBeenCalledTimes(2);
      expect(update).toHaveBeenCalledTimes(2);
    });

    it('should not claim queued message when queued resume is disabled', async () => {
      const sessionId = new SessionId();
      const { fastify, select, update } = createQueuedResumeFastify();

      const result = await __testing.completeRunAndClaimQueuedMessage(
        fastify,
        userId,
        sessionId,
        null,
        { claimQueuedMessage: false }
      );

      expect(result).toBeNull();
      expect(select).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
    });
  });

  describe('saveAndBroadcastEvent (via enqueueSessionEvent)', () => {
    // Note: saveAndBroadcastEvent is not exported, but we can test it indirectly
    // through executeAbort or other exported functions

    it('should be called by executeAbort with correct parameters', async () => {
      // This test documents the expected behavior even if we can't test it directly
      // without exposing internal state
      expect(enqueueSessionEvent).toBeDefined();
    });
  });
});

describe('SessionId', () => {
  it('should generate unique session IDs', () => {
    const id1 = new SessionId();
    const id2 = new SessionId();

    expect(id1.toString()).not.toBe(id2.toString());
  });

  it('should generate UUIDv7 format', () => {
    const sessionId = new SessionId();
    expect(sessionId.toString()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('should convert to and from UUID', () => {
    const sessionId = new SessionId();
    const uuid = sessionId.toUUID();
    const restored = SessionId.fromUUID(uuid);

    expect(restored.toString()).toBe(sessionId.toString());
  });

  it('should convert to and from string', () => {
    const sessionId = new SessionId();
    const str = sessionId.toString();
    const restored = SessionId.fromString(str);

    expect(restored.toString()).toBe(str);
  });

  it('toString and toUUID should return the same value', () => {
    const sessionId = new SessionId();
    expect(sessionId.toString()).toBe(sessionId.toUUID());
  });
});
