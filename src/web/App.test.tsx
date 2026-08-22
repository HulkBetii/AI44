// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../shared/contracts';
import { api } from './api';
import { App } from './App';

vi.mock('./hooks', () => ({ useJobEvents: vi.fn() }));
vi.mock('./components', () => ({
  JobComposer: () => null,
  StatusPill: ({ status }: { status: string }) => <span>{status}</span>,
}));
vi.mock('./pages/DashboardPage', () => ({ DashboardPage: () => <div>Dashboard</div> }));
vi.mock('./pages/AccountsPage', () => ({ AccountsPage: () => <div>Accounts</div> }));
vi.mock('./pages/JobsPage', () => ({ JobsPage: () => <div>Jobs</div> }));
vi.mock('./pages/SettingsPage', () => ({ SettingsPage: () => <div>Settings</div> }));
vi.mock('./api', () => ({
  api: {
    health: vi.fn(),
    workflows: vi.fn(),
    settings: vi.fn(),
    jobs: vi.fn(),
    focusJob: vi.fn(),
  },
}));

function installMobileMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 768px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('App mobile navigation', () => {
  beforeEach(() => {
    installMobileMatchMedia();
    vi.mocked(api.health).mockResolvedValue({ status: 'ok', sheets: 'ready', gpm: 'ready', workerLock: 'free', activeJobId: null, queueLength: 0 });
    vi.mocked(api.workflows).mockResolvedValue([]);
    vi.mocked(api.settings).mockResolvedValue({ values: { sheetId: '', sheetName: '', serviceAccountPath: '', gpmApiBase: '', defaultIntervalMinutes: 1, runtimeDirectory: '' }, envOverrides: [], canEdit: true });
    vi.mocked(api.jobs).mockResolvedValue([]);
    window.history.pushState({}, '', '/dashboard');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps closed navigation inert and exposes health names on mobile', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    const menuButton = screen.getByRole('button', { name: 'Mở menu' });
    const sidebar = document.getElementById('primary-sidebar');
    expect(sidebar).toHaveAttribute('inert');
    expect(sidebar).toHaveAttribute('aria-hidden', 'true');
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(await screen.findByLabelText('Sheet: ready')).toBeInTheDocument();
    expect(screen.getByLabelText('GPM: ready')).toBeInTheDocument();
    expect(screen.getByLabelText('Worker: free')).toBeInTheDocument();

    await user.click(menuButton);
    expect(sidebar).not.toHaveAttribute('inert');
    expect(sidebar).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('button', { name: 'Đóng menu' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(sidebar!).getByRole('link', { name: 'Tổng quan' })).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mở menu' })).toHaveFocus());
    expect(sidebar).toHaveAttribute('inert');
  });

  it('shows neutral health loading and reports when CAPTCHA browser focus is unavailable', async () => {
    const health = deferred<Awaited<ReturnType<typeof api.health>>>();
    const focus = deferred<{ focused: boolean }>();
    vi.mocked(api.health).mockReturnValue(health.promise);
    vi.mocked(api.jobs).mockResolvedValue([activeAttentionJob()]);
    vi.mocked(api.focusJob).mockReturnValue(focus.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    expect(screen.getByLabelText('Sheet: Đang kiểm tra').querySelector('.signal-neutral')).toBeInTheDocument();
    const focusButton = await screen.findByRole('button', { name: 'Mở cửa sổ CAPTCHA' });
    fireEvent.click(focusButton);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Đang mở...' })).toBeDisabled());

    await act(async () => focus.resolve({ focused: false }));
    expect(await screen.findByText('Browser không còn hoạt động để đưa ra trước.')).toHaveAttribute('role', 'alert');
    await act(async () => health.resolve({ status: 'ok', sheets: 'ready', gpm: 'ready', workerLock: 'free', activeJobId: 'job-attention', queueLength: 0 }));

    await userEvent.setup().click(screen.getByRole('button', { name: 'Mở menu' }));
    const attentionBar = document.querySelector('.attention-bar');
    expect(attentionBar).toHaveAttribute('inert');
    expect(attentionBar).toHaveAttribute('aria-hidden', 'true');
  });
});

function activeAttentionJob(): JobRecord {
  return {
    id: 'job-attention',
    status: 'needs_attention',
    request: {
      workflowId: 'signup',
      selection: { mode: 'rows', rowIndexes: [25] },
      options: { proxyMode: 'sheet', intervalMinutes: 1, hasProxyTokenOverride: false },
    },
    acceptedRows: [25],
    rejectedCount: 0,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    currentRowIndex: 25,
    currentAccount: 1,
    totalAccounts: 1,
    currentStep: 'captcha',
    errorCount: 0,
    lastMessage: 'Giải CAPTCHA trong cửa sổ GPM',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
