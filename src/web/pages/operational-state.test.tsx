// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord, RuntimeSettings } from '../../shared/contracts';

const apiMock = vi.hoisted(() => ({
  accounts: vi.fn(),
  jobs: vi.fn(),
  job: vi.fn(),
  cancelJob: vi.fn(),
  focusJob: vi.fn(),
  settings: vi.fn(),
  saveSettings: vi.fn(),
  diagnoseSheets: vi.fn(),
  diagnoseGpm: vi.fn(),
}));

vi.mock('../api', () => ({ api: apiMock }));

import { DashboardPage } from './DashboardPage';
import { JobsPage } from './JobsPage';
import { SettingsPage } from './SettingsPage';

const runtimeSettings: RuntimeSettings = {
  sheetId: 'sheet-id',
  sheetName: 'Accounts',
  serviceAccountPath: 'D:\\credentials.json',
  gpmApiBase: 'http://127.0.0.1:19995',
  defaultIntervalMinutes: 1,
  runtimeDirectory: 'D:\\runtime',
};

describe('operational page state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.accounts.mockResolvedValue([]);
    apiMock.jobs.mockResolvedValue([]);
    apiMock.settings.mockResolvedValue({ values: runtimeSettings, envOverrides: [], canEdit: true });
    apiMock.saveSettings.mockResolvedValue(runtimeSettings);
    apiMock.diagnoseSheets.mockResolvedValue({ ok: true, rowCount: 3 });
    apiMock.diagnoseGpm.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows the settings request error instead of an endless loading state', async () => {
    apiMock.settings.mockRejectedValue(new Error('Không đọc được cấu hình'));

    renderPage(<SettingsPage onProxyCheck={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Không đọc được cấu hình');
    expect(screen.queryByText('Đang tải dữ liệu')).not.toBeInTheDocument();
  });

  it('blocks repeated diagnostics and exposes diagnostic failures', async () => {
    const diagnostic = deferred<{ ok: boolean; rowCount: number }>();
    apiMock.diagnoseSheets.mockReturnValue(diagnostic.promise);
    renderPage(<SettingsPage onProxyCheck={vi.fn()} />);
    const button = await screen.findByRole('button', { name: /Google Sheet/i });

    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent('Đang kiểm tra...');
    fireEvent.click(button);
    expect(apiMock.diagnoseSheets).toHaveBeenCalledTimes(1);

    await act(async () => diagnostic.reject(new Error('Sheet không reachable')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sheet không reachable');
  });

  it('locks settings for a queued job and unlocks from current job query data', async () => {
    apiMock.jobs.mockResolvedValue([makeJob({ status: 'queued' })]);
    const { queryClient } = renderPage(<SettingsPage onProxyCheck={vi.fn()} />);
    const saveButton = await screen.findByRole('button', { name: /Lưu cấu hình/ });

    expect(await screen.findByText(/Cấu hình bị khóa/)).toBeInTheDocument();
    expect(saveButton).toBeDisabled();

    act(() => queryClient.setQueryData(['jobs'], []));
    await waitFor(() => expect(saveButton).toBeEnabled());
  });

  it('blocks repeated saves and exposes save failures', async () => {
    const save = deferred<RuntimeSettings>();
    apiMock.saveSettings.mockReturnValue(save.promise);
    renderPage(<SettingsPage onProxyCheck={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Lưu cấu hình' });
    await waitFor(() => expect(button).toBeEnabled());

    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent('Đang lưu...');
    fireEvent.click(button);
    expect(apiMock.saveSettings).toHaveBeenCalledTimes(1);

    await act(async () => save.reject(new Error('Không thể lưu cấu hình')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Không thể lưu cấu hình');
  });

  it('invalidates config-dependent data and clears diagnostics after saving settings', async () => {
    const { queryClient } = renderPage(<SettingsPage onProxyCheck={vi.fn()} />);
    const diagnosticButton = await screen.findByRole('button', { name: /Google Sheet/i });
    fireEvent.click(diagnosticButton);
    expect(await screen.findByText('3 rows')).toBeInTheDocument();

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    invalidate.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cấu hình' }));

    await waitFor(() => expect(apiMock.saveSettings).toHaveBeenCalledTimes(1));
    for (const queryKey of [['settings'], ['accounts'], ['account'], ['jobs'], ['job'], ['health']]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
    await waitFor(() => expect(diagnosticButton).toHaveTextContent('Chạy kiểm tra'));
  });

  it('disables dashboard controls while focusing and reports an unavailable browser', async () => {
    const focus = deferred<{ focused: boolean }>();
    apiMock.jobs.mockResolvedValue([makeJob({ status: 'running' })]);
    apiMock.focusJob.mockReturnValue(focus.promise);
    renderPage(<DashboardPage onCreateJob={vi.fn()} />);
    const focusButton = await screen.findByRole('button', { name: /Đưa browser ra trước/ });
    const cancelButton = screen.getByRole('button', { name: 'Hủy an toàn' });

    fireEvent.click(focusButton);
    await waitFor(() => expect(focusButton).toBeDisabled());
    expect(cancelButton).toBeDisabled();

    await act(async () => focus.resolve({ focused: false }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Browser không còn hoạt động');
  });

  it('does not offer browser focus for an active proxy diagnostic', async () => {
    apiMock.jobs.mockResolvedValue([makeJob({ status: 'running', request: makeRequest('proxyCheck') })]);
    renderPage(<DashboardPage onCreateJob={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Hủy an toàn' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Đưa browser ra trước/ })).not.toBeInTheDocument();
  });

  it('reports cancel failures in job detail', async () => {
    const active = makeJob({ status: 'running' });
    apiMock.jobs.mockResolvedValue([active]);
    apiMock.job.mockResolvedValue({ job: active, events: [], log: '' });
    apiMock.cancelJob.mockRejectedValue(new Error('Không thể hủy job'));
    renderPage(<JobsPage onRetry={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(active.id.slice(0, 8)) }));
    fireEvent.click(await screen.findByRole('button', { name: 'Hủy' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Không thể hủy job');
  });

  it('does not offer browser focus in an active proxy diagnostic detail', async () => {
    const active = makeJob({ status: 'running', request: makeRequest('proxyCheck') });
    apiMock.jobs.mockResolvedValue([active]);
    apiMock.job.mockResolvedValue({ job: active, events: [], log: '' });
    renderPage(<JobsPage onRetry={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(active.id.slice(0, 8)) }));
    expect(await screen.findByRole('button', { name: 'Hủy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Focus browser/ })).not.toBeInTheDocument();
  });

  it('does not poll raw log for a terminal job', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const completed = makeJob({ status: 'succeeded', completedAt: new Date().toISOString() });
    apiMock.jobs.mockResolvedValue([completed]);
    apiMock.job.mockResolvedValue({ job: completed, events: [], log: 'done' });
    renderPage(<JobsPage onRetry={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(completed.id.slice(0, 8)) }));
    expect(await screen.findByText('done')).toBeInTheDocument();
    expect(apiMock.job).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTime(10_000));
    expect(apiMock.job).toHaveBeenCalledTimes(1);
  });
});

function renderPage(element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  return { ...result, queryClient };
}

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-12345678',
    status: 'queued',
    request: {
      workflowId: 'signup',
      selection: { mode: 'rows', rowIndexes: [2] },
      options: { proxyMode: 'sheet', intervalMinutes: 1, hasProxyTokenOverride: false },
    },
    acceptedRows: [2],
    rejectedCount: 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    currentRowIndex: null,
    currentAccount: 0,
    totalAccounts: 1,
    currentStep: null,
    errorCount: 0,
    lastMessage: 'Queued',
    ...overrides,
  };
}

function makeRequest(workflowId: JobRecord['request']['workflowId']): JobRecord['request'] {
  return {
    workflowId,
    selection: workflowId === 'proxyCheck' ? { mode: 'allEligible' } : { mode: 'rows', rowIndexes: [2] },
    options: { proxyMode: 'sheet', intervalMinutes: 1, hasProxyTokenOverride: false },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
