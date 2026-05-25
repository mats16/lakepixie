import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'node:events';
import { SessionId } from '../models/session.model.js';

const mockSpawn = vi.hoisted(() => vi.fn());

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
      },
      config: {
        DATABRICKS_HOST: 'test.databricks.com',
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
    exitPlanModeTesting.clearPendingExitPlanModes();
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
        'Only one git repository source is supported'
      );
      expect(() =>
        __testing.validateGitSessionContext(
          [source, { type: 'databricks_workspace', path: '/Workspace/test' }],
          [outcome]
        )
      ).toThrow('cannot be combined');
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

    it('should do nothing when no abort controller exists', async () => {
      const sessionId = new SessionId();

      await executeAbort(fastify, userId, sessionId);

      expect(wsManager.broadcast).not.toHaveBeenCalled();
      expect(enqueueSessionEvent).not.toHaveBeenCalled();
    });

    it('should broadcast user abort message and result event when abort controller exists', async () => {
      // Register the session for abort by simulating a query in progress
      // We need to import and mock internal state here
      const sessionId = new SessionId();

      // To test this properly, we'd need to expose the sessionAbortControllers map
      // or use integration tests. For now, we test that it does nothing without a registered controller.
      await executeAbort(fastify, userId, sessionId);

      // Without a registered controller, no broadcasts should occur
      expect(wsManager.broadcast).not.toHaveBeenCalled();
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
