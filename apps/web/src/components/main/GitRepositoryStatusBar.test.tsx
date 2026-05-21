import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import type { ComponentProps } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { GitRepositoryStatusBar } from './GitRepositoryStatusBar';

const mockGitRepositoryService = vi.hoisted(() => ({
  getBranch: vi.fn(),
  listPullRequests: vi.fn(),
  createPullRequest: vi.fn(),
}));

const mockSessionService = vi.hoisted(() => ({
  getGitDiff: vi.fn(),
}));

vi.mock('@/services/git-repository.service', () => ({
  gitRepositoryService: mockGitRepositoryService,
}));

vi.mock('@/services/session.service', () => ({
  sessionService: mockSessionService,
}));

beforeEach(async () => {
  vi.clearAllMocks();
  mockSessionService.getGitDiff.mockResolvedValue(null);
  Object.defineProperty(window, 'open', {
    value: vi.fn(),
    writable: true,
  });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });

  await i18n.init({
    lng: 'en',
    resources: {
      en: {
        translation: {
          gitStatus: {
            openRepository: 'Open repository on GitHub',
            copyBranch: 'Copy branch name',
            branchCopied: 'Branch name copied',
            branchCopyError: 'Failed to copy branch name',
            openPullRequest: 'Open pull request',
            createPullRequest: 'Create PR',
            createDraftPullRequest: 'Create draft PR',
            createPullRequestError: 'Failed to create pull request',
            status: {
              open: 'Open',
              draft: 'Draft',
              closed: 'Closed',
              merged: 'Merged',
              none: 'No pull request',
            },
          },
        },
      },
    },
  });
});

function renderStatusBar(props: Partial<ComponentProps<typeof GitRepositoryStatusBar>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider delayDuration={0}>
        <GitRepositoryStatusBar
          sessionId="019729a8-0000-7000-8000-000000000000"
          owner="acme"
          repo="widgets"
          headBranch="ccbricks/test"
          baseBranch="main"
          sessionTitle="Update widgets"
          {...props}
        />
      </TooltipProvider>
    </I18nextProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(innerResolve => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('GitRepositoryStatusBar', () => {
  it('shows existing pull request details and opens the pull request number directly', async () => {
    mockGitRepositoryService.getBranch.mockResolvedValue({
      name: 'ccbricks/test',
      html_url: 'https://github.com/acme/widgets/tree/ccbricks%2Ftest',
      compare: { html_url: 'https://github.com/acme/widgets/compare/main...ccbricks/test' },
    });
    mockGitRepositoryService.listPullRequests.mockResolvedValue({
      pulls: [
        {
          number: 4,
          title: 'Update widgets',
          state: 'closed',
          draft: false,
          merged: true,
          html_url: 'https://github.com/acme/widgets/pull/4',
          head: { ref: 'ccbricks/test', label: 'acme:ccbricks/test' },
          base: { ref: 'main', label: 'acme:main' },
        },
      ],
    });

    renderStatusBar();

    const pullButton = await screen.findByRole('button', { name: '#4' });
    expect(screen.getByText('widgets')).toBeTruthy();
    expect(screen.getByText('ccbricks/test')).toBeTruthy();
    expect(screen.queryByText('Merged')).toBeNull();
    const pullIcon = document.body.querySelector('.lucide-git-merge');
    expect(pullIcon).toBeTruthy();
    expect(pullButton.querySelector('svg')).toBeNull();

    fireEvent.click(pullIcon!);
    expect(window.open).not.toHaveBeenCalled();
    fireEvent.click(pullButton);
    expect(window.open).toHaveBeenCalledWith(
      'https://github.com/acme/widgets/pull/4',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('copies the branch name when the branch chip is clicked', async () => {
    mockGitRepositoryService.getBranch.mockResolvedValue({
      name: 'ccbricks/test',
      html_url: 'https://github.com/acme/widgets/tree/ccbricks%2Ftest',
      compare: null,
    });
    mockGitRepositoryService.listPullRequests.mockResolvedValue({ pulls: [] });

    renderStatusBar();

    fireEvent.click(await screen.findByText('ccbricks/test'));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ccbricks/test');
  });

  it('uses a commit icon when no pull request exists', async () => {
    mockGitRepositoryService.getBranch.mockResolvedValue({
      name: 'ccbricks/test',
      html_url: 'https://github.com/acme/widgets/tree/ccbricks%2Ftest',
      compare: null,
    });
    mockGitRepositoryService.listPullRequests.mockResolvedValue({ pulls: [] });

    renderStatusBar();

    expect(await screen.findByRole('button', { name: 'Create PR' })).toBeTruthy();
    expect(document.body.querySelector('.lucide-git-commit-vertical')).toBeTruthy();
    expect(screen.queryByText('#')).toBeNull();
  });

  it('refreshes the local diff when the refresh key changes', async () => {
    mockGitRepositoryService.getBranch.mockResolvedValue({
      name: 'ccbricks/test',
      html_url: 'https://github.com/acme/widgets/tree/ccbricks%2Ftest',
      compare: null,
    });
    mockGitRepositoryService.listPullRequests.mockResolvedValue({ pulls: [] });
    mockSessionService.getGitDiff
      .mockResolvedValueOnce({
        html_url: 'https://github.com/acme/widgets/compare/main...ccbricks/test',
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        additions: 2,
        deletions: 0,
      })
      .mockResolvedValueOnce({
        html_url: 'https://github.com/acme/widgets/compare/main...ccbricks/test',
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        additions: 5,
        deletions: 1,
      });

    const { rerender } = renderStatusBar({ diffRefreshKey: 0 });
    expect(await screen.findByText('+2')).toBeTruthy();

    rerender(
      <I18nextProvider i18n={i18n}>
        <TooltipProvider delayDuration={0}>
          <GitRepositoryStatusBar
            sessionId="019729a8-0000-7000-8000-000000000000"
            owner="acme"
            repo="widgets"
            headBranch="ccbricks/test"
            baseBranch="main"
            sessionTitle="Update widgets"
            diffRefreshKey={1}
          />
        </TooltipProvider>
      </I18nextProvider>
    );

    expect(await screen.findByText('+5')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
    expect(mockSessionService.getGitDiff).toHaveBeenCalledTimes(2);
  });

  it('uses a red closed icon for closed pull requests', async () => {
    mockGitRepositoryService.getBranch.mockResolvedValue({
      name: 'ccbricks/test',
      html_url: 'https://github.com/acme/widgets/tree/ccbricks%2Ftest',
      compare: null,
    });
    mockGitRepositoryService.listPullRequests.mockResolvedValue({
      pulls: [
        {
          number: 8,
          title: 'Closed widgets',
          state: 'closed',
          draft: false,
          merged: false,
          html_url: 'https://github.com/acme/widgets/pull/8',
          head: { ref: 'ccbricks/test', label: 'acme:ccbricks/test' },
          base: { ref: 'main', label: 'acme:main' },
        },
      ],
    });

    renderStatusBar();

    expect(await screen.findByText('#8')).toBeTruthy();
    const closedIcon = document.body.querySelector('.lucide-git-pull-request-closed');
    expect(closedIcon).toBeTruthy();
    expect(closedIcon?.getAttribute('class')).toContain('text-red-600');
    expect(screen.queryByText('Closed')).toBeNull();
  });

  it('shows pull request status when hovering the status icon', async () => {
    mockGitRepositoryService.getBranch.mockResolvedValue({
      name: 'ccbricks/test',
      html_url: 'https://github.com/acme/widgets/tree/ccbricks%2Ftest',
      compare: null,
    });
    mockGitRepositoryService.listPullRequests.mockResolvedValue({
      pulls: [
        {
          number: 8,
          title: 'Closed widgets',
          state: 'closed',
          draft: false,
          merged: false,
          html_url: 'https://github.com/acme/widgets/pull/8',
          head: { ref: 'ccbricks/test', label: 'acme:ccbricks/test' },
          base: { ref: 'main', label: 'acme:main' },
        },
      ],
    });

    renderStatusBar();

    await screen.findByText('#8');
    const iconWrapper = document.body.querySelector(
      '.lucide-git-pull-request-closed'
    )?.parentElement;
    expect(iconWrapper).toBeTruthy();
    fireEvent.pointerMove(iconWrapper!);
    fireEvent.pointerOver(iconWrapper!);
    fireEvent.mouseMove(iconWrapper!);

    expect((await screen.findAllByText('Closed')).length).toBeGreaterThan(0);
  });

  it('creates a draft pull request from the split button menu', async () => {
    mockGitRepositoryService.getBranch.mockResolvedValue({
      name: 'ccbricks/test',
      html_url: 'https://github.com/acme/widgets/tree/ccbricks%2Ftest',
      compare: null,
    });
    mockSessionService.getGitDiff.mockResolvedValue({
      html_url: 'https://github.com/acme/widgets/compare/main...ccbricks/test',
      ahead_by: 2,
      behind_by: 0,
      total_commits: 2,
      additions: 60,
      deletions: 6,
    });
    mockGitRepositoryService.listPullRequests.mockResolvedValue({ pulls: [] });
    mockGitRepositoryService.createPullRequest.mockResolvedValue({
      number: 5,
      title: 'Update widgets',
      state: 'open',
      draft: true,
      merged: false,
      html_url: 'https://github.com/acme/widgets/pull/5',
      head: { ref: 'ccbricks/test', label: 'acme:ccbricks/test' },
      base: { ref: 'main', label: 'acme:main' },
    });

    renderStatusBar();

    await screen.findByText('+60');
    expect(mockSessionService.getGitDiff).toHaveBeenCalledWith(
      '019729a8-0000-7000-8000-000000000000'
    );
    expect(screen.getByRole('button', { name: 'Create PR' }).querySelector('svg')).toBeNull();
    expect(document.body.querySelector('.lucide-git-pull-request')).toBeNull();
    const menuButton = screen.getByRole('button', { expanded: false });
    fireEvent.pointerDown(menuButton, { button: 0, ctrlKey: false });
    await screen.findByText('Create draft PR');
    expect(document.body.querySelector('.lucide-git-pull-request-arrow')).toBeTruthy();
    expect(document.body.querySelector('.lucide-git-pull-request-draft')).toBeTruthy();
    fireEvent.click(screen.getByText('Create draft PR'));

    await waitFor(() => {
      expect(mockGitRepositoryService.createPullRequest).toHaveBeenCalledWith('acme/widgets', {
        title: 'Update widgets',
        head: 'acme:ccbricks/test',
        base: 'main',
        draft: true,
        session_id: '019729a8-0000-7000-8000-000000000000',
        language: 'en',
      });
    });
    expect(screen.getByText('+60')).toBeTruthy();
    expect(screen.getByText('-6')).toBeTruthy();
    expect(window.open).toHaveBeenCalledWith(
      'https://github.com/acme/widgets/pull/5',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('still shows pull request details without an error label when branch details fail', async () => {
    mockGitRepositoryService.getBranch.mockRejectedValue(new Error('Branch not found'));
    mockGitRepositoryService.listPullRequests.mockResolvedValue({
      pulls: [
        {
          number: 4,
          title: 'Update widgets',
          state: 'open',
          draft: false,
          merged: false,
          html_url: 'https://github.com/acme/widgets/pull/4',
          head: { ref: 'ccbricks/test', label: 'acme:ccbricks/test' },
          base: { ref: 'main', label: 'acme:main' },
        },
      ],
    });

    renderStatusBar();

    expect(await screen.findByText('#4')).toBeTruthy();
    expect(
      document.body.querySelector('.lucide-git-pull-request-arrow')?.getAttribute('class')
    ).toContain('text-green-600');
    expect(screen.queryByText('Open')).toBeNull();
    expect(screen.queryByText('GitHub details unavailable')).toBeNull();
  });

  it('treats pull request list failures as no existing pull request', async () => {
    mockGitRepositoryService.getBranch.mockResolvedValue({
      name: 'ccbricks/test',
      html_url: 'https://github.com/acme/widgets/tree/ccbricks%2Ftest',
      compare: {
        html_url: 'https://github.com/acme/widgets/compare/main...ccbricks/test',
        additions: 9,
        deletions: 1,
      },
    });
    mockGitRepositoryService.listPullRequests.mockRejectedValue(new Error('Pulls unavailable'));

    renderStatusBar();

    expect(await screen.findByText('+9')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeTruthy();
    expect(screen.queryByText('GitHub details unavailable')).toBeNull();
  });

  it('clears stale pull request data when switching sessions and ignores old responses', async () => {
    const oldPulls = deferred<{
      pulls: Array<{
        number: number;
        title: string;
        state: 'open';
        draft: boolean;
        merged: boolean;
        html_url: string;
        head: { ref: string; label: string };
        base: { ref: string; label: string };
      }>;
    }>();
    mockGitRepositoryService.getBranch.mockResolvedValue({
      name: 'ccbricks/old',
      html_url: 'https://github.com/acme/widgets/tree/ccbricks%2Fold',
      compare: null,
    });
    mockGitRepositoryService.listPullRequests.mockReturnValueOnce(oldPulls.promise);

    const { rerender } = renderStatusBar({
      sessionId: '019729a8-0000-7000-8000-000000000001',
      headBranch: 'ccbricks/old',
    });

    expect(await screen.findByText('ccbricks/old')).toBeTruthy();

    mockGitRepositoryService.getBranch.mockResolvedValue({
      name: 'ccbricks/new',
      html_url: 'https://github.com/acme/widgets/tree/ccbricks%2Fnew',
      compare: null,
    });
    mockGitRepositoryService.listPullRequests.mockResolvedValueOnce({ pulls: [] });

    rerender(
      <I18nextProvider i18n={i18n}>
        <TooltipProvider delayDuration={0}>
          <GitRepositoryStatusBar
            sessionId="019729a8-0000-7000-8000-000000000002"
            owner="acme"
            repo="widgets"
            headBranch="ccbricks/new"
            baseBranch="main"
            sessionTitle="Update widgets"
          />
        </TooltipProvider>
      </I18nextProvider>
    );

    expect(await screen.findByText('ccbricks/new')).toBeTruthy();
    await act(async () => {
      oldPulls.resolve({
        pulls: [
          {
            number: 7,
            title: 'Old PR',
            state: 'open',
            draft: false,
            merged: false,
            html_url: 'https://github.com/acme/widgets/pull/7',
            head: { ref: 'ccbricks/old', label: 'acme:ccbricks/old' },
            base: { ref: 'main', label: 'acme:main' },
          },
        ],
      });
      await Promise.resolve();
    });

    expect(screen.queryByText('#7')).toBeNull();
  });
});
