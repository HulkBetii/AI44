import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileImage, RadioTower, RefreshCcw, RotateCcw, Square, TerminalSquare } from 'lucide-react';
import type { JobRecord, WorkflowId } from '../../shared/contracts';
import { api } from '../api';
import { EmptyState, ErrorState, LoadingLine, StatusPill } from '../components';
import { relativeTime, workflowName } from './DashboardPage';

export function JobsPage({ onRetry }: { onRetry(workflowId: WorkflowId, rows?: number[]): void }) {
  const queryClient = useQueryClient();
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 7_000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useQuery({
    queryKey: ['job', selectedId],
    queryFn: () => api.job(selectedId!),
    enabled: Boolean(selectedId),
    refetchInterval: (query) => isNonTerminal(query.state.data?.job.status) ? 5_000 : false,
  });
  const cancel = useMutation({
    mutationFn: api.cancelJob,
    onSuccess: (_job, jobId) => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    },
  });
  const focus = useMutation({ mutationFn: focusJob });

  const groups = useMemo(() => ({
    active: jobs.data?.filter((job) => ['running', 'needs_attention', 'cancelling'].includes(job.status)) || [],
    queued: jobs.data?.filter((job) => job.status === 'queued') || [],
    history: jobs.data?.filter((job) => !['running', 'needs_attention', 'cancelling', 'queued'].includes(job.status)) || [],
  }), [jobs.data]);

  return (
    <div className="page-stack page-enter">
      <header className="page-heading"><div><span className="eyebrow">Append-only history</span><h1>Lượt chạy</h1><p>Theo dõi queue, structured events, log đã redacted và screenshot lỗi.</p></div><button className="button button-ghost" onClick={() => void jobs.refetch()}><RefreshCcw size={16} />Làm mới</button></header>
      {jobs.isLoading ? <LoadingLine /> : jobs.error ? <ErrorState error={jobs.error} /> : (
        <div className="jobs-layout">
          <div className="job-lists">
            <JobGroup title="Đang chạy" jobs={groups.active} selectedId={selectedId} onSelect={(id) => { focus.reset(); cancel.reset(); setSelectedId(id); }} />
            <JobGroup title="Hàng đợi" jobs={groups.queued} selectedId={selectedId} onSelect={(id) => { focus.reset(); cancel.reset(); setSelectedId(id); }} />
            <JobGroup title="Lịch sử" jobs={groups.history} selectedId={selectedId} onSelect={(id) => { focus.reset(); cancel.reset(); setSelectedId(id); }} />
          </div>
          <section className="job-detail">
            {!selectedId ? <EmptyState title="Chọn một lượt chạy">Timeline và log sẽ hiển thị tại đây.</EmptyState> : selected.isLoading ? <LoadingLine /> : selected.error ? <ErrorState error={selected.error} /> : selected.data && <>
              <div className="job-detail-head"><div><span className="eyebrow">Job #{selected.data.job.id.slice(0, 8)}</span><h2>{workflowName(selected.data.job.request.workflowId)}</h2></div><StatusPill status={selected.data.job.status} /></div>
              <div className="job-actions">
                {['running', 'needs_attention'].includes(selected.data.job.status) && <>
                  {selected.data.job.request.workflowId !== 'proxyCheck' && <button className="button button-primary" disabled={focus.isPending || cancel.isPending} onClick={() => focus.mutate(selected.data!.job.id)}><RadioTower size={16} />{focus.isPending ? 'Đang focus...' : 'Focus browser'}</button>}
                  <button className="button button-danger-ghost" disabled={focus.isPending || cancel.isPending} onClick={() => cancel.mutate(selected.data!.job.id)}><Square size={15} />{cancel.isPending ? 'Đang hủy...' : 'Hủy'}</button>
                </>}
                {selected.data.job.status === 'queued' && <button className="button button-danger-ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(selected.data!.job.id)}>{cancel.isPending ? 'Đang hủy...' : 'Hủy khỏi queue'}</button>}
                {!['running', 'needs_attention', 'cancelling', 'queued'].includes(selected.data.job.status) && selected.data.job.request.workflowId !== 'proxyCheck' && <button className="button button-ghost" onClick={() => onRetry(selected.data!.job.request.workflowId, selected.data!.job.acceptedRows)}><RotateCcw size={16} />Tạo retry job</button>}
              </div>
              {focus.error && <ErrorState error={focus.error} />}
              {cancel.error && <ErrorState error={cancel.error} />}
              <div className="job-facts"><span>Account <strong>{selected.data.job.currentAccount}/{selected.data.job.totalAccounts}</strong></span><span>Lỗi <strong>{selected.data.job.errorCount}</strong></span><span>Step <strong>{selected.data.job.currentStep || '—'}</strong></span></div>
              <div className="job-tabs"><span><TerminalSquare size={15} />Event timeline</span></div>
              <div className="event-timeline">{selected.data.events.filter((event) => event.type !== 'log').map((event) => <div className={`event-row event-${event.level}`} key={event.id}><i /><time>{new Date(event.timestamp).toLocaleTimeString('vi-VN')}</time><div><strong>{event.type}</strong><p>{event.message}</p>{event.type === 'artifact.created' && event.data?.artifactId && <a href={`/api/jobs/${event.jobId}/artifacts/${event.data.artifactId}`} target="_blank" rel="noreferrer"><FileImage size={14} />Mở screenshot <ExternalLink size={12} /></a>}</div></div>)}</div>
              <details className="raw-log"><summary>Raw log đã redacted</summary><pre>{selected.data.log || 'Chưa có log.'}</pre></details>
            </>}
          </section>
        </div>
      )}
    </div>
  );
}

function JobGroup({ title, jobs, selectedId, onSelect }: { title: string; jobs: JobRecord[]; selectedId: string | null; onSelect(id: string): void }) {
  return <section className="job-group"><div className="section-heading"><h2>{title}</h2><span className="count-label">{jobs.length}</span></div>{jobs.length ? jobs.map((job) => <button key={job.id} aria-pressed={selectedId === job.id} className={`job-list-row ${selectedId === job.id ? 'job-list-row-active' : ''}`} onClick={() => onSelect(job.id)}><div><strong>{workflowName(job.request.workflowId)}</strong><small>#{job.id.slice(0, 8)} · {relativeTime(job.createdAt)}</small></div><StatusPill status={job.status} /></button>) : <EmptyState title={`Không có job ${title.toLowerCase()}`} />}</section>;
}

function isNonTerminal(status: JobRecord['status'] | undefined): boolean {
  return Boolean(status && ['queued', 'running', 'needs_attention', 'cancelling'].includes(status));
}

async function focusJob(jobId: string) {
  const result = await api.focusJob(jobId);
  const focused = 'focused' in result ? result.focused : 'accepted' in result ? result.accepted : true;
  if (!focused) throw new Error('Browser không còn hoạt động để đưa ra trước');
  return result;
}
