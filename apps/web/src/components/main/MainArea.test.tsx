import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MainArea } from './MainArea';

const emitExitPlanMode = vi.hoisted(() => ({ value: false }));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockUpdateSession = vi.hoisted(() => vi.fn());
const mockRefetchSession = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', () => ({
  useParams: () => ({ sessionId: 'session-1' }),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ state: null }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => ({
    githubOAuthAuthorization: { status: 'connected' },
    modelSettings: null,
  }),
}));

vi.mock('@/hooks/useOpenWorkspace', () => ({
  useOpenWorkspace: () => ({
    openWorkspace: vi.fn(),
    isOpeningWorkspace: false,
  }),
}));

vi.mock('@/hooks/useSession', () => ({
  useSession: () => ({
    session: {
      id: 'session-1',
      title: 'Test session',
      session_status: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      session_context: {
        cwd: '/workspace',
        model: 'claude-sonnet',
        permission_mode: 'plan',
        permission_mode_before_plan: 'auto',
        effort_level: 'high',
        sources: [
          {
            type: 'git_repository',
            url: 'https://github.com/acme/widgets',
            revision: 'refs/heads/main',
            sparse_checkout_paths: [],
            allow_unrestricted_git_push: true,
          },
        ],
        outcomes: [
          {
            type: 'git_repository',
            git_info: {
              type: 'github',
              repo: 'acme/widgets',
              branches: ['ccbricks/test'],
            },
          },
        ],
      },
    },
    updateSession: mockUpdateSession,
    refetch: mockRefetchSession,
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useSessionEvents', async () => {
  const React = await vi.importActual<typeof import('react')>('react');

  return {
    useSessionEvents: (params: {
      onExitPlanMode?: (request: {
        type: 'exit_plan_mode';
        tool_use_id: string;
        input: Record<string, unknown>;
      }) => void;
    }) => {
      const { onExitPlanMode } = params;

      React.useEffect(() => {
        if (!emitExitPlanMode.value) return;
        onExitPlanMode?.({
          type: 'exit_plan_mode',
          tool_use_id: 'plan-1',
          input: {},
        });
      }, [onExitPlanMode]);

      return {
        events: [],
        toolResultIds: new Set<string>(),
        isLoading: false,
        error: null,
        sessionStatus: 'running',
        sendMessage: vi.fn(),
        answerQuestion: vi.fn().mockResolvedValue(true),
        respondExitPlanMode: vi.fn().mockResolvedValue(true),
        abort: vi.fn().mockResolvedValue(true),
        setPermissionMode: vi.fn().mockResolvedValue(true),
        setModel: vi.fn().mockResolvedValue(true),
        setEffortLevel: vi.fn().mockResolvedValue(true),
      };
    },
  };
});

vi.mock('./MainHeader', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    MainHeader: () => React.createElement('div', { 'data-testid': 'main-header' }),
  };
});

vi.mock('./MessageArea', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    MessageArea: ({ bottomPaddingClassName }: { bottomPaddingClassName: string }) =>
      React.createElement('div', {
        'data-testid': 'message-area',
        'data-bottom-padding': bottomPaddingClassName,
      }),
  };
});

vi.mock('./InputArea', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    InputArea: () => React.createElement('div', { 'data-testid': 'input-area' }),
  };
});

vi.mock('./ExitPlanModeInputArea', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    ExitPlanModeInputArea: () => React.createElement('div', { 'data-testid': 'exit-plan-input' }),
  };
});

vi.mock('./GitRepositoryStatusBar', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    GitRepositoryStatusBar: ({ isHidden }: { isHidden?: boolean }) =>
      React.createElement('div', {
        'data-testid': 'git-status-bar',
        'data-hidden': isHidden ? 'true' : 'false',
      }),
  };
});

vi.mock('./WelcomeScreen', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    WelcomeScreen: () => React.createElement('div', { 'data-testid': 'welcome-screen' }),
  };
});

vi.mock('./SessionNotFound', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    SessionNotFound: () => React.createElement('div', { 'data-testid': 'session-not-found' }),
  };
});

describe('MainArea git repository status', () => {
  beforeEach(() => {
    emitExitPlanMode.value = false;
    vi.clearAllMocks();
  });

  it('shows the git status bar for a git repository session', () => {
    render(<MainArea />);

    expect(screen.getByTestId('git-status-bar').getAttribute('data-hidden')).toBe('false');
    expect(screen.getByTestId('message-area').getAttribute('data-bottom-padding')).toBe('pb-36');
    expect(screen.queryByTestId('exit-plan-input')).toBeNull();
  });

  it('keeps the git status mounted but hidden while exit plan approval is pending', async () => {
    emitExitPlanMode.value = true;

    render(<MainArea />);

    expect(await screen.findByTestId('exit-plan-input')).toBeTruthy();
    expect(screen.getByTestId('git-status-bar').getAttribute('data-hidden')).toBe('true');
    expect(screen.getByTestId('message-area').getAttribute('data-bottom-padding')).toBe('pb-36');
  });
});
