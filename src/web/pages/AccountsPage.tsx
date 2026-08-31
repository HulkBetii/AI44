import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { ArrowDownAZ, ChevronRight, Filter, RefreshCcw, Search, X } from 'lucide-react';
import type { AccountIdentity, AccountRuntime, AccountSummary, JobRequest, StatusGroup, WorkflowId } from '../../shared/contracts';
import { Overlay } from '../Overlay';
import { api } from '../api';
import { EmptyState, ErrorState, LoadingLine, PresenceMark, SecretValue, StatusPill } from '../components';
import { relativeTime, workflowName } from './DashboardPage';

const accountFeatures = tableFeatures({});
const columnHelper = createColumnHelper<typeof accountFeatures, AccountSummary>();

export function AccountsPage({ jobCreationDisabledReason, onCreateJob }: { jobCreationDisabledReason?: string; onCreateJob(workflowId: WorkflowId, selection: JobRequest['selection']): void }) {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.accounts() });
  const refreshAccounts = useMutation({
    mutationFn: () => api.accounts(true),
    onSuccess: (rows) => queryClient.setQueryData(['accounts'], rows),
  });
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState<StatusGroup | 'all'>('all');
  const [sort, setSort] = useState<'row' | 'status'>('row');
  const [selected, setSelected] = useState(new Map<number, string>());
  const [detailIdentity, setDetailIdentity] = useState<AccountIdentity | null>(null);

  const filtered = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return [...(accounts.data || [])]
      .filter((account) => group === 'all' || account.statusGroup === group)
      .filter((account) => !normalized || account.email.toLowerCase().includes(normalized) || String(account.rowIndex).includes(normalized))
      .sort((left, right) => sort === 'row' ? left.rowIndex - right.rowIndex : left.status.localeCompare(right.status));
  }, [accounts.data, group, search, sort]);
  const selectableVisible = useMemo(() => filtered.filter((account) => !account.runtime), [filtered]);

  useEffect(() => {
    if (!accounts.data) return;
    const selectableAccounts = new Map(accounts.data
      .filter((account) => !account.runtime)
      .map((account) => [account.rowIndex, normalizeEmail(account.email)]));
    setSelected((current) => {
      const next = new Map([...current].filter(([rowIndex, email]) => selectableAccounts.get(rowIndex) === normalizeEmail(email)));
      return next.size === current.size ? current : next;
    });
  }, [accounts.data]);

  const toggle = useCallback((rowIndex: number) => setSelected((current) => {
    const account = accounts.data?.find((candidate) => candidate.rowIndex === rowIndex);
    if (!account || account.runtime) return current;
    const next = new Map(current);
    if (next.has(rowIndex)) next.delete(rowIndex); else next.set(rowIndex, account.email);
    return next;
  }), [accounts.data]);
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((account) => selected.has(account.rowIndex));
  const toggleAll = useCallback(() => setSelected((current) => {
    const next = new Map(current);
    if (allVisibleSelected) selectableVisible.forEach((account) => next.delete(account.rowIndex));
    else selectableVisible.forEach((account) => next.set(account.rowIndex, account.email));
    return next;
  }), [allVisibleSelected, selectableVisible]);
  const selectedAccounts = (accounts.data || []).filter((account) => {
    const selectedEmail = selected.get(account.rowIndex);
    return selectedEmail !== undefined && normalizeEmail(selectedEmail) === normalizeEmail(account.email) && !account.runtime;
  });
  const selectedIdentities = identitySelection(selectedAccounts);
  const commonWorkflows = selectedAccounts.length
    ? selectedAccounts[0].eligibleWorkflows.filter((workflow) => selectedAccounts.every((account) => account.eligibleWorkflows.includes(workflow)))
    : [];
  const invalidSelectionReason = selectedAccounts.length && !commonWorkflows.length
    ? selectedAccounts.slice(0, 3).map((account) => `#${account.rowIndex}: ${account.eligibleWorkflows.length ? account.eligibleWorkflows.map(workflowName).join(', ') : 'chỉ kiểm tra thủ công'}`).join(' · ')
    : null;
  const fullCycleUnavailableReason = selectedAccounts.length > 0 && commonWorkflows.length > 0 && !commonWorkflows.includes('fullCycle')
    ? 'Full cycle không khả dụng cho toàn bộ account đã chọn'
    : null;
  const fullCycleDisabledReason = jobCreationDisabledReason || fullCycleUnavailableReason || invalidSelectionReason || undefined;

  const columns = useMemo(() => columnHelper.columns([
    columnHelper.display({
      id: 'select',
      header: () => <input type="checkbox" aria-label="Chọn tất cả account khả dụng đang hiển thị" checked={allVisibleSelected} disabled={selectableVisible.length === 0} onChange={toggleAll} />,
      cell: ({ row }) => {
        const reason = runtimeReservationReason(row.original);
        return <input type="checkbox" aria-label={reason ? `Không thể chọn row ${row.original.rowIndex}: ${reason}` : `Chọn row ${row.original.rowIndex}`} title={reason || undefined} checked={selected.has(row.original.rowIndex)} disabled={Boolean(reason)} onChange={() => toggle(row.original.rowIndex)} onClick={(event) => event.stopPropagation()} />;
      },
    }),
    columnHelper.accessor('rowIndex', { header: 'Row', cell: ({ getValue }) => <code>#{getValue()}</code> }),
    columnHelper.accessor('email', { header: 'Email', cell: ({ getValue, row }) => <div className="account-email-cell"><strong className="account-email" title={getValue()}>{getValue()}</strong>{row.original.runtime && <small className="runtime-note" title={runtimeReservationReason(row.original) || undefined}>{runtimeLabel(row.original.runtime)} · #{row.original.runtime.jobId.slice(0, 8)}</small>}</div> }),
    columnHelper.accessor('status', { header: 'Trạng thái', cell: ({ getValue }) => <AccountStatus status={getValue()} /> }),
    columnHelper.accessor('recommendedAction', { header: 'Đề xuất', cell: ({ getValue }) => getValue() ? workflowName(getValue()!) : <span className="muted">Kiểm tra thủ công</span> }),
    columnHelper.display({ id: 'credentials', header: 'Pass / Key', cell: ({ row }) => <div className="presence-group"><PresenceMark present={row.original.hasElevenPassword} label="Eleven password" /><PresenceMark present={row.original.hasApiKey} label="API key" /></div> }),
    columnHelper.accessor('lastRunAt', { header: 'Lần chạy cuối', cell: ({ getValue }) => getValue() ? relativeTime(getValue()!) : '—' }),
    columnHelper.display({
      id: 'open',
      header: () => <span className="sr-only">Mở chi tiết</span>,
      cell: ({ row }) => (
        <button
          type="button"
          className="icon-button row-open-button"
          aria-label={`Mở chi tiết account ${row.original.email}`}
          onClick={(event) => {
            event.stopPropagation();
            setDetailIdentity({ rowIndex: row.original.rowIndex, email: row.original.email });
          }}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      ),
    }),
  ]), [allVisibleSelected, selectableVisible.length, selected, toggle, toggleAll]);
  const table = useTable({ features: accountFeatures, columns, data: filtered });

  return (
    <div className="page-stack page-enter">
      <header className="page-heading">
        <div><span className="eyebrow">Google Sheet source</span><h1>Tài khoản</h1><p>UI chỉ đọc credential; hành động được giới hạn theo trạng thái thực tế của từng dòng.</p></div>
        <button className="button button-ghost" disabled={refreshAccounts.isPending} onClick={() => refreshAccounts.mutate()}><RefreshCcw size={16} />{refreshAccounts.isPending ? 'Đang đồng bộ...' : 'Đồng bộ Sheet'}</button>
      </header>
      {refreshAccounts.error && <ErrorState error={refreshAccounts.error} />}

      <div className="account-toolbar">
        <label className="search-field"><Search size={16} aria-hidden="true" /><span className="sr-only">Tìm tài khoản</span><input value={search} onChange={(event) => { setSearch(event.target.value); setSelected(new Map()); }} placeholder="Tìm email hoặc sheet row" /></label>
        <label className="select-field"><Filter size={15} aria-hidden="true" /><span className="sr-only">Lọc theo nhóm trạng thái</span><select value={group} onChange={(event) => { setGroup(event.target.value as typeof group); setSelected(new Map()); }}><option value="all">Tất cả trạng thái</option><option value="pending">Pending</option><option value="recoverable">Recoverable</option><option value="complete">Complete</option><option value="manual">Manual review</option><option value="failed">Failed</option></select></label>
        <button className="button button-ghost" onClick={() => setSort((value) => value === 'row' ? 'status' : 'row')}><ArrowDownAZ size={16} />Sort: {sort}</button>
        <span className="result-count">{filtered.length} / {accounts.data?.length || 0}</span>
      </div>

      {selectedAccounts.length > 0 && (
        <div className="selection-bar">
          <strong>{selectedAccounts.length} account đã chọn</strong>
          <div>{commonWorkflows.filter((workflow) => workflow !== 'fullCycle').map((workflow) => <button className="button button-compact" key={workflow} disabled={Boolean(jobCreationDisabledReason)} title={jobCreationDisabledReason} onClick={() => onCreateJob(workflow, selectedIdentities)}>{workflowName(workflow)}</button>)}<button className="button button-primary button-compact" disabled={Boolean(fullCycleDisabledReason)} title={fullCycleDisabledReason} onClick={() => onCreateJob('fullCycle', selectedIdentities)}>Full cycle</button></div>
          {invalidSelectionReason && <span className="selection-warning">Không có workflow chung — {invalidSelectionReason}</span>}
          {fullCycleUnavailableReason && <span className="selection-warning" role="status">{fullCycleUnavailableReason}</span>}
          {jobCreationDisabledReason && <span className="selection-warning" role="status">{jobCreationDisabledReason}</span>}
          <button className="icon-button" onClick={() => setSelected(new Map())} aria-label="Bỏ chọn"><X size={17} /></button>
        </div>
      )}

      {accounts.isLoading ? <LoadingLine /> : accounts.error ? <ErrorState error={accounts.error} /> : filtered.length === 0 ? <EmptyState title="Không có account phù hợp">Thử thay đổi search hoặc bộ lọc trạng thái.</EmptyState> : (
        <div className="table-wrap">
          <table className="data-table accounts-table">
            <thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id}>{header.isPlaceholder ? null : <table.FlexRender header={header} />}</th>)}</tr>)}</thead>
            <tbody>{table.getRowModel().rows.map((row) => <tr key={row.id} className={`${selected.has(row.original.rowIndex) ? 'row-selected ' : ''}${row.original.runtime ? 'row-reserved' : ''}`} onClick={() => setDetailIdentity({ rowIndex: row.original.rowIndex, email: row.original.email })}>{row.getAllCells().map((cell) => <td key={cell.id}><table.FlexRender cell={cell} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      )}

      {detailIdentity && <AccountDrawer identity={detailIdentity} jobCreationDisabledReason={jobCreationDisabledReason} onClose={() => setDetailIdentity(null)} onCreateJob={onCreateJob} />}
    </div>
  );
}

function AccountDrawer({ identity, jobCreationDisabledReason, onClose, onCreateJob }: { identity: AccountIdentity; jobCreationDisabledReason?: string; onClose(): void; onCreateJob(workflowId: WorkflowId, selection: JobRequest['selection']): void }) {
  const { rowIndex, email } = identity;
  const detail = useQuery({
    queryKey: ['account', rowIndex, normalizeEmail(email)],
    queryFn: () => api.account(rowIndex, email),
  });
  const account = detail.data;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = `account-drawer-title-${rowIndex}`;
  const createJob = (workflowId: WorkflowId) => {
    if (!account) return;
    const selection = identitySelection([account]);
    onClose();
    // Release the drawer's modal lock before mounting the composer overlay.
    queueMicrotask(() => onCreateJob(workflowId, selection));
  };

  return (
    <Overlay
      backdropClassName="drawer-backdrop"
      panelClassName="detail-drawer"
      panelAs="aside"
      labelledBy={titleId}
      initialFocusRef={closeButtonRef}
      onClose={onClose}
    >
        <header><div className="drawer-title"><span className="eyebrow">Sheet row #{rowIndex}</span><h2 id={titleId} title={account?.email}>{account?.email || 'Đang tải'}</h2></div><button ref={closeButtonRef} type="button" className="icon-button drawer-close" onClick={onClose} aria-label="Đóng"><X size={18} aria-hidden="true" /></button></header>
        {detail.isLoading ? <LoadingLine /> : detail.error ? <ErrorState error={detail.error} /> : account && <>
          <div className="drawer-status"><StatusPill status={account.status} /><span>{account.recommendedAction ? `Đề xuất: ${workflowName(account.recommendedAction)}` : 'Cần kiểm tra thủ công'}</span></div>
          <section><h3>Hành động hợp lệ</h3>{account.runtime && <div className="warning-box" role="status">{runtimeReservationReason(account)}</div>}{jobCreationDisabledReason && <div className="warning-box" role="status">{jobCreationDisabledReason}</div>}<div className="action-grid">{account.eligibleWorkflows.map((workflow) => <button key={workflow} disabled={Boolean(account.runtime) || Boolean(jobCreationDisabledReason)} title={runtimeReservationReason(account) || jobCreationDisabledReason} className={workflow === account.recommendedAction ? 'button button-primary' : 'button button-ghost'} onClick={() => createJob(workflow)}>{workflowName(workflow)}</button>)}</div></section>
          {account.lastFailure && <section><h3>Lỗi gần nhất</h3><div className="last-failure"><strong>{account.lastFailure.message}</strong><span>Step: {account.lastFailure.step || 'Không xác định'}</span>{account.lastFailure.artifactId && <a href={`/api/jobs/${account.lastFailure.jobId}/artifacts/${account.lastFailure.artifactId}`} target="_blank" rel="noreferrer">Mở screenshot lỗi</a>}</div></section>}
          <section><h3>Credential bảo vệ</h3><SecretValue rowIndex={rowIndex} expectedEmail={account.email} field="hotmailPassword" label="Hotmail password" present /><SecretValue rowIndex={rowIndex} expectedEmail={account.email} field="elevenPassword" label="Eleven password" present={account.hasElevenPassword} /><SecretValue rowIndex={rowIndex} expectedEmail={account.email} field="apiKey" label="API key" present={account.hasApiKey} /></section>
          <section><h3>Lịch sử gần đây</h3>{account.recentJobs.length ? account.recentJobs.slice(0, 6).map((job) => <div className="history-row" key={job.id}><div><strong>{workflowName(job.request.workflowId)}</strong><small>{relativeTime(job.createdAt)} · {job.lastMessage}</small></div><StatusPill status={job.status} /></div>) : <EmptyState title="Chưa có lượt chạy" />}</section>
        </>}
    </Overlay>
  );
}

function AccountStatus({ status }: { status: string }) {
  return (
    <span className="account-status" title={status}>
      <span aria-hidden="true"><StatusPill status={status} /></span>
      <span className="sr-only">Trạng thái: {status}</span>
    </span>
  );
}

function runtimeLabel(runtime: AccountRuntime): string {
  if (runtime.state !== 'running') {
    return ({ queued: 'Đang chờ', waiting_captcha: 'Chờ CAPTCHA', cancelling: 'Đang hủy' })[runtime.state];
  }
  const step = runtime.currentStep?.toLowerCase() || '';
  if (step.includes('rotate proxy')) return 'Đang chuẩn bị proxy';
  if (step.includes('create gpm profile')) return 'Đang tạo profile';
  if (step.includes('start gpm profile')) return 'Đang mở browser';
  if (step.includes('connect to gpm')) return 'Đang kết nối browser';
  return runtime.currentStep ? `Đang chạy: ${runtime.currentStep}` : 'Đang khởi động worker';
}

function runtimeReservationReason(account: AccountSummary): string | null {
  if (!account.runtime) return null;
  return `Đang được giữ bởi job #${account.runtime.jobId.slice(0, 8)} (${runtimeLabel(account.runtime)})`;
}

function identitySelection(accounts: AccountSummary[]): Extract<JobRequest['selection'], { mode: 'identities' }> {
  return {
    mode: 'identities',
    accounts: accounts.map(({ rowIndex, email }) => ({ rowIndex, email })),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
