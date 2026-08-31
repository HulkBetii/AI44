// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobEvent, JobRecord } from '../../shared/contracts';
import { api } from '../api';
import { getRetrySelection, JobsPage } from './JobsPage';

vi.mock('../api', () => ({
  api: {
    jobs: vi.fn(),
    job: vi.fn(),
    cancelJob: vi.fn(),
    focusJob: vi.fn(),
  },
}));

const job: JobRecord = {
  id: 'job-selected-123',
  status: 'succeeded',
  request: {
    workflowId: 'signup',
    selection: { mode: 'rows', rowIndexes: [25] },
    options: { intervalMinutes: 1 },
  },
  acceptedRows: [25],
  rejectedCount: 0,
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  currentRowIndex: 25,
  currentAccount: 1,
  totalAccounts: 1,
  currentStep: 'complete',
  errorCount: 0,
  lastMessage: 'Hoàn tất',
};

describe('JobsPage accessibility', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('exposes the selected job as a pressed button', async () => {
    const user = userEvent.setup();
    vi.mocked(api.jobs).mockResolvedValue([job]);
    vi.mocked(api.job).mockResolvedValue({ job, events: [], log: '' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <JobsPage useDrawer={false} onRetry={vi.fn()} />
      </QueryClientProvider>,
    );

    const jobButton = await screen.findByRole('button', { name: /Chạy pending/ });
    expect(jobButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(jobButton);
    expect(jobButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('refreshes both the job list and the selected terminal job detail', async () => {
    const user = userEvent.setup();
    const jobsRefresh = deferred<JobRecord[]>();
    const detailRefresh = deferred<{ job: JobRecord; events: JobEvent[]; log: string }>();
    vi.mocked(api.jobs)
      .mockResolvedValueOnce([job])
      .mockReturnValueOnce(jobsRefresh.promise);
    vi.mocked(api.job)
      .mockResolvedValueOnce({ job, events: [], log: 'before refresh' })
      .mockReturnValueOnce(detailRefresh.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><JobsPage useDrawer={false} onRetry={vi.fn()} /></QueryClientProvider>);

    await user.click(await screen.findByRole('button', { name: /Chạy pending/ }));
    expect(await screen.findByText('before refresh')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Làm mới' }));

    expect(screen.getByRole('button', { name: 'Đang làm mới...' })).toBeDisabled();
    expect(api.jobs).toHaveBeenCalledTimes(2);
    expect(api.job).toHaveBeenCalledTimes(2);

    await act(async () => {
      jobsRefresh.resolve([job]);
      detailRefresh.resolve({ job, events: [], log: 'after refresh' });
    });
    expect(await screen.findByText('after refresh')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Làm mới' })).toBeEnabled();
  });

  it('opens mobile job details in a drawer and restores focus when closed', async () => {
    const user = userEvent.setup();
    const history = Array.from({ length: 35 }, (_, index) => ({ ...job, id: `job-mobile-${index}` }));
    vi.mocked(api.jobs).mockResolvedValue(history);
    vi.mocked(api.job).mockImplementation(async (jobId) => ({
      job: history.find((item) => item.id === jobId)!,
      events: [],
      log: '',
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <JobsPage useDrawer onRetry={vi.fn()} />
      </QueryClientProvider>,
    );

    const jobButton = (await screen.findAllByRole('button', { name: /Chạy pending/ }))[0];
    await user.click(jobButton);

    expect(await screen.findByRole('dialog', { name: 'Chi tiết lượt chạy' })).toBeInTheDocument();
    const closeButton = screen.getByRole('button', { name: 'Đóng chi tiết lượt chạy' });
    expect(closeButton).toHaveFocus();

    await user.click(closeButton);
    expect(screen.queryByRole('dialog', { name: 'Chi tiết lượt chạy' })).not.toBeInTheDocument();
    expect(jobButton).toHaveFocus();
    expect(jobButton).toHaveAttribute('aria-pressed', 'false');
  });

  it('restores drawer focus to the Jobs heading when the selected row moves out of the list', async () => {
    const user = userEvent.setup();
    vi.mocked(api.jobs).mockResolvedValue([job]);
    vi.mocked(api.job).mockResolvedValue({ job, events: [], log: '' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><JobsPage useDrawer onRetry={vi.fn()} /></QueryClientProvider>);

    await user.click(await screen.findByRole('button', { name: /Chạy pending/ }));
    const closeButton = await screen.findByRole('button', { name: 'Đóng chi tiết lượt chạy' });
    queryClient.setQueryData(['jobs'], []);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Chạy pending/ })).not.toBeInTheDocument());

    await user.click(closeButton);
    expect(screen.getByRole('heading', { name: 'Lượt chạy' })).toHaveFocus();
  });

  it('closes the mobile drawer before opening the retry composer', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const failedJob = { ...job, status: 'failed' as const, errorCount: 1 };
    vi.mocked(api.jobs).mockResolvedValue([failedJob]);
    vi.mocked(api.job).mockResolvedValue({ job: failedJob, events: [accountEvent('account.failed', 25, 1)], log: '' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <JobsPage useDrawer onRetry={onRetry} />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: /Chạy pending/ }));
    await user.click(await screen.findByRole('button', { name: 'Retry 1 account' }));

    expect(screen.queryByRole('dialog', { name: 'Chi tiết lượt chạy' })).not.toBeInTheDocument();
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith('signup', { mode: 'rows', rowIndexes: [25] }));
  });

  it('does not offer retry for a fully successful job', async () => {
    const user = userEvent.setup();
    vi.mocked(api.jobs).mockResolvedValue([job]);
    vi.mocked(api.job).mockResolvedValue({ job, events: [accountEvent('account.succeeded', 25, 1)], log: '' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><JobsPage useDrawer={false} onRetry={vi.fn()} /></QueryClientProvider>);

    await user.click(await screen.findByRole('button', { name: /Chạy pending/ }));
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });

  it('retries only rows whose latest terminal outcome failed', () => {
    const mixedJob = { ...job, status: 'completed_with_errors' as const, acceptedRows: [25, 26, 27], errorCount: 1 };
    const events = [
      accountEvent('account.failed', 25, 1),
      accountEvent('account.succeeded', 25, 2),
      accountEvent('account.succeeded', 26, 3),
      accountEvent('account.failed', 26, 4),
    ];

    expect(getRetrySelection(mixedJob, events)).toEqual({ mode: 'rows', rowIndexes: [26] });
  });

  it('includes unfinished rows after a cancelled job but excludes succeeded rows', () => {
    const cancelledJob = { ...job, status: 'cancelled' as const, acceptedRows: [25, 26, 27] };
    expect(getRetrySelection(cancelledJob, [accountEvent('account.succeeded', 25, 1)]))
      .toEqual({ mode: 'rows', rowIndexes: [26, 27] });
  });

  it('retries new jobs by stable email identity when event rows have moved', () => {
    const failedJob = {
      ...job,
      status: 'failed' as const,
      acceptedAccounts: [{ rowIndex: 25, email: 'Operator@Example.com' }],
    };
    const events = [accountEvent('account.failed', 49, 1, ' operator@example.com ')];

    expect(getRetrySelection(failedJob, events)).toEqual({
      mode: 'identities',
      accounts: [{ rowIndex: 25, email: 'Operator@Example.com' }],
    });
  });

  it('uses email outcomes to retry only failed identities in mixed jobs', () => {
    const mixedJob = {
      ...job,
      status: 'completed_with_errors' as const,
      acceptedRows: [25, 26],
      acceptedAccounts: [
        { rowIndex: 25, email: 'first@example.com' },
        { rowIndex: 26, email: 'second@example.com' },
      ],
    };
    const events = [
      accountEvent('account.failed', 99, 1, 'first@example.com'),
      accountEvent('account.succeeded', 25, 2, 'first@example.com'),
      accountEvent('account.failed', 25, 3, 'second@example.com'),
    ];

    expect(getRetrySelection(mixedJob, events)).toEqual({
      mode: 'identities',
      accounts: [{ rowIndex: 26, email: 'second@example.com' }],
    });
  });
});

function accountEvent(
  type: 'account.succeeded' | 'account.failed',
  rowIndex: number,
  sequence: number,
  email?: string,
): JobEvent {
  return {
    id: `${type}-${rowIndex}-${sequence}`,
    jobId: job.id,
    sequence,
    timestamp: new Date().toISOString(),
    level: type === 'account.failed' ? 'error' : 'info',
    type,
    rowIndex,
    message: type,
    data: email ? { email } : undefined,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
