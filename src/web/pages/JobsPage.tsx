import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { ExternalLink, FileImage, RadioTower, RefreshCcw, RotateCcw, Square, TerminalSquare, X } from 'lucide-react';
import type { JobEvent, JobRecord, JobRequest, WorkflowId } from '../../shared/contracts';
import { api } from '../api';
import { EmptyState, ErrorState, LoadingLine, StatusPill } from '../components';
import { Overlay } from '../Overlay';
import { relativeTime, workflowName } from './DashboardPage';

interface JobsPageProps {
  useDrawer: boolean;
  jobCreationDisabledReason?: string;
  onRetry(workflowId: WorkflowId, selection: JobRequest['selection']): void;
}

export function JobsPage({ useDrawer, jobCreationDisabledReason, onRetry }: JobsPageProps) {
  const queryClient = useQueryClient();
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 7_000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useQuery({
    queryKey: ['job', selectedId],
    queryFn: () => api.job(selectedId!),
    enabled: Boolean(selectedId),
    refetchInterval: (query) => isNonTerminal(query.state.data?.job.status) ? 5_000 : false,
  });
  const refreshPage = useMutation({
    mutationFn: async () => {
      const results = await Promise.all([
        jobs.refetch(),
        ...(selectedId ? [selected.refetch()] : []),
      ]);
      const failed = results.find((result) => result.error);
      if (failed?.error) throw failed.error;
    },
  });
  const cancel = useMutation({
    mutationFn: api.cancelJob,
    onSuccess: (_job, jobId) => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    },
  });
  const focus = useMutation({ mutationFn: focusJob });
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const groups = useMemo(() => ({
    active: jobs.data?.filter((job) => ['running', 'needs_attention', 'cancelling'].includes(job.status)) || [],
    queued: jobs.data?.filter((job) => job.status === 'queued') || [],
    history: jobs.data?.filter((job) => !['running', 'needs_attention', 'cancelling', 'queued'].includes(job.status)) || [],
  }), [jobs.data]);
  const selectJob = (id: string) => {
    focus.reset();
    cancel.reset();
    setSelectedId(id);
  };
  const closeDetails = () => {
    focus.reset();
    cancel.reset();
    setSelectedId(null);
  };
  const retryJob = (workflowId: WorkflowId, selection: JobRequest['selection']) => {
    if (!useDrawer) {
      onRetry(workflowId, selection);
      return;
    }
    closeDetails();
    queueMicrotask(() => onRetry(workflowId, selection));
  };
  const restoreDrawerFocus = () => {
    const selectedButton = [...document.querySelectorAll<HTMLButtonElement>('[data-job-id]')]
      .find((button) => button.dataset.jobId === selectedId);
    return selectedButton || headingRef.current;
  };
  const detailContent = (
    <JobDetailContent
      selectedId={selectedId}
      selected={selected}
      cancel={cancel}
      focus={focus}
      jobCreationDisabledReason={jobCreationDisabledReason}
      onRetry={retryJob}
    />
  );

  return (
    <div className="page-stack page-enter">
      <header className="page-heading"><div><span className="eyebrow">Append-only history</span><h1 ref={headingRef} tabIndex={-1}>Lượt chạy</h1><p>Theo dõi queue, structured events, log đã redacted và screenshot lỗi.</p></div><button className="button button-ghost" disabled={refreshPage.isPending} onClick={() => refreshPage.mutate()}><RefreshCcw size={16} />{refreshPage.isPending ? 'Đang làm mới...' : 'Làm mới'}</button></header>
      {refreshPage.error && <ErrorState error={refreshPage.error} />}
      {jobs.isLoading ? <LoadingLine /> : jobs.error ? <ErrorState error={jobs.error} /> : (
        <div className="jobs-layout">
          <div className="job-lists">
            <JobGroup title="Đang chạy" jobs={groups.active} selectedId={selectedId} onSelect={selectJob} />
            <JobGroup title="Hàng đợi" jobs={groups.queued} selectedId={selectedId} onSelect={selectJob} />
            <JobGroup title="Lịch sử" jobs={groups.history} selectedId={selectedId} onSelect={selectJob} />
          </div>
          {!useDrawer && <section className="job-detail">{detailContent}</section>}
        </div>
      )}
      {useDrawer && selectedId && (
        <Overlay
          backdropClassName="drawer-backdrop"
          panelClassName="detail-drawer job-detail-drawer"
          panelAs="aside"
          ariaLabel="Chi tiết lượt chạy"
          initialFocusRef={closeButtonRef}
          getRestoreFocusTarget={restoreDrawerFocus}
          onClose={closeDetails}
        >
          <header><div className="drawer-title"><span className="eyebrow">Job detail</span><strong>Chi tiết lượt chạy</strong></div><button ref={closeButtonRef} type="button" className="icon-button drawer-close" onClick={closeDetails} aria-label="Đóng chi tiết lượt chạy"><X size={18} aria-hidden="true" /></button></header>
          <div className="job-detail-drawer-body">{detailContent}</div>
        </Overlay>
      )}
    </div>
  );
}

function JobDetailContent({ selectedId, selected, cancel, focus, jobCreationDisabledReason, onRetry }: {
  selectedId: string | null;
  selected: UseQueryResult<{ job: JobRecord; events: JobEvent[]; log: string }>;
  cancel: UseMutationResult<JobRecord, Error, string>;
  focus: UseMutationResult<{ focused: boolean }, Error, string>;
  jobCreationDisabledReason?: string;
  onRetry(workflowId: WorkflowId, selection: JobRequest['selection']): void;
}) {
  if (!selectedId) return <EmptyState title="Chọn một lượt chạy">Timeline và log sẽ hiển thị tại đây.</EmptyState>;
  if (selected.isLoading) return <LoadingLine />;
  if (selected.error) return <ErrorState error={selected.error} />;
  if (!selected.data) return null;

  const { job, events, log } = selected.data;
  const retrySelection = getRetrySelection(job, events);
  const retryCount = retrySelection?.mode === 'identities'
    ? retrySelection.accounts.length
    : retrySelection?.mode === 'rows' ? retrySelection.rowIndexes.length : 0;

  return <>
    <div className="job-detail-head"><div><span className="eyebrow">Job #{job.id.slice(0, 8)}</span><h2>{workflowName(job.request.workflowId)}</h2></div><StatusPill status={job.status} /></div>
    <div className="job-actions">
      {['running', 'needs_attention'].includes(job.status) && <>
        {job.request.workflowId !== 'proxyCheck' && <button className="button button-primary" disabled={focus.isPending || cancel.isPending} onClick={() => focus.mutate(job.id)}><RadioTower size={16} />{focus.isPending ? 'Đang focus...' : 'Focus browser'}</button>}
        <button className="button button-danger-ghost" disabled={focus.isPending || cancel.isPending} onClick={() => cancel.mutate(job.id)}><Square size={15} />{cancel.isPending ? 'Đang hủy...' : 'Hủy'}</button>
      </>}
      {job.status === 'queued' && <button className="button button-danger-ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(job.id)}>{cancel.isPending ? 'Đang hủy...' : 'Hủy khỏi queue'}</button>}
      {retrySelection && job.request.workflowId !== 'proxyCheck' && <button className="button button-ghost" disabled={Boolean(jobCreationDisabledReason)} title={jobCreationDisabledReason} onClick={() => onRetry(job.request.workflowId, retrySelection)}><RotateCcw size={16} />Retry {retryCount} account</button>}
    </div>
    {jobCreationDisabledReason && retrySelection && <div className="action-disabled-reason" role="status">{jobCreationDisabledReason}</div>}
    {focus.error ? <ErrorState error={focus.error} /> : null}
    {cancel.error ? <ErrorState error={cancel.error} /> : null}
    <div className="job-facts"><span>Account <strong>{job.currentAccount}/{job.totalAccounts}</strong></span><span>Lỗi <strong>{job.errorCount}</strong></span><span>Step <strong>{job.currentStep || '—'}</strong></span></div>
    <div className="job-tabs"><span><TerminalSquare size={15} />Event timeline</span></div>
    <div className="event-timeline">{events.filter((event) => event.type !== 'log').map((event) => {
      const artifactId = typeof event.data?.artifactId === 'string' ? event.data.artifactId : null;
      return <div className={`event-row event-${event.level}`} key={event.id}><i /><time>{new Date(event.timestamp).toLocaleTimeString('vi-VN')}</time><div><strong>{event.type}</strong><p>{event.message}</p>{event.type === 'artifact.created' && artifactId ? <a href={`/api/jobs/${event.jobId}/artifacts/${artifactId}`} target="_blank" rel="noreferrer"><FileImage size={14} />Mở screenshot <ExternalLink size={12} /></a> : null}</div></div>;
    })}</div>
    <details className="raw-log"><summary>Raw log đã redacted</summary><pre>{log || 'Chưa có log.'}</pre></details>
  </>;
}

function JobGroup({ title, jobs, selectedId, onSelect }: { title: string; jobs: JobRecord[]; selectedId: string | null; onSelect(id: string): void }) {
  return <section className="job-group"><div className="section-heading"><h2>{title}</h2><span className="count-label">{jobs.length}</span></div>{jobs.length ? jobs.map((job) => <button key={job.id} data-job-id={job.id} aria-pressed={selectedId === job.id} className={`job-list-row ${selectedId === job.id ? 'job-list-row-active' : ''}`} onClick={() => onSelect(job.id)}><div><strong>{workflowName(job.request.workflowId)}</strong><small>#{job.id.slice(0, 8)} · {relativeTime(job.createdAt)}</small></div><StatusPill status={job.status} /></button>) : <EmptyState title={`Không có job ${title.toLowerCase()}`} />}</section>;
}

export function getRetrySelection(job: JobRecord, events: JobEvent[]): JobRequest['selection'] | null {
  if (!['failed', 'cancelled', 'interrupted', 'completed_with_errors'].includes(job.status)) return null;

  if (job.acceptedAccounts?.length) {
    const outcomes = new Map<string, 'succeeded' | 'failed'>();
    for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
      const email = typeof event.data?.email === 'string' ? normalizeEmail(event.data.email) : '';
      if (!email) continue;
      if (event.type === 'account.succeeded') outcomes.set(email, 'succeeded');
      if (event.type === 'account.failed') outcomes.set(email, 'failed');
    }
    const accounts = job.acceptedAccounts.filter((account) => job.status === 'completed_with_errors'
      ? outcomes.get(normalizeEmail(account.email)) === 'failed'
      : outcomes.get(normalizeEmail(account.email)) !== 'succeeded');
    return accounts.length ? { mode: 'identities', accounts } : null;
  }

  const outcomes = new Map<number, 'succeeded' | 'failed'>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.rowIndex === undefined) continue;
    if (event.type === 'account.succeeded') outcomes.set(event.rowIndex, 'succeeded');
    if (event.type === 'account.failed') outcomes.set(event.rowIndex, 'failed');
  }
  const rowIndexes = job.acceptedRows.filter((rowIndex) => job.status === 'completed_with_errors'
    ? outcomes.get(rowIndex) === 'failed'
    : outcomes.get(rowIndex) !== 'succeeded');
  return rowIndexes.length ? { mode: 'rows', rowIndexes } : null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isNonTerminal(status: JobRecord['status'] | undefined): boolean {
  return Boolean(status && ['queued', 'running', 'needs_attention', 'cancelling'].includes(status));
}

async function focusJob(jobId: string) {
  const result = await api.focusJob(jobId);
  if (!result.focused) throw new Error('Browser không còn hoạt động để đưa ra trước');
  return result;
}
