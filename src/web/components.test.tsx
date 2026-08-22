// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountSummary, JobPreview, WorkflowDefinition } from '../shared/contracts';
import { api } from './api';
import { JobComposer, PresenceMark, StatusPill } from './components';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('shared UI components', () => {
  it('renders operational status text', () => {
    render(<StatusPill status="needs_attention" />);
    expect(screen.getByText('needs attention')).toBeInTheDocument();
  });

  it('does not rely on color alone for credential presence', () => {
    render(<PresenceMark present label="API key" />);
    expect(screen.getByLabelText('API key: có')).toBeInTheDocument();
  });

  it('hides unsupported proxy modes and interval for proxy diagnostics', async () => {
    vi.spyOn(api, 'previewJob').mockResolvedValue(preview());
    renderComposer('proxyCheck');

    expect(await screen.findByText('Proxy diagnostic')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Không dùng proxy' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Interval trung bình (phút)')).not.toBeInTheDocument();
  });

  it('keeps enqueue disabled for an empty proxy override', async () => {
    vi.spyOn(api, 'previewJob').mockResolvedValue(preview());
    const user = userEvent.setup();
    renderComposer('proxyCheck');

    await user.selectOptions(await screen.findByLabelText('Chế độ proxy'), 'override');

    expect(screen.getByLabelText('Proxy token override')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Thêm vào hàng đợi' })).toBeDisabled();
  });

  it('keeps enqueue disabled when preview fails', async () => {
    vi.spyOn(api, 'previewJob').mockRejectedValue(new Error('Preview unavailable'));
    renderComposer('signup');

    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable');
    expect(screen.getByRole('button', { name: 'Thêm vào hàng đợi' })).toBeDisabled();
  });

  it('syncs a newly loaded default interval until the operator edits it', async () => {
    vi.spyOn(api, 'previewJob').mockResolvedValue(preview({ accepted: [account()] }));
    const user = userEvent.setup();
    const view = renderComposer('signup', { defaultInterval: 1 });
    const intervalInput = await screen.findByLabelText('Interval trung bình (phút)');

    view.rerender(composerElement('signup', view.queryClient, { defaultInterval: 7 }));
    expect(intervalInput).toHaveValue(7);

    await user.clear(intervalInput);
    await user.type(intervalInput, '2.5');
    view.rerender(composerElement('signup', view.queryClient, { defaultInterval: 12 }));

    expect(intervalInput).toHaveValue(2.5);
  });

  it('surfaces workflow registry errors and prevents enqueue', async () => {
    renderComposer('signup', {
      workflows: [],
      workflowError: new Error('Workflow registry unavailable'),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Workflow registry unavailable');
    expect(screen.getByRole('button', { name: 'Thêm vào hàng đợi' })).toBeDisabled();
  });

  it('blocks interval workflows while settings are loading or unavailable', async () => {
    const view = renderComposer('signup', { settingsLoading: true });

    expect(await screen.findByText('Đang tải interval mặc định')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thêm vào hàng đợi' })).toBeDisabled();

    view.rerender(composerElement('signup', view.queryClient, {
      settingsError: new Error('Settings unavailable'),
    }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Settings unavailable');
    expect(screen.getByRole('button', { name: 'Thêm vào hàng đợi' })).toBeDisabled();
  });

  it('never stores the real proxy token in React Query caches', async () => {
    const secret = 'proxy-secret-value';
    vi.spyOn(api, 'previewJob').mockResolvedValue(preview());
    const create = vi.spyOn(api, 'createJob').mockResolvedValue({} as never);
    const user = userEvent.setup();
    const { queryClient } = renderComposer('proxyCheck');

    await user.selectOptions(await screen.findByLabelText('Chế độ proxy'), 'override');
    await user.type(screen.getByLabelText('Proxy token override'), secret);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Thêm vào hàng đợi' })).toBeEnabled());

    const queryCache = JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.queryKey));
    expect(queryCache).not.toContain(secret);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Thêm vào hàng đợi' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].options.proxyTokenOverride).toBe(secret);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('labels dynamic full-cycle phases without pretending their counts are fixed', async () => {
    vi.spyOn(api, 'previewJob').mockResolvedValue(preview({
      accepted: [account()],
      phases: [
        { phaseId: 'signup', workflowId: 'signup', currentEligible: 1, maxAccounts: 2, dynamic: false },
        { phaseId: 'resume-1', workflowId: 'resume', currentEligible: 0, maxAccounts: 2, dynamic: true },
        { phaseId: 'reset-password', workflowId: 'resetPassword', currentEligible: 0, maxAccounts: 2, dynamic: true },
        { phaseId: 'resume-2', workflowId: 'resume', currentEligible: 0, maxAccounts: 2, dynamic: true },
      ],
    }));
    renderComposer('fullCycle');

    expect(await screen.findByText(/^Signup: 1\/2$/)).toBeInTheDocument();
    expect(screen.getByText(/^Resume pass 1: 0\/2/)).toHaveTextContent('tính lại khi bắt đầu pass');
    expect(screen.getByText(/^Reset password: 0\/2/)).toHaveTextContent('tính lại khi bắt đầu pass');
    expect(screen.getByText(/^Resume pass 2: 0\/2/)).toHaveTextContent('tính lại khi bắt đầu pass');
  });

  it('shows every accepted row and every rejected reason in the preview', async () => {
    const rejected = Array.from({ length: 10 }, (_, index) => ({
      rowIndex: index + 10,
      email: `rejected-${index}@example.com`,
      reason: `Reason ${index}`,
    }));
    vi.spyOn(api, 'previewJob').mockResolvedValue(preview({
      accepted: [account(2, 'accepted-1@example.com'), account(3, 'accepted-2@example.com')],
      rejected,
    }));
    const user = userEvent.setup();
    renderComposer('signup');

    await user.click(await screen.findByText('Xem chính xác 2 account được nhận'));
    await user.click(screen.getByText('Xem đầy đủ 10 account bị loại'));

    expect(screen.getByText('#2 accepted-1@example.com')).toBeInTheDocument();
    expect(screen.getByText('#3 accepted-2@example.com')).toBeInTheDocument();
    rejected.forEach((item) => {
      expect(screen.getByText(`#${item.rowIndex} ${item.email} — ${item.reason}`)).toBeInTheDocument();
    });
  });
});

const workflows: WorkflowDefinition[] = [
  { id: 'signup', label: 'Chạy pending', description: 'Signup', risk: 'normal', supportsAccountSelection: true, allowedProxyModes: ['sheet', 'none', 'override'], usesInterval: true },
  { id: 'fullCycle', label: 'Chạy full cycle', description: 'Full cycle', risk: 'attention', supportsAccountSelection: true, allowedProxyModes: ['sheet', 'none', 'override'], usesInterval: true },
  { id: 'proxyCheck', label: 'Kiểm tra proxy', description: 'Proxy diagnostic', risk: 'normal', supportsAccountSelection: false, allowedProxyModes: ['sheet', 'override'], usesInterval: false },
];

interface ComposerOptions {
  defaultInterval?: number;
  workflows?: WorkflowDefinition[];
  workflowError?: unknown;
  settingsError?: unknown;
  settingsLoading?: boolean;
}

function composerElement(
  workflowId: 'signup' | 'fullCycle' | 'proxyCheck',
  queryClient: QueryClient,
  options: ComposerOptions = {},
): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <JobComposer
        state={{ workflowId }}
        workflows={options.workflows ?? workflows}
        workflowError={options.workflowError}
        settingsError={options.settingsError}
        settingsLoading={options.settingsLoading ?? false}
        defaultInterval={options.defaultInterval ?? 1}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    </QueryClientProvider>
  );
}

function renderComposer(workflowId: 'signup' | 'fullCycle' | 'proxyCheck', options: ComposerOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return { ...render(composerElement(workflowId, queryClient, options)), queryClient };
}

function account(rowIndex = 2, email = 'operator@example.com'): AccountSummary {
  return {
    rowIndex,
    email,
    status: 'pending',
    statusGroup: 'pending',
    recommendedAction: 'signup',
    eligibleWorkflows: ['signup', 'fullCycle'],
    hasElevenPassword: false,
    hasApiKey: false,
    hasProxyToken: true,
    lastRunAt: null,
    runtime: null,
  };
}

function preview(overrides: Partial<JobPreview> = {}): JobPreview {
  return {
    workflowId: 'proxyCheck',
    accepted: [],
    rejected: [],
    phases: [],
    ...overrides,
  };
}
