// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountSummary, JobPreview, JobRequest, WorkflowDefinition } from '../shared/contracts';
import { api } from './api';
import { JobComposer, PresenceMark, SecretValue, StatusPill } from './components';

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

  it('does not display a reveal response after the displayed account identity changes', async () => {
    let resolveReveal!: (response: { value: string }) => void;
    const revealSecret = vi.spyOn(api, 'revealSecret').mockImplementationOnce(() => new Promise((resolve) => {
      resolveReveal = resolve;
    }));
    const user = userEvent.setup();
    const view = render(<SecretValue rowIndex={25} expectedEmail="first@example.com" field="apiKey" label="API key" present />);

    await user.click(screen.getByRole('button', { name: 'Hiện API key' }));
    expect(revealSecret).toHaveBeenCalledWith(25, 'apiKey', 'first@example.com');

    view.rerender(<SecretValue rowIndex={25} expectedEmail="replacement@example.com" field="apiKey" label="API key" present />);
    await act(async () => resolveReveal({ value: 'secret-for-first-account' }));

    expect(screen.queryByText('secret-for-first-account')).not.toBeInTheDocument();
    expect(screen.getByText('••••••••••••')).toBeInTheDocument();
  });

  it('confirms a copied credential without exposing its value in feedback', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.spyOn(api, 'revealSecret').mockResolvedValue({ value: 'revealed-secret' });
    render(<SecretValue rowIndex={25} expectedEmail="operator@example.com" field="apiKey" label="API key" present />);

    await user.click(screen.getByRole('button', { name: 'Hiện API key' }));
    await user.click(await screen.findByRole('button', { name: 'Copy API key' }));

    expect(writeText).toHaveBeenCalledWith('revealed-secret');
    expect(await screen.findByRole('status')).toHaveTextContent('Đã copy');
    expect(screen.getByRole('button', { name: 'Đã copy API key' })).toBeEnabled();
  });

  it('reports clipboard failures instead of leaving an unhandled rejection', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard bị chặn'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.spyOn(api, 'revealSecret').mockResolvedValue({ value: 'revealed-secret' });
    render(<SecretValue rowIndex={25} expectedEmail="operator@example.com" field="apiKey" label="API key" present />);

    await user.click(screen.getByRole('button', { name: 'Hiện API key' }));
    await user.click(await screen.findByRole('button', { name: 'Copy API key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Clipboard bị chặn');
    expect(screen.getByRole('button', { name: 'Copy API key' })).toBeEnabled();
  });

  it('hides unsupported proxy modes and interval for proxy diagnostics', async () => {
    vi.spyOn(api, 'previewJob').mockResolvedValue(preview());
    renderComposer('proxyCheck');

    expect(await screen.findByText('Proxy diagnostic')).toBeInTheDocument();
    expect(screen.queryByLabelText('Interval trung bình (phút)')).not.toBeInTheDocument();
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

  it('lets the operator close a hanging create request and aborts the browser wait', async () => {
    vi.spyOn(api, 'previewJob').mockResolvedValue(preview({ accepted: [account()] }));
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(api, 'createJob').mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
      requestSignal = signal;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderComposer('signup', { onClose });

    await user.click(await screen.findByRole('button', { name: /Thêm vào hàng đợi/ }));
    const stopButton = (await screen.findAllByRole('button', { name: 'Dừng chờ và đóng' }))
      .find((button) => button.classList.contains('button-ghost'))!;
    expect(stopButton).toBeEnabled();
    expect(screen.getByText(/không hủy request trên server/i)).toBeInTheDocument();

    await user.click(stopButton);
    expect(requestSignal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps identity selections for both retry preview and create', async () => {
    const selection: JobRequest['selection'] = {
      mode: 'identities',
      accounts: [{ rowIndex: 25, email: 'operator@example.com' }],
    };
    const previewJob = vi.spyOn(api, 'previewJob').mockResolvedValue(preview({ accepted: [account(49)] }));
    const createJob = vi.spyOn(api, 'createJob').mockResolvedValue({} as never);
    const user = userEvent.setup();
    renderComposer('signup', { selection });

    await user.click(await screen.findByRole('button', { name: /Thêm vào hàng đợi/ }));

    expect(previewJob).toHaveBeenCalledWith(expect.objectContaining({ selection }));
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ selection }), expect.any(AbortSignal));
  });
});

const workflows: WorkflowDefinition[] = [
  { id: 'signup', label: 'Chạy pending', description: 'Signup', risk: 'normal', supportsAccountSelection: true, usesInterval: true },
  { id: 'fullCycle', label: 'Chạy full cycle', description: 'Full cycle', risk: 'attention', supportsAccountSelection: true, usesInterval: true },
  { id: 'proxyCheck', label: 'Kiểm tra proxy', description: 'Proxy diagnostic', risk: 'normal', supportsAccountSelection: false, usesInterval: false },
];

interface ComposerOptions {
  defaultInterval?: number;
  workflows?: WorkflowDefinition[];
  workflowError?: unknown;
  settingsError?: unknown;
  settingsLoading?: boolean;
  creationDisabledReason?: string;
  onClose?: () => void;
  onCreated?: () => void;
  selection?: JobRequest['selection'];
}

function composerElement(
  workflowId: 'signup' | 'fullCycle' | 'proxyCheck',
  queryClient: QueryClient,
  options: ComposerOptions = {},
): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <JobComposer
        state={{ workflowId, selection: options.selection }}
        workflows={options.workflows ?? workflows}
        workflowError={options.workflowError}
        settingsError={options.settingsError}
        settingsLoading={options.settingsLoading ?? false}
        defaultInterval={options.defaultInterval ?? 1}
        creationDisabledReason={options.creationDisabledReason}
        onClose={options.onClose ?? vi.fn()}
        onCreated={options.onCreated ?? vi.fn()}
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
