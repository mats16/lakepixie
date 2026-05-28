import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider, useSidebar } from './sidebar';

const originalMatchMedia = window.matchMedia;

function setIsMobile(isMobile: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: isMobile,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function SidebarStateProbe() {
  const { state } = useSidebar();

  return <div data-testid="sidebar-state">{state}</div>;
}

describe('SidebarProvider', () => {
  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it('keeps desktop collapsed state when the sidebar is closed', () => {
    setIsMobile(false);

    render(
      <SidebarProvider defaultOpen={false}>
        <SidebarStateProbe />
      </SidebarProvider>
    );

    expect(screen.getByTestId('sidebar-state').textContent).toBe('collapsed');
  });

  it('renders mobile sidebar content as expanded even if desktop state is closed', () => {
    setIsMobile(true);

    render(
      <SidebarProvider defaultOpen={false}>
        <SidebarStateProbe />
      </SidebarProvider>
    );

    expect(screen.getByTestId('sidebar-state').textContent).toBe('expanded');
  });
});
