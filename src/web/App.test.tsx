// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord, JobRequest, RecoveryResponse } from '../shared/contracts';
import { api } from './api';
import { App } from './App';

vi.mock('./hooks', () => ({ useJobEvents: vi.fn() }));
vi.mock('./components', () => ({
  JobComposer: ({ state }: { state: { workflowId: string; selection: JobRequest['selection'] } }) => <div role="dialog">Composer {state.workflowId}<span data-testid="composer-selection">{JSON.stringify(state.selection)}</span></div>,
  ErrorState: ({ error }: { error: unknown }) => <div role="alert">{error instanceof Error ? error.message : 'Error'}</div>,
  StatusPill: ({ status }: { status: string }) => <span>{status}</span>,
}));
vi.mock('./pages/DashboardPage', () => ({ DashboardPage: ({ jobCreationDisabledReason, onCreateJob }: { jobCreationDisabledReason?: string; onCreateJob(workflowId: 'signup'): void }) => <button disabled={Boolean(jobCreationDisabledReason)} onClick={() => onCreateJob('signup')}>Tạo job</button> }));
vi.mock('./pages/AccountsPage', () => ({ AccountsPage: ({ onCreateJob }: { onCreateJob(workflowId: 'signup', selection: JobRequest['selection']): void }) => <button onClick={() => onCreateJob('signup', { mode: 'identities', accounts: [{ rowIndex: 25, email: 'operator@example.com' }] })}>Tạo account job</button> }));
vi.mock('./pages/JobsPage', () => ({ JobsPage: () => <div>Jobs</div> }));
vi.mock('./pages/SettingsPage', () => ({ SettingsPage: () => <div>Settings</div> }));
vi.mock('./api', () => ({
  api: {
    health: vi.fn(),
    workflows: vi.fn(),
    settings: vi.fn(),
    jobs: vi.fn(),
    focusJob: vi.fn(),
    recovery: vi.fn(),
    syncRecovery: vi.fn(),
    discardRecovery: vi.fn(),
  },
}));

function installMobileMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: ['(max-width: 768px)', '(max-width: 1100px)'].includes(query),
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
    vi.mocked(api.health).mockResolvedValue({ status: 'ok', sheets: 'ready', gpm: 'ready', workerLock: 'free', activeJobId: null, queueLength: 0, recoveryPendingCount: 0 });
    vi.mocked(api.workflows).mockResolvedValue([]);
    vi.mocked(api.settings).mockResolvedValue({ values: { sheetId: '', sheetName: '', serviceAccountPath: '', gpmApiBase: '', defaultIntervalMinutes: 1, runtimeDirectory: '', proxyProvider: 'none' }, configuredSecrets: [], envOverrides: [], canEdit: true });
    vi.mocked(api.jobs).mockResolvedValue([]);
    vi.mocked(api.recovery).mockResolvedValue({ entries: [] });
    vi.mocked(api.syncRecovery).mockResolvedValue({ entries: [] });
    vi.mocked(api.discardRecovery).mockResolvedValue({ entries: [] });
    window.history.pushState({}, '', '/dashboard');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
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

  it('keeps job creation disabled until the automation lock is verified', async () => {
    const health = deferred<Awaited<ReturnType<typeof api.health>>>();
    vi.mocked(api.health).mockReturnValue(health.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: 'Tạo job' })).toBeDisabled();

    await act(async () => health.resolve({
      status: 'ok', sheets: 'ready', gpm: 'ready', workerLock: 'free', activeJobId: null,
      queueLength: 0, recoveryPendingCount: 0,
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo job' })).toBeEnabled());
  });

  it('passes account identities into the composer instead of historical row selection', async () => {
    window.history.pushState({}, '', '/accounts');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Tạo account job' }));

    expect(await screen.findByRole('dialog')).toHaveTextContent('Composer signup');
    expect(screen.getByTestId('composer-selection')).toHaveTextContent(JSON.stringify({
      mode: 'identities',
      accounts: [{ rowIndex: 25, email: 'operator@example.com' }],
    }));
  });

  it('blocks an external worker lock but still allows queueing behind the active UI job', async () => {
    vi.mocked(api.health).mockResolvedValue({
      status: 'degraded', sheets: 'ready', gpm: 'ready', workerLock: 'busy', activeJobId: null,
      queueLength: 0, recoveryPendingCount: 0,
    });
    const blockedClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const blockedView = render(<QueryClientProvider client={blockedClient}><App /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: 'Tạo job' })).toBeDisabled();
    blockedView.unmount();

    vi.mocked(api.jobs).mockResolvedValue([activeAttentionJob()]);
    vi.mocked(api.health).mockResolvedValue({
      status: 'ok', sheets: 'ready', gpm: 'ready', workerLock: 'busy', activeJobId: 'job-attention',
      queueLength: 0, recoveryPendingCount: 0,
    });
    const activeClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={activeClient}><App /></QueryClientProvider>);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo job' })).toBeEnabled());
  });

  it('blocks stale or mismatched locks even when health reports an active job id', async () => {
    vi.mocked(api.jobs).mockResolvedValue([activeAttentionJob()]);
    vi.mocked(api.health).mockResolvedValue({
      status: 'degraded', sheets: 'ready', gpm: 'ready', workerLock: 'stale', activeJobId: 'job-attention',
      queueLength: 0, recoveryPendingCount: 0,
    });
    const staleClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const staleView = render(<QueryClientProvider client={staleClient}><App /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: 'Tạo job' })).toBeDisabled();
    staleView.unmount();

    vi.mocked(api.health).mockResolvedValue({
      status: 'degraded', sheets: 'ready', gpm: 'ready', workerLock: 'busy', activeJobId: 'different-job',
      queueLength: 0, recoveryPendingCount: 0,
    });
    const mismatchClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={mismatchClient}><App /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: 'Tạo job' })).toBeDisabled();
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
    await act(async () => health.resolve({ status: 'ok', sheets: 'ready', gpm: 'ready', workerLock: 'free', activeJobId: 'job-attention', queueLength: 0, recoveryPendingCount: 0 }));

    await userEvent.setup().click(screen.getByRole('button', { name: 'Mở menu' }));
    const attentionBar = document.querySelector('.attention-bar');
    expect(attentionBar).toHaveAttribute('inert');
    expect(attentionBar).toHaveAttribute('aria-hidden', 'true');
  });

  it('blocks job creation for prepared recovery and exposes confirmed recovery actions', async () => {
    const user = userEvent.setup();
    const sync = deferred<RecoveryResponse>();
    vi.mocked(api.syncRecovery).mockReturnValue(sync.promise);
    vi.mocked(api.recovery).mockResolvedValue({
      entries: [
        { id: 'prepared-1', state: 'prepared', email: 'pending@example.com', originalRowIndex: 25, operation: 'resetPassword', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: 'confirmed-1', state: 'confirmed', email: 'confirmed@example.com', originalRowIndex: 26, operation: 'signup', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    expect(await screen.findByText('2 recovery cần xử lý')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tạo job' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Đồng bộ' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Loại bỏ' })).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: 'Đồng bộ' })[0]);
    expect(vi.mocked(api.syncRecovery).mock.calls[0]?.[0]).toBe('prepared-1');
    expect(screen.getByRole('button', { name: 'Đang đồng bộ...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Đồng bộ' })).toBeDisabled();
    for (const button of screen.getAllByRole('button', { name: 'Loại bỏ' })) expect(button).toBeDisabled();

    await act(async () => sync.resolve({ entries: [] }));
  });

  it('requires confirmation before discarding a recovery entry', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.mocked(api.recovery).mockResolvedValue({
      entries: [{ id: 'prepared-1', state: 'prepared', email: 'pending@example.com', originalRowIndex: 25, operation: 'resetPassword', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    await user.click(await screen.findByRole('button', { name: 'Loại bỏ' }));
    expect(window.confirm).toHaveBeenCalled();
    expect(api.discardRecovery).not.toHaveBeenCalled();
  });

  it('locks recovery actions while a job or automation process can still own the journal', async () => {
    vi.mocked(api.jobs).mockResolvedValue([activeAttentionJob()]);
    vi.mocked(api.health).mockResolvedValue({ status: 'degraded', sheets: 'ready', gpm: 'ready', workerLock: 'busy', activeJobId: 'job-attention', queueLength: 0, recoveryPendingCount: 1 });
    vi.mocked(api.recovery).mockResolvedValue({
      entries: [{ id: 'prepared-1', state: 'prepared', email: 'pending@example.com', originalRowIndex: 25, operation: 'resetPassword', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: 'Đồng bộ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Loại bỏ' })).toBeDisabled();
    expect(screen.getByText('Chờ job active hoặc queued kết thúc trước khi xử lý recovery.')).toHaveAttribute('role', 'status');
  });
});

function activeAttentionJob(): JobRecord {
  return {
    id: 'job-attention',
    status: 'needs_attention',
    request: {
      workflowId: 'signup',
      selection: { mode: 'rows', rowIndexes: [25] },
      options: { intervalMinutes: 1 },
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
