// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountDetail, AccountSummary, WorkflowId } from '../../shared/contracts';
import { api } from '../api';
import { AccountsPage } from './AccountsPage';

vi.mock('../api', () => ({
  api: {
    accounts: vi.fn(),
    account: vi.fn(),
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
  hasApiKey: false,
  hasProxyToken: true,
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

function renderPage(onCreateJob: (workflowId: WorkflowId, rows?: number[]) => void = vi.fn()) {
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

  it('opens account details from a keyboard-accessible button and closes the drawer before composing', async () => {
    const user = userEvent.setup();
    let createdJob: { workflowId: WorkflowId; rows?: number[] } | null = null;
    const onCreateJob = (workflowId: WorkflowId, rows?: number[]) => { createdJob = { workflowId, rows }; };
    vi.mocked(api.accounts).mockResolvedValue([account]);
    vi.mocked(api.account).mockResolvedValue(accountDetail);
    renderPage(onCreateJob);

    const openButton = await screen.findByRole('button', { name: `Mở chi tiết account ${account.email}` });
    openButton.focus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: account.email });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Đóng' })).toHaveFocus();

    fireEvent.click(await screen.findByRole('button', { name: 'Chạy pending' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(createdJob).toEqual({ workflowId: 'signup', rows: [account.rowIndex] }));
  });

  it('excludes reserved accounts from selection and reconciles selection after refresh', async () => {
    const user = userEvent.setup();
    const reservedAccount: AccountSummary = {
      ...account,
      rowIndex: 26,
      email: 'reserved@hotmail.com',
      runtime: { state: 'running', jobId: 'job-reserved-123', workflowId: 'signup' },
    };
    vi.mocked(api.accounts).mockResolvedValue([account, reservedAccount]);
    const { onCreateJob, queryClient } = renderPage();

    const selectAll = await screen.findByRole('checkbox', { name: 'Chọn tất cả account khả dụng đang hiển thị' });
    await user.click(selectAll);
    expect(screen.getByRole('checkbox', { name: `Chọn row ${account.rowIndex}` })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Không thể chọn row 26/ })).toBeDisabled();
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
    expect(onCreateJob).toHaveBeenCalledWith('signup', [secondAccount.rowIndex]);
  });
});
