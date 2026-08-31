// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountDetail, AccountSummary, JobRequest, WorkflowId } from '../../shared/contracts';
import { api } from '../api';
import { AccountsPage } from './AccountsPage';

vi.mock('../api', () => ({
  api: {
    accounts: vi.fn(),
    account: vi.fn(),
    revealSecret: vi.fn(),
  },
}));

const account: AccountSummary = {
  rowIndex: 25,
  email: 'a-very-long-account-address-for-mobile-layout@hotmail.com',
  status: 'pending',
  statusGroup: 'pending',
  recommendedAction: 'signup',
  eligibleWorkflows: ['signup', 'fullCycle'],
  hasElevenPassword: false,
  hasApiKey: true,
  lastRunAt: null,
  runtime: null,
};

const accountDetail: AccountDetail = {
  ...account,
  recoveryEmail: '',
  msaTokenPresent: false,
  tenantGuidPresent: false,
  recentJobs: [],
  lastFailure: null,
};

function renderPage(onCreateJob: (workflowId: WorkflowId, selection: JobRequest['selection']) => void = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AccountsPage onCreateJob={onCreateJob} />
    </QueryClientProvider>,
  );
  view.container.id = 'root';
  return { ...view, onCreateJob, queryClient };
}

describe('AccountsPage accessibility', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('labels filters and exposes full truncated values', async () => {
    vi.mocked(api.accounts).mockResolvedValue([account]);
    renderPage();

    expect(await screen.findByRole('textbox', { name: 'Tìm tài khoản' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Lọc theo nhóm trạng thái' })).toBeInTheDocument();
    expect(await screen.findByTitle(account.email)).toHaveTextContent(account.email);
    expect(screen.getByText('Trạng thái: pending')).toHaveClass('sr-only');
  });

  it('forces a fresh Sheet read, blocks repeated refreshes and updates the accounts cache', async () => {
    const user = userEvent.setup();
    const refresh = deferred<AccountSummary[]>();
    const refreshedAccount = { ...account, rowIndex: 26, email: 'fresh-from-sheet@example.com' };
    vi.mocked(api.accounts)
      .mockResolvedValueOnce([account])
      .mockReturnValueOnce(refresh.promise);
    renderPage();

    const button = await screen.findByRole('button', { name: 'Đồng bộ Sheet' });
    await user.click(button);

    expect(api.accounts).toHaveBeenNthCalledWith(2, true);
    expect(screen.getByRole('button', { name: 'Đang đồng bộ...' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Đang đồng bộ...' }));
    expect(api.accounts).toHaveBeenCalledTimes(2);

    await act(async () => refresh.resolve([refreshedAccount]));
    expect(await screen.findByText(refreshedAccount.email)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Đồng bộ Sheet' })).toBeEnabled();
  });

  it('shows a force-refresh failure without discarding the current account list', async () => {
    const user = userEvent.setup();
    vi.mocked(api.accounts)
      .mockResolvedValueOnce([account])
      .mockRejectedValueOnce(new Error('Không thể đồng bộ Sheet'));
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Đồng bộ Sheet' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Không thể đồng bộ Sheet');
    expect(screen.getByText(account.email)).toBeInTheDocument();
  });

  it('opens account details from a keyboard-accessible button and closes the drawer before composing', async () => {
    const user = userEvent.setup();
    let createdJob: { workflowId: WorkflowId; selection: JobRequest['selection'] } | null = null;
    const onCreateJob = (workflowId: WorkflowId, selection: JobRequest['selection']) => {
      createdJob = { workflowId, selection };
    };
    vi.mocked(api.accounts).mockResolvedValue([account]);
    vi.mocked(api.account).mockResolvedValue(accountDetail);
    renderPage(onCreateJob);

    const openButton = await screen.findByRole('button', { name: `Mở chi tiết account ${account.email}` });
    openButton.focus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: account.email });
    expect(dialog).toBeInTheDocument();
    expect(api.account).toHaveBeenCalledWith(account.rowIndex, account.email);
    expect(screen.getByRole('button', { name: 'Đóng' })).toHaveFocus();

    fireEvent.click(await screen.findByRole('button', { name: 'Chạy pending' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(createdJob).toEqual({
      workflowId: 'signup',
      selection: {
        mode: 'identities',
        accounts: [{ rowIndex: account.rowIndex, email: account.email }],
      },
    }));
  });

  it('sends the displayed account email when revealing a secret', async () => {
    const user = userEvent.setup();
    vi.mocked(api.accounts).mockResolvedValue([account]);
    vi.mocked(api.account).mockResolvedValue(accountDetail);
    vi.mocked(api.revealSecret).mockResolvedValue({ value: 'revealed-value' });
    renderPage();

    await user.click(await screen.findByRole('button', { name: `Mở chi tiết account ${account.email}` }));
    await user.click(await screen.findByRole('button', { name: 'Hiện API key' }));

    expect(api.revealSecret).toHaveBeenCalledWith(account.rowIndex, 'apiKey', account.email);
    expect(await screen.findByText('revealed-value')).toBeInTheDocument();
  });

  it('excludes reserved accounts from selection and reconciles selection after refresh', async () => {
    const user = userEvent.setup();
    const reservedAccount: AccountSummary = {
      ...account,
      rowIndex: 26,
      email: 'reserved@hotmail.com',
      runtime: {
        state: 'running',
        jobId: 'job-reserved-123',
        workflowId: 'signup',
        currentStep: 'rotate proxy (TinProxy)',
      },
    };
    vi.mocked(api.accounts).mockResolvedValue([account, reservedAccount]);
    const { onCreateJob, queryClient } = renderPage();

    const selectAll = await screen.findByRole('checkbox', { name: 'Chọn tất cả account khả dụng đang hiển thị' });
    await user.click(selectAll);
    expect(screen.getByRole('checkbox', { name: `Chọn row ${account.rowIndex}` })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Không thể chọn row 26/ })).toBeDisabled();
    expect(screen.getByText('Đang chuẩn bị proxy · #job-rese')).toBeInTheDocument();
    expect(screen.getByText('1 account đã chọn')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Tìm tài khoản' }), 'reserved');
    expect(screen.queryByText('1 account đã chọn')).not.toBeInTheDocument();
    expect(onCreateJob).not.toHaveBeenCalled();

    await user.clear(screen.getByRole('textbox', { name: 'Tìm tài khoản' }));
    await user.click(screen.getByRole('checkbox', { name: `Chọn row ${account.rowIndex}` }));
    act(() => queryClient.setQueryData(['accounts'], [{ ...account, runtime: reservedAccount.runtime }]));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Không thể chọn row 25/ })).toBeDisabled());
    expect(screen.queryByText('1 account đã chọn')).not.toBeInTheDocument();
  });

  it('selects only visible accounts after search and preserves selection when sorting', async () => {
    const user = userEvent.setup();
    const secondAccount: AccountSummary = {
      ...account,
      rowIndex: 26,
      email: 'second-account@hotmail.com',
    };
    vi.mocked(api.accounts).mockResolvedValue([account, secondAccount]);
    const { onCreateJob } = renderPage();

    const search = await screen.findByRole('textbox', { name: 'Tìm tài khoản' });
    fireEvent.change(search, { target: { value: 'second-account' } });
    expect(screen.getByRole('checkbox', { name: `Chọn row ${secondAccount.rowIndex}` })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: `Chọn row ${account.rowIndex}` })).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Chọn tất cả account khả dụng đang hiển thị' }));
    expect(screen.getByRole('checkbox', { name: `Chọn row ${secondAccount.rowIndex}` })).toBeChecked();
    expect(screen.getByText('1 account đã chọn')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sort: row' }));
    expect(screen.getByRole('checkbox', { name: `Chọn row ${secondAccount.rowIndex}` })).toBeChecked();
    expect(screen.getByText('1 account đã chọn')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Chạy pending' }));
    expect(onCreateJob).toHaveBeenCalledWith('signup', {
      mode: 'identities',
      accounts: [{ rowIndex: secondAccount.rowIndex, email: secondAccount.email }],
    });
  });

  it('explains why Full cycle is disabled when another workflow remains common', async () => {
    const user = userEvent.setup();
    const signupOnlyAccount: AccountSummary = {
      ...account,
      rowIndex: 26,
      email: 'signup-only@example.com',
      eligibleWorkflows: ['signup'],
    };
    vi.mocked(api.accounts).mockResolvedValue([account, signupOnlyAccount]);
    renderPage();

    await user.click(await screen.findByRole('checkbox', { name: 'Chọn tất cả account khả dụng đang hiển thị' }));

    const reason = 'Full cycle không khả dụng cho toàn bộ account đã chọn';
    expect(screen.getByRole('button', { name: 'Full cycle' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Full cycle' })).toHaveAttribute('title', reason);
    expect(screen.getByText(reason)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: 'Chạy pending' })).toBeEnabled();
  });

  it('clears a selection when the same Sheet row now belongs to another email', async () => {
    const user = userEvent.setup();
    vi.mocked(api.accounts).mockResolvedValue([account]);
    const { onCreateJob, queryClient } = renderPage();

    await user.click(await screen.findByRole('checkbox', { name: `Chọn row ${account.rowIndex}` }));
    expect(screen.getByText('1 account đã chọn')).toBeInTheDocument();

    act(() => queryClient.setQueryData(['accounts'], [{
      ...account,
      email: 'replacement-at-same-row@example.com',
    }]));

    await waitFor(() => expect(screen.queryByText('1 account đã chọn')).not.toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: `Chọn row ${account.rowIndex}` })).not.toBeChecked();
    expect(onCreateJob).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
