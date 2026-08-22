import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, CircleAlert, Clock3, Play, RadioTower, RefreshCcw, RotateCcw, Users } from 'lucide-react';
import type { WorkflowId } from '../../shared/contracts';
import { api } from '../api';
import { EmptyState, ErrorState, LoadingLine, StatusPill } from '../components';

export function DashboardPage({ onCreateJob }: { onCreateJob(workflowId: WorkflowId): void }) {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.accounts() });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 8_000 });
  const focus = useMutation({ mutationFn: focusJob });
  const cancel = useMutation({
    mutationFn: api.cancelJob,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  });

  const stats = useMemo(() => {
    const values = { pending: 0, recoverable: 0, complete: 0, manual: 0, failed: 0 };
    for (const account of accounts.data || []) values[account.statusGroup]++;
    return values;
  }, [accounts.data]);
  const active = jobs.data?.find((job) => ['running', 'needs_attention', 'cancelling'].includes(job.status));
  const queued = jobs.data?.filter((job) => job.status === 'queued') || [];
  const history = jobs.data?.filter((job) => !['queued', 'running', 'needs_attention', 'cancelling'].includes(job.status)).slice(0, 5) || [];

  return (
    <div className="page-stack page-enter">
      <header className="page-heading">
        <div><span className="eyebrow">Control surface</span><h1>Tổng quan vận hành</h1><p>Một nơi để thấy account nào cần chạy, job nào cần người và tài nguyên nào chưa sẵn sàng.</p></div>
        <button className="button button-ghost" onClick={() => { void accounts.refetch(); void jobs.refetch(); }}><RefreshCcw size={16} />Làm mới</button>
      </header>

      <section className={`active-run ${active?.status === 'needs_attention' ? 'active-run-attention' : ''}`}>
        <div className="active-run-head">
          <div><span className="eyebrow">Active job</span><h2>{active ? workflowName(active.request.workflowId) : 'Worker đang rảnh'}</h2></div>
          {active ? <StatusPill status={active.status} /> : <span className="status-pill status-idle">idle</span>}
        </div>
        {active ? (
          <>
            <div className="run-grid">
              <div><span>Account</span><strong>{active.currentAccount} / {active.totalAccounts || '—'}</strong><small>{active.currentRowIndex ? `Sheet row ${active.currentRowIndex}` : 'Đang khởi tạo'}</small></div>
              <div><span>Step hiện tại</span><strong>{active.currentStep || 'Worker start'}</strong><small>{active.lastMessage}</small></div>
              <div><span>Bắt đầu</span><strong>{active.startedAt ? relativeTime(active.startedAt) : '—'}</strong><small>{active.errorCount} lỗi account</small></div>
            </div>
            <div className="active-run-actions">
              {active.request.workflowId !== 'proxyCheck' && <button className="button button-primary" disabled={focus.isPending || cancel.isPending || active.status === 'cancelling'} onClick={() => focus.mutate(active.id)}><RadioTower size={16} />{focus.isPending ? 'Đang focus...' : 'Đưa browser ra trước'}</button>}
              <button className="button button-danger-ghost" disabled={focus.isPending || cancel.isPending || active.status === 'cancelling'} onClick={() => cancel.mutate(active.id)}>{cancel.isPending ? 'Đang hủy...' : 'Hủy an toàn'}</button>
            </div>
            {focus.error && <ErrorState error={focus.error} />}
            {cancel.error && <ErrorState error={cancel.error} />}
          </>
        ) : (
          <div className="idle-callout"><span className="idle-orbit"><Play size={22} /></span><p>Chọn một workflow nhanh hoặc mở bảng tài khoản để chạy theo selection.</p></div>
        )}
      </section>

      <section className="quick-actions" aria-label="Thao tác nhanh">
        <button onClick={() => onCreateJob('signup')}><span><Play size={18} /></span><strong>Chạy pending</strong><small>Signup các dòng đang chờ</small><ArrowRight size={17} /></button>
        <button onClick={() => onCreateJob('fullCycle')}><span><RotateCcw size={18} /></span><strong>Chạy full cycle</strong><small>Tự xử lý các recovery pass</small><ArrowRight size={17} /></button>
        <button onClick={() => onCreateJob('proxyCheck')}><span><RadioTower size={18} /></span><strong>Kiểm tra proxy</strong><small>Exit IP và host bắt buộc</small><ArrowRight size={17} /></button>
      </section>

      {accounts.isLoading ? <LoadingLine /> : accounts.error ? <ErrorState error={accounts.error} /> : (
        <section className="stat-strip">
          <Stat icon={Clock3} label="Pending" value={stats.pending} tone="petrol" />
          <Stat icon={RotateCcw} label="Recoverable" value={stats.recoverable} tone="orange" />
          <Stat icon={CheckCircle2} label="Complete" value={stats.complete} tone="green" />
          <Stat icon={Users} label="Manual review" value={stats.manual} tone="ink" />
          <Stat icon={CircleAlert} label="Failed" value={stats.failed} tone="red" />
        </section>
      )}

      <div className="dashboard-columns">
        <section className="section-block">
          <div className="section-heading"><div><span className="eyebrow">Queue</span><h2>Sắp chạy</h2></div><span className="count-label">{queued.length}</span></div>
          {queued.length ? queued.map((job, index) => <div className="queue-row" key={job.id}><span className="queue-index">{String(index + 1).padStart(2, '0')}</span><div><strong>{workflowName(job.request.workflowId)}</strong><small>{job.totalAccounts || 'diagnostic'} account · {relativeTime(job.createdAt)}</small></div><StatusPill status={job.status} /></div>) : <EmptyState title="Hàng đợi trống">Job mới có thể bắt đầu ngay.</EmptyState>}
        </section>
        <section className="section-block">
          <div className="section-heading"><div><span className="eyebrow">Recent</span><h2>Vừa hoàn thành</h2></div></div>
          {jobs.isLoading ? <LoadingLine /> : history.length ? history.map((job) => <div className="history-row" key={job.id}><div><strong>{workflowName(job.request.workflowId)}</strong><small>{relativeTime(job.completedAt || job.createdAt)} · {job.errorCount} lỗi</small></div><StatusPill status={job.status} /></div>) : <EmptyState title="Chưa có lịch sử">Lượt chạy sẽ xuất hiện tại đây.</EmptyState>}
        </section>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone }: { icon: typeof Clock3; label: string; value: number; tone: string }) {
  return <div className={`stat-cell stat-${tone}`}><span><Icon size={16} />{label}</span><strong>{value}</strong></div>;
}

export function workflowName(workflow: WorkflowId): string {
  return ({ signup: 'Chạy pending', resume: 'Tiếp tục account', resetPassword: 'Reset mật khẩu', regenerateKey: 'Tạo key mới', retryPending: 'Retry pending', fullCycle: 'Full cycle', proxyCheck: 'Kiểm tra proxy' })[workflow];
}

export function relativeTime(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)} giây trước`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`;
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

async function focusJob(jobId: string) {
  const result = await api.focusJob(jobId);
  const focused = 'focused' in result ? result.focused : 'accepted' in result ? result.accepted : true;
  if (!focused) throw new Error('Browser không còn hoạt động để đưa ra trước');
  return result;
}
