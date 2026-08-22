// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../../shared/contracts';
import { api } from '../api';
import { JobsPage } from './JobsPage';

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
    options: { proxyMode: 'sheet', intervalMinutes: 1, hasProxyTokenOverride: false },
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
        <JobsPage onRetry={vi.fn()} />
      </QueryClientProvider>,
    );

    const jobButton = await screen.findByRole('button', { name: /Chạy pending/ });
    expect(jobButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(jobButton);
    expect(jobButton).toHaveAttribute('aria-pressed', 'true');
  });
});
